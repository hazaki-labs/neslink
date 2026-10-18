import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { verifyTicket, type ConnectionGrant } from "@neslink/relay-auth";
import { PEER_MAX_INPUTS } from "@neslink/core/netplay";
import { ReplayCache } from "./replay-cache";
import type { RelayConfig } from "./config";

export function createRelay(config: RelayConfig) {
  const replay = new ReplayCache(config.replayPath);
  const rooms = new Map<string, Map<string, WebSocket>>();
  const pendingByIp = new Map<string, number>();
  let pending = 0;
  const server = createServer((request, response) => {
    const health = request.method === "GET" && request.url?.split("?")[0] === "/health";
    response.writeHead(health ? 200 : 404, { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff" });
    response.end(health ? "ok" : "Not found");
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const prune = setInterval(() => replay.prune(), 30_000);
  prune.unref();
  // Terminate clients which disappeared without a close, so capacity is reclaimed.
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) ws.terminate();
      else { alive.delete(ws); ws.ping(); }
    }
  }, 30_000);
  heartbeat.unref();
  server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    const match = request.url?.match(/^\/rooms\/([a-z0-9]{6})\/ws$/);
    const ip = request.socket.remoteAddress ?? "unknown";
    // Do not trust X-Forwarded-For from arbitrary clients.
    if (!match || !origin || !config.allowedOrigins.has(origin)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    if (wss.clients.size >= config.maxConnections || pending >= 128 || (pendingByIp.get(ip) ?? 0) >= 8) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      pending++;
      pendingByIp.set(ip, (pendingByIp.get(ip) ?? 0) + 1);
      alive.add(ws);
      ws.on("pong", () => alive.add(ws));
      let released = false;
      const release = () => {
        if (released) return;
        released = true; pending--;
        const count = (pendingByIp.get(ip) ?? 1) - 1;
        if (count) pendingByIp.set(ip, count); else pendingByIp.delete(ip);
      };
      const timer = setTimeout(() => ws.close(1008, "Authentication timeout"), 5000);
      let grant: ConnectionGrant | null = null;
      let verifying = false;
      let groupKey: string | null = null;
      let messages = 0;
      let windowStart = Date.now();
      ws.on("error", () => ws.terminate());
      ws.on("close", () => {
        clearTimeout(timer); release();
        if (grant && groupKey) {
          const group = rooms.get(groupKey);
          if (group?.get(grant.playerId) === ws) group.delete(grant.playerId);
          if (!group?.size) rooms.delete(groupKey);
        }
      });
      ws.on("message", async (raw, binary) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - windowStart >= 1000) { messages = 0; windowStart = Date.now(); }
        if (++messages > 240 || binary) { ws.close(1008, "Invalid traffic"); return; }
        let message: Record<string, unknown>;
        try { message = JSON.parse(raw.toString()); }
        catch { ws.close(1008, "Malformed message"); return; }
        if (!message || typeof message !== "object") { ws.close(1008, "Malformed message"); return; }
        if (!grant) {
          if (verifying || message.t !== "auth" || typeof message.ticket !== "string") { ws.close(1008, "Authentication required"); return; }
          verifying = true;
          try {
            const verified = await verifyTicket(message.ticket, config.nodeId, match[1], origin, config.keys);
            if (ws.readyState !== WebSocket.OPEN) return;
            const key = `${verified.room.id}:${verified.gameId}`;
            const group = rooms.get(key) ?? new Map<string, WebSocket>();
            if (group.size >= 16 && !group.has(verified.playerId)) throw new Error("Room full");
            if (!replay.consume(verified.jti, verified.expires)) throw new Error("Ticket already used");
            grant = verified; groupKey = key;
            const previous = group.get(grant.playerId);
            group.set(grant.playerId, ws); rooms.set(key, group);
            previous?.close(1000, "Replaced");
            clearTimeout(timer); release();
            ws.send(JSON.stringify({ t: "authenticated" }));
          } catch { ws.close(1008, "Authentication failed"); }
          return;
        }
        if (message.t === "ping" && typeof message.ts === "number" && Number.isFinite(message.ts)) {
          ws.send(JSON.stringify({ t: "pong", ts: message.ts })); return;
        }
        // A spectator cannot submit input. A player cannot impersonate the other seat.
        if (message.t !== "in" || grant.seat === null || message.s !== grant.seat ||
            !Number.isSafeInteger(message.f) || (message.f as number) < 0 ||
            !Array.isArray(message.m) || message.m.length === 0 || message.m.length > PEER_MAX_INPUTS ||
            message.m.length > (message.f as number) + 1 ||
            message.m.some((mask: unknown) => !Number.isInteger(mask) || (mask as number) < 0 || (mask as number) > 255) ||
            !Number.isSafeInteger(message.a) || !Number.isSafeInteger(message.k)) {
          ws.close(1008, "Invalid input"); return;
        }
        const payload = JSON.stringify({ t: "in", s: grant.seat, f: message.f, m: message.m, a: message.a, k: message.k });
        for (const peer of rooms.get(groupKey!)?.values() ?? []) {
          if (peer === ws || peer.readyState !== WebSocket.OPEN) continue;
          if (peer.bufferedAmount > 256 * 1024) peer.close(1013, "Slow receiver");
          else peer.send(payload);
        }
      });
    });
  });
  return {
    server,
    async close() {
      clearInterval(prune); clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      replay.close();
    },
  };
}
