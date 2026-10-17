import { describe, expect, it } from "vitest";
import { FramePacer } from "./frame-pacer";

const NES_MS = 1000 / 60.0988;

/** Feed refresh timestamps with a little jitter; return frames per refresh. */
function run(pacer: FramePacer, refreshMs: number, count: number) {
  const frames: number[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    t += refreshMs + (i % 2 ? 0.4 : -0.4);
    frames.push(pacer.advance(t));
  }
  return frames.slice(20); // skip refresh-rate estimation
}

describe("FramePacer", () => {
  it("locks to one frame per refresh at 60Hz", () => {
    const pacer = new FramePacer(NES_MS, true);
    expect(run(pacer, 1000 / 60, 300).every((n) => n === 1)).toBe(true);
    expect(pacer.lockedInterval()).toBe(1);
  });

  it("locks to one frame every other refresh at 120Hz", () => {
    const pacer = new FramePacer(NES_MS, true);
    const frames = run(pacer, 1000 / 120, 300);
    expect(pacer.lockedInterval()).toBe(2);
    expect(frames.join("")).toMatch(/^(10)+1?$|^(01)+0?$/);
  });

  it("paces by time when the refresh rate is not a multiple", () => {
    const pacer = new FramePacer(NES_MS, true);
    const frames = run(pacer, 1000 / 144, 1440);
    expect(pacer.lockedInterval()).toBeNull();
    const perSecond = frames.reduce((a, b) => a + b, 0) / ((frames.length * 1000) / 144 / 1000);
    expect(perSecond).toBeCloseTo(60.1, 0);
  });

  it("resumes with a single frame after a stall", () => {
    const pacer = new FramePacer(NES_MS, true);
    run(pacer, 1000 / 60, 30);
    pacer.advance(1e6);
    expect(pacer.advance(1e6 + 1000 / 60)).toBe(1);
  });
});
