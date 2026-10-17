import type { RoomInfo } from "@neslink/core/netplay";
import { Room } from "./room";

export { Room };

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
}

// Unambiguous characters only, since people read room codes to each other.
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const ID_LENGTH = 6;
const SHA1_HEX = /^[0-9a-f]{40}$/;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      return createRoom(request, env);
    }

    const match = url.pathname.match(/^\/api\/rooms\/([a-z0-9]+)(\/ws)?$/);
    if (match) {
      const [, id, ws] = match;
      const room = env.ROOMS.get(env.ROOMS.idFromName(id));
      if (ws) return room.fetch(request);
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      const info = await room.getInfo();
      return info ? Response.json(info) : Response.json({ error: "房间不存在" }, { status: 404 });
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
    return Response.json({ error: "请求格式错误" }, { status: 400 });
  }
  if (typeof body.romHash !== "string" || !SHA1_HEX.test(body.romHash)) {
    return Response.json({ error: "缺少 ROM 校验值" }, { status: 400 });
  }
  const romName = typeof body.romName === "string" ? body.romName.slice(0, 100) : "";
  const info: RoomInfo = { id: randomId(), romHash: body.romHash, romName };
  await env.ROOMS.get(env.ROOMS.idFromName(info.id)).init(info);
  return Response.json(info, { status: 201 });
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}
