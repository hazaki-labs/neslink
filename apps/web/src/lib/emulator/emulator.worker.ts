/// <reference lib="webworker" />
import {
  MAX_PLAYERS,
  NES_FRAME_RATE,
  NES_HEIGHT,
  NES_WIDTH,
  NETPLAY_HASH_INTERVAL,
  NETPLAY_SNAPSHOT_INTERVAL,
  MAX_ROLLBACK,
  type FromWorker,
  type ToAudio,
  type ToWorker,
  FramePacer,
  InputHistory,
  LockstepSession,
  unpackInputs,
  type PeerPacket,
  RollbackSession,
  WasmCore,
} from "@neslink/core";
import { NetplayLink, type GameStart, type NetSession, type SimulatedNetwork } from "./netplay-link";

const FRAME_MS = 1000 / NES_FRAME_RATE;

const scope = self as unknown as DedicatedWorkerGlobalScope;
// Worker rAF fires in step with the display, which is what makes pacing smooth.
// Without it (older browsers) fall back to a timer, paced by wall-clock time.
const hasRaf = typeof scope.requestAnimationFrame === "function";

let core: WasmCore | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let image: ImageData | null = null;
let audioPort: MessagePort | null = null;
let rom: Uint8Array<ArrayBuffer> | null = null;

const inputs = new Array<number>(MAX_PLAYERS).fill(0);
const rafPacer = new FramePacer(FRAME_MS, true);
const timerPacer = new FramePacer(FRAME_MS, false);
let pacer = hasRaf ? rafPacer : timerPacer;
let usingTimer = !hasRaf;
let romLoaded = false;
let paused = false;
let hidden = false;
let frame = 0;
let scheduled: number | null = null;
let fpsWindowStart: number | null = null;
let fpsFrames = 0;
/** Refreshes since the last rendered frame, and how many frames broke the rhythm. */
let refreshesSinceRender = 0;
let unevenFrames = 0;

let link: NetplayLink | null = null;
/** Direct link to the other player through the UI thread (WebRTC), if any. */
let peerPort: MessagePort | null = null;
/** Our inputs not yet acknowledged over the direct link. */
const peerHistory = new InputHistory();
/** Netplay frames the clock says are due but that could not run yet. */
let owedFrames = 0;
let netWaits = 0;
/** Most owed frames made up at once, so a long wait does not turn into a fast-forward. */
const MAX_OWED = 4;
/**
 * A spectator further than this behind the newest input it holds is catching
 * up (joined mid-game, or the tab was busy) and fast-forwards.
 */
const SPECTATOR_SLACK = 2;
/** Frames a catching-up spectator runs per refresh: ~25ms of emulation. */
const CATCH_UP_FRAMES = 30;
/**
 * Emulation time one rollback may take. The window of speculative frames is
 * sized so a worst-case re-simulation fits, measured on this device. A long
 * re-simulation costs one late frame; a window too small to cover the network
 * trip makes the game stop and wait instead, which is worse, so lean generous.
 */
const ROLLBACK_BUDGET_MS = 12;
const MIN_ROLLBACK_WINDOW = 4;
/** Smoothed cost of emulating one frame, in ms. */
let frameCostMs = 1;
/**
 * rAF can stop without the page reporting itself hidden (a background tab in
 * some embedders, an occluded window). Alone that only pauses the game, but in
 * netplay it freezes the other player too, so a watchdog falls back to a timer
 * and returns to rAF once it fires again.
 */
const RAF_STALL_MS = 100;
const WATCHDOG_MS = 100;
let watchdog: ReturnType<typeof setInterval> | null = null;
let lastTickAt = 0;
let lastRafAt = 0;

function post(message: FromWorker, transfer: Transferable[] = []) {
  scope.postMessage(message, transfer);
}

function postAudio(message: ToAudio, transfer: Transferable[] = []) {
  audioPort?.postMessage(message, transfer);
}

function inNetGame() {
  return link?.session != null;
}

function running() {
  if (core === null || !romLoaded || paused) return false;
  // In a room, frames only run while a game is in progress.
  return link === null || inNetGame();
}

/**
 * Run one frame. `live` frames are shown and heard; re-simulated (rollback)
 * and fast-forwarded frames are silent and not counted as displayed frames.
 */
