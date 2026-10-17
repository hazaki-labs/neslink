import { DurableObject } from "cloudflare:workers";
import {
  chooseInputDelay,
  NETPLAY_PING,
  NETPLAY_PONG,
  NETPLAY_SEATS,
  type ClientMessage,
  type RoomInfo,
  type RoomPlayer,
  type RoomState,
  type ServerMessage,
} from "@neslink/core/netplay";
import type { Env } from "./index";

/** A room with nobody connected is forgotten after this long. */
const IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONNECTIONS = 16;
/** Roughly 2 hours of two-player input without a snapshot; past that late spectators cannot sync. */
const MAX_LOGGED_INPUTS = 900_000;
/** Base64 of a save state is ~30KB; anything far larger is not one. */
const MAX_SNAPSHOT_CHARS = 512 * 1024;

/** Per-socket player data. Stored on the socket so it survives hibernation. */
interface Attachment extends RoomPlayer {
  joinedAt: number;
}

/**
 * What a spectator needs to join a game in progress: the latest snapshot and
 * every input since it. Kept in memory only; a running game keeps the object
 * awake, since inputs arrive every frame.
 */
interface Game {
  delay: number;
  seats: number[];
  snapshot: { f: number; s: string } | null;
  log: [seat: number, frame: number, mask: number][];
}

/**
 * One netplay room. People connect over WebSocket and either sit in a seat
 * or spectate; the host starts a game with whoever is seated. The room
 * relays each player's inputs to everyone else, compares the state hashes
 * players report to detect desyncs, and keeps snapshots so spectators can
 * join mid-game.
 *
 * Uses the hibernation API, so anything that must outlive an idle period
 * lives in storage (room info, host, started) or on the sockets (players).
 */
