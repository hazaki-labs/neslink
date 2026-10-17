import { describe, expect, it } from "vitest";
import { LockstepSession } from "./lockstep";

const BOTH = [0, 1];

describe("LockstepSession", () => {
  it("runs the first `delay` frames without waiting", () => {
    const s = new LockstepSession(BOTH, 0, 3);
    for (let i = 0; i < 3; i++) {
      expect(s.ready()).toBe(true);
      expect(s.advance(0).inputs).toEqual([0, 0]);
    }
    expect(s.ready()).toBe(false);
    expect(s.waitingOn()).toEqual([1]);
  });

  it("schedules local input `delay` frames ahead", () => {
    const s = new LockstepSession(BOTH, 1, 2);
    expect(s.advance(0b1010).localFrame).toBe(2);
    expect(s.advance(0).localFrame).toBe(3);
    s.receive(0, 2, 0b1);
    expect(s.advance(0).inputs).toEqual([0b1, 0b1010]);
  });

  it("feeds both machines identical inputs", () => {
    const a = new LockstepSession(BOTH, 0, 3);
    const b = new LockstepSession(BOTH, 1, 3);
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
        toB.push([localFrame!, tick % 7]);
      }
      if (tick % 3 !== 0 && b.ready()) {
        const { inputs, localFrame } = b.advance(tick % 5);
        ranB.push(inputs);
        toA.push([localFrame!, tick % 5]);
      }
    }
    const n = Math.min(ranA.length, ranB.length);
    expect(n).toBeGreaterThan(100);
    expect(ranA.slice(0, n)).toEqual(ranB.slice(0, n));
  });

  it("ignores stale, duplicate, own-seat and empty-seat inputs", () => {
    const s = new LockstepSession(BOTH, 0, 1);
    s.advance(0);
    s.receive(1, 0, 5); // already run
    s.receive(0, 1, 5); // our own seat
    s.receive(1, 1, 3);
    s.receive(1, 1, 9); // duplicate
    expect(s.advance(0).inputs).toEqual([0, 3]);
    const solo = new LockstepSession([0], 0, 1);
    solo.receive(1, 1, 7); // nobody sits in seat 1
    solo.advance(0b11);
    expect(solo.advance(0).inputs).toEqual([0b11, 0]);
  });

  it("lets one player run alone", () => {
    const s = new LockstepSession([0], 0, 2);
    for (let f = 0; f < 50; f++) {
      expect(s.ready()).toBe(true);
      s.advance(f & 0xff);
    }
  });

  it("lets a spectator follow from power-on", () => {
    const player = new LockstepSession([0], 0, 2);
    const watcher = new LockstepSession([0], null, 2);
    for (let f = 0; f < 20; f++) {
      const { localFrame } = player.advance(f);
      watcher.receive(0, localFrame!, f);
    }
    expect(watcher.available()).toBe(22); // 2 empty frames + 20 inputs
    const seen = Array.from({ length: 22 }, () => watcher.advance().inputs[0]);
    expect(seen).toEqual([0, 0, ...Array.from({ length: 20 }, (_, f) => f)]);
    expect(watcher.advance.bind(watcher)).toThrow();
  });

  it("lets a spectator start from a snapshot frame", () => {
    const s = new LockstepSession(BOTH, null, 4, 600);
    // No implicit empty frames after a snapshot: the log supplies them.
    expect(s.ready()).toBe(false);
    s.receive(0, 600, 1);
    s.receive(1, 600, 2);
    s.receive(0, 599, 9); // before the snapshot, ignored
    expect(s.advance()).toEqual({ inputs: [1, 2], localFrame: null });
    expect(s.frame).toBe(601);
  });
});
