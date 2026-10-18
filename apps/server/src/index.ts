import type { ApiErrorCode, RoomInfo } from "@neslink/core/netplay";
import { Room } from "./room";
import { turnServers } from "./turn";
import { relayNodes } from "./relays";

export { Room };

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
  /** Cloudflare Realtime TURN key; both are secrets, and TURN is off without them. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  RELAY_NODES?: string;
  RELAY_SIGNING_KEYS?: string;
}

// Unambiguous characters only, since people read room codes to each other.
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const ID_LENGTH = 6;
const SHA1_HEX = /^[0-9a-f]{40}$/;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/ping" && request.method === "GET") {
      return new Response("ok", { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/api/relay-nodes" && request.method === "GET") {
      return Response.json(relayNodes(env), { headers: { "Cache-Control": "no-store" } });
    }
    const ticketMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9]+)\/relay-ticket$/);
    if (ticketMatch && request.method === "POST") {
      if (request.headers.get("Origin") !== url.origin) return apiError("connectionDenied", 403);
      if (Number(request.headers.get("Content-Length")) > 1024) return apiError("badRequest", 400);
      let connectionToken: unknown;
      try { ({ connectionToken } = await request.json() as { connectionToken?: unknown }); }
      catch { return apiError("badRequest", 400); }
      if (typeof connectionToken !== "string" || connectionToken.length > 100) return apiError("connectionDenied", 403);
      const result = await env.ROOMS.get(env.ROOMS.idFromName(ticketMatch[1])).relayTicket(connectionToken, url.origin);
      return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store", "Pragma": "no-cache" } });
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      return createRoom(request, env);
    }

    if (url.pathname === "/api/turn" && request.method === "GET") {
      return turnServers(env);
    }

    const match = url.pathname.match(/^\/api\/rooms\/([a-z0-9]+)(\/ws)?$/);
    if (match) {
      const [, id, ws] = match;
      const room = env.ROOMS.get(env.ROOMS.idFromName(id));
      if (ws) return room.fetch(request);
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      const info = await room.getInfo();
      return info ? Response.json(info) : apiError("roomNotFound", 404);
    }

    if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function createRoom(request: Request, env: Env): Promise<Response> {
  let body: { romHash?: unknown; romName?: unknown };
  try {
    body = await request.json();
  } catch {
    return apiError("badRequest", 400);
  }
  if (typeof body.romHash !== "string" || !SHA1_HEX.test(body.romHash)) {
    return apiError("missingRomHash", 400);
  }
  const romName = typeof body.romName === "string" ? body.romName.slice(0, 100) : "";
  const info: RoomInfo = { id: randomId(), romHash: body.romHash, romName };
  await env.ROOMS.get(env.ROOMS.idFromName(info.id)).init(info);
  return Response.json(info, { status: 201 });
}

/** Errors carry a code; the frontend shows it in the viewer's language. */
function apiError(code: ApiErrorCode, status: number): Response {
  return Response.json({ error: code }, { status });
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}
