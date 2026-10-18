import { Button, type ButtonName } from "./types";

/** Turbo (auto-fire) versions of A and B: held, they press and release on their own. */
export type TurboName = "TurboA" | "TurboB";

/** Maps KeyboardEvent.code to a button, one map per controller port. */
export type KeyMap = Record<string, ButtonName | TurboName>;

/** One keyboard layout, for 1P; a second local player uses a gamepad. */
export const DEFAULT_KEYMAPS: readonly KeyMap[] = [
  {
    KeyW: "Up",
    KeyS: "Down",
    KeyA: "Left",
    KeyD: "Right",
    KeyJ: "TurboB",
    KeyK: "TurboA",
    KeyN: "B",
    KeyM: "A",
    KeyV: "Select",
    KeyB: "Start",
  },
];

/**
 * What a controller is doing: buttons held down, and buttons held in turbo
 * mode (as NES masks of A/B), which `applyTurbo` turns into presses per frame.
 */
export interface ControllerState {
  held: number;
  turbo: number;
}

const TURBO_BUTTON: Record<TurboName, number> = { TurboA: Button.A, TurboB: Button.B };

/** Frames per turbo cycle: pressed for half, released for half (~15 presses a second). */
export const TURBO_PERIOD = 4;

/**
 * The buttons pressed on `frame`: held buttons, plus turbo buttons on the
 * first half of each cycle. Depends only on the frame number, so a netplay
 * peer sends exactly the presses its game runs with.
 */
export function applyTurbo(state: ControllerState, frame: number): number {
  const on = frame % TURBO_PERIOD < TURBO_PERIOD / 2;
  return state.held | (on ? state.turbo : 0);
}

/** Combine two controllers driving the same port (keyboard and gamepad). */
export function mergeControllers(a: ControllerState, b: ControllerState): ControllerState {
  return { held: a.held | b.held, turbo: a.turbo | b.turbo };
}

export const IDLE_CONTROLLER: ControllerState = { held: 0, turbo: 0 };

/**
 * Tracks held keys and turns them into per-port controller states.
 * The caller wires it to keydown/keyup so it stays DOM-agnostic.
 */
export class KeyboardInput {
  private readonly states: ControllerState[];

  constructor(private readonly keymaps: readonly KeyMap[] = DEFAULT_KEYMAPS) {
    this.states = keymaps.map(() => ({ held: 0, turbo: 0 }));
  }

  /** Returns true when the key is bound, so the caller can preventDefault. */
  handle(code: string, down: boolean): boolean {
    let bound = false;
    this.keymaps.forEach((map, port) => {
      const name = map[code];
      if (!name) return;
      bound = true;
      const state = this.states[port];
      const key = name === "TurboA" || name === "TurboB" ? "turbo" : "held";
      const bit = key === "turbo" ? TURBO_BUTTON[name as TurboName] : Button[name as ButtonName];
      state[key] = down ? state[key] | bit : state[key] & ~bit;
    });
    return bound;
  }

  clear(): void {
    for (const state of this.states) {
      state.held = 0;
      state.turbo = 0;
    }
  }

  state(port: number): ControllerState {
    const state = this.states[port];
    return state ? { ...state } : IDLE_CONTROLLER;
  }
}

const AXIS_THRESHOLD = 0.5;

/** Reads a "standard" mapping gamepad (W3C Gamepad API) into a controller state. */
export function readGamepad(pad: Gamepad): ControllerState {
  const pressed = (i: number) => pad.buttons[i]?.pressed ?? false;
  const [x = 0, y = 0] = pad.axes;
  let held = 0;
  // Same layout as RetroArch: NES A on the right face button, B on the bottom;
  // the left and top face buttons are turbo B and turbo A.
  if (pressed(1)) held |= Button.A;
  if (pressed(0)) held |= Button.B;
  if (pressed(8)) held |= Button.Select;
  if (pressed(9)) held |= Button.Start;
  if (pressed(12) || y < -AXIS_THRESHOLD) held |= Button.Up;
  if (pressed(13) || y > AXIS_THRESHOLD) held |= Button.Down;
  if (pressed(14) || x < -AXIS_THRESHOLD) held |= Button.Left;
  if (pressed(15) || x > AXIS_THRESHOLD) held |= Button.Right;
  // Opposing directions confuse many games; the real D-pad cannot do this.
  if ((held & Button.Up) && (held & Button.Down)) held &= ~(Button.Up | Button.Down);
  if ((held & Button.Left) && (held & Button.Right)) held &= ~(Button.Left | Button.Right);
  let turbo = 0;
  if (pressed(3)) turbo |= Button.A;
  if (pressed(2)) turbo |= Button.B;
  return { held, turbo };
}
