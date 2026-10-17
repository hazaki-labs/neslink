import init, { Nes } from "@neslink/nes-wasm";
import {
  MAX_PLAYERS,
  NES_HEIGHT,
  NES_WIDTH,
  type EmulatorCore,
  type EmulatorCoreOptions,
} from "./types";

const FRAME_BYTES = NES_WIDTH * NES_HEIGHT * 4;

/** EmulatorCore backed by tetanes-core compiled to WebAssembly (packages/nes-wasm). */
export class WasmCore implements EmulatorCore {
  private constructor(
    private readonly nes: Nes,
    private readonly memory: WebAssembly.Memory,
  ) {}

  static async create(options: EmulatorCoreOptions): Promise<WasmCore> {
    const { memory } = await init();
    return new WasmCore(new Nes(options.sampleRate), memory);
  }

  loadRom(rom: Uint8Array): void {
    this.nes.loadRom("rom.nes", rom);
  }

  reset(): void {
    this.nes.reset();
  }

  runFrame(inputs: readonly number[]): void {
    this.nes.runFrame(inputs[0] ?? 0, MAX_PLAYERS > 1 ? (inputs[1] ?? 0) : 0);
  }

  saveState(): Uint8Array {
    const length = this.nes.saveState();
    // Copy out: the caller keeps or transfers it, and wasm memory may move.
    return new Uint8Array(this.memory.buffer, this.nes.statePtr(), length).slice();
  }

  loadState(state: Uint8Array): void {
    this.nes.loadState(state);
  }

  framebuffer(): Uint8ClampedArray<ArrayBuffer> {
    // Recreated each call because memory.buffer is replaced when wasm memory grows.
    return new Uint8ClampedArray(this.memory.buffer as ArrayBuffer, this.nes.framePtr(), FRAME_BYTES);
  }

  drainAudio(): Float32Array<ArrayBuffer> {
    const count = this.nes.drainAudio();
    const view = new Float32Array(this.memory.buffer as ArrayBuffer, this.nes.audioPtr(), count);
    return view.slice();
  }
}
