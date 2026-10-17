/** Messages between the UI thread and the emulator worker. */

export type ToWorker =
  | {
      type: "init";
      canvas: OffscreenCanvas;
      sampleRate: number;
      /** Port connected to the AudioWorklet; samples are posted straight to it. */
      audioPort: MessagePort | null;
    }
  | { type: "loadRom"; rom: Uint8Array<ArrayBuffer> }
  | { type: "input"; port: number; mask: number }
  | { type: "pause"; paused: boolean }
  | { type: "reset" }
  | { type: "saveState"; requestId: number }
  | { type: "loadState"; state: Uint8Array<ArrayBuffer> };

export type FromWorker =
  | { type: "ready" }
  | { type: "romLoaded" }
  | { type: "stats"; fps: number; frame: number }
  | { type: "state"; requestId: number; state: Uint8Array<ArrayBuffer> }
  | { type: "error"; message: string };

/** Messages from the worker to the AudioWorklet. */
export type ToAudio = { type: "samples"; samples: Float32Array<ArrayBuffer> } | { type: "flush" };
