/**
 * Cheat codes. Every kind becomes the same thing: a read patch, where reads
 * of `addr` return `data` (only when the byte there equals `compare`, if set).
 * The core applies patches between the CPU and memory, as a Game Genie does,
 * so a RAM value holds against the game instead of flickering.
 *
 * Accepted, case-insensitive, several joined with `+`, `,` or spaces:
 * - Game Genie: 6 or 8 letters of APZLGITYEOXUKSVN (8 adds a compare byte).
 * - Raw: `AAAA:VV` or `AAAA:VV:CC`, hex address, value and compare.
 * - Pro Action Replay: 8 hex digits `00AAAAVV`.
 */

export interface CheatPatch {
  addr: number;
  data: number;
  compare: number | null;
}

/** A cheat as the player keeps it, per ROM. */
export interface Cheat {
  code: string;
  name: string;
  enabled: boolean;
}

const GENIE_LETTERS = "APZLGITYEOXUKSVN";

/** Decode one 6- or 8-letter Game Genie code, or null if it is not one. */
export function decodeGameGenie(code: string): CheatPatch | null {
  const upper = code.toUpperCase();
  if (upper.length !== 6 && upper.length !== 8) return null;
  const n = [...upper].map((c) => GENIE_LETTERS.indexOf(c));
  if (n.some((v) => v < 0)) return null;
  const addr =
    0x8000 |
    ((n[3] & 7) << 12) |
    ((n[5] & 7) << 8) |
    ((n[4] & 8) << 8) |
    ((n[2] & 7) << 4) |
    ((n[1] & 8) << 4) |
    (n[4] & 7) |
    (n[3] & 8);
  if (upper.length === 6) {
    const data = ((n[1] & 7) << 4) | ((n[0] & 8) << 4) | (n[0] & 7) | (n[5] & 8);
    return { addr, data, compare: null };
  }
  const data = ((n[1] & 7) << 4) | ((n[0] & 8) << 4) | (n[0] & 7) | (n[7] & 8);
  const compare = ((n[7] & 7) << 4) | ((n[6] & 8) << 4) | (n[6] & 7) | (n[5] & 8);
  return { addr, data, compare };
}

const RAW = /^([0-9A-F]{1,4}):([0-9A-F]{1,2})(?::([0-9A-F]{1,2}))?$/;
const PRO_ACTION_REPLAY = /^00([0-9A-F]{4})([0-9A-F]{2})$/;

/** Decode one code of any accepted kind, or null if it is none of them. */
export function decodeCheatPart(part: string): CheatPatch | null {
  const upper = part.toUpperCase();
  const raw = RAW.exec(upper);
  if (raw) {
    return { addr: parseInt(raw[1], 16), data: parseInt(raw[2], 16), compare: raw[3] ? parseInt(raw[3], 16) : null };
  }
  const par = PRO_ACTION_REPLAY.exec(upper);
  if (par) return { addr: parseInt(par[1], 16), data: parseInt(par[2], 16), compare: null };
  return decodeGameGenie(upper);
}

/** Split a cheat into its codes, normalized (upper case). */
export function cheatParts(code: string): string[] {
  return code
    .split(/[\s+,]+/)
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

/** Every patch a cheat makes, or null if any of its codes is invalid (or it has none). */
export function parseCheat(code: string): CheatPatch[] | null {
  const parts = cheatParts(code);
  if (parts.length === 0) return null;
  const patches: CheatPatch[] = [];
  for (const part of parts) {
    const patch = decodeCheatPart(part);
    if (!patch) return null;
    patches.push(patch);
  }
  return patches;
}

/** A cheat in one canonical spelling, so the same codes compare equal. */
export function normalizeCheat(code: string): string {
  return cheatParts(code).join("+");
}

/**
 * The patches for a list of enabled cheat codes, in order; a later patch at
 * the same address replaces an earlier one. Invalid codes are skipped.
 */
export function cheatPatches(codes: readonly string[]): CheatPatch[] {
  return codes.flatMap((code) => parseCheat(code) ?? []);
}
