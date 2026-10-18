import type { RelayProbe, RelaySelection, RelayState } from "./relay";

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

/**
 * Set on the host's input for a frame (above the eight controller buttons):
 * press the console's reset button before running that frame. Going through
 * the input stream makes every player reset on the same frame, rollback
 * replays it like any input, and late spectators see it in the room's log.
 */
export const NETPLAY_RESET = 0x100;
/**
 * Set on a player's input for a frame: load the save state that player sent
 * (`load` message, always ahead of the input on the room socket) before running
 * that frame. Applied in seat order, so if both load on one frame the higher seat wins.
 */
export const NETPLAY_LOAD = 0x200;
/** Bits above the buttons: things that happen once, on the frame they were sent for. */
export const NETPLAY_EVENTS = NETPLAY_RESET | NETPLAY_LOAD;
/** Largest input mask on the wire: the eight buttons plus the event bits. */
export const NETPLAY_MAX_MASK = 0x3ff;

/** Why the room refused a request. The UI turns these into text in the viewer's language. */
export type RoomErrorCode =
  | "malformed"
  | "notHost"
  | "noPlayers"
  | "seatLocked"
  | "nodeLocked"
  | "seatTaken"
  | "romMismatch"
  | "lateJoinUnavailable"
  | "playerReconnecting";

/** Errors from the HTTP rooms API, as `{ error: code }`. */
export type ApiErrorCode = "roomNotFound" | "badRequest" | "missingRomHash" | "relayUnavailable" | "connectionDenied" | "tooManyRequests";

/** Why a game in progress ended for this client. */
export type RoomEndReason = "peerLeft" | "disconnected";

export interface RoomInfo {
  id: string;
  romHash: string;
  romName: string;
}

/** How long a seated player who dropped (not left) keeps their seat, in ms. */
export const NETPLAY_RECONNECT_GRACE_MS = 20_000;

/** Quick reactions a player can send everyone in the room. */
export type ReactionKind = "thumbs";

export interface RoomPlayer {
  id: string;
  name: string;
  /** Controller port, or null for a spectator. */
  seat: number | null;
  /** Hash of the ROM this player has loaded; must equal the room's to play. */
  romHash: string;
  /** Latest round trip this player measured to the room, if any yet. */
  rttMs: number | null;
  /** Round trip over this player's direct link to the other player, if one is up. */
  directRttMs: number | null;
  relayProbes?: RelayProbe[];
  /** False while a seated player who dropped may still come back (their seat is kept). */
  connected?: boolean;
}

export interface RoomState {
  info: RoomInfo;
  hostId: string | null;
  players: RoomPlayer[];
  started: boolean;
  /**
   * Seats in the running game that nobody plays: the first seat's player
   * fills them with neutral input, and a spectator may sit down in one.
   */
  vacantSeats?: number[];
  relay?: RelayState;
}

export type ClientMessage =
  | { t: "relayProbes"; probes: RelayProbe[] }
  | { t: "relaySelect"; selection: RelaySelection }
  /** `resume`: rejoin as the player `id` this tab was before a drop or refresh. */
  | { t: "hello"; name: string; romHash: string; resume?: { id: string; token: string } }
  | { t: "rename"; name: string }
  | { t: "react"; kind: ReactionKind }
  /**
   * Before a game: sit in a seat, or stand up to spectate (null). During one,
   * a spectator may take a vacant seat (see RoomState.vacantSeats).
   */
  | { t: "seat"; seat: number | null }
  /** Host only: begin the game with whoever is seated (at least one). */
  | { t: "start" }
  /** Local input `m` for frame `f` (buttons, plus NETPLAY_RESET from the host). */
  /** `a`: the sender's frame advantage, for rollback time sync. */
  /** `s`: the vacant seat this input fills in for, when standing in (see `standIn`). */
  | { t: "input"; f: number; m: number; a?: number; s?: number }
  /** Stopped standing in for seat `s` (after `handover`); `f` is the last frame filled. */
  | { t: "handedOver"; s: number; f: number }
  /** State hash `h` after running frame `f`. */
  | { t: "hash"; f: number; h: number }
  /**
   * This player's measured round trip to the room, and over its direct link to
   * the other player if one is up, for choosing the input delay.
   */
  | { t: "rtt"; ms: number; direct?: number | null }
  /** Save state `s` (base64) taken before running frame `f`. */
  | { t: "snapshot"; f: number; s: string }
  /** Save state `s` (base64) this player loads before running frame `f` (its input there has NETPLAY_LOAD). */
  | { t: "load"; f: number; s: string }
  /** WebRTC signaling (offer, answer, ICE candidate) for player `to`; relayed as is. */
  | { t: "signal"; to: string; data: unknown };

export type ServerMessage =
  /** `resumeToken`: keep it (per room, per tab) to rejoin as `you` after a drop. */
  | { t: "welcome"; you: string; room: RoomState; connectionToken?: string; resumeToken?: string }
  | { t: "react"; from: string; kind: ReactionKind }
  | { t: "room"; room: RoomState }
  | {
      t: "start";
      delay: number;
      /** Seats taking part; the others read no input. */
      seats: number[];
      /**
       * For a spectator joining mid-game: the snapshot to start from, plus every
       * input logged since it. Absent means start from power-on at frame 0
       * (with any inputs logged so far). `loaded`: the snapshot is a state a
       * player loaded at `f`, so NETPLAY_LOAD bits on frame `f` are already applied.
       */
      from?: { f: number; s: string; loaded?: boolean };
      inputs?: [seat: number, frame: number, mask: number][];
      /** Seats nobody plays, which the first seat's player stands in for (see `standIn`). */
      vacant?: number[];
    }
  | { t: "input"; s: number; f: number; m: number; a?: number }
  /**
   * To the first seat's player: seat `s` is vacant, fill it with neutral input
   * from frame `f` on (from the newest one you hold of theirs when absent),
   * sending each like your own with `s` set.
   */
  | { t: "standIn"; s: number; f?: number }
  /** To the player standing in: someone takes seat `s`. Stop, and answer `handedOver`. */
  | { t: "handover"; s: number }
  /** Seat `s` loads save state `data` before frame `f`; sent ahead of that input. */
  | { t: "load"; s: number; f: number; data: string }
  | { t: "desync"; f: number }
  | { t: "signal"; from: string; data: unknown }
  | { t: "error"; code: RoomErrorCode };
