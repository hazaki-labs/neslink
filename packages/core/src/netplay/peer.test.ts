import { describe, expect, it } from "vitest";
import { MAX_ROLLBACK, RollbackSession, type RollbackHost } from "./rollback";
import { InputHistory, PEER_MAX_INPUTS, unpackInputs, type PeerPacket } from "./peer";
import { NETPLAY_RESET } from "./protocol";

describe("InputHistory", () => {
  it("resends everything the other side has not acknowledged", () => {
    const h = new InputHistory();
    for (let f = 3; f < 15; f++) h.push(f, f * 2);
    expect(unpackInputs(h.packet(1, 2, 0)!)).toEqual(Array.from({ length: 12 }, (_, i) => [3 + i, (3 + i) * 2]));
    h.acknowledge(10);
    const p = h.packet(1, 2, 5)!;
    expect(p).toMatchObject({ t: "in", s: 1, f: 14, a: 2, k: 5 });
    expect(unpackInputs(p)).toEqual([11, 12, 13, 14].map((f) => [f, f * 2]));
    h.acknowledge(14);
    expect(h.packet(1, 0, 0)).toBeNull();
  });

  it("caps a packet at the newest PEER_MAX_INPUTS inputs", () => {
    const h = new InputHistory();
    for (let f = 0; f < 100; f++) h.push(f, 1);
    expect(unpackInputs(h.packet(0, 0, 0)!)).toHaveLength(PEER_MAX_INPUTS);
    expect(h.pending).toBe(100);
  });

  it("starts over after a gap", () => {
    const h = new InputHistory();
    h.push(3, 1);
    h.push(9, 2);
    expect(unpackInputs(h.packet(0, 0, 0)!)).toEqual([[9, 2]]);
  });

  it("rejects malformed packets", () => {
    // Frames before 0 are dropped, the rest kept.
    expect(unpackInputs({ t: "in", s: 0, f: 2, m: [1, 2, 3, 4], a: 0, k: 0 })).toEqual([[0, 2], [1, 3], [2, 4]]);
    expect(unpackInputs({ t: "in", s: 0, f: 1.5, m: [1], a: 0, k: 0 })).toEqual([]);
    expect(unpackInputs({ t: "in", s: 0, f: 99, m: Array(PEER_MAX_INPUTS + 1).fill(0), a: 0, k: 0 })).toEqual([]);
    expect(unpackInputs({ t: "ping", ts: 1 })).toEqual([]);
  });
});

class FakeGame implements RollbackHost {
  state = 1;
  slots = new Map<number, number>();
  save(slot: number) {
    this.slots.set(slot, this.state);
  }
  load(slot: number) {
    this.state = this.slots.get(slot)!;
  }
  run(inputs: readonly number[]) {
    this.state = (Math.imul(this.state, 31) + inputs[0] * 7 + inputs[1] * 13 + 1) >>> 0;
  }
  hash() {
    return this.state;
  }
}

describe("redundant packets over a lossy channel", () => {
  it("keeps both sides in sync when most packets are lost", () => {
    const peers = [0, 1].map((seat) => {
      const game = new FakeGame();
      const session = new RollbackSession([0, 1], seat, 2, game);
      const finals = new Map<number, number>();
      session.onFinal = (f, h) => finals.set(f, h);
      return { seat, session, finals, history: new InputHistory() };
    });
    let seed = 7;
    const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    const inFlight: { at: number; to: number; packet: PeerPacket }[] = [];
    for (let tick = 0; tick < 800; tick++) {
      for (const msg of inFlight.filter((m) => m.at === tick)) {
        const peer = peers[msg.to];
        const packet = msg.packet as Extract<PeerPacket, { t: "in" }>;
        for (const [f, m] of unpackInputs(packet)) peer.session.receive(packet.s, f, m);
        peer.history.acknowledge(packet.k);
      }
      for (const peer of peers) {
        peer.session.resolve();
        if (peer.session.canAdvance()) {
          const mask = (peer.session.frame * (peer.seat + 3)) % 7;
          peer.history.push(peer.session.advance(mask)!, mask);
        }
        // Resent every tick, stalled or not: a stalled side's last packet may have been lost.
        // 60% of packets vanish; the rest take 2-4 ticks, in any order.
        const packet = peer.history.packet(peer.seat, 0, peer.session.receivedThrough(1 - peer.seat));
        if (!packet || random() < 0.6) continue;
        inFlight.push({ at: tick + 2 + Math.floor(random() * 3), to: 1 - peer.seat, packet });
      }
    }
    const frames = Math.min(peers[0].finals.size, peers[1].finals.size);
    expect(frames).toBeGreaterThan(600);
    for (let f = 0; f < frames; f++) expect(peers[0].finals.get(f)).toBe(peers[1].finals.get(f));
    expect(peers[0].session.frame - peers[0].session.confirmedFrame).toBeLessThanOrEqual(MAX_ROLLBACK);
  });
});

describe("unpackInputs reset", () => {
  it("keeps the reset bit and drops masks past it", () => {
    const packet: PeerPacket = { t: "in", s: 0, f: 2, m: [1, NETPLAY_RESET | 1, 0x200], a: 0, k: 0 };
    expect(unpackInputs(packet)).toEqual([[0, 1], [1, NETPLAY_RESET | 1]]);
  });
});
