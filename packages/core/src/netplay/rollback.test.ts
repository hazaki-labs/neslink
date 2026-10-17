import { describe, expect, it } from "vitest";
import { LockstepSession } from "./lockstep";
import { MAX_ROLLBACK, ROLLBACK_SLOTS, RollbackSession, type RollbackHost } from "./rollback";

/** A deterministic stand-in for the emulator: its state folds in every frame's inputs. */
class FakeGame implements RollbackHost {
  state = 1;
  slots = new Map<number, number>();
  runs = 0;
  replays = 0;
  save(slot: number) {
    this.slots.set(slot, this.state);
  }
  load(slot: number) {
    if (!this.slots.has(slot)) throw new Error(`empty slot ${slot}`);
    this.state = this.slots.get(slot)!;
  }
  run(inputs: readonly number[], replay: boolean) {
    this.state = (Math.imul(this.state, 31) + inputs[0] * 7 + inputs[1] * 13 + 1) >>> 0;
    this.runs++;
    if (replay) this.replays++;
  }
  hash() {
    return this.state;
  }
}

/** Reference hashes for a game played with these per-frame inputs. */
function reference(inputs: [number, number][]) {
  const game = new FakeGame();
  return inputs.map((i) => {
    game.run(i, false);
    return game.hash();
  });
}

interface Peer {
  game: FakeGame;
  session: RollbackSession;
  finals: Map<number, number>;
  /** Input this peer presses on its frame N (deterministic per peer). */
  press: (frame: number) => number;
  speed: number;
}

function peer(seat: number, delay: number, speed: number, press: (f: number) => number): Peer {
  const game = new FakeGame();
  const session = new RollbackSession([0, 1], seat, delay, game);
  const finals = new Map<number, number>();
  session.onFinal = (frame, hash) => {
    expect(finals.has(frame)).toBe(false); // each frame finalizes once, in order
    finals.set(frame, hash);
  };
  return { game, session, finals, press, speed };
}

/**
 * Two peers exchanging inputs through a network that delays each message by
 * `latency(tick)` ticks. Each tick, a peer runs `speed` frames when it can.
 */
function play(ticks: number, delay: number, latency: (tick: number) => number, speeds = [1, 1]) {
  const a = peer(0, delay, speeds[0], (f) => (f * 7) % 5);
  const b = peer(1, delay, speeds[1], (f) => (f % 9 < 4 ? 0b1001 : 0));
  const inFlight: { at: number; to: Peer; seat: number; frame: number; mask: number; adv: number }[] = [];
  const truth = new Map<number, [number, number]>();
  for (let tick = 0; tick < ticks; tick++) {
    for (const msg of inFlight.filter((m) => m.at <= tick)) {
      msg.to.session.receive(msg.seat, msg.frame, msg.mask);
      msg.to.session.receiveAdvantage(msg.adv);
    }
    inFlight.splice(0, inFlight.length, ...inFlight.filter((m) => m.at > tick));
    for (const [self, other, seat] of [[a, b, 0], [b, a, 1]] as const) {
      self.session.resolve();
      for (let n = 0; n < self.speed && self.session.canAdvance(); n++) {
        const frame = self.session.frame;
        const mask = self.press(frame);
        const localFrame = self.session.advance(mask);
        const entry = truth.get(localFrame) ?? [0, 0];
        entry[seat] = mask;
        truth.set(localFrame, entry);
        inFlight.push({ at: tick + latency(tick), to: other, seat, frame: localFrame, mask, adv: self.session.localAdvantage() });
      }
    }
  }
  const frames = Math.min(a.finals.size, b.finals.size);
  const inputs = Array.from({ length: frames }, (_, f): [number, number] => truth.get(f) ?? [0, 0]);
  return { a, b, frames, expected: reference(inputs) };
}

describe("RollbackSession", () => {
  it("agrees on every final frame despite jittery latency", () => {
    const { a, b, frames, expected } = play(600, 2, (t) => 1 + ((t * 37) % 5));
    expect(frames).toBeGreaterThan(500);
    for (let f = 0; f < frames; f++) {
      expect(a.finals.get(f)).toBe(expected[f]);
      expect(b.finals.get(f)).toBe(expected[f]);
    }
    expect(a.game.replays + b.game.replays).toBeGreaterThan(0); // predictions were wrong sometimes
  });

  it("never waits when latency is under the window", () => {
    const { a, b } = play(300, 1, () => 3);
    expect(a.session.frame).toBe(300);
    expect(b.session.frame).toBe(300);
  });

  it("waits instead of speculating past the window", () => {
    const latency = MAX_ROLLBACK + 6;
    const { a } = play(200, 1, () => latency);
    // Without remote input for `latency` ticks, A stops `window` frames past the last confirmed one.
    expect(a.session.frame - a.session.confirmedFrame).toBeLessThanOrEqual(MAX_ROLLBACK);
    expect(a.session.frame).toBeLessThan(200);
  });

  it("respects a smaller window on slow machines", () => {
    const game = new FakeGame();
    const s = new RollbackSession([0, 1], 0, 1, game);
    s.window = 3;
    let ran = 0;
    while (s.canAdvance()) {
      s.advance(0);
      ran++;
    }
    expect(s.frame - s.confirmedFrame).toBe(3);
    expect(ran).toBe(4); // frame 0 has implicit input; then 3 speculative frames
  });

  it("feeds spectators the same game", () => {
    const { a, frames, expected } = play(400, 2, (t) => 2 + (t % 3));
    // A spectator only sees final, confirmed inputs: replaying them gives the reference.
    const watcher = new LockstepSession([0, 1], null, 2);
    const ref = new FakeGame();
    expect(watcher.ready()).toBe(true);
    for (let f = 0; f < 2; f++) ref.run(watcher.advance().inputs, false);
    expect(ref.hash()).toBe(expected[1]);
    expect(a.finals.get(frames - 1)).toBe(expected[frames - 1]);
  });

  it("only runs alone without ever rolling back", () => {
    const game = new FakeGame();
    const s = new RollbackSession([0], 0, 1, game);
    const finals: number[] = [];
    s.onFinal = (f) => finals.push(f);
    for (let f = 0; f < 50; f++) {
      s.resolve();
      expect(s.canAdvance()).toBe(true);
      s.advance(f & 3);
    }
    expect(game.replays).toBe(0);
    expect(finals).toEqual(Array.from({ length: 50 }, (_, f) => f));
  });

  it("slows down the side that runs ahead", () => {
    const { a, b } = play(900, 2, () => 2, [2, 1]);
    // A could run twice as fast but must stay within the window of B.
    expect(a.session.frame - b.session.frame).toBeLessThanOrEqual(MAX_ROLLBACK + 4);
  });

  it("keeps the state before a final frame for snapshots", () => {
    const game = new FakeGame();
    const s = new RollbackSession([0], 0, 1, game);
    for (let f = 0; f < 20; f++) s.advance(0);
    expect(s.slotBefore(20)).toBeNull();
    expect(s.slotBefore(19)).toBe(19 % ROLLBACK_SLOTS);
    expect(() => s.slotBefore(5)).toThrow();
  });
});
