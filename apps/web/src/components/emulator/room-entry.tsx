import { useEffect, useRef, useState } from "react";
import { ArrowLeft, RefreshCw, Upload } from "lucide-react";
import { hashRom, parseRomHeader, type RoomInfo } from "@neslink/core";
import { Button } from "@/components/ui/button";
import { useI18n, type Messages } from "@/i18n";
import { fetchRoomRom, getRoom, RoomApiError } from "@/lib/rooms";
import { getRom, putRom, type StoredRom } from "@/lib/storage";
import { Player } from "./player";

type Entry =
  | { step: "loading" }
  | { step: "missing" }
  | { step: "failed"; message: (t: Messages) => string }
  /** The room exists but this browser does not have its ROM: get it from someone in the room. */
  | { step: "fetching"; info: RoomInfo; bytes: number }
  /** Nobody could send it: the joiner loads their own copy. */
  | { step: "needRom"; info: RoomInfo }
  | { step: "ready"; info: RoomInfo; rom: StoredRom };

/**
 * Resolves a room link into something playable: the room must exist, and we
 * need the exact ROM it was created with. Ours if this browser has it; else a
 * player in the room sends theirs (kept for this room only, not in the
 * library); failing that, the joiner loads their own copy, checked by hash.
 */
export function RoomEntry({ roomId, knownRom, onExit }: { roomId: string; knownRom: StoredRom | null; onExit: () => void }) {
  const { t } = useI18n();
  const [entry, setEntry] = useState<Entry>({ step: "loading" });
  // Worded at render time, so switching language rewords it too.
  const [error, setError] = useState<((t: Messages) => string) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const info = await getRoom(roomId);
      if (!info) return { step: "missing" } as const;
      const rom = knownRom?.hash === info.romHash ? knownRom : await getRom(info.romHash);
      return rom ? ({ step: "ready", info, rom } as const) : ({ step: "fetching", info, bytes: 0 } as const);
    })().then(
      (next) => !cancelled && setEntry(next),
      (e: Error) =>
        !cancelled &&
        setEntry({ step: "failed", message: (t) => (e instanceof RoomApiError ? t.apiErrors[e.code] : e.message) }),
    );
    return () => {
      cancelled = true;
    };
  }, [roomId, knownRom]);

  // Ask the room for its ROM. Received ROMs are used for this room only.
  const fetchingInfo = entry.step === "fetching" ? entry.info : null;
  useEffect(() => {
    if (!fetchingInfo) return;
    let cancelled = false;
    fetchRoomRom(fetchingInfo, (bytes) => !cancelled && setEntry({ step: "fetching", info: fetchingInfo, bytes })).then(
      (data) => {
        if (cancelled) return;
        const rom: StoredRom = {
          hash: fetchingInfo.romHash, name: fetchingInfo.romName, size: data.length, addedAt: Date.now(), data,
        };
        setEntry({ step: "ready", info: fetchingInfo, rom });
      },
      (e: Error) => {
        if (cancelled) return;
        setEntry({ step: "needRom", info: fetchingInfo });
        setError(() => (t: Messages) => (e instanceof RoomApiError ? t.apiErrors[e.code] : e.message));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fetchingInfo]);

  const importRom = async (file: File | undefined) => {
    if (!file || entry.step !== "needRom") return;
    setError(null);
    const data = new Uint8Array(await file.arrayBuffer());
    try {
      parseRomHeader(data);
    } catch {
      return setError(() => (t: Messages) => t.library.invalidRom(file.name));
    }
    const hash = await hashRom(data);
    if (hash !== entry.info.romHash) return setError(() => (t: Messages) => t.entry.romHashMismatch);
    const rom: StoredRom = { hash, name: file.name.replace(/\.nes$/i, ""), size: data.length, addedAt: Date.now(), data };
    await putRom(rom);
    setEntry({ step: "ready", info: entry.info, rom });
  };

  if (entry.step === "ready") return <Player rom={entry.rom} room={entry.info} onExit={onExit} />;

  return (
    <div className="flex w-full max-w-md flex-col gap-4">
      <Button variant="ghost" size="sm" className="self-start" onClick={onExit}>
        <ArrowLeft data-icon="inline-start" />
        {t.library.title}
      </Button>
      <h1 className="text-xl font-semibold">
        {t.entry.title} <span className="font-mono">{roomId}</span>
      </h1>
      {entry.step === "loading" && <p className="text-sm text-muted-foreground">{t.entry.loading}</p>}
      {entry.step === "missing" && <p className="text-sm text-muted-foreground">{t.entry.missing}</p>}
      {entry.step === "failed" && <p className="text-sm text-destructive">{entry.message(t)}</p>}
      {entry.step === "fetching" && (
        <p className="text-sm text-muted-foreground">
          {t.entry.fetchingRom(
            <span className="font-medium text-foreground">{entry.info.romName || t.entry.unnamedGame}</span>,
            Math.round(entry.bytes / 1024),
          )}
        </p>
      )}
      {entry.step === "needRom" && (
        <>
          <p className="text-sm text-muted-foreground">
            {t.entry.needRom(
              <span className="font-medium text-foreground">{entry.info.romName || t.entry.unnamedGame}</span>,
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setError(null);
                setEntry({ step: "fetching", info: entry.info, bytes: 0 });
              }}
            >
              <RefreshCw data-icon="inline-start" />
              {t.entry.retry}
            </Button>
            <Button variant="outline" onClick={() => inputRef.current?.click()}>
              <Upload data-icon="inline-start" />
              {t.entry.pickRom}
            </Button>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".nes"
            hidden
            onChange={(e) => {
              void importRom(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {error && <p className="text-sm text-destructive">{error(t)}</p>}
        </>
      )}
    </div>
  );
}
