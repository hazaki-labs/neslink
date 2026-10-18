import type { ReactionKind, RoomEndReason, RoomErrorCode, RoomState } from "./netplay/protocol";
import type { RelaySelection } from "./netplay/relay";

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
  /** A controller's state: `held` buttons, and `turbo` A/B the worker auto-fires per frame. */
  | { type: "input"; port: number; held: number; turbo: number }
  | { type: "pause"; paused: boolean }
  | { type: "reset" }
  | { type: "saveState"; requestId: number }
  | { type: "loadState"; state: Uint8Array<ArrayBuffer> }
  /** Whether the page is hidden; netplay keeps running on a timer when it is. */
  | { type: "visibility"; hidden: boolean }
  /** Connect to a netplay room; the worker owns the socket so inputs skip the UI thread. */
  | {
      type: "netJoin";
      url: string;
      name: string;
      romHash: string;
      /** Dev tool: extra latency to simulate on this player's link. */
      simulated: { lagMs: number; jitterMs: number } | null;
      /** Port to the UI thread's direct (WebRTC) link to the other player, if any. */
      peerPort: MessagePort | null;
      /** Who this tab was in the room before a refresh, to rejoin as. */
      resume: { id: string; token: string } | null;
    }
  | { type: "netRename"; name: string }
  | { type: "netReact"; kind: ReactionKind }
  /** Round trip over the direct link, or null when there is none (reported to the room). */
  | { type: "peerRtt"; ms: number | null }
  /** WebRTC signaling from the UI thread, for the room to relay to player `to`. */
  | { type: "netSignal"; to: string; data: unknown }
  /** Host only: ask the room to start. */
  | { type: "netStart" }
  | { type: "netRelaySelect"; selection: RelaySelection }
  /** Lobby: sit in a seat, or null to spectate. */
  | { type: "netSeat"; seat: number | null }
  | { type: "netLeave" };

/** "reconnecting": the socket dropped and we are trying to get our seat back. */
export type NetStatus = "connecting" | "open" | "reconnecting" | "closed";

export type FromWorker =
  | { type: "netRelayStatus"; nodeId: string; state: "connecting" | "open" | "failed"; rttMs: number | null }
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
      /** Netplay rollback: corrections and frames re-simulated in this window. */
      rollbacks: number;
      replayedFrames: number;
      /** Netplay rollback: frames we may run ahead of the other player, sized to this device. */
      rollbackWindow: number | null;
      /** Smoothed time to emulate one frame on this device, in ms. */
      frameCostMs: number;
    }
  | { type: "state"; requestId: number; state: Uint8Array<ArrayBuffer> }
  /** `kind` says what failed; `message` is the underlying (untranslated) detail. */
  | { type: "error"; kind: "emulationStopped" | "other"; message: string }
  | { type: "netStatus"; status: NetStatus; reason?: string }
  | { type: "netRoom"; room: RoomState; you: string }
  /** `seat` null: watching. `delay`: input delay in frames for this game. */
  | { type: "netStarted"; seat: number | null; delay: number }
  /** Round trip to the room server in ms. */
  | { type: "netPing"; rttMs: number }
  | { type: "netEnded"; reason: RoomEndReason }
  | { type: "netDesync"; frame: number }
  | { type: "netError"; code: RoomErrorCode }
  /** WebRTC signaling relayed by the room from player `from`. */
  | { type: "netSignal"; from: string; data: unknown }
  /** Our identity in the room, for the UI thread to keep (per tab) and rejoin with. */
  | { type: "netCredentials"; id: string; token: string }
  | { type: "netReaction"; from: string; kind: ReactionKind }
  /** The host reset the netplay game (the console's reset button). */
  | { type: "netReset" }
  /** A player in the netplay game loaded a save state, for everyone. */
  | { type: "netLoaded"; seat: number };

/** Messages from the worker to the AudioWorklet. `samples` is mono. */
export type ToAudio = { type: "samples"; samples: Float32Array<ArrayBuffer> } | { type: "flush" };
