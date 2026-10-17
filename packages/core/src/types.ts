export const NES_WIDTH = 256;
export const NES_HEIGHT = 240;
/** NTSC NES frame rate. */
export const NES_FRAME_RATE = 60.0988;

/**
 * Controller state for one pad as an 8-bit mask, in the order the NES
 * shift register reports buttons. Netplay will send these bytes per frame.
 */
export const Button = {
  A: 1 << 0,
  B: 1 << 1,
  Select: 1 << 2,
  Start: 1 << 3,
  Up: 1 << 4,
  Down: 1 << 5,
  Left: 1 << 6,
  Right: 1 << 7,
} as const;
export type ButtonName = keyof typeof Button;
export const BUTTON_NAMES = Object.keys(Button) as ButtonName[];

/** Controller ports supported by the current core. */
export const MAX_PLAYERS = 2;

export interface EmulatorCoreOptions {
  sampleRate: number;
}

/**
 * The surface every emulator core must provide. It is deliberately
 * deterministic: the same ROM, state and input sequence must yield the same
 * output on every machine, which the rollback netcode relies on.
 */
export interface EmulatorCore {
  loadRom(rom: Uint8Array): void;
  reset(): void;
  /** Advance exactly one frame with the given per-port button masks. */
  runFrame(inputs: readonly number[]): void;
  saveState(): Uint8Array;
  loadState(state: Uint8Array): void;
  /** RGBA pixels (NES_WIDTH x NES_HEIGHT) of the last finished frame. */
  framebuffer(): Uint8ClampedArray<ArrayBuffer>;
  /** Interleaved stereo samples produced since the last call. */
  drainAudio(): Float32Array<ArrayBuffer>;
}
