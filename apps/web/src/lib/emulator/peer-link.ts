import type { PeerPacket } from "@neslink/core";

export type PeerState = "off" | "connecting" | "open" | "failed";

export interface PeerStatus {
  state: PeerState;
  /** Round trip over the direct link, once measured. */
  rttMs: number | null;
}

/** Public STUN only: two players behind ordinary NATs can usually reach each other this way. */
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }];
const PING_INTERVAL_MS = 1000;
const PING_SAMPLES = 5;

type Signal = { sdp: RTCSessionDescriptionInit } | { candidate: RTCIceCandidateInit };

/**
 * A direct WebRTC data channel to the other seated player, on the UI thread
 * (RTCPeerConnection is not available in workers). Input packets cross a
 * MessagePort to and from the emulator worker untouched.
 *
 * Purely an accelerator: inputs also travel through the room server, and
 * whichever copy arrives first wins, so failing to connect (strict NATs, no
 * TURN relay) only means playing over the server as before.
 */
export class PeerLink {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private peerId: string | null = null;
  private pending: { from: string; data: Signal }[] = [];
  private candidates: RTCIceCandidateInit[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private rtts: number[] = [];
  private status: PeerStatus = { state: "off", rttMs: null };

  constructor(
    private readonly port: MessagePort,
    private readonly signal: (to: string, data: Signal) => void,
    private readonly onStatus: (status: PeerStatus) => void,
  ) {
    // Packets from the worker go straight out over the channel.
    port.onmessage = (event: MessageEvent<PeerPacket>) => {
      if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(event.data));
    };
  }

  /** Connect to `peerId`, or drop the link with null. The lower id makes the offer. */
  setPeer(selfId: string | null, peerId: string | null): void {
    if (peerId === this.peerId) return;
    this.close();
    this.peerId = peerId;
    if (!selfId || !peerId) return;
    this.setStatus({ state: "connecting", rttMs: null });

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    pc.onicecandidate = (event) => {
      if (event.candidate) this.signal(peerId, { candidate: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      if (pc.connectionState === "failed") this.setStatus({ state: "failed", rttMs: null });
      else if (pc.connectionState === "disconnected" || pc.connectionState === "closed") {
        this.setStatus({ state: "connecting", rttMs: null });
      }
    };
    if (selfId < peerId) {
      // Late inputs are useless and retransmits would queue newer ones behind them.
      this.wire(pc.createDataChannel("inputs", { ordered: false, maxRetransmits: 0 }));
      void this.offer(pc, peerId);
    } else {
      pc.ondatachannel = (event) => this.wire(event.channel);
    }
    const early = this.pending.filter((p) => p.from === peerId);
    this.pending = [];
    for (const { data } of early) void this.handleSignal(peerId, data);
  }

  /** Signaling from another player, relayed by the room. */
  async handleSignal(from: string, data: unknown): Promise<void> {
    const signal = data as Signal;
    if (from !== this.peerId || !this.pc) {
      // Their offer can arrive before our room state shows them as the peer.
      this.pending.push({ from, data: signal });
      if (this.pending.length > 64) this.pending.shift();
      return;
    }
    const pc = this.pc;
    try {
      if ("sdp" in signal) {
        await pc.setRemoteDescription(signal.sdp);
        for (const candidate of this.candidates.splice(0)) await pc.addIceCandidate(candidate);
        if (signal.sdp.type === "offer") {
          await pc.setLocalDescription(await pc.createAnswer());
          this.signal(from, { sdp: pc.localDescription!.toJSON() });
        }
      } else if ("candidate" in signal) {
        if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate);
        else this.candidates.push(signal.candidate);
      }
    } catch {
      // A failed handshake leaves play on the server relay.
      this.setStatus({ state: "failed", rttMs: null });
    }
  }

  close(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.dc?.close();
    this.pc?.close();
    this.dc = null;
    this.pc = null;
    this.peerId = null;
    this.candidates = [];
    this.rtts = [];
    this.setStatus({ state: "off", rttMs: null });
  }

  dispose(): void {
    this.close();
    this.port.onmessage = null;
    this.port.close();
  }

  private async offer(pc: RTCPeerConnection, peerId: string) {
    try {
      await pc.setLocalDescription(await pc.createOffer());
      if (pc === this.pc) this.signal(peerId, { sdp: pc.localDescription!.toJSON() });
    } catch {
      this.setStatus({ state: "failed", rttMs: null });
    }
  }

  private wire(dc: RTCDataChannel) {
    this.dc = dc;
    dc.onopen = () => {
      if (dc !== this.dc) return;
      this.setStatus({ state: "open", rttMs: null });
      this.pingTimer = setInterval(() => this.sendRaw({ t: "ping", ts: performance.now() }), PING_INTERVAL_MS);
      this.sendRaw({ t: "ping", ts: performance.now() });
    };
    dc.onclose = () => {
      if (dc === this.dc && this.status.state === "open") this.setStatus({ state: "connecting", rttMs: null });
    };
    dc.onmessage = (event) => {
      let packet: PeerPacket;
      try {
        packet = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (packet.t === "ping") return this.sendRaw({ t: "pong", ts: packet.ts });
      if (packet.t === "pong") return this.recordRtt(performance.now() - packet.ts);
      this.port.postMessage(packet);
    };
  }

  private recordRtt(rtt: number) {
    if (!Number.isFinite(rtt) || rtt < 0) return;
    this.rtts.push(rtt);
    if (this.rtts.length > PING_SAMPLES) this.rtts.shift();
    const sorted = [...this.rtts].sort((a, b) => a - b);
    this.setStatus({ state: "open", rttMs: sorted[sorted.length >> 1] });
  }

  private sendRaw(packet: PeerPacket) {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(packet));
  }

  private setStatus(status: PeerStatus) {
    this.status = status;
    this.onStatus(status);
  }
}
