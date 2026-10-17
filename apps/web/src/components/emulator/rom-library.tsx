import { useEffect, useRef, useState } from "react";
import { Gamepad2, Play, Trash2, Upload } from "lucide-react";
import { hashRom, parseRomHeader } from "@neslink/core";
import { Button } from "@/components/ui/button";
import { deleteRom, listRoms, putRom, type StoredRom } from "@/lib/storage";
import { cn } from "@/lib/utils";

export function RomLibrary({ onPlay }: { onPlay: (rom: StoredRom) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [roms, setRoms] = useState<StoredRom[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    listRoms().then(setRoms, (e: Error) => setError(`无法读取本地游戏库：${e.message}`));
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
        setError(`${file.name} 不是有效的 .nes 文件`);
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

  const remove = async (hash: string) => {
    await deleteRom(hash);
    setRoms(await listRoms());
  };

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Gamepad2 className="size-6" />
          NESLink
        </h1>
        <p className="text-sm text-muted-foreground">
          载入你自己的 .nes 文件开始游戏。ROM 只保存在这个浏览器里，不会上传。
        </p>
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
        <span>点击选择或拖入 .nes 文件</span>
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

      {error && <p className="text-sm text-destructive">{error}</p>}

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
                开始
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label={`删除 ${rom.name}`} onClick={() => remove(rom.hash)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
