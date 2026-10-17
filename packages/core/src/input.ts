import { Button, type ButtonName } from "./types";

/** Maps KeyboardEvent.code to a button, one map per controller port. */
export type KeyMap = Record<string, ButtonName>;

export const DEFAULT_KEYMAPS: readonly KeyMap[] = [
  {
    KeyW: "Up",
    KeyS: "Down",
    KeyA: "Left",
    KeyD: "Right",
    KeyJ: "B",
    KeyK: "A",
    KeyV: "Select",
    KeyB: "Start",
  },
  {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Numpad1: "B",
    Numpad2: "A",
    Numpad5: "Select",
    NumpadEnter: "Start",
  },
];

/**
 * Tracks held keys and turns them into per-port button masks.
 * The caller wires it to keydown/keyup so it stays DOM-agnostic.
 */
export class KeyboardInput {
  private readonly masks: number[];

  constructor(private readonly keymaps: readonly KeyMap[] = DEFAULT_KEYMAPS) {
    this.masks = keymaps.map(() => 0);
  }

  /** Returns true when the key is bound, so the caller can preventDefault. */
  handle(code: string, down: boolean): boolean {
    let bound = false;
    this.keymaps.forEach((map, port) => {
      const name = map[code];
      if (!name) return;
      bound = true;
      this.masks[port] = down ? this.masks[port] | Button[name] : this.masks[port] & ~Button[name];
    });
    return bound;
  }

  clear(): void {
    this.masks.fill(0);
  }

  mask(port: number): number {
    return this.masks[port] ?? 0;
  }
}

const AXIS_THRESHOLD = 0.5;

/** Reads a "standard" mapping gamepad (W3C Gamepad API) into a button mask. */
export function readGamepad(pad: Gamepad): number {
  const pressed = (i: number) => pad.buttons[i]?.pressed ?? false;
  const [x = 0, y = 0] = pad.axes;
  let mask = 0;
  // Same layout as RetroArch: NES A on the right face button, B on the bottom (or left).
  if (pressed(1)) mask |= Button.A;
  if (pressed(0) || pressed(2)) mask |= Button.B;
  if (pressed(8)) mask |= Button.Select;
  if (pressed(9)) mask |= Button.Start;
  if (pressed(12) || y < -AXIS_THRESHOLD) mask |= Button.Up;
  if (pressed(13) || y > AXIS_THRESHOLD) mask |= Button.Down;
  if (pressed(14) || x < -AXIS_THRESHOLD) mask |= Button.Left;
  if (pressed(15) || x > AXIS_THRESHOLD) mask |= Button.Right;
  // Opposing directions confuse many games; the real D-pad cannot do this.
  if ((mask & Button.Up) && (mask & Button.Down)) mask &= ~(Button.Up | Button.Down);
  if ((mask & Button.Left) && (mask & Button.Right)) mask &= ~(Button.Left | Button.Right);
  return mask;
}
