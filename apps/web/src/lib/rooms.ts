import type { RoomInfo } from "@neslink/core";

export async function createRoom(romHash: string, romName: string): Promise<RoomInfo> {
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ romHash, romName }),
  });
  if (!res.ok) throw new Error(await errorText(res, "创建房间失败"));
  return res.json();
}

/** The room's info, or null when it does not exist (expired or mistyped). */
export async function getRoom(id: string): Promise<RoomInfo | null> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await errorText(res, "读取房间失败"));
  return res.json();
}

export function roomSocketUrl(id: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/rooms/${encodeURIComponent(id)}/ws`;
}

export function roomLink(id: string): string {
  return `${location.origin}/?room=${encodeURIComponent(id)}`;
}

/** The room id in the current URL, if any. */
export function roomIdFromUrl(): string | null {
  return new URLSearchParams(location.search).get("room");
}

export function setRoomInUrl(id: string | null): void {
  const url = new URL(location.href);
  if (id) url.searchParams.set("room", id);
  else url.searchParams.delete("room");
  history.pushState(null, "", url);
}

const NAME_KEY = "neslink:name";

/** A display name for rooms, remembered per browser. */
export function playerName(): string {
  try {
    const saved = localStorage.getItem(NAME_KEY);
    if (saved) return saved;
    const name = `玩家${Math.floor(1000 + Math.random() * 9000)}`;
    localStorage.setItem(NAME_KEY, name);
    return name;
  } catch {
    return "玩家";
  }
}

async function errorText(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}
