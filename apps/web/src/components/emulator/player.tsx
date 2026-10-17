import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, Maximize, Pause, Play, RotateCcw, Save } from "lucide-react";
import {
  NES_FRAME_RATE,
  NES_HEIGHT,
  NES_WIDTH,
  type NetStatus,
  type RoomEndReason,
  type RoomInfo,
  type RoomState,
} from "@neslink/core";
import { Button } from "@/components/ui/button";
import { useI18n, type Messages } from "@/i18n";
import { EmulatorClient, type EmulatorError, type EmulatorStats, type NetEvent } from "@/lib/emulator/emulator-client";
import { useControllerInput } from "@/lib/emulator/use-controller-input";
import { playerName, roomSocketUrl, simulatedNetwork } from "@/lib/rooms";
import { getSave, putSave, type StoredRom } from "@/lib/storage";
import { RoomLobby } from "./room-lobby";

const QUICK_SLOT = 0;

interface NetView {
  status: NetStatus;
  room: RoomState | null;
  you: string | null;
  /** Whether a game is running (we are playing or watching it). */
  playing: boolean;
  /** Our seat in the running game, or null when watching it. */
  seat: number | null;
  /** Why the last game ended, if it did. */
  notice: RoomEndReason | null;
  /** Round trip to the room server, once measured. */
  rttMs: number | null;
  /** Input delay of the running game, in frames. */
  delayFrames: number | null;
}

const INITIAL_NET: NetView = {
  status: "connecting",
  room: null,
  you: null,
  playing: false,
  seat: null,
  notice: null,
  rttMs: null,
  delayFrames: null,
};

function applyNetEvent(view: NetView, event: NetEvent): NetView {
  switch (event.type) {
    case "netStatus":
      return event.status === "closed" ? { ...view, status: event.status, playing: false, seat: null } : { ...view, status: event.status };
    case "netRoom":
      return { ...view, room: event.room, you: event.you };
    case "netStarted":
      return { ...view, playing: true, seat: event.seat, delayFrames: event.delay, notice: null };
    case "netPing":
      return { ...view, rttMs: event.rttMs };
    case "netEnded":
      return { ...view, playing: false, seat: null, notice: event.reason };
    default:
      return view;
  }
}

function describeError(t: Messages, error: EmulatorError): string {
  switch (error.kind) {
    case "emulationStopped":
      return t.player.emulationStopped(error.message);
    case "audioUnavailable":
      return t.player.audioUnavailable(error.message);
    default:
      return error.message;
  }
}

/** Text worded at render time, so switching language rewords what is on screen. */
type Text = (t: Messages) => string;

