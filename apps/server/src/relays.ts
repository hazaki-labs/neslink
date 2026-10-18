import { secretBytes, type SigningKey } from "@neslink/relay-auth";
import type { RelayNode } from "@neslink/core/netplay";
import type { Env } from "./index";

/** Public node metadata is separated from signing secrets, including in configuration. */
export function relayNodes(env: Env): RelayNode[] {
  const nodes: unknown = JSON.parse(env.RELAY_NODES ?? "[]");
  if (!Array.isArray(nodes) || nodes.length > 16) throw new Error("Invalid RELAY_NODES");
  const ids = new Set<string>();
  return nodes.map((node: RelayNode) => {
    if (!node || typeof node.id !== "string" || !/^[a-z0-9-]{1,32}$/.test(node.id) || node.id === "main" || ids.has(node.id) ||
        typeof node.name !== "string" || !node.name.trim() || node.name.length > 60 || typeof node.url !== "string") throw new Error("Invalid relay node");
    const url = new URL(node.url);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Relay URLs must be HTTPS origins (HTTP only on loopback)");
    ids.add(node.id);
    return { id: node.id, name: node.name, url: url.origin };
  });
}

export function relayKey(env: Env, nodeId: string): SigningKey {
  const keys = JSON.parse(env.RELAY_SIGNING_KEYS ?? "{}") as Record<string, SigningKey>;
  const key = Object.hasOwn(keys, nodeId) ? keys[nodeId] : undefined;
  if (!key || typeof key.kid !== "string" || !/^[a-zA-Z0-9-]{1,40}$/.test(key.kid) || typeof key.secret !== "string") throw new Error("Relay signing key missing");
  secretBytes(key.secret);
  return key;
}
