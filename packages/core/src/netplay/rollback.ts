import { NETPLAY_EVENTS, NETPLAY_SEATS } from "./protocol";

/** What a rollback session drives: the emulator, through save slots it owns. */
export interface RollbackHost {
  /** Save the current state (before running a frame) into `slot`. */
  save(slot: number): void;
  /** Restore the state saved in `slot`. */
  load(slot: number): void;
  /** Run `frame`. `replay` marks a re-simulation of a frame already shown: skip its audio. */
  run(inputs: readonly number[], replay: boolean, frame: number): void;
  /** Hash of the state right after a run, for desync checks across machines. */
  hash(): number;
}

/** Most frames the session will run past the last fully confirmed one. */
export const MAX_ROLLBACK = 8;
/** Slots needed: one per speculative frame, plus the confirmed one before them. */
export const ROLLBACK_SLOTS = MAX_ROLLBACK + 2;

/** Frames of advantage over the other player before we start yielding. */
const YIELD_THRESHOLD = 1;
/** Frames between two yields, so slowing down stays imperceptible. */
const YIELD_SPACING = 15;

export interface RollbackStats {
  rollbacks: number;
  replayedFrames: number;
}

/**
 * Rollback netplay for a seated player (GGPO style).
 *
 * Local input still takes effect `delay` frames after it is pressed (a small
 * delay hides most of the network trip), but the session never waits for the
 * other player's input: it predicts it (repeating their last known input),
 * runs on, and when the real input arrives and differs, it reloads the state
 * from before that frame and re-simulates up to the present. The player only
 * waits when the other side falls more than `window` frames behind.
 *
 * Frames whose inputs are all confirmed are final: `onFinal` reports them in
 * order with their state hash, and only they are used for desync checks and
 * spectator snapshots.
 */
export class RollbackSession {
  readonly spectating = false;
  /** How far past the last confirmed frame we may speculate (shrinks on slow devices). */
  window = MAX_ROLLBACK;
  onFinal: ((frame: number, hash: number) => void) | null = null;

  private next = 0;
  /** seat -> frame -> confirmed mask. */
  private readonly confirmed = new Map<number, Map<number, number>>();
  /** seat -> newest frame up to which every input is confirmed. */
  private readonly contiguous = new Map<number, number>();
  /** seat -> newest frame any input has arrived for (to estimate their progress). */
  private readonly newest = new Map<number, number>();
  /** frame -> inputs it last ran with, for frames not yet final. */
  private readonly used = new Map<number, number[]>();
  private readonly hashes = new Array<number>(ROLLBACK_SLOTS).fill(0);
  private finalized = 0;
  private rollbackFrom: number | null = null;
  /** Where local play picks up after a resume (see `resume`). */
  private resumeAt = 0;
  private remoteAdvantage = 0;
  private sinceYield = 0;
  private readonly stats: RollbackStats = { rollbacks: 0, replayedFrames: 0 };

  /**
   * `startFrame` > 0 resumes a game in progress from a snapshot taken before
   * that frame: `seed` the room's logged inputs, then `resume()` and `catchUp()`.
   */
  constructor(
    readonly activeSeats: readonly number[],
    readonly localSeat: number,
    readonly delay: number,
    private readonly host: RollbackHost,
    startFrame = 0,
  ) {
    if (!activeSeats.includes(localSeat)) throw new Error(`Local seat ${localSeat} is not active`);
    this.next = startFrame;
    this.finalized = startFrame;
    this.resumeAt = startFrame;
    for (const seat of activeSeats) {
      const inputs = new Map<number, number>();
      // Nobody has input for the first `delay` frames of a game from power-on.
      const implicit = startFrame === 0 ? delay : 0;
      for (let frame = 0; frame < implicit; frame++) inputs.set(frame, 0);
      this.confirmed.set(seat, inputs);
      this.contiguous.set(seat, startFrame + implicit - 1);
      this.newest.set(seat, startFrame + implicit - 1);
    }
  }

  /** The next frame to run. */
  get frame(): number {
    return this.next;
  }

