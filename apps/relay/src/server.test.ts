import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { issueTicket } from "@neslink/relay-auth";
import { createRelay } from "./server";
import { ReplayCache } from "./replay-cache";
import { readConfig, type RelayConfig } from "./config";

const origin = "https://nes.example";
const secret = "dGVzdC1vbmx5LW5vdC1hLXByb2R1Y3Rpb24ta2V5LTEyMzQ1Njc4OTA";
const key = { kid: "test-key", secret };
const room = { id: "abcdef", romHash: "a".repeat(40), romName: "Test" };
const gameId = "11111111-1111-4111-8111-111111111111";
const config: RelayConfig = { nodeId: "east", keys: new Map([[key.kid, secret]]), allowedOrigins: new Set([origin]),
  replayPath: ":memory:", host: "127.0.0.1", port: 0, maxConnections: 32 };
const ticket = async (seat: number | null, playerId: string, audience = "east") =>
  (await issueTicket(audience, room, origin, key, { seat, playerId, gameId })).ticket;

describe("standalone relay", () => {
  let relay: ReturnType<typeof createRelay>;
  let base: string;
  beforeEach(async () => {
    relay = createRelay(config);
    await new Promise<void>((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
    const address = relay.server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { await relay.close(); });

  function connect(token: string, roomId = room.id) {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`${base.replace("http:", "ws:")}/rooms/${roomId}/ws`, { origin });
      ws.on("error", reject);
      ws.on("open", () => ws.send(JSON.stringify({ t: "auth", ticket: token })));
      ws.once("message", (raw) => { if (JSON.parse(raw.toString()).t === "authenticated") resolve(ws); else reject(new Error("Unexpected message")); });
      ws.once("close", (code) => reject(new Error(`Closed ${code}`)));
    });
  }
  const receive = (ws: WebSocket) => new Promise<Record<string, unknown>>((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
  const closed = (ws: WebSocket) => new Promise<number>((resolve) => ws.once("close", resolve));

  it("allows public cross-origin probes without credentials", async () => {
    const response = await fetch(`${base}/health?probe=test`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("ok");
  });
  it("relays signed players' inputs and rejects impersonating another seat", async () => {
    const a = await connect(await ticket(0, "11111111"));
    const b = await connect(await ticket(1, "22222222"));
    const received = receive(b);
    a.send(JSON.stringify({ t: "in", s: 0, f: 0, m: [16], a: 0, k: -1 }));
    expect(await received).toMatchObject({ s: 0, m: [16] });
    const rejected = closed(a);
    a.send(JSON.stringify({ t: "in", s: 1, f: 1, m: [0], a: 0, k: -1 }));
    expect(await rejected).toBe(1008);
  });
  it("rejects simultaneous reuse of a ticket, and can reconnect only with a fresh one", async () => {
    const token = await ticket(0, "11111111");
    const results = await Promise.allSettled([connect(token), connect(token)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(connect(token)).rejects.toThrow("1008");
    await expect(connect(await ticket(0, "11111111"))).resolves.toBeInstanceOf(WebSocket);
  });
  it("accepts a 240 Hz client's inputs plus ping traffic and still rejects excessive traffic", async () => {
    const a = await connect(await ticket(0, "11111111"));
    const b = await connect(await ticket(1, "22222222"));
    const end = new Promise<void>((resolve) => b.on("message", (raw) => {
      if (JSON.parse(raw.toString()).f === 299) resolve();
    }));
    for (let f = 0; f < 300; f++) a.send(JSON.stringify({ t: "in", s: 0, f, m: [0], a: 0, k: -1 }));
    await end;
    const pong = receive(a);
    a.send(JSON.stringify({ t: "ping", ts: 123 }));
    expect(await pong).toEqual({ t: "pong", ts: 123 });
    const rejected = closed(a);
    for (let f = 300; f < 1000; f++) a.send(JSON.stringify({ t: "in", s: 0, f, m: [0], a: 0, k: -1 }));
    expect(await rejected).toBe(1008);
  });
  it("rejects tickets for a different node or room and spectator input", async () => {
    await expect(connect(await ticket(0, "11111111", "west"))).rejects.toThrow("1008");
    await expect(connect(await ticket(0, "11111111"), "ghjkmn")).rejects.toThrow("1008");
    const watcher = await connect(await ticket(null, "33333333"));
    const rejected = closed(watcher);
    watcher.send(JSON.stringify({ t: "in", s: 0, f: 0, m: [0], a: 0, k: -1 }));
    expect(await rejected).toBe(1008);
  });
  it("rejects unapproved origins before upgrading", async () => {
    await expect(new Promise((_, reject) => {
      const ws = new WebSocket(`${base.replace("http:", "ws:")}/rooms/abcdef/ws`, { origin: "https://evil.example" });
      ws.on("error", reject);
    })).rejects.toThrow("403");
  });
});

it("keeps replay protection across restarts and expires the cache only after the ticket expires", () => {
  const dir = mkdtempSync(resolve(".test-data-"));
  const path = join(dir, "cache.sqlite");
  try {
    const first = new ReplayCache(path);
    expect(first.consume("once", 130, 100)).toBe(true);
    first.close();
    const restarted = new ReplayCache(path);
    expect(restarted.consume("once", 130, 110)).toBe(false);
    restarted.prune(130);
    expect(restarted.consume("once", 130, 130)).toBe(false);
    restarted.close();
  } finally {
    for (const file of readdirSync(dir)) unlinkSync(join(dir, file));
    rmdirSync(dir);
  }
});

it("requires strong keys and supports an optional exact-origin restriction", () => {
  expect(() => readConfig({ RELAY_NODE_ID: "east", RELAY_KEYS: JSON.stringify({ key: "weak" }), RELAY_ALLOWED_ORIGINS: origin })).toThrow();
  expect(() => readConfig({ RELAY_NODE_ID: "east", RELAY_KEYS: JSON.stringify({ key: secret }), RELAY_ALLOWED_ORIGINS: "*,https://nes.example" })).toThrow();
  expect(readConfig({ RELAY_NODE_ID: "east", RELAY_KEYS: JSON.stringify({ key: secret }) }).allowedOrigins.has("*")).toBe(true);
  expect(readConfig({ RELAY_NODE_ID: "east", RELAY_KEYS: JSON.stringify({ key: secret }), RELAY_ALLOWED_ORIGINS: origin }).nodeId).toBe("east");
});

it("requires an explicit opt-in for HTTP origins and allows fail-closed probe-only startup", async () => {
  const base = { RELAY_NODE_ID: "east", RELAY_KEYS: JSON.stringify({ key: secret }) };
  expect(() => readConfig({ ...base, RELAY_ALLOWED_ORIGINS: "http://game.example" })).toThrow();
  expect(readConfig({ ...base, RELAY_ALLOW_INSECURE: "1", RELAY_ALLOWED_ORIGINS: "http://game.example" }).allowedOrigins.has("http://game.example")).toBe(true);
  expect(readConfig(base).allowedOrigins.has("*")).toBe(true);
  const node = createRelay({ ...readConfig({ ...base, RELAY_PROBE_ONLY: "1" }), replayPath: ":memory:", port: 0 });
  try {
    await new Promise<void>((resolve) => node.server.listen(0, "127.0.0.1", resolve));
    const port = (node.server.address() as { port: number }).port;
    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).text()).toBe("ok");
    await expect(new Promise((_, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/rooms/abcdef/ws`, { origin });
      ws.on("error", reject);
    })).rejects.toThrow("403");
  } finally { await node.close(); }
});

it("allows an unconfigured website with a valid ticket but rejects a mismatched ticket origin", async () => {
  const node = createRelay({ ...config, allowedOrigins: new Set(["*"]) });
  try {
    await new Promise<void>((resolve) => node.server.listen(0, "127.0.0.1", resolve));
    const port = (node.server.address() as { port: number }).port;
    const website = "https://previously-unknown.example";
    const grant = await issueTicket("east", room, website, key, { seat: 0, playerId: "11111111", gameId });
    const open = (requestOrigin: string) => new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/rooms/abcdef/ws`, { origin: requestOrigin });
      ws.on("error", reject);
      ws.on("open", () => ws.send(JSON.stringify({ t: "auth", ticket: grant.ticket })));
      ws.on("message", (raw) => resolve(JSON.parse(raw.toString()).t));
      ws.on("close", (code) => reject(new Error(`Closed ${code}`)));
    });
    await expect(open("https://wrong.example")).rejects.toThrow("1008");
    await expect(open(website)).resolves.toBe("authenticated");
  } finally { await node.close(); }
});
