/// <reference lib="webworker" />
import {
  MAX_PLAYERS,
  NES_FRAME_RATE,
  NES_HEIGHT,
  NES_WIDTH,
  type FromWorker,
  type ToAudio,
  type ToWorker,
  FramePacer,
  WasmCore,
} from "@neslink/core";

const FRAME_MS = 1000 / NES_FRAME_RATE;

const scope = self as unknown as DedicatedWorkerGlobalScope;
// Worker rAF fires in step with the display, which is what makes pacing smooth.
// Without it (older browsers) fall back to a timer, paced by wall-clock time.
const hasRaf = typeof scope.requestAnimationFrame === "function";

let core: WasmCore | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let image: ImageData | null = null;
let audioPort: MessagePort | null = null;

const inputs = new Array<number>(MAX_PLAYERS).fill(0);
const pacer = new FramePacer(FRAME_MS, hasRaf);
let romLoaded = false;
let paused = false;
let frame = 0;
let scheduled: number | null = null;
let fpsWindowStart: number | null = null;
let fpsFrames = 0;
/** Refreshes since the last rendered frame, and how many frames broke the rhythm. */
let refreshesSinceRender = 0;
let unevenFrames = 0;

function post(message: FromWorker, transfer: Transferable[] = []) {
  scope.postMessage(message, transfer);
}

function postAudio(message: ToAudio, transfer: Transferable[] = []) {
  audioPort?.postMessage(message, transfer);
}

function running() {
  return core !== null && romLoaded && !paused;
}

function step() {
  core!.runFrame(inputs);
  frame++;
  fpsFrames++;
  const samples = core!.drainAudio();
  if (samples.length > 0) postAudio({ type: "samples", samples }, [samples.buffer]);
}

function render() {
  image!.data.set(core!.framebuffer());
  ctx!.putImageData(image!, 0, 0);
}

function tick(now: number) {
  scheduled = null;
  if (!running()) return;
  schedule();

  const frames = pacer.advance(now);
  try {
    for (let i = 0; i < frames; i++) step();
  } catch (error) {
    romLoaded = false;
    post({ type: "error", message: `Emulation stopped: ${errorMessage(error)}` });
    return;
  }

  refreshesSinceRender++;
  if (frames === 0) return;
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
      refreshHz: hasRaf && refreshMs ? 1000 / refreshMs : null,
      vsyncLocked: pacer.lockedInterval() !== null,
      unevenFrames,
    });
    fpsWindowStart = now;
    fpsFrames = 0;
    unevenFrames = 0;
  }
}

function schedule() {
  if (scheduled !== null || !running()) return;
  scheduled = hasRaf
    ? scope.requestAnimationFrame(tick)
    : (setTimeout(() => tick(performance.now()), FRAME_MS / 4) as unknown as number);
}

function cancel() {
  if (scheduled === null) return;
  if (hasRaf) scope.cancelAnimationFrame(scheduled);
  else clearTimeout(scheduled);
  scheduled = null;
}

function start() {
  pacer.reset();
  fpsWindowStart = null;
  fpsFrames = 0;
  refreshesSinceRender = 0;
  unevenFrames = 0;
  postAudio({ type: "flush" });
  schedule();
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
      core.loadRom(message.rom);
      romLoaded = true;
      frame = 0;
      post({ type: "romLoaded" });
      start();
      break;
    }
    case "input":
      if (message.port >= 0 && message.port < MAX_PLAYERS) inputs[message.port] = message.mask;
      break;
    case "pause":
      paused = message.paused;
      if (paused) cancel();
      else start();
      break;
    case "reset":
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
      core.loadState(message.state);
      render();
      break;
  }
}

// Handle messages strictly in order: init is async (wasm instantiation) and
// everything after it must wait for the core to exist.
let queue = Promise.resolve();
scope.onmessage = (event: MessageEvent<ToWorker>) => {
  queue = queue
    .then(() => handle(event.data))
    .catch((error) => post({ type: "error", message: errorMessage(error) }));
};

// wasm-bindgen JsError values arrive as Error, but be defensive about thrown strings.
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
