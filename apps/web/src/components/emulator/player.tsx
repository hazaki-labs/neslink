import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, Maximize, Pause, Play, RotateCcw, Save } from "lucide-react";
import { NES_FRAME_RATE, NES_HEIGHT, NES_WIDTH, type NetStatus, type RoomInfo, type RoomState } from "@neslink/core";
import { Button } from "@/components/ui/button";
import { EmulatorClient, type EmulatorStats, type NetEvent } from "@/lib/emulator/emulator-client";
import { useControllerInput } from "@/lib/emulator/use-controller-input";
import { playerName, roomSocketUrl } from "@/lib/rooms";
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
  notice: string | null;
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

/** Plays a ROM alone, or in a netplay room when `room` is given. */
export function Player({ rom, room, onExit }: { rom: StoredRom; room?: RoomInfo; onExit: () => void }) {
  const roomId = room?.id ?? null;
  const screenRef = useRef<HTMLDivElement>(null);
  const [client, setClient] = useState<EmulatorClient | null>(null);
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState<EmulatorStats | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [hasSave, setHasSave] = useState(false);
  const [net, setNet] = useState<NetView>(INITIAL_NET);

  function flash(text: string, ms = 2000) {
    setMessage(text);
    setTimeout(() => setMessage((current) => (current === text ? null : current)), ms);
  }

  useEffect(() => {
    const screen = screenRef.current!;
    const emulator: EmulatorClient = new EmulatorClient({
      onReady: () => setClient(emulator),
      onStats: setStats,
      onError: (error) => setMessage(error),
      onNet: (event) => {
        if (event.type === "netDesync") flash(`检测到画面不同步（第 ${event.frame} 帧）`, 5000);
        else if (event.type === "netError") flash(event.message, 4000);
        else setNet((view) => applyNetEvent(view, event));
      },
    });
    emulator.canvas.className = "[image-rendering:pixelated]";
    screen.appendChild(emulator.canvas);
    const stopFitting = fitIntegerScale(screen, emulator.canvas);
    if (roomId) {
      emulator.loadRom(rom.data, false);
      emulator.joinRoom(roomSocketUrl(roomId), playerName(), rom.hash);
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
    flash("已保存进度");
  };

  const loadState = async () => {
    const save = await getSave(rom.hash, QUICK_SLOT);
    if (!client || !save) return;
    client.loadState(save.state);
    flash("已读取进度");
  };

  return (
    <div className="flex w-full max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onExit}>
          <ArrowLeft data-icon="inline-start" />
          {roomId ? "离开房间" : "游戏库"}
        </Button>
        <h1 className="mr-auto truncate text-lg font-semibold">{rom.name}</h1>
        {roomId && (
          <span className="text-sm text-muted-foreground">
            房间 <span className="font-mono">{roomId}</span>
            {net.playing && (net.seat !== null ? ` · 你是 ${net.seat + 1}P` : " · 观战中")}
          </span>
        )}
        {roomId && net.rttMs !== null && (
          <span
            className="font-mono text-xs text-muted-foreground tabular-nums"
            title="网络：到房间服务器的往返时间。输入延迟：按键到生效之间固定等待的帧数，用来等对方的输入到达。"
          >
            网络 {Math.round(net.rttMs)}ms
            {net.playing && net.seat !== null && net.delayFrames !== null &&
              ` · 输入延迟 ${net.delayFrames} 帧（${Math.round((net.delayFrames * 1000) / NES_FRAME_RATE)}ms）`}
          </span>
        )}
        <span
          className="font-mono text-xs text-muted-foreground tabular-nums"
          title={
            stats
              ? `最近 1 秒内节奏不均的帧：${stats.unevenFrames}` +
                (roomId ? `，等待对方输入的刷新：${stats.netWaits}` : "")
              : undefined
          }
        >
          {stats === null ? "--" : stats.fps.toFixed(1)} fps
          {stats?.refreshHz && ` · ${Math.round(stats.refreshHz)}Hz${stats.vsyncLocked ? " 同步" : ""}`}
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
            {message}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {/* Pause, reset and save states would desync a netplay game. */}
        {!roomId && (
          <>
        <Button variant="outline" onClick={togglePause}>
          {paused ? <Play data-icon="inline-start" /> : <Pause data-icon="inline-start" />}
          {paused ? "继续" : "暂停"}
        </Button>
        <Button variant="outline" onClick={() => client?.reset()}>
          <RotateCcw data-icon="inline-start" />
          重置
        </Button>
        <Button variant="outline" onClick={saveState}>
          <Save data-icon="inline-start" />
          保存进度
        </Button>
        <Button variant="outline" onClick={loadState} disabled={!hasSave}>
          <Download data-icon="inline-start" />
          读取进度
        </Button>
          </>
        )}
        <Button variant="outline" className="ml-auto" onClick={() => screenRef.current?.requestFullscreen()}>
          <Maximize data-icon="inline-start" />
          全屏
        </Button>
      </div>

      <dl className="grid grid-cols-[auto_1fr_1fr] gap-x-6 gap-y-1 text-sm text-muted-foreground">
        <dt />
        <dd className="font-medium text-foreground">1P</dd>
        <dd className="font-medium text-foreground">2P</dd>
        <dt>方向</dt>
        <dd>W A S D</dd>
        <dd>方向键</dd>
        <dt>B / A</dt>
        <dd>J / K</dd>
        <dd>小键盘 1 / 2</dd>
        <dt>Select / Start</dt>
        <dd>V / B</dd>
        <dd>小键盘 5 / 小键盘 Enter</dd>
        <dt>手柄</dt>
        <dd className="col-span-2">按连接顺序分配给 1P、2P</dd>
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
