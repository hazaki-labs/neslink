import { describe, expect, it } from "vitest";
import { applyTurbo, KeyboardInput, mergeControllers, readGamepad, TURBO_PERIOD } from "./input";
import { Button } from "./types";

describe("KeyboardInput", () => {
  it("maps N/M to B/A and J/K to turbo B/A", () => {
    const k = new KeyboardInput();
    expect(k.handle("KeyN", true)).toBe(true);
    expect(k.handle("KeyK", true)).toBe(true);
    expect(k.state(0)).toEqual({ held: Button.B, turbo: Button.A });
    k.handle("KeyM", true);
    k.handle("KeyJ", true);
    expect(k.state(0)).toEqual({ held: Button.A | Button.B, turbo: Button.A | Button.B });
    k.handle("KeyK", false);
    k.handle("KeyN", false);
    expect(k.state(0)).toEqual({ held: Button.A, turbo: Button.B });
    expect(k.handle("KeyQ", true)).toBe(false);
  });

  it("releases everything on clear", () => {
    const k = new KeyboardInput();
    k.handle("KeyJ", true);
    k.handle("KeyW", true);
    k.clear();
    expect(k.state(0)).toEqual({ held: 0, turbo: 0 });
  });
});

describe("applyTurbo", () => {
  it("presses turbo buttons on half of every cycle and held ones always", () => {
    const state = { held: Button.Up, turbo: Button.A };
    const frames = Array.from({ length: TURBO_PERIOD * 3 }, (_, f) => applyTurbo(state, f));
    expect(frames.every((m) => (m & Button.Up) !== 0)).toBe(true);
    const presses = frames.map((m) => ((m & Button.A) !== 0 ? 1 : 0)).join("");
    expect(presses).toBe("110011001100");
  });

  it("is a plain press when held and turbo overlap", () => {
    expect(applyTurbo({ held: Button.A, turbo: Button.A }, 3)).toBe(Button.A);
  });
});

describe("controllers", () => {
  it("merges keyboard and gamepad on one port", () => {
    expect(mergeControllers({ held: Button.Up, turbo: 0 }, { held: 0, turbo: Button.B })).toEqual({
      held: Button.Up,
      turbo: Button.B,
    });
  });

  it("reads face buttons: A/B single, Y/X turbo", () => {
    const pad = (pressed: number[]) =>
      ({ buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: pressed.includes(i) })), axes: [0, 0] }) as unknown as Gamepad;
    expect(readGamepad(pad([0, 1]))).toEqual({ held: Button.A | Button.B, turbo: 0 });
    expect(readGamepad(pad([2, 3]))).toEqual({ held: 0, turbo: Button.A | Button.B });
  });
});
