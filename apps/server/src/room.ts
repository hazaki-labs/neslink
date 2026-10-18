import { DurableObject } from "cloudflare:workers";
import {
  chooseNetplayDelay,
  NETPLAY_PING,
  NETPLAY_MAX_MASK,
  NETPLAY_PONG,
  NETPLAY_RECONNECT_GRACE_MS,
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
/** Fewest milliseconds between two reactions from one player. */
const REACTION_SPACING_MS = 400;

/** Per-socket player data. Stored on the socket so it survives hibernation. */
interface Attachment extends RoomPlayer {
  joinedAt: number;
  connectionToken: string;
  ticketAt: number;
  probedAt: number;
  awaitingSnapshot?: boolean;
  /** Secret that lets this tab rejoin as this player after a drop. */
  resumeToken: string;
}

/** A seated player who dropped without leaving; their seat is kept until `until`. */
interface PendingPlayer extends Attachment {
  until: number;
}

/** Persisted at start so tickets keep the same scope after object recovery. */
interface ActiveGame {
  id: string;
  delay: number;
  seats: number[];
  activeNodeId: string | null;
  /** Seats of the game nobody plays; the first seat's player stands in for them. */
  vacant?: number[];
}

/** Snapshot/input history stays in memory; running inputs keep the object awake. */
interface Game extends ActiveGame {
  /** After object recovery, wait for a fresh snapshot before admitting spectators. */
  historyComplete: boolean;
  /** `loaded`: a state seat `seat` loaded at `f` (its NETPLAY_LOAD there is already applied). */
  snapshot: { f: number; s: string; loaded?: boolean; seat?: number } | null;
  log: [seat: number, frame: number, mask: number][];
  /** seat -> newest frame logged for it, to pick up from when it falls vacant. */
  lastInput: Map<number, number>;
  /** A spectator taking a vacant seat, while the stand-in finishes (see `handover`). */
  handover: { id: string; seat: number } | null;
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
  /** Seated players who dropped and may come back, by id. Persisted. */
  private pending = new Map<string, PendingPlayer>();
  /** id -> last reaction time, for rate limiting. */
  private readonly reactedAt = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered at the edge without waking the object, so latency probes are cheap.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(NETPLAY_PING, NETPLAY_PONG));
    ctx.blockConcurrencyWhile(async () => {
      this.info = (await ctx.storage.get<RoomInfo>("info")) ?? null;
      this.hostId = (await ctx.storage.get<string>("hostId")) ?? null;
      this.started = (await ctx.storage.get<boolean>("started")) ?? false;
      this.selection = (await ctx.storage.get<RelaySelection>("relaySelection")) ?? this.selection;
      for (const p of (await ctx.storage.get<PendingPlayer[]>("pending")) ?? []) this.pending.set(p.id, p);
      const active = await ctx.storage.get<ActiveGame>("activeGame");
      if (this.started && active) {
        this.activeNodeId = active.activeNodeId;
        // History saved while someone was reconnecting lets them (and spectators) resume right away.
        const history = await ctx.storage.get<Pick<Game, "snapshot" | "log">>("gameHistory");
        this.game = history
          ? { ...active, historyComplete: true, snapshot: history.snapshot, log: history.log, lastInput: new Map(), handover: null }
          : { ...active, historyComplete: false, snapshot: null, log: [], lastInput: new Map(), handover: null };
      } else if (this.started) {
        // Old deployments persisted only started, without enough data to resume.
        this.started = false;
        await ctx.storage.put("started", false);
        this.broadcast({ t: "room", room: this.state() });
      }
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
        if (!me) await this.join(ws, message.name, message.romHash, message.resume);
        break;
      case "rename":
        if (me && typeof message.name === "string" && message.name.trim()) {
          me.name = message.name.trim().slice(0, 20);
          ws.serializeAttachment(me);
          this.broadcast({ t: "room", room: this.state() });
        }
        break;
      case "react": {
        if (!me || message.kind !== "thumbs") break;
        const now = Date.now();
        if (now - (this.reactedAt.get(me.id) ?? 0) < REACTION_SPACING_MS) break;
        this.reactedAt.set(me.id, now);
        this.broadcast({ t: "react", from: me.id, kind: "thumbs" }, ws);
        break;
      }
      case "seat":
        if (me) this.takeSeat(ws, me, message.seat);
        break;
      case "start":
        if (me) await this.start(ws, me);
        break;
      case "input":
        if (this.playing(me) && isFrame(message.f) && isMask(message.m)) {
          // Standing in for a vacant seat: only the first seat's player, only while it is vacant.
          const seat = message.s === undefined ? me.seat : message.s;
          if (seat !== me.seat && !(me.seat === this.game?.seats[0] && this.game.vacant?.includes(seat))) break;
          this.logInput(seat, message.f, message.m);
          // While someone is reconnecting, keep the history they will resume from safe.
          if (this.pending.size > 0) await this.saveHistory();
          const a = seat === me.seat && Number.isInteger(message.a) ? message.a : undefined;
          this.broadcast({ t: "input", s: seat, f: message.f, m: message.m, a }, ws);
        }
        break;
      case "handedOver":
        if (this.playing(me) && isFrame(message.f) && Number.isInteger(message.s)) await this.handedOver(me, message.s, message.f);
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
      case "load":
        if (this.playing(me) && isFrame(message.f) && typeof message.s === "string" && message.s.length <= MAX_SNAPSHOT_CHARS) {
          await this.loadState(ws, me.seat, message.f, message.s);
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

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // "Leave room" closes with 1000 "leave"; anything else (refresh, network drop) may come back.
    await this.leave(ws, code === 1000 && reason === "leave");
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.leave(ws, false);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.pending) {
      if (p.until > now) continue;
      this.pending.delete(id);
      changed = true;
      await this.dropped(p);
    }
    if (changed) {
      await this.ctx.storage.put("pending", [...this.pending.values()]);
      this.broadcast({ t: "room", room: this.state() });
    }
    if (this.ctx.getWebSockets().length === 0 && this.pending.size === 0) {
      await this.ctx.storage.deleteAll();
      this.info = null;
      return;
    }
    await this.scheduleAlarm();
  }

  /** Next alarm: the earliest reconnect deadline, else the idle TTL. */
  private async scheduleAlarm() {
    const deadlines = [...this.pending.values()].map((p) => p.until);
    await this.ctx.storage.setAlarm(deadlines.length ? Math.min(...deadlines) : Date.now() + IDLE_TTL_MS);
  }

  /** A player is gone for good: end their game, hand on the host role. */
  private async dropped(me: Attachment) {
    const game = this.game;
    if (me.seat !== null && this.started && game?.seats.includes(me.seat)) {
      if (game.handover?.id === me.id) {
        // Left before the stand-in handed the seat over: `handedOver` sends it back.
        game.handover = null;
      } else if (me.seat !== game.seats[0] && this.firstSeatPlayer()) {
        // Another seat empties: the game goes on, and someone watching may take it.
        await this.vacate(me.seat);
      } else {
        // Without the first seat the game cannot go on.
        this.started = false;
        this.game = null;
        await this.ctx.storage.put({ started: false, activeGame: null });
        await this.ctx.storage.delete("gameHistory");
      }
    }
    if (me.id === this.hostId) {
      this.hostId = this.players()[0]?.id ?? [...this.pending.values()][0]?.id ?? null;
      await this.ctx.storage.put("hostId", this.hostId);
    }
  }

  /** The first seat's player, still connected or about to reconnect. */
  private firstSeatPlayer(): Attachment | null {
    const first = this.game?.seats[0];
    return [...this.players(), ...this.pending.values()].find((p) => p.seat === first) ?? null;
  }

  private async saveActiveGame() {
    const game = this.game;
    if (!game) return;
    const active: ActiveGame = { id: game.id, delay: game.delay, seats: game.seats, activeNodeId: game.activeNodeId, vacant: game.vacant };
    await this.ctx.storage.put("activeGame", active);
  }

  /** Seat `seat` has nobody now: the first seat's player fills it in from its last logged frame. */
  private async vacate(seat: number) {
    const game = this.game!;
    game.vacant = [...new Set([...(game.vacant ?? []), seat])];
    await this.saveActiveGame();
    const last = game.lastInput.get(seat);
    this.sendToFirstSeat({ t: "standIn", s: seat, f: last === undefined ? undefined : last + 1 });
  }

  private sendToFirstSeat(message: ServerMessage) {
    const first = this.game?.seats[0];
    const ws = this.ctx.getWebSockets().find((socket) => this.player(socket)?.seat === first);
    if (ws) this.send(ws, message);
  }

  /**
   * A spectator sits in a vacant seat of the running game. The stand-in stops
   * first and reports where (`handedOver`), so the room's log is complete before
   * the newcomer joins from it, as someone rejoining would.
   */
  private takeOver(ws: WebSocket, me: Attachment, seat: number) {
    const game = this.game!;
    if (!game.vacant?.includes(seat) || game.handover) return this.send(ws, { t: "error", code: "seatTaken" });
    if (me.seat !== null) return this.send(ws, { t: "error", code: "seatLocked" });
    if (me.romHash !== this.info!.romHash) return this.send(ws, { t: "error", code: "romMismatch" });
    if (!this.ctx.getWebSockets().some((socket) => this.player(socket)?.seat === game.seats[0])) {
      return this.send(ws, { t: "error", code: "playerReconnecting" });
    }
    me.seat = seat;
    ws.serializeAttachment(me);
    game.handover = { id: me.id, seat };
    this.sendToFirstSeat({ t: "handover", s: seat });
    this.broadcast({ t: "room", room: this.state() });
  }

  private async handedOver(me: Attachment, seat: number, frame: number) {
    const game = this.game!;
    if (me.seat !== game.seats[0] || !game.vacant?.includes(seat)) return;
    const handover = game.handover?.seat === seat ? game.handover : null;
    const ws = handover && this.ctx.getWebSockets().find((socket) => this.player(socket)?.id === handover.id);
    const newcomer = ws && this.player(ws);
    if (!newcomer) {
      // They left meanwhile: keep standing in.
      game.handover = null;
      return this.sendToFirstSeat({ t: "standIn", s: seat, f: frame + 1 });
    }
    game.handover = null;
    game.vacant = game.vacant.filter((s) => s !== seat);
    await this.saveActiveGame();
    this.broadcast({ t: "room", room: this.state() });
    this.sendGameInProgress(ws, newcomer);
  }

  private async saveHistory() {
    if (this.game) await this.ctx.storage.put("gameHistory", { snapshot: this.game.snapshot, log: this.game.log });
  }

  private async join(ws: WebSocket, rawName: unknown, romHash: unknown, resume: unknown) {
    if (await this.rejoin(ws, resume)) return;
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
      resumeToken: crypto.randomUUID() + crypto.randomUUID(),
    };
    ws.serializeAttachment(me);
    if (!this.hostId || ![...this.players(), ...this.pending.values()].some((p) => p.id === this.hostId)) {
      this.hostId = me.id;
      await this.ctx.storage.put("hostId", me.id);
    }
    this.send(ws, { t: "welcome", you: me.id, room: this.state(), connectionToken: me.connectionToken, resumeToken: me.resumeToken });
    this.broadcast({ t: "room", room: this.state() }, ws);
    if (this.started) this.sendGameInProgress(ws, me);
  }

  /**
   * Take a returning player back as who they were: their seat, name and id.
   * They may also return over a new socket before the room noticed the old one
   * is dead; then the old one is retired. Returns false for anyone else.
   */
  private async rejoin(ws: WebSocket, resume: unknown): Promise<boolean> {
    if (!resume || typeof resume !== "object") return false;
    const { id, token } = resume as { id?: unknown; token?: unknown };
    if (typeof id !== "string" || typeof token !== "string") return false;
    let previous: Attachment | undefined = this.pending.get(id);
    if (previous) {
      if (previous.resumeToken !== token) return false;
      this.pending.delete(id);
      await this.ctx.storage.put("pending", [...this.pending.values()]);
    } else {
      const stale = this.ctx.getWebSockets().find((socket) => socket !== ws && this.player(socket)?.id === id);
      const attachment = stale && this.player(stale);
      if (!attachment || attachment.resumeToken !== token) return false;
      stale!.serializeAttachment(null);
      try {
        stale!.close(1000, "replaced");
      } catch {
        // Already gone.
      }
      previous = attachment;
    }
    const { until: _until, ...rest } = previous as PendingPlayer;
    const me: Attachment = { ...rest, connectionToken: crypto.randomUUID() + crypto.randomUUID(), ticketAt: 0, probedAt: 0 };
    ws.serializeAttachment(me);
    this.send(ws, { t: "welcome", you: me.id, room: this.state(), connectionToken: me.connectionToken, resumeToken: me.resumeToken });
    this.broadcast({ t: "room", room: this.state() }, ws);
    if (this.started) this.sendGameInProgress(ws, me);
    if (this.pending.size === 0) await this.ctx.storage.delete("gameHistory");
    await this.scheduleAlarm();
    return true;
  }

  /** Bring a spectator arriving mid-game up to date: snapshot plus every input since. */
  private sendGameInProgress(ws: WebSocket, me: Attachment) {
    if (me.romHash !== this.info!.romHash) return;
    const game = this.game;
    if (!game || game.log.length >= MAX_LOGGED_INPUTS) {
      return this.send(ws, { t: "error", code: "lateJoinUnavailable" });
    }
    if (!game.historyComplete) {
      me.awaitingSnapshot = true;
      ws.serializeAttachment(me);
      return;
    }
    me.awaitingSnapshot = false;
    ws.serializeAttachment(me);
    this.send(ws, {
      t: "start",
      delay: game.delay,
      seats: game.seats,
      from: game.snapshot ? { f: game.snapshot.f, s: game.snapshot.s, loaded: game.snapshot.loaded } : undefined,
      inputs: game.log,
      vacant: game.vacant ?? [],
    });
  }

  private takeSeat(ws: WebSocket, me: Attachment, seat: unknown) {
    if (this.started) {
      if (!Number.isInteger(seat) || !this.game) return this.send(ws, { t: "error", code: "seatLocked" });
      return this.takeOver(ws, me, seat as number);
    }
    if (seat === null) {
      me.seat = null;
    } else {
      if (!Number.isInteger(seat) || (seat as number) < 0 || (seat as number) >= NETPLAY_SEATS) return;
      if (me.romHash !== this.info!.romHash) return this.send(ws, { t: "error", code: "romMismatch" });
      if ([...this.players(), ...this.pending.values()].some((p) => p.seat === seat && p.id !== me.id)) {
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
    if ([...this.pending.values()].some((p) => p.seat !== null)) return this.send(ws, { t: "error", code: "playerReconnecting" });
    const seated = this.players().filter((p) => p.seat !== null);
    if (seated.length === 0) return this.send(ws, { t: "error", code: "noPlayers" });
    // Players roll back, so a small delay (from latency measured now, over a
    // direct link if both have one) is enough; prediction covers the rest.
    const activeNodeId = this.state().relay!.activeNodeId;
    // HTTP probes do not prove that a relay can authenticate. Keep enough delay
    // for the established room/direct route even if relay admission later fails.
    const delay = chooseNetplayDelay(seated);
    const taken = seated.map((p) => p.seat!).sort((a, b) => a - b);
    // With 1P there, every seat plays: empty ones are stood in for until someone sits down.
    const seats = taken[0] === 0 ? Array.from({ length: NETPLAY_SEATS }, (_, seat) => seat) : taken;
    const vacant = seats.filter((seat) => !taken.includes(seat));
    this.activeNodeId = activeNodeId;
    const active: ActiveGame = { id: crypto.randomUUID(), delay, seats, activeNodeId, vacant };
    this.game = { ...active, historyComplete: true, snapshot: null, log: [], lastInput: new Map(), handover: null };
    this.started = true;
    this.hashes.clear();
    await this.ctx.storage.put({ started: true, activeGame: active });
    for (const socket of this.ctx.getWebSockets()) {
      const player = this.player(socket);
      if (player?.awaitingSnapshot) { player.awaitingSnapshot = false; socket.serializeAttachment(player); }
    }
    this.broadcast({ t: "room", room: this.state() });
    this.broadcast({ t: "start", delay, seats, vacant });
  }

  private async leave(ws: WebSocket, intentional: boolean) {
    const me = this.player(ws);
    ws.serializeAttachment(null);
    try {
      ws.close(1000, "bye");
    } catch {
      // Already closed.
    }
    if (!me) return;
    // Someone still waiting to take over a seat has nothing to come back to.
    const handingOver = this.game?.handover?.id === me.id;
    if (me.seat !== null && !intentional && !handingOver) {
      // Dropped, not left: keep their seat (and the game) for a while so they can come back.
      this.pending.set(me.id, { ...me, until: Date.now() + NETPLAY_RECONNECT_GRACE_MS });
      await this.ctx.storage.put("pending", [...this.pending.values()]);
      if (this.started) await this.saveHistory();
      await this.scheduleAlarm();
    } else {
      // Spectators come and go freely; a seated player who left ends the game.
      await this.dropped(me);
      if (this.ctx.getWebSockets().length <= 1) await this.scheduleAlarm();
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
    const game = this.game;
    if (!game) return;
    if (game.log.length < MAX_LOGGED_INPUTS) game.log.push([seat, frame, mask]);
    game.lastInput.set(seat, Math.max(game.lastInput.get(seat) ?? -1, frame));
  }

  private storeSnapshot(seat: number, frame: number, state: string) {
    const game = this.game;
    // One player supplies snapshots so they all describe the same timeline.
    if (!game || seat !== game.seats[0] || state.length > MAX_SNAPSHOT_CHARS) return;
    if (game.snapshot && frame <= game.snapshot.f) return;
    game.snapshot = { f: frame, s: state };
    game.historyComplete = true;
    // Inputs before the snapshot are inside it now.
    game.log = game.log.filter(([, f]) => f >= frame);
    for (const ws of this.ctx.getWebSockets()) {
      const me = this.player(ws);
      if (me?.awaitingSnapshot) this.sendGameInProgress(ws, me);
    }
  }

  /**
   * A player loads a save state before frame `frame`. It becomes the snapshot
   * newcomers start from (marked loaded, so they do not load it again), and
   * goes to everyone else ahead of the input that applies it.
   */
  private async loadState(ws: WebSocket, seat: number, frame: number, state: string) {
    const game = this.game;
    if (!game) return;
    const current = game.snapshot;
    // Both loading on one frame: the higher seat's state wins, as on every client.
    const newer = !current || frame > current.f || (frame === current.f && (!current.loaded || seat >= (current.seat ?? -1)));
    if (newer) {
      game.snapshot = { f: frame, s: state, loaded: true, seat };
      game.historyComplete = true;
      game.log = game.log.filter(([, f]) => f >= frame);
      if (this.pending.size > 0) await this.saveHistory();
    }
    this.broadcast({ t: "load", s: seat, f: frame, data: state }, ws);
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
    const players = [
      ...this.players().map((player) => ({ ...player, connected: true })),
      ...[...this.pending.values()].map((player) => ({ ...player, connected: false })),
    ].map((player) => ({
      ...player,
      relayProbes: Date.now() - (player.probedAt ?? 0) < 45_000 ? player.relayProbes ?? [] : [],
    }));
    const recommendedNodeId = recommendRelay(nodes, players);
    return {
      info: this.info!,
      hostId: this.hostId,
      started: this.started,
      vacantSeats: this.started ? (this.game?.vacant ?? []).filter((seat) => this.game?.handover?.seat !== seat) : [],
      relay: { nodes, selection: this.selection, recommendedNodeId,
        activeNodeId: this.started ? this.activeNodeId : this.selection.mode === "auto" ? recommendedNodeId : this.selection.nodeId },
      players: players.map(({ id, name, seat, romHash, rttMs, directRttMs, relayProbes, connected }) => ({
        id,
        name,
        seat,
        romHash,
        rttMs,
        directRttMs: directRttMs ?? null,
        relayProbes,
        connected,
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
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= NETPLAY_MAX_MASK;
}
