/* tslint:disable */
/* eslint-disable */

export class Nes {
    free(): void;
    [Symbol.dispose](): void;
    audioPtr(): number;
    /**
     * Moves pending mono samples into an internal buffer; returns how many there are.
     * Read them from [`Nes::audio_ptr`] before the next call.
     */
    drainAudio(): number;
    /**
     * Renders the last frame as RGBA into an internal buffer and returns its address.
     */
    framePtr(): number;
    loadRom(name: string, rom: Uint8Array): void;
    /**
     * Restores rollback slot `slot`, saved earlier on this machine by [`Nes::save_slot`].
     */
    loadSlot(slot: number): void;
    loadState(state: Uint8Array): void;
    constructor(sample_rate: number);
    reset(): void;
    /**
     * Runs one frame. `p1`/`p2` are button masks in NES shift-register order.
     */
    runFrame(p1: number, p2: number): void;
    /**
     * Saves the console into rollback slot `slot` (slots grow as needed).
     */
    saveSlot(slot: number): void;
    /**
     * Serializes the console into an internal buffer; returns its length.
     * Read it from [`Nes::state_ptr`]. Uncompressed, so it is fast enough for rollback.
     */
    saveState(): number;
    statePtr(): number;
    /**
     * FNV-1a hash of the 2KB work RAM, for netplay desync checks. Unlike the full
     * save state it does not depend on the host audio sample rate.
     */
    wramHash(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_nes_free: (a: number, b: number) => void;
    readonly nes_audioPtr: (a: number) => number;
    readonly nes_drainAudio: (a: number) => number;
    readonly nes_framePtr: (a: number) => number;
    readonly nes_loadRom: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly nes_loadSlot: (a: number, b: number) => [number, number];
    readonly nes_loadState: (a: number, b: number, c: number) => [number, number];
    readonly nes_new: (a: number) => number;
    readonly nes_reset: (a: number) => void;
    readonly nes_runFrame: (a: number, b: number, c: number) => [number, number];
    readonly nes_saveSlot: (a: number, b: number) => [number, number];
    readonly nes_saveState: (a: number) => [number, number, number];
    readonly nes_statePtr: (a: number) => number;
    readonly nes_wramHash: (a: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