  /** First frame whose inputs are not all confirmed yet. */
  get confirmedFrame(): number {
    return Math.min(...this.contiguous.values()) + 1;
  }

  /** Newest frame up to which every input of `seat` has arrived (an ack for direct links). */
  receivedThrough(seat: number): number {
    return this.contiguous.get(seat) ?? -1;
  }

  /** Record a remote seat's input. If it contradicts a prediction already run, a rollback is due. */
  receive(seat: number, frame: number, mask: number): void {
    if (seat === this.localSeat) return;
    const inputs = this.confirmed.get(seat);
    if (!inputs || inputs.has(frame) || frame <= this.contiguous.get(seat)!) return;
    inputs.set(frame, mask);
    this.newest.set(seat, Math.max(this.newest.get(seat)!, frame));
    let contiguous = this.contiguous.get(seat)!;
    while (inputs.has(contiguous + 1)) contiguous++;
    this.contiguous.set(seat, contiguous);

    const ran = this.used.get(frame);
    if (ran && ran[seat] !== mask) {
      this.rollbackFrom = this.rollbackFrom === null ? frame : Math.min(this.rollbackFrom, frame);
    }
  }

  /**
   * Record an input logged by the room for any seat, ours included: used when
   * rejoining a game, before `resume()`. Frames already run are ignored.
   */
  seed(seat: number, frame: number, mask: number): void {
    const inputs = this.confirmed.get(seat);
    if (!inputs || frame < this.next || inputs.has(frame) || frame <= this.contiguous.get(seat)!) return;
    inputs.set(frame, mask);
    this.newest.set(seat, Math.max(this.newest.get(seat)!, frame));
    let contiguous = this.contiguous.get(seat)!;
    while (inputs.has(contiguous + 1)) contiguous++;
    this.contiguous.set(seat, contiguous);
  }

  /**
   * After seeding a rejoin: pick up right after our last input the room has,
   * so nothing we already sent changes. Inputs of ours the others never got
   * (the gap before that point) become neutral; they are returned, frame and
   * mask, for the caller to send. A fresh game returns nothing.
   */
  resume(): [frame: number, mask: number][] {
    const own = this.contiguous.get(this.localSeat)!;
    this.resumeAt = Math.max(this.next, own + 1 - this.delay);
    const filled: [number, number][] = [];
    const inputs = this.confirmed.get(this.localSeat)!;
    for (let frame = own + 1; frame < this.resumeAt + this.delay; frame++) {
      inputs.set(frame, 0);
      filled.push([frame, 0]);
    }
    if (filled.length > 0) {
      this.contiguous.set(this.localSeat, this.resumeAt + this.delay - 1);
      this.newest.set(this.localSeat, Math.max(this.newest.get(this.localSeat)!, this.resumeAt + this.delay - 1));
    }
    return filled;
  }

  /**
   * Silently run every frame up to the resume point whose inputs are all known
   * (catching up a rejoin). Returns frames run; stops early at a gap in the
   * others' inputs, which normal play then predicts as usual.
   */
  catchUp(): number {
    let ran = 0;
    while (this.next < this.resumeAt && [...this.confirmed.values()].every((inputs) => inputs.has(this.next))) {
      this.runFrame(this.next, true);
      this.next++;
      ran++;
    }
    this.finalize();
    return ran;
  }

  /** The other player's view of how far ahead of us they are, for time sync. */
  receiveAdvantage(advantage: number): void {
    this.remoteAdvantage = advantage;
  }

  /**
   * How many frames we run ahead of the other player: our frame minus the frame
   * they were on when they sent their newest input.
   */
  localAdvantage(): number {
    let behind = Infinity;
    for (const [seat, newest] of this.newest) {
      if (seat !== this.localSeat) behind = Math.min(behind, newest - this.delay + 1);
    }
    return behind === Infinity ? 0 : this.next - behind;
  }

