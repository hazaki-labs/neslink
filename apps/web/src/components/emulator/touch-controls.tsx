import { useId, useRef, useState, type PointerEvent } from "react";
import { Button, IDLE_CONTROLLER, type ButtonName, type ControllerState } from "@neslink/core";

type Pad = "Up" | "Down" | "Left" | "Right";
type Key = ButtonName | "TurboA" | "TurboB";

/** Fraction of the D-pad's radius around its centre that presses nothing. */
const DEAD_ZONE = 0.25;

/** Directions for a touch at (x, y) from the D-pad centre, radius-normalized; diagonals press two. */
function padDirections(x: number, y: number): Pad[] {
  if (Math.hypot(x, y) < DEAD_ZONE) return [];
  const angle = (Math.atan2(y, x) * 180) / Math.PI; // 0 = right, 90 = down
  const out: Pad[] = [];
  // Eight sectors of 45°: each axis owns 3 of them (its own and the two diagonals beside it).
  if (angle > -67.5 && angle < 67.5) out.push("Right");
  if (angle > 112.5 || angle < -112.5) out.push("Left");
  if (angle > 22.5 && angle < 157.5) out.push("Down");
  if (angle < -22.5 && angle > -157.5) out.push("Up");
  return out;
}

function stateFor(keys: Iterable<Key>): ControllerState {
  let held = 0;
  let turbo = 0;
  for (const key of keys) {
    if (key === "TurboA") turbo |= Button.A;
    else if (key === "TurboB") turbo |= Button.B;
    else held |= Button[key];
  }
  return { held, turbo };
}

/**
 * On-screen NES controller for touch screens. One handler follows every
 * finger: whatever is under it now is pressed, so a thumb can slide from B to
 * A, or round the D-pad, without lifting. Below the screen when the phone is
 * upright, at its sides when it is turned.
 */
export function TouchControls({ onChange }: { onChange: (state: ControllerState) => void }) {
  const fingers = useRef(new Map<number, Key[]>());
  /** What is pressed, for drawing; `last` is the same, current between renders. */
  const [pressed, setPressed] = useState<ReadonlySet<Key>>(new Set());
  const last = useRef<ReadonlySet<Key>>(new Set());

  const update = () => {
    const all = new Set([...fingers.current.values()].flat());
    const before = last.current;
    if (all.size === before.size && [...all].every((key) => before.has(key))) return;
    if ([...all].some((key) => !before.has(key))) navigator.vibrate?.(8);
    last.current = all;
    setPressed(all);
    onChange(all.size ? stateFor(all) : IDLE_CONTROLLER);
  };

  const track = (event: PointerEvent<HTMLDivElement>) => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const pad = target?.closest<HTMLElement>("[data-pad]");
    const key = target?.closest<HTMLElement>("[data-key]")?.dataset.key as Key | undefined;
    if (pad) {
      const rect = pad.getBoundingClientRect();
      const radius = rect.width / 2;
      const x = (event.clientX - rect.left - radius) / radius;
      const y = (event.clientY - rect.top - rect.height / 2) / radius;
      fingers.current.set(event.pointerId, padDirections(x, y));
    } else {
      fingers.current.set(event.pointerId, key ? [key] : []);
    }
    update();
  };

  const down = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    // Keep getting this finger's moves even once it leaves the button it landed on.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Not a live pointer (a synthetic event); moves still arrive while over the control.
    }
    track(event);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (fingers.current.has(event.pointerId)) track(event);
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    fingers.current.delete(event.pointerId);
    update();
  };

  const handlers = { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: up };
  const on = (key: Key) => pressed.has(key);

  return (
    // Upright: under the screen, D-pad and buttons on one row, Select / Start centred below.
    // Turned: D-pad and buttons over the screen's sides, Select / Start at the bottom.
    <div
      className="pointer-events-none grid shrink-0 select-none grid-cols-[auto_1fr_auto] items-center gap-y-3 px-1 [-webkit-touch-callout:none] [touch-action:none] landscape:absolute landscape:inset-x-4 landscape:bottom-14 landscape:top-14 landscape:z-20 landscape:opacity-90"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="pointer-events-auto col-start-1 row-start-1 touch-none" {...handlers}>
        <DPad on={on} />
      </div>

      <div className="pointer-events-auto col-start-3 row-start-1 touch-none" {...handlers}>
        {/* Slanted like the NES pad: A sits a little higher than B. */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <FaceButton label="B" turbo keyName="TurboB" on={on("TurboB")} />
          <FaceButton label="A" turbo keyName="TurboA" on={on("TurboA")} className="-translate-y-3" />
          <FaceButton label="B" keyName="B" on={on("B")} />
          <FaceButton label="A" keyName="A" on={on("A")} className="-translate-y-3" />
        </div>
      </div>

      <div
        className="pointer-events-auto col-span-3 row-start-2 flex touch-none justify-center gap-6 landscape:col-span-1 landscape:col-start-3"
        {...handlers}
      >
        <Pill label="SELECT" keyName="Select" on={on("Select")} />
        <Pill label="START" keyName="Start" on={on("Start")} />
      </div>
    </div>
  );
}

