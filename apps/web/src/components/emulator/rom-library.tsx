import { useEffect, useRef, useState } from "react";
import { Gamepad2, Languages, Play, Trash2, Upload, Users } from "lucide-react";
import { hashRom, parseRomHeader } from "@neslink/core";
import { Button } from "@/components/ui/button";
import { useI18n, type Messages } from "@/i18n";
import { RoomApiError } from "@/lib/rooms";
import { deleteRom, listRoms, putRom, type StoredRom } from "@/lib/storage";
import { cn } from "@/lib/utils";

export function RomLibrary({
  onPlay,
  onHost,
}: {
  onPlay: (rom: StoredRom) => void;
  /** Create a netplay room for this ROM. */
  onHost: (rom: StoredRom) => Promise<void>;
}) {
  const { t, locale, setLocale } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [roms, setRoms] = useState<StoredRom[] | null>(null);
  // Worded at render time, so switching language rewords it too.
  const [error, setError] = useState<((t: Messages) => string) | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hosting, setHosting] = useState<string | null>(null);

  useEffect(() => {
    listRoms().then(setRoms, (e: Error) => setError(() => (t: Messages) => t.library.loadFailed(e.message)));
  }, []);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    let last: StoredRom | null = null;
    for (const file of Array.from(files)) {
      const data = new Uint8Array(await file.arrayBuffer());
      try {
        parseRomHeader(data);
      } catch {
        setError(() => (t: Messages) => t.library.invalidRom(file.name));
        continue;
      }
      last = {
        hash: await hashRom(data),
        name: file.name.replace(/\.nes$/i, ""),
        size: data.length,
        addedAt: Date.now(),
        data,
      };
      await putRom(last);
    }
    setRoms(await listRoms());
    // A single new file most likely means "play this now".
    if (last && files.length === 1) onPlay(last);
  };

  const host = async (rom: StoredRom) => {
    setError(null);
    setHosting(rom.hash);
    try {
      await onHost(rom);
    } catch (e) {
      setError(() => (t: Messages) => (e instanceof RoomApiError ? t.apiErrors[e.code] : (e as Error).message));
      setHosting(null);
    }
  };

  const remove = async (hash: string) => {
    await deleteRom(hash);
    setRoms(await listRoms());
  };

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Gamepad2 className="size-6" />
            NESLink
          </h1>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t.language.label}
            onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
          >
            <Languages data-icon="inline-start" />
            {t.language.switchTo}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t.library.intro}</p>
      </header>

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addFiles(e.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col items-center gap-2 rounded-xl border-2 border-dashed p-10 text-sm text-muted-foreground transition-colors hover:bg-muted/50",
          dragging && "border-primary bg-muted",
        )}
      >
        <Upload className="size-6" />
        <span>{t.library.dropHint}</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".nes"
        multiple
        hidden
        onChange={(e) => {
          void addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {error && <p className="text-sm text-destructive">{error(t)}</p>}

      {roms && roms.length > 0 && (
        <ul className="divide-y rounded-xl border">
          {roms.map((rom) => (
            <li key={rom.hash} className="flex items-center gap-3 px-4 py-3">
              <div className="mr-auto min-w-0">
                <p className="truncate font-medium">{rom.name}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {(rom.size / 1024).toFixed(0)} KiB · {rom.hash.slice(0, 8)}
                </p>
              </div>
              <Button size="sm" onClick={() => onPlay(rom)}>
                <Play data-icon="inline-start" />
                {t.library.play}
              </Button>
              <Button size="sm" variant="outline" disabled={hosting !== null} onClick={() => host(rom)}>
                <Users data-icon="inline-start" />
                {hosting === rom.hash ? t.library.hosting : t.library.host}
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label={t.library.remove(rom.name)} onClick={() => remove(rom.hash)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