function step(frameInputs: readonly number[], live = true) {
  const t0 = performance.now();
  core!.runFrame(frameInputs);
  frameCostMs += (performance.now() - t0 - frameCostMs) * 0.05;
  if (!live) {
    core!.discardAudio();
    return;
  }
  frame++;
  fpsFrames++;
  const samples = core!.drainAudio();
  if (samples.length > 0) postAudio({ type: "samples", samples }, [samples.buffer]);
}

/** Either keyboard layout or gamepad drives the local seat; the seat itself comes from the room. */
function localMask() {
  return inputs[0] | inputs[1];
}

function render() {
  image!.data.set(core!.framebuffer());
  ctx!.putImageData(image!, 0, 0);
}

/** A spectator follows the confirmed inputs; returns frames shown this refresh. */
function tickSpectator(session: LockstepSession, due: number): number {
  let ran = 0;
  const backlog = session.available(CATCH_UP_FRAMES + session.delay + SPECTATOR_SLACK);
  if (backlog > session.delay + SPECTATOR_SLACK) {
    // Behind the game: run ahead silently until close to live.
    const n = Math.min(CATCH_UP_FRAMES, backlog - session.delay);
    for (; ran < n; ran++) step(session.advance().inputs, ran === n - 1);
    owedFrames = 0;
    return ran;
  }
  owedFrames = Math.min(owedFrames + due, MAX_OWED);
  while (owedFrames > 0 && session.ready()) {
    step(session.advance().inputs);
    owedFrames--;
    ran++;
  }
  if (owedFrames > 0) netWaits++;
  return ran;
}

/** A seated player runs on predictions and corrects them; returns whether the screen changed. */
function tickPlayer(session: RollbackSession, due: number): boolean {
  owedFrames = Math.min(owedFrames + due, MAX_OWED);
  // Running ahead of the other player only makes them roll back more; ease off now and then.
  if (owedFrames > 0 && session.shouldYield()) owedFrames--;
  const replayed = session.resolve();
  let ran = 0;
  while (owedFrames > 0 && session.canAdvance()) {
    const mask = localMask();
    const localFrame = session.advance(mask);
    link!.sendInput(localFrame, mask, session.localAdvantage());
    peerHistory.push(localFrame, mask);
    owedFrames--;
    ran++;
  }
  if (owedFrames > 0) netWaits++;
  sendPeerPacket(session);
  return ran > 0 || replayed > 0;
}

/**
 * Send our unacknowledged inputs over the direct link. Every refresh, even
 * without a new frame: on a lossy channel the last packet may have been lost.
 */
function sendPeerPacket(session: RollbackSession) {
  if (!peerPort) return;
  const other = session.activeSeats.find((seat) => seat !== session.localSeat);
  if (other === undefined) return;
  const packet = peerHistory.packet(session.localSeat, session.localAdvantage(), session.receivedThrough(other));
  if (packet) peerPort.postMessage(packet);
}

/** A packet from the other player over the direct link: same inputs as the server relays, sooner. */
function onPeerPacket(packet: PeerPacket) {
  const session = link?.session;
  if (!(session instanceof RollbackSession) || packet.t !== "in" || packet.s === session.localSeat) return;
  for (const [f, m] of unpackInputs(packet)) session.receive(packet.s, f, m);
  if (Number.isInteger(packet.a)) session.receiveAdvantage(packet.a);
  if (Number.isInteger(packet.k)) peerHistory.acknowledge(packet.k);
}

/** Run what this refresh owes; returns whether the screen changed. */
function runDue(due: number): boolean {
  const session = link?.session;
  if (session instanceof RollbackSession) return tickPlayer(session, due);
  if (session instanceof LockstepSession) return tickSpectator(session, due) > 0;
  for (let i = 0; i < due; i++) step(inputs);
  return due > 0;
}

