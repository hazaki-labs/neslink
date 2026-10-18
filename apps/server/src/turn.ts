import type { Env } from "./index";

/** How long the credentials handed to browsers stay valid. */
const CREDENTIAL_TTL_S = 3600;
/** Reuse one set per isolate this long, so every room join doesn't call the API. */
const CACHE_MS = 10 * 60 * 1000;

/** RTCIceServer, which Workers don't have a type for. */
interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

let cached: { iceServers: IceServer[]; expires: number } | null = null;

/**
 * GET /api/turn: short-lived ICE servers for the direct player link, from
 * Cloudflare Realtime TURN. Players behind NATs that STUN can't get through
 * relay their data channel over TURN instead of falling back to the room.
 */
export async function turnServers(env: Env): Promise<Response> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return Response.json(
      { error: "turnNotConfigured", detail: "Set the TURN_KEY_ID and TURN_KEY_API_TOKEN secrets to enable TURN." },
      { status: 503 },
    );
  }
  if (!cached || cached.expires <= Date.now()) {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: CREDENTIAL_TTL_S }),
      },
    );
    if (!res.ok) {
      console.error(`TURN credentials request failed: ${res.status} ${await res.text()}`);
      return Response.json({ error: "turnFailed" }, { status: 502 });
    }
    const body = (await res.json()) as { iceServers?: IceServer[] };
    cached = { iceServers: withoutPort53(body.iceServers ?? []), expires: Date.now() + CACHE_MS };
  }
  return Response.json({ iceServers: cached.iceServers }, { headers: { "Cache-Control": "private, max-age=600" } });
}

/** Browsers block port 53, and trying those URLs only slows ICE down. */
function withoutPort53(servers: IceServer[]): IceServer[] {
  return servers
    .map((server) => {
      const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((u) => !/:53(\?|$)/.test(u));
      return { ...server, urls };
    })
    .filter((server) => server.urls.length > 0);
}
