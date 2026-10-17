import { useState } from "react";
import { Check, Copy, Crown, Play } from "lucide-react";
import { NETPLAY_SEATS, type NetStatus, type RoomState } from "@neslink/core";
import { Button } from "@/components/ui/button";
import { roomLink } from "@/lib/rooms";

interface Props {
  status: NetStatus;
  room: RoomState | null;
  you: string | null;
  notice: string | null;
  onStart: () => void;
}

/** Overlay on the game screen while a room waits for players or between games. */
export function RoomLobby({ status, room, you, notice, onStart }: Props) {
  const [copied, setCopied] = useState(false);
  const isHost = room !== null && room.hostId === you;
  const seated = room?.players.filter((p) => p.seat !== null) ?? [];
  const canStart = isHost && seated.length === NETPLAY_SEATS;

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
          <ul className="flex flex-col gap-1.5">
            {Array.from({ length: NETPLAY_SEATS }, (_, seat) => {
              const player = room?.players.find((p) => p.seat === seat);
              return (
                <li key={seat} className="flex items-center gap-3 rounded-md bg-white/10 px-3 py-2 text-sm">
                  <span className="w-6 font-mono text-white/60">{seat + 1}P</span>
                  {player ? (
                    <span className="flex items-center gap-1.5">
                      {player.name}
                      {player.id === room?.hostId && <Crown className="size-3.5 text-amber-300" aria-label="房主" />}
                      {player.id === you && <span className="text-white/50">（你）</span>}
                    </span>
                  ) : (
                    <span className="text-white/40">等待加入…</span>
                  )}
                </li>
              );
            })}
            {room?.players.some((p) => p.seat === null && p.id === you) && (
              <li className="text-sm text-amber-300">
                {room.players.find((p) => p.id === you)?.romHash !== room.info.romHash
                  ? "你的 ROM 和房间不一致，无法入座"
                  : "座位已满，你在观战席"}
              </li>
            )}
          </ul>
        )}

        {notice && <p className="text-sm text-amber-300">{notice}</p>}

        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={copy} disabled={!room}>
            {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
            {copied ? "已复制" : "复制邀请链接"}
          </Button>
          {isHost && (
            <Button className="flex-1" onClick={onStart} disabled={!canStart}>
              <Play data-icon="inline-start" />
              开始游戏
            </Button>
          )}
        </div>
        {!isHost && status === "open" && <p className="text-center text-xs text-white/50">等待房主开始游戏</p>}
      </div>
    </div>
  );
}
