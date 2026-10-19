import {
  NES_HEIGHT,
  NES_WIDTH,
  type FromWorker,
  type ToWorker,
  type ControllerState,
} from "@neslink/core";
import { PeerLink, type PeerStatus } from "./peer-link";

export type { PeerStatus };
export type EmulatorStats = Omit<Extract<FromWorker, { type: "stats" }>, "type">;
/** What went wrong (for the UI to word) plus the untranslated detail. */
export interface EmulatorError {
  kind: "emulationStopped" | "audioUnavailable" | "other";
  message: string;
}
/** Netplay events from the worker (room updates, start/end, desync, errors). */
/** How long a closing player's worker gets to send the room its "leave" close. */
const LEAVE_GRACE_MS = 500;

export type NetEvent = Extract<FromWorker, { type: `net${string}` }>;

export interface EmulatorEvents {
  onReady?: () => void;
  onRomLoaded?: () => void;
  onStats?: (stats: EmulatorStats) => void;
  onError?: (error: EmulatorError) => void;
  onNet?: (event: NetEvent) => void;
  /** State of the direct (WebRTC) link to the other player. */
  onPeer?: (status: PeerStatus) => void;
}

/**
 * UI-thread handle to the emulator worker. Owns the canvas (transferred to
 * the worker as an OffscreenCanvas) and the AudioWorklet output.
 */
export class EmulatorClient {
  readonly canvas: HTMLCanvasElement;
  private readonly worker: Worker;
  private readonly audio: AudioContext;
  private readonly pending = new Map<number, (state: Uint8Array<ArrayBuffer>) => void>();
  private nextRequestId = 1;
  private destroyed = false;
  private peer: PeerLink | null = null;
  private roomUrl: string | null = null;

  constructor(private readonly events: EmulatorEvents = {}) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = NES_WIDTH;
    this.canvas.height = NES_HEIGHT;

