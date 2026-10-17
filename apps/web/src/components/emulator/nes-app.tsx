import { useState } from "react";
import type { StoredRom } from "@/lib/storage";
import { Player } from "./player";
import { RomLibrary } from "./rom-library";

export function NesApp() {
  const [rom, setRom] = useState<StoredRom | null>(null);
  return rom ? <Player rom={rom} onExit={() => setRom(null)} /> : <RomLibrary onPlay={setRom} />;
}
