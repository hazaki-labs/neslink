/**
 * Input bookkeeping for delay-based lockstep: every machine runs frame N only
 * once it holds every seat's input for frame N, so all machines feed the
 * (deterministic) core identical inputs.
 *
 * Local input pressed while running frame N is scheduled for frame N + delay
 * and sent to the others right away, which gives it `delay` frames to arrive
 * before anyone needs it. The first `delay` frames have no input.
 */
export class LockstepSession {
  private readonly pending: Map<number, number>[];
  private next = 0;

  constructor(
    readonly seats: number,
    readonly localSeat: number,
    readonly delay: number,
  ) {
    this.pending = Array.from({ length: seats }, () => new Map<number, number>());
    for (const inputs of this.pending) {
      for (let frame = 0; frame < delay; frame++) inputs.set(frame, 0);
    }
  }

  /** The next frame to run. */
  get frame(): number {
    return this.next;
  }

  /** Whether every seat's input for the next frame has arrived. */
  ready(): boolean {
    return this.pending.every((inputs) => inputs.has(this.next));
  }

  /** Seats whose input for the next frame is still missing. */
  waitingOn(): number[] {
    return this.pending.flatMap((inputs, seat) => (inputs.has(this.next) ? [] : [seat]));
  }

  /**
   * Record a remote seat's input. Duplicates and frames already run are
   * ignored, so a resend can never change history.
   */
  receive(seat: number, frame: number, mask: number): void {
    if (seat < 0 || seat >= this.seats || seat === this.localSeat || frame < this.next) return;
    const inputs = this.pending[seat];
    if (!inputs.has(frame)) inputs.set(frame, mask);
  }

  /**
   * Take the inputs for the next frame and schedule the local input that
   * goes with it. Call only when `ready()`. Returns the per-seat masks to run
   * now, plus the frame the local input was scheduled for (to send it).
   */
  advance(localMask: number): { inputs: number[]; localFrame: number } {
    if (!this.ready()) throw new Error(`Inputs for frame ${this.next} are incomplete`);
    const inputs = this.pending.map((pending) => {
      const mask = pending.get(this.next)!;
      pending.delete(this.next);
      return mask;
    });
    const localFrame = this.next + this.delay;
    this.pending[this.localSeat].set(localFrame, localMask);
    this.next++;
    return { inputs, localFrame };
  }
}
