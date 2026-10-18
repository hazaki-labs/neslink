import {
  type LockstepSession,
  NETPLAY_PING,
  NETPLAY_PONG,
  type ClientMessage,
  type RoomEndReason,
  type RoomErrorCode,
  type RollbackSession,
  type RoomState,
  type ServerMessage,
  type PeerPacket,
  type ReactionKind,
  type RelaySelection,
  NETPLAY_RECONNECT_GRACE_MS,
} from "@neslink/core/netplay";
import type { NetStatus } from "@neslink/core";
import { probeRelays, summarizeProbe } from "../relay-probes";
import { RelayLink, type RelayStatus } from "./relay-link";

/** A seated player rolls back; a spectator follows confirmed inputs in lockstep. */
export type NetSession = RollbackSession | LockstepSession;

export interface GameStart {
  seats: number[];
  /** Our seat in this game, or null to watch it. */
  localSeat: number | null;
  delay: number;
  /** Frame to start from: 0 (power-on) or a snapshot's frame. */
  startFrame: number;
  /** Base64 save state for a late spectator or a rejoining player, else null. */
  snapshot: string | null;
  /** Inputs the room logged since that frame, all seats (ours too, when rejoining). */
  inputs: [seat: number, frame: number, mask: number][];
}

/** Who this tab is in the room, to rejoin as after a drop or a refresh. */
export interface RoomCredentials {
  id: string;
  token: string;
}

export interface NetplayEvents {
  onStatus(status: NetStatus, reason?: string): void;
  onRoom(room: RoomState, you: string): void;
  /**
   * A game started (or is in progress, for a late spectator). The handler
   * builds the session that will run it and returns it; the link then feeds
   * it every input that arrives.
   */
  onStart(start: GameStart): NetSession | null;
  /** A game in progress ended (a player left, or the connection dropped). */
  onEnd(reason: RoomEndReason): void;
  onDesync(frame: number): void;
  onError(code: RoomErrorCode): void;
  /** Round trip to the room server in ms (median of recent probes). */
  onPing(rttMs: number): void;
  /** WebRTC signaling from another player. */
  onSignal(from: string, data: unknown): void;
  onRelayPacket(packet: PeerPacket): void;
  onRelayStatus(status: RelayStatus): void;
  /** Our identity in the room changed (joined or rejoined); keep it to rejoin later. */
  onCredentials(credentials: RoomCredentials): void;
  /** Someone in the room reacted. */
  onReaction(from: string, kind: ReactionKind): void;
}

/** Extra latency to simulate on this link (dev tool, from `?lag=` / `?swing=`). */
export interface SimulatedNetwork {
  /** Added round trip, split evenly between the two directions. */
  lagMs: number;
  /** Up to this much more per message, at random (order is kept, as on a real socket). */
  jitterMs: number;
}

const PING_INTERVAL_MS = 1000;
const PING_SAMPLES = 5;
const RETRY_FIRST_MS = 300;
const RETRY_MAX_MS = 2000;

/** One player's connection to a room: the socket plus the game session once started. */
export class NetplayLink {
  session: NetSession | null = null;
  private ws!: WebSocket;
  private resumeToken: string | null = null;
  /** While reconnecting: give up at this time (the room keeps our seat until then). */
  private reconnectBy = 0;
  private retryMs = RETRY_FIRST_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private you: string | null = null;
  private room: RoomState | null = null;
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSentAt: number | null = null;
  private readonly rtts: number[] = [];
  private directRtt: number | null = null;
  private sendAt = 0;
  private receiveAt = 0;
  private connectionToken: string | null = null;
  private relay: RelayLink | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private probing = false;
  private readonly controlOrigin: string;

