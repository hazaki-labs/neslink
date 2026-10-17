import { describe, expect, it } from "vitest";
import { chooseInputDelay, chooseRollbackDelay, MAX_INPUT_DELAY, MAX_ROLLBACK_DELAY, MIN_INPUT_DELAY } from "./delay";
import { NETPLAY_INPUT_DELAY } from "./protocol";

describe("chooseInputDelay", () => {
  it("falls back to the default until every player is measured", () => {
    expect(chooseInputDelay([30, null])).toBe(NETPLAY_INPUT_DELAY);
    expect(chooseInputDelay([])).toBe(NETPLAY_INPUT_DELAY);
  });

  it("uses fewer frames for players close to the server", () => {
    // 10ms + 10ms one way -> (20 * 1.1 + 8) / 16.64 = 1.8 -> 2 frames
    expect(chooseInputDelay([20, 20])).toBe(2);
  });

  it("covers the trip between the two links", () => {
    // 22.5 + 22.5 = 45ms one way -> 4 frames, today's fixed default
    expect(chooseInputDelay([45, 45])).toBe(4);
    // A far player dominates: 10 + 60 = 70ms -> 6 frames
    expect(chooseInputDelay([20, 120])).toBe(6);
  });

  it("uses the minimum for a player alone", () => {
    expect(chooseInputDelay([300])).toBe(MIN_INPUT_DELAY);
    expect(chooseInputDelay([null])).toBe(MIN_INPUT_DELAY);
  });

  it("stays within bounds", () => {
    expect(chooseInputDelay([0, 0])).toBe(MIN_INPUT_DELAY);
    expect(chooseInputDelay([400, 400])).toBe(MAX_INPUT_DELAY);
  });

  it("always gives the input time to arrive", () => {
    for (let a = 0; a <= 200; a += 7) {
      for (let b = 0; b <= 200; b += 11) {
        const frames = chooseInputDelay([a, b]);
        if (frames < MAX_INPUT_DELAY) expect(frames * (1000 / 60.0988)).toBeGreaterThan(a / 2 + b / 2);
      }
    }
  });
});

describe("chooseRollbackDelay", () => {
  it("uses about half the lockstep delay, within 1..3 frames", () => {
    expect(chooseRollbackDelay([20, 20])).toBe(1); // lockstep 2
    expect(chooseRollbackDelay([45, 45])).toBe(2); // lockstep 4
    expect(chooseRollbackDelay([400, 400])).toBe(MAX_ROLLBACK_DELAY);
    expect(chooseRollbackDelay([300])).toBe(MIN_INPUT_DELAY);
    expect(chooseRollbackDelay([30, null])).toBe(2); // lockstep default 4
  });
});
