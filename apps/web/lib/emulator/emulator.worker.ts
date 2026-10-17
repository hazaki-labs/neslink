/// <reference lib="webworker" />
import {
  JsnesCore,
  MAX_PLAYERS,
  NES_FRAME_RATE,
  NES_HEIGHT,
  NES_WIDTH,
  type FromWorker,
  type ToAudio,
  type ToWorker,
} from "@neslink/core";

const FRAME_MS = 1000 / NES_FRAME_RATE;
/** Most frames we run to catch up before giving up and resyncing the clock. */
const MAX_CATCH_UP = 4;

const scope = self as unknown as DedicatedWorkerGlobalScope;

let core: JsnesCore | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let image: ImageData | null = null;
let audioPort: MessagePort | null = null;

const inputs = new Array<number>(MAX_PLAYERS).fill(0);
let romLoaded = false;
let paused = false;
let frame = 0;
let nextFrameAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let fpsWindowStart = 0;
let fpsFrames = 0;

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

function tick() {
  timer = null;
  if (!running()) return;

  const now = performance.now();
  let ran = 0;
  try {
    while (now >= nextFrameAt && ran < MAX_CATCH_UP) {
      step();
      nextFrameAt += FRAME_MS;
      ran++;
    }
  } catch (error) {
    romLoaded = false;
    post({ type: "error", message: `Emulation stopped: ${(error as Error).message}` });
    return;
  }
  // Fell too far behind (tab throttled, debugger, slow device): drop the backlog.
  if (now - nextFrameAt > FRAME_MS * MAX_CATCH_UP) nextFrameAt = now + FRAME_MS;
  if (ran > 0) render();

  if (now - fpsWindowStart >= 1000) {
    post({ type: "stats", fps: (fpsFrames * 1000) / (now - fpsWindowStart), frame });
    fpsWindowStart = now;
    fpsFrames = 0;
  }

  schedule();
}

function schedule() {
  if (timer !== null || !running()) return;
  timer = setTimeout(tick, Math.max(0, nextFrameAt - performance.now()));
}

function start() {
  nextFrameAt = performance.now();
  fpsWindowStart = nextFrameAt;
  fpsFrames = 0;
  postAudio({ type: "flush" });
  schedule();
}

function handle(message: ToWorker) {
  switch (message.type) {
    case "init": {
      core = new JsnesCore({ sampleRate: message.sampleRate });
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
      if (paused && timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (!paused) start();
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

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  try {
    handle(event.data);
  } catch (error) {
    post({ type: "error", message: (error as Error).message });
  }
};