function tick(now: number) {
  lastTickAt = performance.now();
  scheduled = null;
  if (!running()) return;
  schedule();

  const due = pacer.advance(now);
  let changed: boolean;
  try {
    changed = runDue(due);
  } catch (error) {
    romLoaded = false;
    post({ type: "error", kind: "emulationStopped", message: errorMessage(error) });
    return;
  }

  refreshesSinceRender++;
  if (!changed) return;
  // However many frames ran or were corrected, only the newest is drawn.
  render();
  const n = pacer.lockedInterval();
  if (n !== null && refreshesSinceRender !== n) unevenFrames++;
  refreshesSinceRender = 0;

  // Open and close the fps window on frame-producing refreshes only. Closing on
  // whichever refresh first passes 1s would make a window hold 60 or 61 frames
  // at random and read 59.5 / 60.9 even when pacing is perfect.
  if (fpsWindowStart === null) {
    fpsWindowStart = now;
    fpsFrames = 0;
  } else if (now - fpsWindowStart >= 1000) {
    const refreshMs = pacer.refreshMs();
    const session = link?.session;
    const rollback = session instanceof RollbackSession ? session : null;
    // Size the rollback window to what this device can re-simulate within budget.
    if (rollback) {
      rollback.window = Math.max(MIN_ROLLBACK_WINDOW, Math.min(MAX_ROLLBACK, Math.floor(ROLLBACK_BUDGET_MS / frameCostMs)));
    }
    const rollbackStats = rollback?.takeStats() ?? { rollbacks: 0, replayedFrames: 0 };
    post({
      type: "stats",
      fps: (fpsFrames * 1000) / (now - fpsWindowStart),
      frame,
      refreshHz: !usingTimer && refreshMs ? 1000 / refreshMs : null,
      vsyncLocked: pacer.lockedInterval() !== null,
      unevenFrames,
      netWaits,
      ...rollbackStats,
      rollbackWindow: rollback?.window ?? null,
      frameCostMs,
    });
    fpsWindowStart = now;
    fpsFrames = 0;
    unevenFrames = 0;
    netWaits = 0;
  }
}

function schedule() {
  if (scheduled !== null || !running()) return;
  scheduled = usingTimer
    ? (setTimeout(() => tick(performance.now()), FRAME_MS / 4) as unknown as number)
    : scope.requestAnimationFrame(tick);
}

function cancel() {
  if (scheduled === null) return;
  if (usingTimer) clearTimeout(scheduled);
  else scope.cancelAnimationFrame(scheduled);
  scheduled = null;
}

function start() {
  // rAF stops while the page is hidden. Alone that just pauses the game, but in
  // netplay it would freeze the other player too, so keep going on a timer.
  setPacing(!hasRaf || (hidden && inNetGame()));
  fpsWindowStart = null;
  fpsFrames = 0;
  refreshesSinceRender = 0;
  unevenFrames = 0;
  postAudio({ type: "flush" });
  lastTickAt = performance.now();
  if (inNetGame() && hasRaf && watchdog === null) watchdog = setInterval(watchRaf, WATCHDOG_MS);
}

function setPacing(timer: boolean) {
  cancel();
  usingTimer = timer;
  pacer = timer ? timerPacer : rafPacer;
  pacer.reset();
  schedule();
}

function watchRaf() {
  if (!inNetGame()) {
    clearInterval(watchdog!);
    watchdog = null;
    return;
  }
  if (!running()) return;
  const now = performance.now();
  if (!usingTimer) {
    if (now - lastTickAt > RAF_STALL_MS) setPacing(true);
    return;
  }
  if (hidden) return;
  // On the timer: probe rAF and go back to it (smoother, vsync-locked) once it runs again.
  if (now - lastRafAt < WATCHDOG_MS * 1.5) setPacing(false);
  else
    scope.requestAnimationFrame(() => {
      lastRafAt = performance.now();
    });
}

/** Build the session for a game: rollback for a seated player, lockstep for a spectator. */
function startGame(game: GameStart): NetSession | null {
  if (!core || !rom) return null;
  const emulator = core;
  // Every player powers on the same cartridge, so all cores start identical;
  // a late spectator then jumps to the room's latest snapshot.
  emulator.loadRom(rom);
  if (game.snapshot) emulator.loadState(fromBase64(game.snapshot));
  romLoaded = true;
  frame = game.startFrame;
  owedFrames = 0;
  peerHistory.clear();

  let session: NetSession;
  if (game.localSeat === null) {
    session = new LockstepSession(game.seats, null, game.delay, game.startFrame);
  } else {
    const rollback = new RollbackSession(game.seats, game.localSeat, game.delay, {
      save: (slot) => emulator.saveSlot(slot),
      load: (slot) => emulator.loadSlot(slot),
      run: (frameInputs, replay) => step(frameInputs, !replay),
      hash: () => emulator.stateHash(),
    });
    const uploadsSnapshots = game.localSeat === game.seats[0];
    rollback.onFinal = (final, hash) => {
      const next = final + 1;
      if (next % NETPLAY_HASH_INTERVAL === 0) link!.sendHash(final, hash);
      // The first seat keeps the room's snapshot fresh for spectators who join late.
      if (uploadsSnapshots && next % NETPLAY_SNAPSHOT_INTERVAL === 0) {
        const slot = rollback.slotBefore(next);
        const bytes = slot === null ? emulator.saveState() : emulator.slotBytes(slot);
        link!.sendSnapshot(next, toBase64(bytes));
      }
    };
    session = rollback;
  }
  post({ type: "netStarted", seat: game.localSeat, delay: game.delay });
  // Start on the next turn: the link attaches the session to receive inputs first.
  queueMicrotask(start);
  return session;
}

