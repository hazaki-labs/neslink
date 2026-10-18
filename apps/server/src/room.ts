import { DurableObject } from "cloudflare:workers";
import {
  chooseRelayInputDelay,
  NETPLAY_PING,
  NETPLAY_PONG,
  NETPLAY_SEATS,
  type ClientMessage,
  type RoomInfo,
  type RoomPlayer,
  type RoomState,
  type ServerMessage,
  type RelayProbe,
  type RelaySelection,
  recommendRelay,
} from "@neslink/core/netplay";
import type { Env } from "./index";
import { relayKey, relayNodes } from "./relays";
import { issueTicket } from "@neslink/relay-auth";

/** A room with nobody connected is forgotten after this long. */
const IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONNECTIONS = 16;
/** Roughly 2 hours of two-player input without a snapshot; past that late spectators cannot sync. */
const MAX_LOGGED_INPUTS = 900_000;
/** Base64 of a save state is ~30KB; anything far larger is not one. */
const MAX_SNAPSHOT_CHARS = 512 * 1024;
/** SDP offers with many candidates run a few KB; this is generous. */
const MAX_SIGNAL_CHARS = 32 * 1024;

/** Per-socket player data. Stored on the socket so it survives hibernation. */
interface Attachment extends RoomPlayer {
  joinedAt: number;
  connectionToken: string;
  ticketAt: number;
  probedAt: number;
}

/**
 * What a spectator needs to join a game in progress: the latest snapshot and
 * every input since it. Kept in memory only; a running game keeps the object
 * awake, since inputs arrive every frame.
 */
interface Game {
  id: string;
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
  private selection: RelaySelection = { mode: "auto", nodeId: null };
  private activeNodeId: string | null = null;
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
      this.selection = (await ctx.storage.get<RelaySelection>("relaySelection")) ?? this.selection;
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

