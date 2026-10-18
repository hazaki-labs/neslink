import { NETPLAY_MAX_MASK } from "./protocol";

/**
 * Direct player-to-player packets over a WebRTC data channel. The channel is
 * unordered and never retransmits (a late input is worse than a lost one, and
 * retransmits queue everything behind them). Instead every packet carries all
 * of the sender's inputs the other side has not acknowledged yet, and the
 * frame up to which the sender has the other side's inputs (its ack). Losing
 * packets then costs nothing as long as a later one arrives, and senders
 * repeat their latest packet every refresh, even when not advancing, since a
 * stalled player's last packet may be the one that was lost.
 */

/** Most unacknowledged inputs one packet carries (about a second of play). */
export const PEER_MAX_INPUTS = 64;

export type PeerPacket =
  /**
   * Seat `s`'s inputs for frames `f - m.length + 1 ..= f`, its frame advantage
   * `a`, and `k`: the newest frame up to which it holds every input of ours.
   */
  | { t: "in"; s: number; f: number; m: number[]; a: number; k: number }
  | { t: "ping"; ts: number }
  | { t: "pong"; ts: number };

/** The local player's inputs not yet acknowledged by the other side, packed for sending. */
export class InputHistory {
  private first = 0;
  private masks: number[] = [];

  /** Record the input scheduled for `frame`; frames arrive in increasing order. */
  push(frame: number, mask: number): void {
    if (this.masks.length > 0 && frame !== this.first + this.masks.length) {
      // A gap (should not happen within a game): start over rather than send wrong frames.
      this.masks = [];
    }
    if (this.masks.length === 0) this.first = frame;
    this.masks.push(mask);
  }

  /** The other side holds every input of ours up to `frame`: stop resending those. */
  acknowledge(frame: number): void {
    const drop = Math.min(this.masks.length, frame - this.first + 1);
    if (drop <= 0) return;
    this.masks.splice(0, drop);
    this.first += drop;
  }

  /** Pending inputs (newest last, at most PEER_MAX_INPUTS), with our ack of theirs. */
  packet(seat: number, advantage: number, ack: number): PeerPacket | null {
    if (this.masks.length === 0) return null;
    const masks = this.masks.slice(-PEER_MAX_INPUTS);
    return { t: "in", s: seat, f: this.first + this.masks.length - 1, m: masks, a: advantage, k: ack };
  }

  /** Inputs still waiting for acknowledgement. */
  get pending(): number {
    return this.masks.length;
  }

  clear(): void {
    this.masks = [];
  }
}

/** The (frame, mask) pairs an input packet carries, oldest first; empty if it is malformed. */
export function unpackInputs(packet: PeerPacket): [frame: number, mask: number][] {
  if (packet.t !== "in" || !Number.isInteger(packet.f) || !Array.isArray(packet.m)) return [];
  if (packet.m.length > PEER_MAX_INPUTS) return [];
  const first = packet.f - packet.m.length + 1;
  const out: [number, number][] = [];
  packet.m.forEach((mask, i) => {
    if (Number.isInteger(mask) && mask >= 0 && mask <= NETPLAY_MAX_MASK && first + i >= 0) out.push([first + i, mask]);
  });
  return out;
}
