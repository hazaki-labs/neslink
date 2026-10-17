import { DurableObject } from "cloudflare:workers";
import {
  NETPLAY_INPUT_DELAY,
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
const MAX_CONNECTIONS = 8;

/** Per-socket player data. Stored on the socket so it survives hibernation. */
interface Attachment extends RoomPlayer {
  joinedAt: number;
}

/**
 * One netplay room. Players connect over WebSocket; the room assigns seats,
 * starts the game, relays each player's inputs to the others and compares
 * the state hashes they report to detect desyncs.
 *
 * Uses the hibernation API, so anything that must outlive an idle period
 * lives in storage (room info, host, started) or on the sockets (players).
 */
export class Room extends DurableObject<Env> {
  private info: RoomInfo | null = null;
  private hostId: string | null = null;
  private started = false;
  /** frame -> seat -> hash, until every seat has reported that frame. */
  private readonly hashes = new Map<number, Map<number, number>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
      case "start":
        if (me) await this.start(ws, me);
        break;
      case "input":
        if (me?.seat != null && this.started && isFrame(message.f) && isMask(message.m)) {
          this.broadcast({ t: "input", s: me.seat, f: message.f, m: message.m }, ws);
        }
        break;
      case "hash":
        if (me?.seat != null && this.started && isFrame(message.f) && Number.isInteger(message.h)) {
          this.checkHash(message.f, me.seat, message.h);
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
    const taken = new Set(this.players().map((p) => p.seat));
    // Seats are handed out only before the game starts and only to players with the right ROM.
    let seat: number | null = null;
    if (!this.started && hash === this.info!.romHash) {
      for (let s = 0; s < NETPLAY_SEATS; s++) {
        if (!taken.has(s)) {
          seat = s;
          break;
        }
      }
    }
    const me: Attachment = { id: crypto.randomUUID().slice(0, 8), name, seat, romHash: hash, joinedAt: Date.now() };
    ws.serializeAttachment(me);
    if (!this.hostId || !this.players().some((p) => p.id === this.hostId)) {
      this.hostId = me.id;
      await this.ctx.storage.put("hostId", me.id);
    }
    this.send(ws, { t: "welcome", you: me.id, room: this.state() });
    this.broadcast({ t: "room", room: this.state() }, ws);
  }

  private async start(ws: WebSocket, me: Attachment) {
    if (me.id !== this.hostId) return this.send(ws, { t: "error", message: "只有房主可以开始游戏" });
    if (this.started) return;
    const seated = this.players().filter((p) => p.seat !== null);
    if (seated.length < NETPLAY_SEATS) return this.send(ws, { t: "error", message: "还在等待玩家加入" });
    this.started = true;
    this.hashes.clear();
    await this.ctx.storage.put("started", true);
    this.broadcast({ t: "room", room: this.state() });
    this.broadcast({ t: "start", delay: NETPLAY_INPUT_DELAY });
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
    if (me.seat !== null && this.started) {
      this.started = false;
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

  private checkHash(frame: number, seat: number, hash: number) {
    let reports = this.hashes.get(frame);
    if (!reports) this.hashes.set(frame, (reports = new Map()));
    reports.set(seat, hash);
    if (reports.size < NETPLAY_SEATS) return;
    this.hashes.delete(frame);
    if (new Set(reports.values()).size > 1) this.broadcast({ t: "desync", f: frame });
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
      players: this.players().map(({ id, name, seat, romHash }) => ({ id, name, seat, romHash })),
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