  /** `resume`: credentials from before a page refresh, to rejoin as that player. */
  constructor(
    private readonly url: string,
    private readonly hello: { name: string; romHash: string },
    private readonly events: NetplayEvents,
    private readonly simulated: SimulatedNetwork | null = null,
    private readonly resume: RoomCredentials | null = null,
  ) {
    events.onStatus("connecting");
    const base = new URL(url);
    base.protocol = base.protocol === "wss:" ? "https:" : "http:";
    this.controlOrigin = base.origin;
    this.connect();
  }

  private connect() {
    this.retryTimer = null;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.events.onStatus("open");
      // After a drop (or a refresh) ask to be who we were: same seat, same game.
      const resume = this.you && this.resumeToken ? { id: this.you, token: this.resumeToken } : this.resume ?? undefined;
      this.send({ t: "hello", ...this.hello, resume });
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
    };
    ws.onmessage = (event) =>
      this.later("receive", () => {
        if (ws !== this.ws) return;
        if (this.closed && event.data !== NETPLAY_PONG) return;
        if (event.data === NETPLAY_PONG) return this.onPong();
        this.onMessage(JSON.parse(event.data as string) as ServerMessage);
      });
    ws.onclose = (event) => {
      if (ws !== this.ws) return;
      this.stopPinging();
      this.stopRelay();
      if (this.closed) return;
      const now = performance.now();
      // "replaced": this identity reconnected from another tab, which now owns it.
      const replaced = event.code === 1000 && event.reason === "replaced";
      if (!replaced && this.you && this.resumeToken && (this.reconnectBy === 0 || now < this.reconnectBy)) {
        // Unexpected drop: try again until the room gives our seat away. The game
        // keeps running on predictions meanwhile, until its window runs out.
        if (this.reconnectBy === 0) this.reconnectBy = now + NETPLAY_RECONNECT_GRACE_MS - 1000;
        this.events.onStatus("reconnecting");
        this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
        return;
      }
      this.closed = true;
      if (this.session) {
        this.session = null;
        this.events.onEnd("disconnected");
      }
      this.events.onStatus("closed", event.reason || undefined);
    };
  }

  rename(name: string): void {
    this.send({ t: "rename", name });
  }

  react(kind: ReactionKind): void {
    this.send({ t: "react", kind });
  }

  requestStart(): void {
    this.send({ t: "start" });
  }

  selectRelay(selection: RelaySelection): void { this.send({ t: "relaySelect", selection }); }
  sendRelayPacket(packet: PeerPacket): void { this.relay?.send(packet); }

  /** Sit in `seat`, or stand up to spectate with null. Lobby only. */
  takeSeat(seat: number | null): void {
    this.send({ t: "seat", seat });
  }

  /** Round trip over the direct link (null when none), reported with our next latency probe. */
  setDirectRtt(ms: number | null): void {
    this.directRtt = ms;
  }

  sendSignal(to: string, data: unknown): void {
    this.send({ t: "signal", to, data });
  }

  sendSnapshot(frame: number, state: string): void {
    this.send({ t: "snapshot", f: frame, s: state });
  }

  sendInput(frame: number, mask: number, advantage?: number): void {
    this.send({ t: "input", f: frame, m: mask, a: advantage });
  }

  sendHash(frame: number, hash: number): void {
    this.send({ t: "hash", f: frame, h: hash });
  }

  close(): void {
    this.stopPinging();
    this.stopRelay();
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.closed = true;
    this.session = null;
    // "leave" tells the room we left on purpose: no seat is kept for us.
    this.ws.close(1000, "leave");
  }

  private ping() {
    // One probe in flight at a time; a lost one is simply replaced next interval.
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.pingSentAt = performance.now();
    this.raw(NETPLAY_PING);
  }

  private onPong() {
    if (this.pingSentAt === null) return;
    this.rtts.push(performance.now() - this.pingSentAt);
    this.pingSentAt = null;
    if (this.rtts.length > PING_SAMPLES) this.rtts.shift();
    const sorted = [...this.rtts].sort((a, b) => a - b);
    const rtt = sorted[sorted.length >> 1];
    this.events.onPing(rtt);
    // The room picks the game's input delay from every player's latest figure.
    this.send({ t: "rtt", ms: rtt, direct: this.directRtt });
  }

  private stopPinging() {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.probeTimer !== null) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  private stopRelay() { this.relay?.close(); this.relay = null; }

  private async probe() {
    if (this.closed || this.probing || this.room?.started || !this.room?.relay?.nodes.length) return;
    this.probing = true;
    try {
      const probes = await probeRelays(this.room.relay.nodes);
      // Measure the actual room socket, not a nearby Worker edge HTTP response.
      probes.unshift(summarizeProbe("main", this.rtts));
      if (!this.closed && !this.room?.started) this.send({ t: "relayProbes", probes });
    } finally { this.probing = false; }
  }

  private onMessage(message: ServerMessage) {
    switch (message.t) {
      case "welcome":
        this.you = message.you;
        this.connectionToken = message.connectionToken ?? null;
        this.resumeToken = message.resumeToken ?? null;
        this.reconnectBy = 0;
        this.retryMs = RETRY_FIRST_MS;
        if (this.resumeToken) this.events.onCredentials({ id: message.you, token: this.resumeToken });
        this.updateRoom(message.room);
        void this.probe();
        if (this.probeTimer !== null) clearInterval(this.probeTimer);
        this.probeTimer = setInterval(() => void this.probe(), 15_000);
        break;
      case "room":
        this.updateRoom(message.room);
        break;
      case "start": {
        const seat = this.room?.players.find((p) => p.id === this.you)?.seat ?? null;
        // Not seated in this game means watching it.
        const localSeat = seat !== null && message.seats.includes(seat) ? seat : null;
        this.session = this.events.onStart({
          seats: message.seats,
          localSeat,
          delay: message.delay,
          startFrame: message.from?.f ?? 0,
          snapshot: message.from?.s ?? null,
          inputs: message.inputs ?? [],
        });
        this.stopRelay();
        const node = this.room?.relay?.nodes.find((node) => node.id === this.room?.relay?.activeNodeId);
        if (node && this.connectionToken && this.room) {
          this.relay = new RelayLink(this.controlOrigin, this.room.info.id, this.connectionToken, node,
            (packet) => this.events.onRelayPacket(packet), (status) => this.events.onRelayStatus(status));
        }
        break;
      }
      case "input":
        this.session?.receive(message.s, message.f, message.m);
        if (message.a !== undefined && this.session && !this.session.spectating) {
          (this.session as RollbackSession).receiveAdvantage(message.a);
        }
        break;
      case "desync":
        this.events.onDesync(message.f);
        break;
      case "signal":
        this.events.onSignal(message.from, message.data);
        break;
      case "react":
        this.events.onReaction(message.from, message.kind);
        break;
      case "error":
        this.events.onError(message.code);
        break;
    }
  }

  private updateRoom(room: RoomState) {
    this.room = room;
    if (this.session && !room.started) {
      this.stopRelay();
      this.session = null;
      this.events.onEnd("peerLeft");
    }
    if (this.you) this.events.onRoom(room, this.you);
  }

  private send(message: ClientMessage) {
    this.raw(JSON.stringify(message));
  }

  private raw(data: string) {
    this.later("send", () => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
    });
  }

  /** Run `fn` now, or after the simulated one-way delay, never overtaking earlier messages. */
  private later(direction: "send" | "receive", fn: () => void) {
    if (!this.simulated) return fn();
    const now = performance.now();
    const delay = this.simulated.lagMs / 2 + Math.random() * this.simulated.jitterMs;
    const last = direction === "send" ? this.sendAt : this.receiveAt;
    const at = Math.max(last, now + delay);
    if (direction === "send") this.sendAt = at;
    else this.receiveAt = at;
    setTimeout(fn, at - now);
  }
}