export class Room extends DurableObject<Env> {
  private info: RoomInfo | null = null;
  private hostId: string | null = null;
  private started = false;
  private game: Game | null = null;
  /** frame -> seat -> hash, until every seat has reported that frame. */
  private readonly hashes = new Map<number, Map<number, number>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered at the edge without waking the object, so latency probes are cheap.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(NETPLAY_PING, NETPLAY_PONG));
    ctx.blockConcurrencyWhile(async () => {
      this.info = (await ctx.storage.get<RoomInfo>("info")) ?? null;
      this.hostId = (await ctx.storage.get<string>("hostId")) ?? null;
      this.started = (await ctx.storage.get<boolean>("started")) ?? false;
    });
  }

  /** RPC: called once when the room is created. */
  async init(info: RoomInfo): Promise<void> {
    if (this.info) throw new Error("Room already exists");
    this.info = info;
    await this.ctx.storage.put("info", info);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_TTL_MS);
  }

  /** RPC: the room's info, or null if it does not exist. */
  async getInfo(): Promise<RoomInfo | null> {
    return this.info;
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.info) return new Response("Room not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) {
      return new Response("Room is full", { status: 503 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    let message: ClientMessage;
    try {
      message = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch {
      return this.send(ws, { t: "error", message: "Malformed message" });
    }
    const me = this.player(ws);

    switch (message.t) {
      case "hello":
        if (!me) await this.join(ws, message.name, message.romHash);
        break;
      case "seat":
        if (me) this.takeSeat(ws, me, message.seat);
        break;
      case "start":
        if (me) await this.start(ws, me);
        break;
      case "input":
        if (this.playing(me) && isFrame(message.f) && isMask(message.m)) {
          this.logInput(me.seat, message.f, message.m);
          this.broadcast({ t: "input", s: me.seat, f: message.f, m: message.m }, ws);
        }
        break;
      case "hash":
        if (this.playing(me) && isFrame(message.f) && Number.isInteger(message.h)) {
          this.checkHash(message.f, me.seat, message.h);
        }
        break;
      case "snapshot":
        if (this.playing(me) && isFrame(message.f) && typeof message.s === "string") {
          this.storeSnapshot(me.seat, message.f, message.s);
        }
        break;
      case "rtt":
        if (me && Number.isFinite(message.ms) && message.ms >= 0 && message.ms < 10_000) {
          me.rttMs = Math.round(message.ms);
          ws.serializeAttachment(me);
          // Shown in the lobby; during a game nobody looks, so skip the chatter.
          if (!this.started) this.broadcast({ t: "room", room: this.state() });
        }
        break;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_TTL_MS);
      return;
    }
    await this.ctx.storage.deleteAll();
    this.info = null;
  }

  private async join(ws: WebSocket, rawName: unknown, romHash: unknown) {
    const name = typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 20) : "玩家";
    const hash = typeof romHash === "string" ? romHash : "";
    // The first person in (the host, normally) sits down; everyone after starts as a
    // spectator and takes a free seat if they want to play.
    const seat = !this.started && hash === this.info!.romHash && !this.players().some((p) => p.seat !== null) ? 0 : null;
    const me: Attachment = {
      id: crypto.randomUUID().slice(0, 8),
      name,
      seat,
      romHash: hash,
      rttMs: null,
      joinedAt: Date.now(),
    };
    ws.serializeAttachment(me);
    if (!this.hostId || !this.players().some((p) => p.id === this.hostId)) {
      this.hostId = me.id;
      await this.ctx.storage.put("hostId", me.id);
    }
    this.send(ws, { t: "welcome", you: me.id, room: this.state() });
    this.broadcast({ t: "room", room: this.state() }, ws);
    if (this.started) this.sendGameInProgress(ws, me);
  }

  /** Bring a spectator arriving mid-game up to date: snapshot plus every input since. */
  private sendGameInProgress(ws: WebSocket, me: Attachment) {
    if (me.romHash !== this.info!.romHash) return;
    const game = this.game;
    if (!game || game.log.length >= MAX_LOGGED_INPUTS) {
      return this.send(ws, { t: "error", message: "这局开始太久了，暂时无法中途观战" });
    }
    this.send(ws, {
      t: "start",
      delay: game.delay,
      seats: game.seats,
      from: game.snapshot ?? undefined,
      inputs: game.log,
    });
  }

  private takeSeat(ws: WebSocket, me: Attachment, seat: unknown) {
    if (this.started) return this.send(ws, { t: "error", message: "对局进行中，不能换座位" });
    if (seat === null) {
      me.seat = null;
    } else {
      if (!Number.isInteger(seat) || (seat as number) < 0 || (seat as number) >= NETPLAY_SEATS) return;
      if (me.romHash !== this.info!.romHash) return this.send(ws, { t: "error", message: "你的 ROM 和房间不一致，无法入座" });
      if (this.players().some((p) => p.seat === seat && p.id !== me.id)) {
        return this.send(ws, { t: "error", message: "这个座位已经有人了" });
      }
      me.seat = seat as number;
    }
    ws.serializeAttachment(me);
    this.broadcast({ t: "room", room: this.state() });
  }

  private async start(ws: WebSocket, me: Attachment) {
    if (me.id !== this.hostId) return this.send(ws, { t: "error", message: "只有房主可以开始游戏" });
    if (this.started) return;
    const seated = this.players().filter((p) => p.seat !== null);
    if (seated.length === 0) return this.send(ws, { t: "error", message: "至少要有一个人入座" });
    // Just enough delay for an input to cross between the players, measured now.
    const delay = chooseInputDelay(seated.map((p) => p.rttMs));
    const seats = seated.map((p) => p.seat!).sort((a, b) => a - b);
    this.game = { delay, seats, snapshot: null, log: [] };
    this.started = true;
    this.hashes.clear();
    await this.ctx.storage.put("started", true);
    this.broadcast({ t: "room", room: this.state() });
    this.broadcast({ t: "start", delay, seats });
  }

  private async leave(ws: WebSocket) {
    const me = this.player(ws);
    ws.serializeAttachment(null);
    try {
      ws.close(1000, "bye");
    } catch {
      // Already closed.
    }
    if (!me) return;
    // A seated player leaving ends the game: lockstep cannot continue without them.
    // Spectators come and go freely.
    if (me.seat !== null && this.started) {
      this.started = false;
      this.game = null;
      await this.ctx.storage.put("started", false);
    }
    if (me.id === this.hostId) {
      this.hostId = this.players()[0]?.id ?? null;
      await this.ctx.storage.put("hostId", this.hostId);
    }
    if (this.ctx.getWebSockets().length <= 1) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_TTL_MS);
    }
    this.broadcast({ t: "room", room: this.state() }, ws);
  }

  private logInput(seat: number, frame: number, mask: number) {
    const log = this.game?.log;
    if (log && log.length < MAX_LOGGED_INPUTS) log.push([seat, frame, mask]);
  }

  private storeSnapshot(seat: number, frame: number, state: string) {
    const game = this.game;
    // One player supplies snapshots so they all describe the same timeline.
    if (!game || seat !== game.seats[0] || state.length > MAX_SNAPSHOT_CHARS) return;
    if (game.snapshot && frame <= game.snapshot.f) return;
    game.snapshot = { f: frame, s: state };
    // Inputs before the snapshot are inside it now.
    game.log = game.log.filter(([, f]) => f >= frame);
  }

  private checkHash(frame: number, seat: number, hash: number) {
    const players = this.game?.seats.length ?? NETPLAY_SEATS;
    let reports = this.hashes.get(frame);
    if (!reports) this.hashes.set(frame, (reports = new Map()));
    reports.set(seat, hash);
    if (reports.size < players) return;
    this.hashes.delete(frame);
    if (new Set(reports.values()).size > 1) this.broadcast({ t: "desync", f: frame });
  }

  /** Narrows to a player seated in the running game. */
  private playing(me: Attachment | null): me is Attachment & { seat: number } {
    return me !== null && me.seat !== null && this.started;
  }

  private player(ws: WebSocket): Attachment | null {
    return (ws.deserializeAttachment() as Attachment | null) ?? null;
  }

  private players(): Attachment[] {
    return this.ctx
      .getWebSockets()
      .map((ws) => this.player(ws))
      .filter((p): p is Attachment => p !== null)
      .sort((a, b) => a.joinedAt - b.joinedAt);
  }

  private state(): RoomState {
    return {
      info: this.info!,
      hostId: this.hostId,
      started: this.started,
      players: this.players().map(({ id, name, seat, romHash, rttMs }) => ({ id, name, seat, romHash, rttMs })),
    };
  }

  private send(ws: WebSocket, message: ServerMessage) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Socket closing; webSocketClose will clean up.
    }
  }

  private broadcast(message: ServerMessage, except?: WebSocket) {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || !this.player(ws)) continue;
      try {
        ws.send(payload);
      } catch {
        // Socket closing; webSocketClose will clean up.
      }
    }
  }
}

function isFrame(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isMask(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xff;
}
