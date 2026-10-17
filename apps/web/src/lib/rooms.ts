import type { ApiErrorCode, RoomInfo } from "@neslink/core";
import { messages } from "@/i18n";

/** A failed rooms API call; `code` is worded by the UI in the viewer's language. */
export class RoomApiError extends Error {
  constructor(readonly code: ApiErrorCode | "createFailed" | "loadFailed") {
    super(code);
  }
}

export async function createRoom(romHash: string, romName: string): Promise<RoomInfo> {
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ romHash, romName }),
  });
  if (!res.ok) throw new RoomApiError(await errorCode(res, "createFailed"));
  return res.json();
}

/** The room's info, or null when it does not exist (expired or mistyped). */
export async function getRoom(id: string): Promise<RoomInfo | null> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new RoomApiError(await errorCode(res, "loadFailed"));
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

/**
 * Dev tool: `?lag=120&jitter=20` adds that much round-trip latency (and random
 * jitter) to this tab's room connection, to try rollback without a far-away friend.
 */
export function simulatedNetwork(): { lagMs: number; jitterMs: number } | null {
  const params = new URLSearchParams(location.search);
  const lagMs = Number(params.get("lag") ?? 0);
  const jitterMs = Number(params.get("jitter") ?? 0);
  if (!(lagMs > 0 || jitterMs > 0)) return null;
  return { lagMs: Math.min(Math.max(lagMs, 0), 2000), jitterMs: Math.min(Math.max(jitterMs, 0), 1000) };
}

const NAME_KEY = "neslink:name";

/** A display name for rooms, remembered per browser. */
export function playerName(): string {
  try {
    const saved = localStorage.getItem(NAME_KEY);
    if (saved) return saved;
    const name = `${messages().playerNamePrefix}${Math.floor(1000 + Math.random() * 9000)}`;
    localStorage.setItem(NAME_KEY, name);
    return name;
  } catch {
    return messages().playerNamePrefix;
  }
}

const API_ERROR_CODES: readonly string[] = ["roomNotFound", "badRequest", "missingRomHash"] satisfies ApiErrorCode[];

async function errorCode(res: Response, fallback: RoomApiError["code"]): Promise<RoomApiError["code"]> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error && API_ERROR_CODES.includes(body.error) ? (body.error as ApiErrorCode) : fallback;
  } catch {
    return fallback;
  }
}