    this.worker = new Worker(new URL("./emulator.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.onMessage(event.data);
    this.worker.onerror = (event) => {
      if (!this.destroyed) this.events.onError?.({ kind: "other", message: event.message || "Worker crashed" });
    };

    this.audio = new AudioContext({ latencyHint: "interactive" });
    const channel = new MessageChannel();
    void this.connectAudio(channel.port1);

    document.addEventListener("visibilitychange", this.onVisibility);

    const offscreen = this.canvas.transferControlToOffscreen();
    this.send(
      { type: "init", canvas: offscreen, sampleRate: this.audio.sampleRate, audioPort: channel.port2 },
      [offscreen, channel.port2],
    );
  }

  /** Must be called from a user gesture at least once for sound to play. */
  resumeAudio(): void {
    if (this.audio.state === "suspended") void this.audio.resume();
  }

  /** With `autostart: false` the cartridge waits until a netplay room starts it. */
  loadRom(rom: Uint8Array<ArrayBuffer>, autostart = true): void {
    // Copy so the caller's buffer survives the transfer.
    const copy = rom.slice();
    this.send({ type: "loadRom", rom: copy, autostart }, [copy.buffer]);
  }

  /**
   * `simulated`: dev tool, extra latency to add to this player's server link.
   * `direct`: also try a WebRTC link straight to the other player (on by default),
   * with this ICE transport policy; null for no direct link.
   */
  joinRoom(
    url: string,
    name: string,
    romHash: string,
    simulated: { lagMs: number; jitterMs: number } | null = null,
    direct: RTCIceTransportPolicy | null = typeof RTCPeerConnection === "function" ? "all" : null,
  ): void {
    this.peer?.dispose();
    this.peer = null;
    let peerPort: MessagePort | null = null;
    if (direct) {
      const channel = new MessageChannel();
      peerPort = channel.port2;
      this.peer = new PeerLink(
        channel.port1,
        (to, data) => this.send({ type: "netSignal", to, data }),
        (status) => {
          this.send({ type: "peerRtt", ms: status.state === "open" ? status.rttMs : null });
          this.events.onPeer?.(status);
        },
        direct,
      );
    }
    this.roomUrl = url;
    this.send({ type: "netJoin", url, name, romHash, simulated, peerPort, resume: loadCredentials(url) }, peerPort ? [peerPort] : []);
  }

  /** Change our display name in the room. */
  rename(name: string): void {
    this.send({ type: "netRename", name });
  }

  /** Send everyone in the room a thumbs-up. */
  react(): void {
    this.send({ type: "netReact", kind: "thumbs" });
  }

  startRoom(): void {
    this.send({ type: "netStart" });
  }

  selectRelay(selection: import("@neslink/core").RelaySelection): void {
    this.send({ type: "netRelaySelect", selection });
  }

  /** Sit in `seat`, or stand up to spectate with null. */
  takeSeat(seat: number | null): void {
    this.send({ type: "netSeat", seat });
  }

  leaveRoom(): void {
    this.peer?.close();
    this.send({ type: "netLeave" });
  }

  /** A controller's held buttons and turbo A/B; the worker expands turbo per frame. */
  setInput(port: number, state: ControllerState): void {
    this.send({ type: "input", port, held: state.held, turbo: state.turbo });
  }

  setPaused(paused: boolean): void {
    this.send({ type: "pause", paused });
    if (paused) void this.audio.suspend();
    else this.resumeAudio();
  }

  reset(): void {
    this.send({ type: "reset" });
  }

  saveState(): Promise<Uint8Array<ArrayBuffer>> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.send({ type: "saveState", requestId });
    });
  }

  /** The cheat codes to run with (in a room, only the host's apply, for everyone). */
  setCheats(codes: string[]): void {
    this.send({ type: "setCheats", codes });
  }

  loadState(state: Uint8Array<ArrayBuffer>): void {
    const copy = state.slice();
    this.send({ type: "loadState", state: copy }, [copy.buffer]);
  }

  destroy(): void {
    // Closing the player in a room is leaving it on purpose: no seat is kept,
    // and coming back is a fresh join. A refresh never gets here.
    const inRoom = this.roomUrl !== null;
    if (inRoom) {
      clearCredentials(this.roomUrl!);
      this.send({ type: "netLeave" });
    }
    this.destroyed = true;
    this.peer?.dispose();
    this.peer = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
    // Give the worker a moment to send the socket's "leave" close first.
    if (inRoom) setTimeout(() => this.worker.terminate(), LEAVE_GRACE_MS);
    else this.worker.terminate();
    void this.audio.close();
    this.pending.clear();
  }

  private async connectAudio(port: MessagePort) {
    try {
      await this.audio.audioWorklet.addModule("/audio-worklet.js");
      if (this.destroyed) return;
      const node = new AudioWorkletNode(this.audio, "nes-audio", {
        numberOfInputs: 0,
        outputChannelCount: [2],
      });
      node.port.postMessage({ type: "port", port }, [port]);
      node.connect(this.audio.destination);
    } catch (error) {
      // destroy() closes the context, which rejects a pending addModule.
      if (!this.destroyed) this.events.onError?.({ kind: "audioUnavailable", message: (error as Error).message });
    }
  }

  private readonly onVisibility = () => {
    this.send({ type: "visibility", hidden: document.hidden });
  };

  private send(message: ToWorker, transfer: Transferable[] = []) {
    if (!this.destroyed) this.worker.postMessage(message, transfer);
  }

  private onMessage(message: FromWorker) {
    // A closing worker may still talk while it leaves the room; nobody is listening.
    if (this.destroyed) return;
    switch (message.type) {
      case "ready":
        this.events.onReady?.();
        break;
      case "romLoaded":
        this.events.onRomLoaded?.();
        break;
      case "stats":
        this.events.onStats?.(message);
        break;
      case "state":
        this.pending.get(message.requestId)?.(message.state);
        this.pending.delete(message.requestId);
        break;
      case "error":
        this.events.onError?.({ kind: message.kind, message: message.message });
        break;
      case "netSignal":
        void this.peer?.handleSignal(message.from, message.data);
        break;
      case "netCredentials":
        if (this.roomUrl) saveCredentials(this.roomUrl, { id: message.id, token: message.token });
        break;
      case "netRoom": {
        // Link directly to the other seated player, if we sit and exactly one other does.
        // Someone reconnecting counts as gone: their link is rebuilt once they are back.
        const me = message.room.players.find((p) => p.id === message.you);
        const others = message.room.players.filter(
          (p) => p.seat !== null && p.id !== message.you && p.connected !== false,
        );
        this.peer?.setPeer(message.you, me?.seat != null && others.length === 1 ? others[0].id : null);
        this.events.onNet?.(message);
        break;
      }
      default:
        this.events.onNet?.(message);
    }
  }
}

/**
 * Room identity per tab (sessionStorage): a refresh rejoins as the same player,
 * while a second tab is a new one.
 */
function credentialsKey(url: string) {
  return `neslink:resume:${url}`;
}

function loadCredentials(url: string): { id: string; token: string } | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(credentialsKey(url)) ?? "null") as { id?: unknown; token?: unknown } | null;
    return saved && typeof saved.id === "string" && typeof saved.token === "string" ? { id: saved.id, token: saved.token } : null;
  } catch {
    return null;
  }
}

function clearCredentials(url: string) {
  try {
    sessionStorage.removeItem(credentialsKey(url));
  } catch {
    // Nothing was kept.
  }
}

function saveCredentials(url: string, credentials: { id: string; token: string }) {
  try {
    sessionStorage.setItem(credentialsKey(url), JSON.stringify(credentials));
  } catch {
    // Not kept across a refresh; dropping and coming back without one still works.
  }
}