/** The D-pad's outline: one piece, rounded only at the arms' ends, so no seams show. */
const CROSS =
  "M40 2H60Q67 2 67 9V33H91Q98 33 98 40V60Q98 67 91 67H67V91Q67 98 60 98H40Q33 98 33 91V67H9Q2 67 2 60V40Q2 33 9 33H33V9Q33 2 40 2Z";

/** Each arm's area; a pressed one is lit within the cross's outline. */
const ARMS: Record<Pad, { x: number; y: number; w: number; h: number }> = {
  Up: { x: 33, y: 0, w: 34, h: 38 },
  Down: { x: 33, y: 62, w: 34, h: 38 },
  Left: { x: 0, y: 33, w: 38, h: 34 },
  Right: { x: 62, y: 33, w: 38, h: 34 },
};
const ARROWS: Record<Pad, string> = {
  Up: "M50 10L57 21H43Z",
  Down: "M50 90L57 79H43Z",
  Left: "M10 50L21 43V57Z",
  Right: "M90 50L79 43V57Z",
};
const PADS: Pad[] = ["Up", "Down", "Left", "Right"];

/** A cross-shaped D-pad; the arms light up while pressed. */
function DPad({ on }: { on: (key: Key) => boolean }) {
  const clip = useId();
  return (
    <div data-pad className="relative size-34 drop-shadow-[0_4px_6px_rgba(0,0,0,0.6)]">
      <svg viewBox="0 0 100 100" className="size-full" aria-hidden>
        <defs>
          <clipPath id={clip}>
            <path d={CROSS} />
          </clipPath>
        </defs>
        <path d={CROSS} className="fill-neutral-800" />
        <g clipPath={`url(#${clip})`}>
          {PADS.filter((pad) => on(pad)).map((pad) => (
            <rect key={pad} x={ARMS[pad].x} y={ARMS[pad].y} width={ARMS[pad].w} height={ARMS[pad].h} className="fill-neutral-600" />
          ))}
        </g>
        <path d={CROSS} className="fill-none stroke-neutral-600" strokeWidth="1.5" />
        <circle cx="50" cy="50" r="9" className="fill-neutral-900" />
        {PADS.map((pad) => (
          <path key={pad} d={ARROWS[pad]} className={on(pad) ? "fill-white" : "fill-neutral-500"} />
        ))}
      </svg>
    </div>
  );
}

function FaceButton({
  label, keyName, turbo, on, className = "",
}: { label: string; keyName: Key; turbo?: boolean; on: boolean; className?: string }) {
  const size = turbo ? "size-14 text-base" : "size-16 text-xl";
  const face = on
    ? "translate-y-[3px] bg-red-400 shadow-[0_1px_0_#7f1d1d]"
    : turbo
      ? "bg-red-700/80 shadow-[0_3px_0_#450a0a]"
      : "bg-[radial-gradient(circle_at_35%_30%,#f87171,#b91c1c)] shadow-[0_4px_0_#7f1d1d,0_6px_10px_rgba(0,0,0,0.5)]";
  return (
    <div className={`flex justify-center ${className}`}>
      <div
        data-key={keyName}
        className={`flex flex-col items-center justify-center rounded-full font-bold text-white transition-transform duration-75 ${size} ${face}`}
      >
        <span className="leading-none">{label}</span>
        {turbo && <span className="mt-0.5 text-[8px] font-semibold leading-none tracking-widest opacity-80">TURBO</span>}
      </div>
    </div>
  );
}

function Pill({ label, keyName, on }: { label: string; keyName: Key; on: boolean }) {
  return (
    <div data-key={keyName} className="flex flex-col items-center gap-1">
      <div
        className={`h-6 w-14 -rotate-12 rounded-full transition-transform duration-75 ${
          on ? "translate-y-[2px] bg-neutral-500" : "bg-neutral-700 shadow-[0_3px_0_#171717]"
        }`}
      />
      <span className="text-[9px] font-semibold tracking-widest text-neutral-400">{label}</span>
    </div>
  );
}
