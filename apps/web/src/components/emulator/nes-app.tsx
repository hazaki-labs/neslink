import { useEffect, useState } from "react";
import { createRoom, roomIdFromUrl, setRoomInUrl } from "@/lib/rooms";
import type { StoredRom } from "@/lib/storage";
import { Player } from "./player";
import { RomLibrary } from "./rom-library";
import { RoomEntry } from "./room-entry";

type View =
  | { kind: "library" }
  | { kind: "solo"; rom: StoredRom }
  /** `rom` is known when we just created the room; joiners look it up by hash. */
  | { kind: "room"; roomId: string; rom: StoredRom | null };

function viewFromUrl(): View {
  const roomId = roomIdFromUrl();
  return roomId ? { kind: "room", roomId, rom: null } : { kind: "library" };
}

export function NesApp() {
  const [view, setView] = useState<View>(viewFromUrl);

  useEffect(() => {
    const onPopState = () => setView(viewFromUrl());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const host = async (rom: StoredRom) => {
    const info = await createRoom(rom.hash, rom.name);
    setRoomInUrl(info.id);
    setView({ kind: "room", roomId: info.id, rom });
  };

  const exit = () => {
    if (view.kind === "room") setRoomInUrl(null);
    setView({ kind: "library" });
  };

  switch (view.kind) {
    case "library":
      return <RomLibrary onPlay={(rom) => setView({ kind: "solo", rom })} onHost={host} />;
    case "solo":
      return <Player rom={view.rom} onExit={exit} />;
    case "room":
      return <RoomEntry key={view.roomId} roomId={view.roomId} knownRom={view.rom} onExit={exit} />;
  }
}
