import type { RoomState } from "./netplay/protocol";

/** Messages between the UI thread and the emulator worker. */

export type ToWorker =
  | {
      type: "init";
      canvas: OffscreenCanvas;
      sampleRate: number;
      /** Port connected to the AudioWorklet; samples are posted straight to it. */
      audioPort: MessagePort | null;
    }
  /** `autostart: false` loads the cartridge but waits (netplay waits for the room to start). */
  | { type: "loadRom"; rom: Uint8Array<ArrayBuffer>; autostart: boolean }
  | { type: "input"; port: number; mask: number }
  | { type: "pause"; paused: boolean }
  | { type: "reset" }
  | { type: "saveState"; requestId: number }
  | { type: "loadState"; state: Uint8Array<ArrayBuffer> }
  /** Whether the page is hidden; netplay keeps running on a timer when it is. */
  | { type: "visibility"; hidden: boolean }
  /** Connect to a netplay room; the worker owns the socket so inputs skip the UI thread. */
  | { type: "netJoin"; url: string; name: string; romHash: string }
  /** Host only: ask the room to start. */
  | { type: "netStart" }
  /** Lobby: sit in a seat, or null to spectate. */
  | { type: "netSeat"; seat: number | null }
  | { type: "netLeave" };

export type NetStatus = "connecting" | "open" | "closed";

export type FromWorker =
  | { type: "ready" }
  | { type: "romLoaded" }
  | {
      type: "stats";
      fps: number;
      frame: number;
      /** Measured display refresh rate, once known. */
      refreshHz: number | null;
      /** Whether frames are locked to display refreshes (smooth) or paced by time. */
      vsyncLocked: boolean;
      /** Frames in this window held on screen for an irregular number of refreshes (judder). */
      unevenFrames: number;
      /** Netplay: refreshes in this window spent waiting for the other player's input. */
      netWaits: number;
    }
  | { type: "state"; requestId: number; state: Uint8Array<ArrayBuffer> }
  | { type: "error"; message: string }
  | { type: "netStatus"; status: NetStatus; reason?: string }
  | { type: "netRoom"; room: RoomState; you: string }
  /** `seat` null: watching. `delay`: input delay in frames for this game. */
  | { type: "netStarted"; seat: number | null; delay: number }
  /** Round trip to the room server in ms. */
  | { type: "netPing"; rttMs: number }
  | { type: "netEnded"; reason: string }
  | { type: "netDesync"; frame: number }
  | { type: "netError"; message: string };

/** Messages from the worker to the AudioWorklet. `samples` is mono. */
export type ToAudio = { type: "samples"; samples: Float32Array<ArrayBuffer> } | { type: "flush" };
