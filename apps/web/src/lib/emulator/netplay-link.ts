import {
  LockstepSession,
  NETPLAY_SEATS,
  type ClientMessage,
  type NetStatus,
  type RoomState,
  type ServerMessage,
} from "@neslink/core";

export interface NetplayEvents {
  onStatus(status: NetStatus, reason?: string): void;
  onRoom(room: RoomState, you: string): void;
  /** The room started; run from power-on with this session. */
  onStart(session: LockstepSession): void;
  /** A game in progress ended (a player left). */
  onEnd(reason: string): void;
  onDesync(frame: number): void;
  onError(message: string): void;
}

/** One player's connection to a room: the socket plus the lockstep session once started. */
export class NetplayLink {
  session: LockstepSession | null = null;
  private readonly ws: WebSocket;
  private you: string | null = null;
  private room: RoomState | null = null;
  private closed = false;

  constructor(url: string, hello: { name: string; romHash: string }, private readonly events: NetplayEvents) {
    events.onStatus("connecting");
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      events.onStatus("open");
      this.send({ t: "hello", ...hello });
    };
    this.ws.onmessage = (event) => this.onMessage(JSON.parse(event.data as string) as ServerMessage);
    this.ws.onclose = (event) => {
      if (this.closed) return;
      this.closed = true;
      if (this.session) {
        this.session = null;
        events.onEnd("与房间的连接断开了");
      }
      events.onStatus("closed", event.reason || undefined);
    };
  }

  requestStart(): void {
    this.send({ t: "start" });
  }

  sendInput(frame: number, mask: number): void {
    this.send({ t: "input", f: frame, m: mask });
  }

  sendHash(frame: number, hash: number): void {
    this.send({ t: "hash", f: frame, h: hash });
  }

  close(): void {
    this.closed = true;
    this.session = null;
    this.ws.close(1000, "leave");
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
        if (seat === null) {
          this.events.onError("你在观战席，暂不支持观战");
          return;
        }
        this.session = new LockstepSession(NETPLAY_SEATS, seat, message.delay);
        this.events.onStart(this.session);
        break;
      }
      case "input":
        this.session?.receive(message.s, message.f, message.m);
        break;
      case "desync":
        this.events.onDesync(message.f);
        break;
      case "error":
        this.events.onError(message.message);
        break;
    }
  }

  private updateRoom(room: RoomState) {
    this.room = room;
    if (this.session && !room.started) {
      this.session = null;
      this.events.onEnd("对方离开了房间，游戏结束");
    }
    if (this.you) this.events.onRoom(room, this.you);
  }

  private send(message: ClientMessage) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }
}
