import { useState } from "react";
import { Check, Copy, Crown, Eye, Play } from "lucide-react";
import { chooseInputDelay, NES_FRAME_RATE, NETPLAY_SEATS, type NetStatus, type RoomState } from "@neslink/core";
import { Button } from "@/components/ui/button";
import { roomLink } from "@/lib/rooms";

interface Props {
  status: NetStatus;
  room: RoomState | null;
  you: string | null;
  notice: string | null;
  onStart: () => void;
  /** Sit in a seat, or stand up to spectate (null). */
  onSeat: (seat: number | null) => void;
}

/** Overlay on the game screen while a room waits for players or between games. */
export function RoomLobby({ status, room, you, notice, onStart, onSeat }: Props) {
  const [copied, setCopied] = useState(false);
  const me = room?.players.find((p) => p.id === you) ?? null;
  const isHost = room !== null && room.hostId === you;
  const romMatches = me !== null && room !== null && me.romHash === room.info.romHash;
  const seated = room?.players.filter((p) => p.seat !== null) ?? [];
  const spectators = room?.players.filter((p) => p.seat === null) ?? [];
  const canStart = isHost && seated.length > 0;
  // The same rule the room applies when the game starts.
  const delay = seated.length > 0 ? chooseInputDelay(seated.map((p) => p.rttMs)) : null;
  const measured = seated.length === 1 || seated.every((p) => p.rttMs !== null);

  const copy = async () => {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(roomLink(room.info.id));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked; the code is on screen to copy by hand.
    }
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/85 p-4 text-white">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm text-white/60">房间</p>
          <p className="font-mono text-2xl tracking-widest">{room?.info.id ?? "······"}</p>
        </div>

        {status !== "open" ? (
          <p className="text-sm text-white/70">{status === "connecting" ? "正在连接房间…" : "与房间的连接已断开"}</p>
        ) : (
          <>
            <ul className="flex flex-col gap-1.5">
              {Array.from({ length: NETPLAY_SEATS }, (_, seat) => {
                const player = room?.players.find((p) => p.seat === seat);
                return (
                  <li key={seat} className="flex h-11 items-center gap-3 rounded-md bg-white/10 px-3 text-sm">
                    <span className="w-6 font-mono text-white/60">{seat + 1}P</span>
                    {player ? (
                      <>
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate">{player.name}</span>
                          {player.id === room?.hostId && <Crown className="size-3.5 shrink-0 text-amber-300" aria-label="房主" />}
                          {player.id === you && <span className="shrink-0 text-white/50">（你）</span>}
                        </span>
                        <span className="ml-auto font-mono text-xs text-white/50 tabular-nums">
                          {player.rttMs !== null ? `${player.rttMs}ms` : "测速中"}
                        </span>
                        {player.id === you && (
                          <Button size="xs" variant="secondary" onClick={() => onSeat(null)}>
                            <Eye data-icon="inline-start" />
                            去观战
                          </Button>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="text-white/40">空位</span>
                        {romMatches && (
                          <Button size="xs" variant="secondary" className="ml-auto" onClick={() => onSeat(seat)}>
                            坐下
                          </Button>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>

            <div className="text-sm">
              <p className="text-white/60">观众（{spectators.length}）</p>
              {spectators.length > 0 && (
                <p className="mt-1 text-white/80">
                  {spectators.map((p) => (p.id === you ? `${p.name}（你）` : p.name)).join("、")}
                </p>
              )}
              {me && me.seat === null && !romMatches && (
                <p className="mt-1 text-amber-300">你的 ROM 和房间不一致，只能看大厅，无法入座或观战</p>
              )}
            </div>
          </>
        )}

        {delay !== null && (
          <p className="text-xs text-white/60">
            {seated.length === 1
              ? "单人开局，其他人观战"
              : measured
                ? `按双方网络延迟，输入延迟将设为 ${delay} 帧（${Math.round((delay * 1000) / NES_FRAME_RATE)}ms）`
                : `还在测速，现在开始会使用默认的 ${delay} 帧输入延迟`}
          </p>
        )}

        {notice && <p className="text-sm text-amber-300">{notice}</p>}

        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={copy} disabled={!room}>
            {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
            {copied ? "已复制" : "复制房间链接"}
          </Button>
          {isHost && (
            <Button className="flex-1" onClick={onStart} disabled={!canStart}>
              <Play data-icon="inline-start" />
              开始游戏
            </Button>
          )}
        </div>
        {!isHost && status === "open" && <p className="text-center text-xs text-white/50">等待房主开始游戏</p>}
        <p className="text-center text-xs text-white/40">打开这个链接的人可以入座，也可以观战（对局中也能进来看）</p>
      </div>
    </div>
  );
}
