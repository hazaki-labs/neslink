import { hashRom, parseRomHeader, type ApiErrorCode, type RoomInfo } from "@neslink/core";
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

/**
 * The room's ROM, from a player in it who has it, for joining without one.
 * `onProgress` gets the bytes received so far. Checked against the room's
 * hash; a ROM that fails the check, or a transfer cut short, is romUnavailable.
 */
export async function fetchRoomRom(info: RoomInfo, onProgress: (bytes: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(info.id)}/rom`, { cache: "no-store" });
  if (!res.ok || !res.body) throw new RoomApiError(await errorCode(res, "romUnavailable"));
  const parts: Uint8Array[] = [];
  let received = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.length;
      onProgress(received);
    }
  } catch {
    throw new RoomApiError("romUnavailable");
  }
  const data = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  try {
    parseRomHeader(data);
  } catch {
    throw new RoomApiError("romUnavailable");
  }
  if ((await hashRom(data)) !== info.romHash) throw new RoomApiError("romUnavailable");
  return data;
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
 * Dev tool: `?lag=120&swing=20` adds that much round-trip latency (and up to
 * `swing` ms of random extra) to this tab's room connection, to try rollback
 * without a far-away friend.
 */
export function simulatedNetwork(): { lagMs: number; jitterMs: number } | null {
  const params = new URLSearchParams(location.search);
  const lagMs = Number(params.get("lag") ?? 0);
  const jitterMs = Number(params.get("swing") ?? 0);
  if (!(lagMs > 0 || jitterMs > 0)) return null;
  return { lagMs: Math.min(Math.max(lagMs, 0), 2000), jitterMs: Math.min(Math.max(jitterMs, 0), 1000) };
}

/**
 * How to try the direct link to the other player, or null for not at all.
 * Dev tools: `?route=room` keeps play going through the room server, to compare
 * with a direct link; `?route=transit` only allows routes through Cloudflare's
 * TURN transit nodes, to check TURN works.
 */
export function directLinkPolicy(): RTCIceTransportPolicy | null {
  if (typeof RTCPeerConnection !== "function") return null;
  const route = new URLSearchParams(location.search).get("route");
  if (route === "room") return null;
  return route === "transit" ? "relay" : "all";
}

const NAME_KEY = "neslink:name";

/** Remember a new display name for rooms in this browser. */
export function setPlayerName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Only this room hears about it then.
  }
}

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

const API_ERROR_CODES: readonly string[] = [
  "roomNotFound", "badRequest", "missingRomHash", "relayUnavailable", "connectionDenied", "tooManyRequests", "romUnavailable",
] satisfies ApiErrorCode[];

async function errorCode(res: Response, fallback: RoomApiError["code"]): Promise<RoomApiError["code"]> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error && API_ERROR_CODES.includes(body.error) ? (body.error as ApiErrorCode) : fallback;
  } catch {
    return fallback;
  }
}