  /**
   * Whether to skip one frame to let the other player catch up. Both sides
   * measure their advantage including network delay; half the difference is
   * how far ahead we really are.
   */
  shouldYield(): boolean {
    this.sinceYield++;
    if (this.sinceYield < YIELD_SPACING) return false;
    if ((this.localAdvantage() - this.remoteAdvantage) / 2 < YIELD_THRESHOLD) return false;
    this.sinceYield = 0;
    return true;
  }

  /** Re-simulate from the earliest mispredicted frame, if any. Returns frames replayed. */
  resolve(): number {
    let replayed = 0;
    if (this.rollbackFrom !== null) {
      const from = this.rollbackFrom;
      this.rollbackFrom = null;
      this.host.load(from % ROLLBACK_SLOTS);
      for (let frame = from; frame < this.next; frame++) {
        this.runFrame(frame, true);
        replayed++;
      }
      this.stats.rollbacks++;
      this.stats.replayedFrames += replayed;
    }
    this.finalize();
    return replayed;
  }

  /** Whether the next frame may run without speculating past the window. */
  canAdvance(): boolean {
    return this.next - this.confirmedFrame < this.window;
  }

  /**
   * Run the next frame with the local input pressed now. Call `resolve()`
   * first and only when `canAdvance()`. Returns the frame the local input was
   * scheduled for, to send it, or null when that frame's input was already
   * settled (just after a rejoin).
   */
  advance(localMask: number): number | null {
    if (this.rollbackFrom !== null) throw new Error("Resolve the pending rollback first");
    if (!this.canAdvance()) throw new Error(`Frame ${this.next} is past the rollback window`);
    let localFrame: number | null = this.next + this.delay;
    const local = this.confirmed.get(this.localSeat)!;
    if (local.has(localFrame)) {
      localFrame = null;
    } else {
      local.set(localFrame, localMask);
      this.contiguous.set(this.localSeat, localFrame);
      this.newest.set(this.localSeat, localFrame);
    }
    this.runFrame(this.next, false);
    this.next++;
    this.finalize();
    return localFrame;
  }

  /** Slot holding the state just before `frame` (still ringed), or null if that is the current state. */
  slotBefore(frame: number): number | null {
    if (frame === this.next) return null;
    if (frame > this.next || frame < this.next - ROLLBACK_SLOTS + 1) throw new Error(`No state kept for frame ${frame}`);
    return frame % ROLLBACK_SLOTS;
  }

  /** Counters since the last call. */
  takeStats(): RollbackStats {
    const stats = { ...this.stats };
    this.stats.rollbacks = 0;
    this.stats.replayedFrames = 0;
    return stats;
  }

  private runFrame(frame: number, replay: boolean) {
    this.host.save(frame % ROLLBACK_SLOTS);
    const inputs = this.inputsFor(frame);
    this.used.set(frame, inputs);
    this.host.run(inputs, replay, frame);
    this.hashes[frame % ROLLBACK_SLOTS] = this.host.hash();
  }

  private inputsFor(frame: number): number[] {
    const inputs = new Array<number>(NETPLAY_SEATS).fill(0);
    for (const [seat, confirmed] of this.confirmed) {
      // Unknown remote input: assume they still hold what they last held,
      // but never repeat a reset or a load: those happen once, on the frame they were sent for.
      inputs[seat] = confirmed.get(frame) ?? (confirmed.get(Math.min(frame, this.contiguous.get(seat)!)) ?? 0) & ~NETPLAY_EVENTS;
    }
    return inputs;
  }

  /** Report frames that became final, in order, and drop bookkeeping for them. */
  private finalize() {
    const confirmed = this.confirmedFrame;
    while (this.finalized < confirmed && this.finalized < this.next) {
      const frame = this.finalized++;
      this.onFinal?.(frame, this.hashes[frame % ROLLBACK_SLOTS]);
      this.used.delete(frame);
      for (const [seat, inputs] of this.confirmed) {
        // Keep the newest confirmed input per seat: predictions repeat it.
        if (frame < this.contiguous.get(seat)!) inputs.delete(frame);
      }
    }
  }
}
