import { useState } from "react";
import { Check, Copy, Crown, Eye, Pencil, Play } from "lucide-react";
import {
  chooseNetplayDelay,
  NES_FRAME_RATE,
  NETPLAY_SEATS,
  type NetStatus,
  type RoomEndReason,
  type RoomState,
  type RelaySelection,
} from "@neslink/core";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { roomLink } from "@/lib/rooms";
import { RelaySelector } from "./relay-selector";

interface Props {
  status: NetStatus;
  room: RoomState | null;
  you: string | null;
  /** Why the last game ended, if it did. */
  notice: RoomEndReason | null;
  onStart: () => void;
  /** Sit in a seat, or stand up to spectate (null). */
  onSeat: (seat: number | null) => void;
  onRelaySelect: (selection: RelaySelection) => void;
  /** Change our display name. */
  onRename: (name: string) => void;
}

/** Overlay on the game screen while a room waits for players or between games. */
export function RoomLobby({ status, room, you, notice, onStart, onSeat, onRelaySelect, onRename }: Props) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  /** The name being typed, while editing ours. */
  const [draft, setDraft] = useState<string | null>(null);
  const me = room?.players.find((p) => p.id === you) ?? null;
  const isHost = room !== null && room.hostId === you;
  const romMatches = me !== null && room !== null && me.romHash === room.info.romHash;
  const seated = room?.players.filter((p) => p.seat !== null) ?? [];
  const spectators = room?.players.filter((p) => p.seat === null) ?? [];
  const canStart = isHost && seated.length > 0;
  // The same rule the room applies when the game starts.
  const delay = seated.length > 0 ? chooseNetplayDelay(seated) : null;
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
      <div className="flex max-h-full w-full max-w-lg flex-col gap-4 overflow-y-auto">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm text-white/60">{t.lobby.room}</p>
          <p className="font-mono text-2xl tracking-widest">{room?.info.id ?? "······"}</p>
        </div>

        {status !== "open" ? (
          <p className="text-sm text-white/70">
            {status === "connecting" ? t.lobby.connecting : status === "reconnecting" ? t.lobby.reconnecting : t.lobby.disconnected}
          </p>
        ) : (
          <>
            {me && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-white/60">{t.lobby.yourName}</span>
                {draft === null ? (
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1.5 rounded px-1 hover:bg-white/10"
                    title={t.lobby.rename}
                    onClick={() => setDraft(me.name)}
                  >
                    <span className="truncate">{me.name}</span>
                    <Pencil className="size-3 shrink-0 text-white/50" />
                  </button>
                ) : (
                  <input
                    autoFocus
                    maxLength={20}
                    value={draft}
                    aria-label={t.lobby.rename}
                    className="min-w-0 flex-1 rounded bg-white/10 px-2 py-0.5 outline-none focus:ring-1 focus:ring-white/40"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setDraft(null);
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    onBlur={() => {
                      const name = draft.trim();
                      if (name && name !== me.name) onRename(name);
                      setDraft(null);
                    }}
                  />
                )}
              </div>
            )}
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
                          {player.id === room?.hostId && <Crown className="size-3.5 shrink-0 text-amber-300" aria-label={t.lobby.host} />}
                          {player.id === you && <span className="shrink-0 text-white/50">{t.lobby.you}</span>}
                          {player.connected === false && <span className="shrink-0 text-amber-300">{t.lobby.away}</span>}
                        </span>
                        <span className="ml-auto font-mono text-xs text-white/50 tabular-nums">
                          {player.rttMs !== null ? `${player.rttMs}ms` : t.lobby.measuring}
                          {player.directRttMs !== null && ` · ${t.player.directRtt(player.directRttMs)}`}
                        </span>
                        {player.id === you && (
                          <Button size="xs" variant="secondary" onClick={() => onSeat(null)}>
                            <Eye data-icon="inline-start" />
                            {t.lobby.spectate}
                          </Button>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="text-white/40">{t.lobby.emptySeat}</span>
                        {romMatches && (
                          <Button size="xs" variant="secondary" className="ml-auto" onClick={() => onSeat(seat)}>
                            {t.lobby.sit}
                          </Button>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>

            <div className="text-sm">
              <p className="text-white/60">{t.lobby.audience(spectators.length)}</p>
              {spectators.length > 0 && (
                <p className="mt-1 text-white/80">
                  {spectators.map((p) => (p.id === you ? `${p.name}${t.lobby.you}` : p.name)).join(t.lobby.listSeparator)}
                </p>
              )}
              {me && me.seat === null && !romMatches && (
                <p className="mt-1 text-amber-300">{t.lobby.romMismatch}</p>
              )}
            </div>
          </>
        )}

        {delay !== null && (
          <p className="text-xs text-white/60">
            {seated.length === 1
              ? t.lobby.soloHint
              : measured
                ? t.lobby.delayPlanned(delay, NES_FRAME_RATE)
                : t.lobby.delayDefault(delay)}
          </p>
        )}

        {room && <RelaySelector room={room} isHost={isHost} onSelect={onRelaySelect} />}
        {notice && <p className="text-sm text-amber-300">{t.roomEnded[notice]}</p>}

        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={copy} disabled={!room}>
            {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
            {copied ? t.lobby.copied : t.lobby.copyLink}
          </Button>
          {isHost && (
            <Button className="flex-1" onClick={onStart} disabled={!canStart}>
              <Play data-icon="inline-start" />
              {t.lobby.start}
            </Button>
          )}
        </div>
        {!isHost && status === "open" && <p className="text-center text-xs text-white/50">{t.lobby.waitingForHost}</p>}
        <p className="text-center text-xs text-white/40">{t.lobby.linkHint}</p>
      </div>
    </div>
  );
}
