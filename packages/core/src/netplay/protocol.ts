/**
 * WebSocket protocol between players and the room server (a Durable Object).
 * Messages are small JSON objects; inputs are a few bytes per frame per player.
 */

/** Frames between pressing a button and the frame it takes effect on. Hides relay latency. */
export const NETPLAY_INPUT_DELAY = 4;
/** How often (in frames) players report a state hash so the server can spot desyncs. */
export const NETPLAY_HASH_INTERVAL = 60;
export const NETPLAY_SEATS = 2;

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
}

export interface RoomState {
  info: RoomInfo;
  hostId: string | null;
  players: RoomPlayer[];
  started: boolean;
}

export type ClientMessage =
  | { t: "hello"; name: string; romHash: string }
  /** Host only: begin the game once every seat is filled. */
  | { t: "start" }
  /** Local input `m` for frame `f`. */
  | { t: "input"; f: number; m: number }
  /** State hash `h` after running frame `f`. */
  | { t: "hash"; f: number; h: number };

export type ServerMessage =
  | { t: "welcome"; you: string; room: RoomState }
  | { t: "room"; room: RoomState }
  | { t: "start"; delay: number }
  | { t: "input"; s: number; f: number; m: number }
  | { t: "desync"; f: number }
  | { t: "error"; message: string };
