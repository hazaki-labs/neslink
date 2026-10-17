/**
 * WebSocket protocol between players and the room server (a Durable Object).
 * Messages are small JSON objects; inputs are a few bytes per frame per player.
 */

/**
 * Frames between pressing a button and the frame it takes effect on, which hides relay
 * latency. Used until both players have measured their latency (see chooseInputDelay).
 */
export const NETPLAY_INPUT_DELAY = 4;
/** How often (in frames) players report a state hash so the server can spot desyncs. */
export const NETPLAY_HASH_INTERVAL = 60;
export const NETPLAY_SEATS = 2;
/**
 * How often (in frames) the first seated player uploads a save state, so a
 * spectator arriving mid-game can start from it instead of from power-on.
 */
export const NETPLAY_SNAPSHOT_INTERVAL = 600;
/**
 * Latency probe: the room answers this exact text frame with NETPLAY_PONG
 * itself (Durable Object auto-response), without running room code.
 */
export const NETPLAY_PING = "ping";
export const NETPLAY_PONG = "pong";

/** Why the room refused a request. The UI turns these into text in the viewer's language. */
export type RoomErrorCode =
  | "malformed"
  | "notHost"
  | "noPlayers"
  | "seatLocked"
  | "seatTaken"
  | "romMismatch"
  | "lateJoinUnavailable";

/** Errors from the HTTP rooms API, as `{ error: code }`. */
export type ApiErrorCode = "roomNotFound" | "badRequest" | "missingRomHash";

/** Why a game in progress ended for this client. */
export type RoomEndReason = "peerLeft" | "disconnected";

export interface RoomInfo {
  id: string;
  romHash: string;
  romName: string;
}

export interface RoomPlayer {
  id: string;
  name: string;
  /** Controller port, or null for a spectator. */
  seat: number | null;
  /** Hash of the ROM this player has loaded; must equal the room's to play. */
  romHash: string;
  /** Latest round trip this player measured to the room, if any yet. */
  rttMs: number | null;
}

export interface RoomState {
  info: RoomInfo;
  hostId: string | null;
  players: RoomPlayer[];
  started: boolean;
}

export type ClientMessage =
  | { t: "hello"; name: string; romHash: string }
  /** Before a game: sit in a seat, or stand up to spectate (null). */
  | { t: "seat"; seat: number | null }
  /** Host only: begin the game with whoever is seated (at least one). */
  | { t: "start" }
  /** Local input `m` for frame `f`. */
  /** `a`: the sender's frame advantage, for rollback time sync. */
  | { t: "input"; f: number; m: number; a?: number }
  /** State hash `h` after running frame `f`. */
  | { t: "hash"; f: number; h: number }
  /** This player's measured round trip to the room, for choosing the input delay. */
  | { t: "rtt"; ms: number }
  /** Save state `s` (base64) taken before running frame `f`. */
  | { t: "snapshot"; f: number; s: string }
  /** WebRTC signaling (offer, answer, ICE candidate) for player `to`; relayed as is. */
  | { t: "signal"; to: string; data: unknown };

export type ServerMessage =
  | { t: "welcome"; you: string; room: RoomState }
  | { t: "room"; room: RoomState }
  | {
      t: "start";
      delay: number;
      /** Seats taking part; the others read no input. */
      seats: number[];
      /**
       * For a spectator joining mid-game: the snapshot to start from, plus every
       * input logged since it. Absent means start from power-on at frame 0
       * (with any inputs logged so far).
       */
      from?: { f: number; s: string };
      inputs?: [seat: number, frame: number, mask: number][];
    }
  | { t: "input"; s: number; f: number; m: number; a?: number }
  | { t: "desync"; f: number }
  | { t: "signal"; from: string; data: unknown }
  | { t: "error"; code: RoomErrorCode };
