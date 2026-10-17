import { NES, type ButtonKey, type ControllerId, type EmulatorData } from "jsnes";
import {
  MAX_PLAYERS,
  NES_HEIGHT,
  NES_WIDTH,
  type EmulatorCore,
  type EmulatorCoreOptions,
} from "./types";

const STATE_FORMAT = "neslink/jsnes@1";

interface SerializedState {
  format: string;
  data: EmulatorData;
}

/** EmulatorCore backed by jsnes. Good enough for M0; swap for a WASM core later. */
export class JsnesCore implements EmulatorCore {
  private readonly nes: NES;
  private readonly pixels = new Uint8ClampedArray(NES_WIDTH * NES_HEIGHT * 4);
  private readonly pixels32 = new Uint32Array(this.pixels.buffer);
  private audio = new Float32Array(4096);
  private audioLength = 0;
  private readonly pressed = new Array<number>(MAX_PLAYERS).fill(0);
  private romLoaded = false;

  constructor(options: EmulatorCoreOptions) {
    this.pixels32.fill(0xff000000);
    this.nes = new NES({
      sampleRate: options.sampleRate,
      emulateSound: true,
      onFrame: (buffer) => {
        // jsnes emits 0xBBGGRR; on little-endian that is RGBA once alpha is set.
        for (let i = 0; i < buffer.length; i++) {
          this.pixels32[i] = 0xff000000 | buffer[i];
        }
      },
      onAudioSample: (left, right) => this.pushSample(left, right),
    });
  }

  loadRom(rom: Uint8Array): void {
    this.nes.loadROM(rom);
    this.romLoaded = true;
    this.pressed.fill(0);
    this.audioLength = 0;
  }

  reset(): void {
    this.nes.reloadROM();
    this.pressed.fill(0);
  }

  runFrame(inputs: readonly number[]): void {
    if (!this.romLoaded) return;
    for (let port = 0; port < MAX_PLAYERS; port++) {
      this.applyInput(port, inputs[port] ?? 0);
    }
    this.nes.frame();
  }

  saveState(): Uint8Array {
    const state: SerializedState = { format: STATE_FORMAT, data: this.nes.toJSON() };
    return new TextEncoder().encode(JSON.stringify(state));
  }

  loadState(bytes: Uint8Array): void {
    const state = JSON.parse(new TextDecoder().decode(bytes)) as SerializedState;
    if (state.format !== STATE_FORMAT) {
      throw new Error(`Unsupported save state format: ${state.format}`);
    }
    this.nes.fromJSON(state.data);
    // fromJSON restores controller state; force a full re-sync on the next frame.
    this.pressed.fill(-1);
  }

  framebuffer(): Uint8ClampedArray<ArrayBuffer> {
    return this.pixels;
  }

  drainAudio(): Float32Array<ArrayBuffer> {
    const out = this.audio.slice(0, this.audioLength);
    this.audioLength = 0;
    return out;
  }

  private applyInput(port: number, mask: number): void {
    const previous = this.pressed[port];
    if (previous === mask) return;
    const controller = (port + 1) as ControllerId;
    for (let bit = 0; bit < 8; bit++) {
      const down = (mask >> bit) & 1;
      if (previous !== -1 && down === ((previous >> bit) & 1)) continue;
      // Button bit order matches jsnes button ids 0-7.
      if (down) this.nes.buttonDown(controller, bit as ButtonKey);
      else this.nes.buttonUp(controller, bit as ButtonKey);
    }
    this.pressed[port] = mask;
  }

  private pushSample(left: number, right: number): void {
    if (this.audioLength + 2 > this.audio.length) {
      const grown = new Float32Array(this.audio.length * 2);
      grown.set(this.audio);
      this.audio = grown;
    }
    this.audio[this.audioLength++] = left;
    this.audio[this.audioLength++] = right;
  }
}
