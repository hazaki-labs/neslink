import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Upload } from "lucide-react";
import { hashRom, parseRomHeader, type RoomInfo } from "@neslink/core";
import { Button } from "@/components/ui/button";
import { useI18n, type Messages } from "@/i18n";
import { getRoom, RoomApiError } from "@/lib/rooms";
import { getRom, putRom, type StoredRom } from "@/lib/storage";
import { Player } from "./player";

type Entry =
  | { step: "loading" }
  | { step: "missing" }
  | { step: "failed"; message: (t: Messages) => string }
  /** The room exists but this browser does not have its ROM yet. */
  | { step: "needRom"; info: RoomInfo }
  | { step: "ready"; info: RoomInfo; rom: StoredRom };

/**
 * Resolves a room link into something playable: the room must exist and this
 * browser must hold the exact ROM it was created with (ROMs never leave the
 * browser, so a joiner brings their own copy and we check it by hash).
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
      return rom ? ({ step: "ready", info, rom } as const) : ({ step: "needRom", info } as const);
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
      {entry.step === "needRom" && (
        <>
          <p className="text-sm text-muted-foreground">
            {t.entry.needRom(
              <span className="font-medium text-foreground">{entry.info.romName || t.entry.unnamedGame}</span>,
            )}
          </p>
          <Button variant="outline" onClick={() => inputRef.current?.click()}>
            <Upload data-icon="inline-start" />
            {t.entry.pickRom}
          </Button>
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
