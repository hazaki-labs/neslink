import {
  NES_HEIGHT,
  NES_WIDTH,
  type FromWorker,
  type ToWorker,
} from "@neslink/core";

export type EmulatorStats = Omit<Extract<FromWorker, { type: "stats" }>, "type">;
/** Netplay events from the worker (room updates, start/end, desync, errors). */
export type NetEvent = Extract<FromWorker, { type: `net${string}` }>;

export interface EmulatorEvents {
  onReady?: () => void;
  onRomLoaded?: () => void;
  onStats?: (stats: EmulatorStats) => void;
  onError?: (message: string) => void;
  onNet?: (event: NetEvent) => void;
}

/**
 * UI-thread handle to the emulator worker. Owns the canvas (transferred to
 * the worker as an OffscreenCanvas) and the AudioWorklet output.
 */
export class EmulatorClient {
  readonly canvas: HTMLCanvasElement;
  private readonly worker: Worker;
  private readonly audio: AudioContext;
  private readonly pending = new Map<number, (state: Uint8Array<ArrayBuffer>) => void>();
  private nextRequestId = 1;
  private destroyed = false;

  constructor(private readonly events: EmulatorEvents = {}) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = NES_WIDTH;
    this.canvas.height = NES_HEIGHT;

    this.worker = new Worker(new URL("./emulator.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.onMessage(event.data);
    this.worker.onerror = (event) => {
      if (!this.destroyed) this.events.onError?.(event.message || "Worker crashed");
    };

    this.audio = new AudioContext({ latencyHint: "interactive" });
    const channel = new MessageChannel();
    void this.connectAudio(channel.port1);

    document.addEventListener("visibilitychange", this.onVisibility);

    const offscreen = this.canvas.transferControlToOffscreen();
    this.send(
      { type: "init", canvas: offscreen, sampleRate: this.audio.sampleRate, audioPort: channel.port2 },
      [offscreen, channel.port2],
    );
  }

  /** Must be called from a user gesture at least once for sound to play. */
  resumeAudio(): void {
    if (this.audio.state === "suspended") void this.audio.resume();
  }

  /** With `autostart: false` the cartridge waits until a netplay room starts it. */
  loadRom(rom: Uint8Array<ArrayBuffer>, autostart = true): void {
    // Copy so the caller's buffer survives the transfer.
    const copy = rom.slice();
    this.send({ type: "loadRom", rom: copy, autostart }, [copy.buffer]);
  }

  joinRoom(url: string, name: string, romHash: string): void {
    this.send({ type: "netJoin", url, name, romHash });
  }

  startRoom(): void {
    this.send({ type: "netStart" });
  }

  /** Sit in `seat`, or stand up to spectate with null. */
  takeSeat(seat: number | null): void {
    this.send({ type: "netSeat", seat });
  }

  leaveRoom(): void {
    this.send({ type: "netLeave" });
  }

  setInput(port: number, mask: number): void {
    this.send({ type: "input", port, mask });
  }

  setPaused(paused: boolean): void {
    this.send({ type: "pause", paused });
    if (paused) void this.audio.suspend();
    else this.resumeAudio();
  }

  reset(): void {
    this.send({ type: "reset" });
  }

  saveState(): Promise<Uint8Array<ArrayBuffer>> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.send({ type: "saveState", requestId });
    });
  }

  loadState(state: Uint8Array<ArrayBuffer>): void {
    const copy = state.slice();
    this.send({ type: "loadState", state: copy }, [copy.buffer]);
  }

  destroy(): void {
    this.destroyed = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.worker.terminate();
    void this.audio.close();
    this.pending.clear();
  }

  private async connectAudio(port: MessagePort) {
    try {
      await this.audio.audioWorklet.addModule("/audio-worklet.js");
      if (this.destroyed) return;
      const node = new AudioWorkletNode(this.audio, "nes-audio", {
        numberOfInputs: 0,
        outputChannelCount: [2],
      });
      node.port.postMessage({ type: "port", port }, [port]);
      node.connect(this.audio.destination);
    } catch (error) {
      // destroy() closes the context, which rejects a pending addModule.
      if (!this.destroyed) this.events.onError?.(`Audio unavailable: ${(error as Error).message}`);
    }
  }

  private readonly onVisibility = () => {
    this.send({ type: "visibility", hidden: document.hidden });
  };

  private send(message: ToWorker, transfer: Transferable[] = []) {
    if (!this.destroyed) this.worker.postMessage(message, transfer);
  }

  private onMessage(message: FromWorker) {
    switch (message.type) {
      case "ready":
        this.events.onReady?.();
        break;
      case "romLoaded":
        this.events.onRomLoaded?.();
        break;
      case "stats":
        this.events.onStats?.(message);
        break;
      case "state":
        this.pending.get(message.requestId)?.(message.state);
        this.pending.delete(message.requestId);
        break;
      case "error":
        this.events.onError?.(message.message);
        break;
      default:
        this.events.onNet?.(message);
    }
  }
}
