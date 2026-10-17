/// <reference lib="webworker" />
import {
  MAX_PLAYERS,
  NES_FRAME_RATE,
  NES_HEIGHT,
  NES_WIDTH,
  NETPLAY_HASH_INTERVAL,
  NETPLAY_SNAPSHOT_INTERVAL,
  type FromWorker,
  type ToAudio,
  type ToWorker,
  FramePacer,
  WasmCore,
} from "@neslink/core";
import { NetplayLink } from "./netplay-link";

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
/** Netplay frames the clock says are due but that are still waiting on remote input. */
let owedFrames = 0;
let netWaits = 0;
/**
 * A spectator further than this behind the newest input it holds is catching
 * up (joined mid-game, or the tab was busy) and fast-forwards.
 */
const SPECTATOR_SLACK = 2;
/** Frames a catching-up spectator runs per refresh: ~25ms of emulation. */
const CATCH_UP_FRAMES = 30;

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

function step(frameInputs: readonly number[], audio = true) {
  core!.runFrame(frameInputs);
  frame++;
  fpsFrames++;
  const samples = core!.drainAudio();
  // Fast-forwarded frames would arrive as a burst of sound; drop it.
  if (audio && samples.length > 0) postAudio({ type: "samples", samples }, [samples.buffer]);
}

function stepNetplay(audio = true) {
  const session = link!.session!;
  // Either keyboard layout drives the local seat; the seat itself comes from the room.
  const local = inputs[0] | inputs[1];
  const { inputs: frameInputs, localFrame } = session.advance(local);
  if (localFrame !== null) link!.sendInput(localFrame, local);
  step(frameInputs, audio);
  if (session.spectating) return;
  if (session.frame % NETPLAY_HASH_INTERVAL === 0) {
    link!.sendHash(session.frame - 1, core!.stateHash());
  }
  // The first seat keeps the room's snapshot fresh for spectators who join late.
  if (session.localSeat === session.activeSeats[0] && session.frame % NETPLAY_SNAPSHOT_INTERVAL === 0) {
    link!.sendSnapshot(session.frame, toBase64(core!.saveState()));
  }
}

function render() {
  image!.data.set(core!.framebuffer());
  ctx!.putImageData(image!, 0, 0);
}

function tick(now: number) {
  scheduled = null;
  if (!running()) return;
  schedule();

  const due = pacer.advance(now);
  let ran = 0;
  try {
    if (inNetGame()) {
      const session = link!.session!;
      const backlog = session.spectating ? session.available(CATCH_UP_FRAMES + session.delay + SPECTATOR_SLACK) : 0;
      if (backlog > session.delay + SPECTATOR_SLACK) {
        // Spectator behind the game: run ahead silently until close to live.
        for (const n = Math.min(CATCH_UP_FRAMES, backlog - session.delay); ran < n; ran++) stepNetplay(false);
        owedFrames = 0;
      } else {
        // Frames we could not run while waiting are made up once input arrives, but
        // only a few, so a long wait does not turn into a fast-forward.
        owedFrames = Math.min(owedFrames + due, session.delay);
        while (owedFrames > 0 && session.ready()) {
          stepNetplay();
          owedFrames--;
          ran++;
        }
        if (owedFrames > 0) netWaits++;
      }
    } else {
      for (; ran < due; ran++) step(inputs);
    }
  } catch (error) {
    romLoaded = false;
    post({ type: "error", kind: "emulationStopped", message: errorMessage(error) });
    return;
  }

  refreshesSinceRender++;
  if (ran === 0) return;
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
    post({
      type: "stats",
      fps: (fpsFrames * 1000) / (now - fpsWindowStart),
      frame,
      refreshHz: !usingTimer && refreshMs ? 1000 / refreshMs : null,
      vsyncLocked: pacer.lockedInterval() !== null,
      unevenFrames,
      netWaits,
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
  cancel();
  // rAF stops while the page is hidden. Alone that just pauses the game, but in
  // netplay it would freeze the other player too, so keep going on a timer.
  usingTimer = !hasRaf || (hidden && inNetGame());
  pacer = usingTimer ? timerPacer : rafPacer;
  pacer.reset();
  fpsWindowStart = null;
  fpsFrames = 0;
  refreshesSinceRender = 0;
  unevenFrames = 0;
  postAudio({ type: "flush" });
  schedule();
}

function joinRoom(url: string, name: string, romHash: string) {
  link?.close();
  link = new NetplayLink(url, { name, romHash }, {
    onStatus: (status, reason) => post({ type: "netStatus", status, reason }),
    onRoom: (room, you) => post({ type: "netRoom", room, you }),
    onStart: (session, snapshot) => {
      if (!core || !rom) return;
      // Every player powers on the same cartridge, so all cores start identical;
      // a late spectator then jumps to the room's latest snapshot.
      core.loadRom(rom);
      if (snapshot) core.loadState(fromBase64(snapshot));
      romLoaded = true;
      frame = session.frame;
      owedFrames = 0;
      post({ type: "netStarted", seat: session.localSeat, delay: session.delay });
      start();
    },
    onEnd: (reason) => {
      cancel();
      post({ type: "netEnded", reason });
    },
    onDesync: (desyncFrame) => post({ type: "netDesync", frame: desyncFrame }),
    onError: (code) => post({ type: "netError", code }),
    onPing: (rttMs) => post({ type: "netPing", rttMs }),
  });
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
      joinRoom(message.url, message.name, message.romHash);
      break;
    case "netStart":
      link?.requestStart();
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