  /** Only a live room connection can request a ticket; its token is never broadcast. */
  async relayTicket(connectionToken: string, origin: string) {
    const ws = this.ctx.getWebSockets().find((socket) => this.player(socket)?.connectionToken === connectionToken);
    const me = ws && this.player(ws);
    if (!this.info || !me || !this.started || !this.game) return { status: 403, body: { error: "connectionDenied" } };
    const node = relayNodes(this.env).find((node) => node.id === this.activeNodeId);
    if (!node) return { status: 409, body: { error: "relayUnavailable" } };
    const now = Date.now();
    if (now - me.ticketAt < 2000) return { status: 429, body: { error: "tooManyRequests" } };
    me.ticketAt = now;
    ws!.serializeAttachment(me);
    try {
      const grant = await issueTicket(node.id, this.info, origin, relayKey(this.env, node.id), {
        playerId: me.id, seat: me.seat, gameId: this.game.id,
      });
      return { status: 200, body: { ...grant, node } };
    } catch {
      return { status: 503, body: { error: "relayUnavailable" } };
    }
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
    if ((typeof data === "string" ? data.length : data.byteLength) > 600_000) {
      ws.close(1009, "Message too large"); return;
    }
    let message: ClientMessage;
    try {
      message = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch {
      return this.send(ws, { t: "error", code: "malformed" });
    }
    const me = this.player(ws);

    if (!message || typeof message !== "object" || typeof message.t !== "string") {
      return this.send(ws, { t: "error", code: "malformed" });
    }

    switch (message.t) {
      case "relaySelect":
        if (!me) break;
        if (me.id !== this.hostId) return this.send(ws, { t: "error", code: "notHost" });
        if (this.started) return this.send(ws, { t: "error", code: "nodeLocked" });
        if (!message.selection || !["auto", "manual"].includes(message.selection.mode) ||
            (message.selection.nodeId !== null && !relayNodes(this.env).some((node) => node.id === message.selection.nodeId))) {
          return this.send(ws, { t: "error", code: "malformed" });
        }
        this.selection = { mode: message.selection.mode, nodeId: message.selection.mode === "auto" ? null : message.selection.nodeId };
        await this.ctx.storage.put("relaySelection", this.selection);
        this.broadcast({ t: "room", room: this.state() });
        break;
      case "relayProbes": {
        if (!me || this.started || Date.now() - me.probedAt < 4000) break;
        const allowed = new Set(["main", ...relayNodes(this.env).map((node) => node.id)]);
        if (!Array.isArray(message.probes) || message.probes.length > allowed.size) break;
        const probes: RelayProbe[] = [];
        for (const probe of message.probes) {
          if (!probe || !allowed.delete(probe.nodeId) ||
              (probe.rttMs !== null && (!Number.isFinite(probe.rttMs) || probe.rttMs < 0 || probe.rttMs > 10_000)) ||
              (probe.jitterMs !== null && (!Number.isFinite(probe.jitterMs) || probe.jitterMs < 0 || probe.jitterMs > 10_000))) return;
          probes.push({ nodeId: probe.nodeId, rttMs: probe.rttMs, jitterMs: probe.jitterMs });
        }
        me.relayProbes = probes; me.probedAt = Date.now();
        ws.serializeAttachment(me);
        this.broadcast({ t: "room", room: this.state() });
        break;
      }
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
          const a = Number.isInteger(message.a) ? message.a : undefined;
          this.broadcast({ t: "input", s: me.seat, f: message.f, m: message.m, a }, ws);
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
      case "signal":
        if (me && typeof message.to === "string") this.relaySignal(me, message.to, message.data);
        break;
      case "rtt":
        if (me && Number.isFinite(message.ms) && message.ms >= 0 && message.ms < 10_000) {
          me.rttMs = Math.round(message.ms);
          const direct = message.direct;
          me.directRttMs = typeof direct === "number" && Number.isFinite(direct) && direct >= 0 && direct < 10_000 ? Math.round(direct) : null;
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
    const name = typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 20) : "Player";
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
      directRttMs: null,
      joinedAt: Date.now(),
      connectionToken: crypto.randomUUID() + crypto.randomUUID(),
      ticketAt: 0,
      probedAt: 0,
    };
    ws.serializeAttachment(me);
    if (!this.hostId || !this.players().some((p) => p.id === this.hostId)) {
      this.hostId = me.id;
      await this.ctx.storage.put("hostId", me.id);
    }
    this.send(ws, { t: "welcome", you: me.id, room: this.state(), connectionToken: me.connectionToken });
    this.broadcast({ t: "room", room: this.state() }, ws);
    if (this.started) this.sendGameInProgress(ws, me);
  }

  /** Bring a spectator arriving mid-game up to date: snapshot plus every input since. */
  private sendGameInProgress(ws: WebSocket, me: Attachment) {
    if (me.romHash !== this.info!.romHash) return;
    const game = this.game;
    if (!game || game.log.length >= MAX_LOGGED_INPUTS) {
      return this.send(ws, { t: "error", code: "lateJoinUnavailable" });
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
    if (this.started) return this.send(ws, { t: "error", code: "seatLocked" });
    if (seat === null) {
      me.seat = null;
    } else {
      if (!Number.isInteger(seat) || (seat as number) < 0 || (seat as number) >= NETPLAY_SEATS) return;
      if (me.romHash !== this.info!.romHash) return this.send(ws, { t: "error", code: "romMismatch" });
      if (this.players().some((p) => p.seat === seat && p.id !== me.id)) {
        return this.send(ws, { t: "error", code: "seatTaken" });
      }
      me.seat = seat as number;
    }
    ws.serializeAttachment(me);
    this.broadcast({ t: "room", room: this.state() });
  }

  private async start(ws: WebSocket, me: Attachment) {
    if (me.id !== this.hostId) return this.send(ws, { t: "error", code: "notHost" });
    if (this.started) return;
    const seated = this.players().filter((p) => p.seat !== null);
    if (seated.length === 0) return this.send(ws, { t: "error", code: "noPlayers" });
    // Players roll back, so a small delay (from latency measured now, over a
    // direct link if both have one) is enough; prediction covers the rest.
    const activeNodeId = this.state().relay!.activeNodeId;
    const delay = chooseRelayInputDelay(seated.map((player) => ({ ...player,
      relayProbes: Date.now() - player.probedAt < 45_000 ? player.relayProbes : [],
    })), activeNodeId);
    const seats = seated.map((p) => p.seat!).sort((a, b) => a - b);
    this.activeNodeId = activeNodeId;
    this.game = { id: crypto.randomUUID(), delay, seats, snapshot: null, log: [] };
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

  /** Pass WebRTC signaling between two people in the room, so players can connect directly. */
  private relaySignal(me: Attachment, to: string, data: unknown) {
    if (JSON.stringify(data ?? null).length > MAX_SIGNAL_CHARS) return;
    for (const ws of this.ctx.getWebSockets()) {
      if (this.player(ws)?.id === to) return this.send(ws, { t: "signal", from: me.id, data });
    }
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
    if (this.hashes.size > 120) this.hashes.delete(this.hashes.keys().next().value!);
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
    const nodes = relayNodes(this.env);
    const players = this.players().map((player) => ({
      ...player,
      relayProbes: Date.now() - (player.probedAt ?? 0) < 45_000 ? player.relayProbes ?? [] : [],
    }));
    const recommendedNodeId = recommendRelay(nodes, players);
    return {
      info: this.info!,
      hostId: this.hostId,
      started: this.started,
      relay: { nodes, selection: this.selection, recommendedNodeId,
        activeNodeId: this.started ? this.activeNodeId : this.selection.mode === "auto" ? recommendedNodeId : this.selection.nodeId },
      players: players.map(({ id, name, seat, romHash, rttMs, directRttMs, relayProbes }) => ({
        id,
        name,
        seat,
        romHash,
        rttMs,
        directRttMs: directRttMs ?? null,
        relayProbes,
      })),
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
