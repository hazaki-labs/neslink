import {
  type LockstepSession,
  NETPLAY_PING,
  NETPLAY_PONG,
  type ClientMessage,
  type NetStatus,
  type RoomEndReason,
  type RoomErrorCode,
  type RollbackSession,
  type RoomState,
  type ServerMessage,
} from "@neslink/core";

/** A seated player rolls back; a spectator follows confirmed inputs in lockstep. */
export type NetSession = RollbackSession | LockstepSession;

export interface GameStart {
  seats: number[];
  /** Our seat in this game, or null to watch it. */
  localSeat: number | null;
  delay: number;
  /** Frame to start from: 0 (power-on) or a snapshot's frame. */
  startFrame: number;
  /** Base64 save state for a late spectator, else null. */
  snapshot: string | null;
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
}

/** Extra latency to simulate on this link (dev tool, from `?lag=` / `?jitter=`). */
export interface SimulatedNetwork {
  /** Added round trip, split evenly between the two directions. */
  lagMs: number;
  /** Up to this much more per message, at random (order is kept, as on a real socket). */
  jitterMs: number;
}

const PING_INTERVAL_MS = 1000;
const PING_SAMPLES = 5;

/** One player's connection to a room: the socket plus the game session once started. */
export class NetplayLink {
  session: NetSession | null = null;
  private readonly ws: WebSocket;
  private you: string | null = null;
  private room: RoomState | null = null;
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSentAt: number | null = null;
  private readonly rtts: number[] = [];
  private sendAt = 0;
  private receiveAt = 0;

  constructor(
    url: string,
    hello: { name: string; romHash: string },
    private readonly events: NetplayEvents,
    private readonly simulated: SimulatedNetwork | null = null,
  ) {
    events.onStatus("connecting");
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      events.onStatus("open");
      this.send({ t: "hello", ...hello });
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
    };
    this.ws.onmessage = (event) =>
      this.later("receive", () => {
        if (this.closed && event.data !== NETPLAY_PONG) return;
        if (event.data === NETPLAY_PONG) return this.onPong();
        this.onMessage(JSON.parse(event.data as string) as ServerMessage);
      });
    this.ws.onclose = (event) => {
      this.stopPinging();
      if (this.closed) return;
      this.closed = true;
      if (this.session) {
        this.session = null;
        events.onEnd("disconnected");
      }
      events.onStatus("closed", event.reason || undefined);
    };
  }

  requestStart(): void {
    this.send({ t: "start" });
  }

  /** Sit in `seat`, or stand up to spectate with null. Lobby only. */
  takeSeat(seat: number | null): void {
    this.send({ t: "seat", seat });
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
    this.closed = true;
    this.session = null;
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
    this.send({ t: "rtt", ms: rtt });
  }

  private stopPinging() {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private onMessage(message: ServerMessage) {
    switch (message.t) {
      case "welcome":
        this.you = message.you;
        this.updateRoom(message.room);
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
        });
        for (const [s, f, m] of message.inputs ?? []) this.session?.receive(s, f, m);
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
      case "error":
        this.events.onError(message.code);
        break;
    }
  }

  private updateRoom(room: RoomState) {
    this.room = room;
    if (this.session && !room.started) {
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