function joinRoom(url: string, name: string, romHash: string, simulated: SimulatedNetwork | null, port: MessagePort | null) {
  link?.close();
  peerPort?.close();
  peerPort = port;
  if (peerPort) peerPort.onmessage = (event: MessageEvent<PeerPacket>) => onPeerPacket(event.data);
  link = new NetplayLink(url, { name, romHash }, {
    onStatus: (status, reason) => post({ type: "netStatus", status, reason }),
    onRoom: (room, you) => post({ type: "netRoom", room, you }),
    onStart: startGame,
    onEnd: (reason) => {
      cancel();
      post({ type: "netEnded", reason });
    },
    onDesync: (desyncFrame) => post({ type: "netDesync", frame: desyncFrame }),
    onError: (code) => post({ type: "netError", code }),
    onPing: (rttMs) => post({ type: "netPing", rttMs }),
    onSignal: (from, data) => post({ type: "netSignal", from, data }),
  }, simulated);
}

async function handle(message: ToWorker) {
  switch (message.type) {
    case "init": {
      core = await WasmCore.create({ sampleRate: message.sampleRate });
      audioPort = message.audioPort;
      ctx = message.canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
      image = ctx.createImageData(NES_WIDTH, NES_HEIGHT);
      post({ type: "ready" });
      break;
    }
    case "loadRom": {
      if (!core) throw new Error("Worker not initialised");
      rom = message.rom;
      core.loadRom(rom);
      romLoaded = true;
      frame = 0;
      post({ type: "romLoaded" });
      if (message.autostart) start();
      break;
    }
    case "input":
      if (message.port >= 0 && message.port < MAX_PLAYERS) inputs[message.port] = message.mask;
      break;
    case "pause":
      // Pausing, resetting or loading a state alone would desync a netplay game.
      if (inNetGame()) break;
      paused = message.paused;
      if (paused) cancel();
      else start();
      break;
    case "reset":
      if (inNetGame()) break;
      core?.reset();
      frame = 0;
      break;
    case "saveState": {
      if (!core || !romLoaded) throw new Error("No game running");
      const state = core.saveState() as Uint8Array<ArrayBuffer>;
      post({ type: "state", requestId: message.requestId, state }, [state.buffer]);
      break;
    }
    case "loadState":
      if (!core || !romLoaded) throw new Error("No game running");
      if (inNetGame()) break;
      core.loadState(message.state);
      render();
      break;
    case "visibility":
      hidden = message.hidden;
      if (running()) start();
      break;
    case "netJoin":
      joinRoom(message.url, message.name, message.romHash, message.simulated, message.peerPort);
      break;
    case "netStart":
      link?.requestStart();
      break;
    case "netSignal":
      link?.sendSignal(message.to, message.data);
      break;
    case "peerRtt":
      link?.setDirectRtt(message.ms);
      break;
    case "netSeat":
      link?.takeSeat(message.seat);
      break;
    case "netLeave":
      cancel();
      link?.close();
      link = null;
      break;
  }
}

// Handle messages strictly in order: init is async (wasm instantiation) and
// everything after it must wait for the core to exist.
let queue = Promise.resolve();
scope.onmessage = (event: MessageEvent<ToWorker>) => {
  queue = queue
    .then(() => handle(event.data))
    .catch((error) => post({ type: "error", kind: "other", message: errorMessage(error) }));
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

// wasm-bindgen JsError values arrive as Error, but be defensive about thrown strings.
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
