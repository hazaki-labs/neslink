/** Fraction by which the refresh rate may miss a whole multiple of the NES rate and still lock. */
const LOCK_TOLERANCE = 0.02;
/** Deltas longer than this are stalls (tab hidden, debugger), not refreshes. */
const MAX_REFRESH_MS = 50;
const SAMPLES = 32;
const MIN_SAMPLES = 8;

/**
 * Decides how many emulated frames to run on each display refresh.
 *
 * When the display runs at (close to) a whole multiple of the NES frame rate,
 * e.g. 60Hz or 120Hz, it locks to one frame every n refreshes so every frame is
 * shown for the same number of refreshes. That runs the emulator a hair off
 * its native 60.0988Hz; the audio player absorbs the difference. Other rates
 * (144Hz, 75Hz, ...) fall back to accumulating wall-clock time.
 */
export class FramePacer {
  private last: number | null = null;
  private deltas: number[] = [];
  private refreshAcc = 0;
  private timeAcc = 0;

  constructor(
    private readonly frameMs: number,
    /** False when ticks are not display refreshes (setTimeout fallback). */
    private readonly lockable: boolean,
    private readonly maxCatchUp = 4,
  ) {}

  reset(): void {
    this.last = null;
    this.deltas = [];
    this.refreshAcc = 0;
    this.timeAcc = 0;
  }

  /** Median refresh interval, once enough refreshes have been seen. */
  refreshMs(): number | null {
    if (this.deltas.length < MIN_SAMPLES) return null;
    const sorted = [...this.deltas].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }

  /** Refreshes per emulated frame while locked, else null. */
  lockedInterval(): number | null {
    const period = this.lockable ? this.refreshMs() : null;
    if (period === null) return null;
    const ratio = this.frameMs / period;
    const n = Math.round(ratio);
    return n >= 1 && Math.abs(ratio - n) / n < LOCK_TOLERANCE ? n : null;
  }

  /** Call on every refresh (or timer tick); returns how many frames to emulate now. */
  advance(now: number): number {
    if (this.last === null) {
      this.last = now;
      return 1;
    }
    const delta = now - this.last;
    this.last = now;
    if (delta <= 0) return 0;
    if (delta < MAX_REFRESH_MS) {
      this.deltas.push(delta);
      if (this.deltas.length > SAMPLES) this.deltas.shift();
    }

    let frames: number;
    const n = this.lockedInterval();
    if (n !== null) {
      // Count refreshes, not milliseconds, so timestamp jitter cannot cause judder.
      this.refreshAcc += Math.max(1, Math.round(delta / this.refreshMs()!));
      frames = Math.floor(this.refreshAcc / n);
      this.refreshAcc -= frames * n;
      this.timeAcc = 0;
    } else {
      this.timeAcc += delta;
      frames = Math.floor(this.timeAcc / this.frameMs);
      this.timeAcc -= frames * this.frameMs;
      this.refreshAcc = 0;
    }

    if (frames > this.maxCatchUp) {
      // Coming back from a stall: resume instead of fast-forwarding through it.
      this.refreshAcc = 0;
      this.timeAcc = 0;
      return 1;
    }
    return frames;
  }
}
