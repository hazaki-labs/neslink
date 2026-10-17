import { describe, expect, it } from "vitest";
import { LockstepSession } from "./lockstep";

/** Two sessions wired together with a configurable message delay (in frames). */
function pair(delay: number) {
  const a = new LockstepSession(2, 0, delay);
  const b = new LockstepSession(2, 1, delay);
  return { a, b };
}

describe("LockstepSession", () => {
  it("runs the first `delay` frames without waiting", () => {
    const s = new LockstepSession(2, 0, 3);
    for (let i = 0; i < 3; i++) {
      expect(s.ready()).toBe(true);
      expect(s.advance(0).inputs).toEqual([0, 0]);
    }
    expect(s.ready()).toBe(false);
    expect(s.waitingOn()).toEqual([1]);
  });

  it("schedules local input `delay` frames ahead", () => {
    const s = new LockstepSession(2, 1, 2);
    expect(s.advance(0b1010).localFrame).toBe(2);
    expect(s.advance(0).localFrame).toBe(3);
    s.receive(0, 2, 0b1);
    expect(s.advance(0).inputs).toEqual([0b1, 0b1010]);
  });

  it("feeds both machines identical inputs", () => {
    const { a, b } = pair(3);
    const ranA: number[][] = [];
    const ranB: number[][] = [];
    const toB: [number, number][] = [];
    const toA: [number, number][] = [];
    // A runs ahead of B by up to the delay; messages arrive a frame late.
    for (let tick = 0; tick < 200; tick++) {
      for (const [f, m] of toA.splice(0)) a.receive(1, f, m);
      for (const [f, m] of toB.splice(0)) b.receive(0, f, m);
      if (a.ready()) {
        const { inputs, localFrame } = a.advance(tick % 7);
        ranA.push(inputs);
        toB.push([localFrame, tick % 7]);
      }
      if (tick % 3 !== 0 && b.ready()) {
        const { inputs, localFrame } = b.advance(tick % 5);
        ranB.push(inputs);
        toA.push([localFrame, tick % 5]);
      }
    }
    const n = Math.min(ranA.length, ranB.length);
    expect(n).toBeGreaterThan(100);
    expect(ranA.slice(0, n)).toEqual(ranB.slice(0, n));
  });

  it("ignores stale, duplicate and own-seat inputs", () => {
    const s = new LockstepSession(2, 0, 1);
    s.advance(0);
    s.receive(1, 0, 5); // already run
    s.receive(0, 1, 5); // our own seat
    s.receive(1, 1, 3);
    s.receive(1, 1, 9); // duplicate
    expect(s.advance(0).inputs).toEqual([0, 3]);
  });
});