/** Plays a ROM alone, or in a netplay room when `room` is given. */
export function Player({ rom, room, onExit }: { rom: StoredRom; room?: RoomInfo; onExit: () => void }) {
  const roomId = room?.id ?? null;
  const screenRef = useRef<HTMLDivElement>(null);
  const [client, setClient] = useState<EmulatorClient | null>(null);
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState<EmulatorStats | null>(null);
  const { t } = useI18n();
  const [message, setMessage] = useState<Text | null>(null);
  const [hasSave, setHasSave] = useState(false);
  const [net, setNet] = useState<NetView>(INITIAL_NET);

  function flash(text: Text, ms = 2000) {
    setMessage(() => text);
    setTimeout(() => setMessage((current: Text | null) => (current === text ? null : current)), ms);
  }

  useEffect(() => {
    const screen = screenRef.current!;
    const emulator: EmulatorClient = new EmulatorClient({
      onReady: () => setClient(emulator),
      onStats: setStats,
      onError: (error) => setMessage(() => (t: Messages) => describeError(t, error)),
      onNet: (event) => {
        if (event.type === "netDesync") flash((t) => t.player.desync(event.frame), 5000);
        else if (event.type === "netError") flash((t) => t.roomErrors[event.code], 4000);
        else setNet((view) => applyNetEvent(view, event));
      },
    });
    emulator.canvas.className = "[image-rendering:pixelated]";
    screen.appendChild(emulator.canvas);
    const stopFitting = fitIntegerScale(screen, emulator.canvas);
    if (roomId) {
      emulator.loadRom(rom.data, false);
      emulator.joinRoom(roomSocketUrl(roomId), playerName(), rom.hash, simulatedNetwork());
    } else {
      emulator.loadRom(rom.data);
    }
    emulator.resumeAudio();
    // Browsers may keep audio suspended until a gesture lands on the page.
    const resume = () => emulator.resumeAudio();
    window.addEventListener("pointerdown", resume);
    window.addEventListener("keydown", resume);
    return () => {
      stopFitting();
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
      emulator.destroy();
      emulator.canvas.remove();
      setClient(null);
      setNet(INITIAL_NET);
    };
  }, [rom, roomId]);

  useEffect(() => {
    let cancelled = false;
    getSave(rom.hash, QUICK_SLOT).then((save) => !cancelled && setHasSave(save !== undefined));
    return () => {
      cancelled = true;
    };
  }, [rom]);

  useControllerInput(client);

  const togglePause = () => {
    client?.setPaused(!paused);
    setPaused(!paused);
  };

  const saveState = async () => {
    if (!client) return;
    const state = await client.saveState();
    await putSave({ romHash: rom.hash, slot: QUICK_SLOT, savedAt: Date.now(), state });
    setHasSave(true);
    flash((t) => t.player.saved);
  };

  const loadState = async () => {
    const save = await getSave(rom.hash, QUICK_SLOT);
    if (!client || !save) return;
    client.loadState(save.state);
    flash((t) => t.player.loaded);
  };

  return (
    <div className="flex w-full max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onExit}>
          <ArrowLeft data-icon="inline-start" />
          {roomId ? t.player.leaveRoom : t.library.title}
        </Button>
        <h1 className="mr-auto truncate text-lg font-semibold">{rom.name}</h1>
        {roomId && (
          <span className="text-sm text-muted-foreground">
            {t.player.room} <span className="font-mono">{roomId}</span>
            {net.playing && ` · ${net.seat !== null ? t.player.youAre(net.seat + 1) : t.player.spectating}`}
          </span>
        )}
        {roomId && net.rttMs !== null && (
          <span
            className="font-mono text-xs text-muted-foreground tabular-nums"
            title={t.player.latencyTitle}
          >
            {t.player.network(Math.round(net.rttMs))}
            {simulatedNetwork() && ` ${t.player.simulated}`}
            {net.playing &&
              net.seat !== null &&
              net.delayFrames !== null &&
              ` · ${t.player.inputDelay(net.delayFrames, NES_FRAME_RATE)}`}
          </span>
        )}
        <span
          className="font-mono text-xs text-muted-foreground tabular-nums"
          title={
            stats
              ? t.player.statsTitle(stats.unevenFrames, stats.frameCostMs) +
                (roomId ? t.player.statsNetTitle(stats.netWaits) : "") +
                (stats.rollbackWindow !== null
                  ? t.player.statsRollbackTitle(stats.rollbacks, stats.replayedFrames, stats.rollbackWindow)
                  : "")
              : undefined
          }
        >
          {stats === null ? "--" : stats.fps.toFixed(1)} fps
          {stats?.refreshHz && ` · ${Math.round(stats.refreshHz)}Hz${stats.vsyncLocked ? ` ${t.player.vsync}` : ""}`}
        </span>
      </div>

      <div
        ref={screenRef}
        className="relative flex aspect-[256/240] w-full items-center justify-center overflow-hidden rounded-lg border-2 border-muted-foreground/40 bg-black"
      >
        {roomId && !net.playing && (
          <RoomLobby
            status={net.status}
            room={net.room}
            you={net.you}
            notice={net.notice}
            onStart={() => client?.startRoom()}
            onSeat={(seat) => client?.takeSeat(seat)}
          />
        )}
        {message && (
          <div className="absolute inset-x-0 top-3 z-10 mx-auto w-fit rounded-md bg-black/70 px-3 py-1.5 text-sm text-white">
            {message(t)}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {/* Pause, reset and save states would desync a netplay game. */}
        {!roomId && (
          <>
        <Button variant="outline" onClick={togglePause}>
          {paused ? <Play data-icon="inline-start" /> : <Pause data-icon="inline-start" />}
          {paused ? t.player.resume : t.player.pause}
        </Button>
        <Button variant="outline" onClick={() => client?.reset()}>
          <RotateCcw data-icon="inline-start" />
          {t.player.reset}
        </Button>
        <Button variant="outline" onClick={saveState}>
          <Save data-icon="inline-start" />
          {t.player.save}
        </Button>
        <Button variant="outline" onClick={loadState} disabled={!hasSave}>
          <Download data-icon="inline-start" />
          {t.player.load}
        </Button>
          </>
        )}
        <Button variant="outline" className="ml-auto" onClick={() => screenRef.current?.requestFullscreen()}>
          <Maximize data-icon="inline-start" />
          {t.player.fullscreen}
        </Button>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm text-muted-foreground">
        <dt>{t.player.controls.dpad}</dt>
        <dd>W A S D</dd>
        <dt>B / A</dt>
        <dd>J / K</dd>
        <dt>Select / Start</dt>
        <dd>V / B</dd>
        <dt>{t.player.controls.gamepad}</dt>
        <dd>{t.player.controls.gamepadHint}</dd>
      </dl>
    </div>
  );
}

/**
 * Sizes the canvas to the largest whole multiple of the NES resolution, in
 * device pixels, that fits the container. A fractional scale makes NES pixel
 * columns alternate between widths (say 4 and 5 device pixels), so a scroll of
 * one NES pixel per frame moves unevenly on screen and looks like judder.
 */
function fitIntegerScale(container: HTMLElement, canvas: HTMLCanvasElement): () => void {
  const fit = () => {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth, clientHeight } = container;
    const scale = Math.max(
      1,
      Math.floor(Math.min((clientWidth * dpr) / NES_WIDTH, (clientHeight * dpr) / NES_HEIGHT)),
    );
    canvas.style.width = `${(NES_WIDTH * scale) / dpr}px`;
    canvas.style.height = `${(NES_HEIGHT * scale) / dpr}px`;
  };
  const observer = new ResizeObserver(fit);
  observer.observe(container);
  // Zooming or moving to another monitor changes devicePixelRatio without resizing.
  window.addEventListener("resize", fit);
  fit();
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", fit);
  };
}
