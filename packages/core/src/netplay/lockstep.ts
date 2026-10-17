import { NETPLAY_SEATS } from "./protocol";

/**
 * Input bookkeeping for delay-based lockstep: every machine runs frame N only
 * once it holds every active seat's input for frame N, so all machines feed
 * the (deterministic) core identical inputs.
 *
 * Local input pressed while running frame N is scheduled for frame N + delay
 * and sent to the others right away, which gives it `delay` frames to arrive
 * before anyone needs it. A game started from power-on has no input for its
 * first `delay` frames. Seats nobody sits in always read 0.
 *
 * A spectator (`localSeat` null) only consumes inputs. It may start from a
 * snapshot at `startFrame`, fed with every input from that frame on.
 */
export class LockstepSession {
  private readonly pending = new Map<number, Map<number, number>>();
  private next: number;

  constructor(
    readonly activeSeats: readonly number[],
    readonly localSeat: number | null,
    readonly delay: number,
    startFrame = 0,
  ) {
    if (localSeat !== null && !activeSeats.includes(localSeat)) {
      throw new Error(`Local seat ${localSeat} is not active`);
    }
    this.next = startFrame;
    for (const seat of activeSeats) {
      const inputs = new Map<number, number>();
      if (startFrame === 0) for (let frame = 0; frame < delay; frame++) inputs.set(frame, 0);
      this.pending.set(seat, inputs);
    }
  }

  /** The next frame to run. */
  get frame(): number {
    return this.next;
  }

  get spectating(): boolean {
    return this.localSeat === null;
  }

  /** Whether every active seat's input for the next frame has arrived. */
  ready(): boolean {
    return this.available(1) === 1;
  }

  /** How many consecutive frames from the next one could run now (at most `limit`). */
  available(limit = Infinity): number {
    let count = 0;
    while (count < limit) {
      const frame = this.next + count;
      for (const inputs of this.pending.values()) if (!inputs.has(frame)) return count;
      count++;
    }
    return count;
  }

  /** Active seats whose input for the next frame is still missing. */
  waitingOn(): number[] {
    return [...this.pending].flatMap(([seat, inputs]) => (inputs.has(this.next) ? [] : [seat]));
  }

  /**
   * Record a remote seat's input. Duplicates, inactive seats and frames
   * already run are ignored, so a resend can never change history.
   */
  receive(seat: number, frame: number, mask: number): void {
    if (seat === this.localSeat || frame < this.next) return;
    const inputs = this.pending.get(seat);
    if (inputs && !inputs.has(frame)) inputs.set(frame, mask);
  }

  /**
   * Take the inputs for the next frame and, for a player, schedule the local
   * input that goes with it. Call only when `ready()`. Returns the per-port
   * masks to run now, plus the frame the local input was scheduled for (to
   * send it), or null for a spectator.
   */
  advance(localMask = 0): { inputs: number[]; localFrame: number | null } {
    if (!this.ready()) throw new Error(`Inputs for frame ${this.next} are incomplete`);
    const inputs = new Array<number>(NETPLAY_SEATS).fill(0);
    for (const [seat, pending] of this.pending) {
      inputs[seat] = pending.get(this.next)!;
      pending.delete(this.next);
    }
    let localFrame: number | null = null;
    if (this.localSeat !== null) {
      localFrame = this.next + this.delay;
      this.pending.get(this.localSeat)!.set(localFrame, localMask);
    }
    this.next++;
    return { inputs, localFrame };
  }
}
