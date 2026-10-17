import { NES_FRAME_RATE } from "../types";
import { NETPLAY_INPUT_DELAY } from "./protocol";

export const MIN_INPUT_DELAY = 1;
export const MAX_INPUT_DELAY = 8;
/** Headroom for jitter: 10% of the trip plus a fixed few ms. */
const JITTER_FACTOR = 1.1;
const JITTER_MS = 8;

/**
 * Input delay (in frames) for a game, from each seated player's measured round
 * trip to the room server.
 *
 * An input travels sender -> server -> receiver, which takes about half of
 * each one's round trip. The delay must cover that trip, or the receiver
 * stalls waiting for it; any more than that is lag nobody needs. Players
 * without a measurement yet fall back to the fixed default; a player alone
 * needs no delay beyond the minimum.
 */
export function chooseInputDelay(rttsMs: readonly (number | null)[], frameMs = 1000 / NES_FRAME_RATE): number {
  // Alone, every input is local: nothing has to cross the network in time.
  if (rttsMs.length === 1) return MIN_INPUT_DELAY;
  if (rttsMs.length === 0 || rttsMs.some((rtt) => rtt === null || !Number.isFinite(rtt))) {
    return NETPLAY_INPUT_DELAY;
  }
  const halves = (rttsMs as number[]).map((rtt) => rtt / 2).sort((a, b) => b - a);
  // Worst case is the input between the two slowest links.
  const oneWayMs = halves[0] + (halves[1] ?? halves[0]);
  const frames = Math.ceil((oneWayMs * JITTER_FACTOR + JITTER_MS) / frameMs);
  return Math.min(MAX_INPUT_DELAY, Math.max(MIN_INPUT_DELAY, frames));
}

/** Most input delay rollback games use; past this, prediction does the rest. */
export const MAX_ROLLBACK_DELAY = 3;

/**
 * Input delay (in frames) for a rollback game. A small delay still hides part
 * of the trip, which keeps rollbacks short and rare; prediction covers the
 * rest, so this is about half of what lockstep would need.
 */
export function chooseRollbackDelay(rttsMs: readonly (number | null)[], frameMs?: number): number {
  if (rttsMs.length === 1) return MIN_INPUT_DELAY;
  const lockstep = chooseInputDelay(rttsMs, frameMs);
  return Math.min(MAX_ROLLBACK_DELAY, Math.max(MIN_INPUT_DELAY, Math.ceil(lockstep / 2)));
}
