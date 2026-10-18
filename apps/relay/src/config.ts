import { secretBytes } from "@neslink/relay-auth";

export interface RelayConfig {
  nodeId: string;
  keys: ReadonlyMap<string, string>;
  allowedOrigins: ReadonlySet<string>;
  replayPath: string;
  host: string;
  port: number;
  maxConnections: number;
}

export function readConfig(env: NodeJS.ProcessEnv): RelayConfig {
  const nodeId = env.RELAY_NODE_ID ?? "";
  if (!/^[a-z0-9-]{1,32}$/.test(nodeId) || nodeId === "main") throw new Error("Set RELAY_NODE_ID");
  const rawKeys: unknown = JSON.parse(env.RELAY_KEYS ?? "{}");
  if (!rawKeys || typeof rawKeys !== "object" || Array.isArray(rawKeys)) throw new Error("Invalid RELAY_KEYS");
  const keys = new Map(Object.entries(rawKeys));
  if (!keys.size || keys.size > 4) throw new Error("Configure 1-4 relay verification keys");
  for (const [kid, secret] of keys) {
    if (!/^[A-Za-z0-9-]{1,40}$/.test(kid) || typeof secret !== "string") throw new Error("Invalid relay key");
    secretBytes(secret);
  }
  const origins = (env.RELAY_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!origins.length || origins.some((origin) => {
    const url = new URL(origin);
    return url.origin !== origin || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  })) throw new Error("Set exact HTTPS RELAY_ALLOWED_ORIGINS (HTTP only on loopback)");
  const port = Number(env.PORT ?? 8788);
  const maxConnections = Number(env.RELAY_MAX_CONNECTIONS ?? 1024);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 100_000) throw new Error("Invalid relay limits");
  return { nodeId, keys: keys as Map<string, string>, allowedOrigins: new Set(origins),
    replayPath: env.RELAY_REPLAY_DB ?? "data/relay-tickets.sqlite", host: env.HOST ?? "127.0.0.1", port, maxConnections };
}
