// Exercises the real Wrangler/workerd room service plus a real standalone relay.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { createRelay } from "../src/server";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

class Client {
  readonly ws: WebSocket;
  readonly messages: Record<string, any>[] = [];
  constructor(url: string, origin: string) {
    this.ws = new WebSocket(url, { origin });
    this.ws.on("message", (raw) => this.messages.push(JSON.parse(raw.toString())));
    this.ws.on("error", () => {});
  }
  async wait(predicate: (message: Record<string, any>) => boolean, after = 0) {
    for (let i = 0; i < 200; i++) {
      const match = this.messages.slice(after).find(predicate);
      if (match) return match;
      await delay(25);
    }
    throw new Error("Timed out waiting for protocol message");
  }
  send(message: unknown) { this.ws.send(JSON.stringify(message)); }
}

const controlPort = await freePort();
const origin = `http://127.0.0.1:${controlPort}`;
const secret = "dGVzdC1vbmx5LW5vdC1hLXByb2R1Y3Rpb24ta2V5LTEyMzQ1Njc4OTA";
const node = createRelay({ nodeId: "test", keys: new Map([["test", secret]]), allowedOrigins: new Set([origin]),
  replayPath: ":memory:", host: "127.0.0.1", port: 0, maxConnections: 32 });
await new Promise<void>((resolve) => node.server.listen(0, "127.0.0.1", resolve));
const relayOrigin = `http://127.0.0.1:${(node.server.address() as { port: number }).port}`;
const serverDir = fileURLToPath(new URL("../../server/", import.meta.url));
const configPath = fileURLToPath(new URL(`../../server/.test-data-${crypto.randomUUID()}.json`, import.meta.url));
const envPath = `${configPath}.env`;
// --env-file disables .dev.vars discovery; never consume a developer's live keys.
writeFileSync(envPath, "");
writeFileSync(configPath, JSON.stringify({
  name: "neslink-relay-test", main: "src/index.ts", compatibility_date: "2026-10-01",
  assets: { directory: "../web/dist", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api/*"] },
  durable_objects: { bindings: [{ name: "ROOMS", class_name: "Room" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
  vars: { RELAY_NODES: JSON.stringify([{ id: "test", name: "Test relay", url: relayOrigin }]),
    RELAY_SIGNING_KEYS: JSON.stringify({ test: { kid: "test", secret } }) },
}));
const wrangler = fileURLToPath(new URL("../../server/node_modules/wrangler/bin/wrangler.js", import.meta.url));
const controller = spawn(process.execPath, [wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", String(controlPort),
  "--config", configPath, "--env-file", envPath, "--persist-to", `.wrangler/integration-${crypto.randomUUID()}`], {
  cwd: serverDir, windowsHide: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
controller.stdout.on("data", (chunk) => { logs += chunk; });
controller.stderr.on("data", (chunk) => { logs += chunk; });
const clients: Client[] = [];
let nodeClosed = false;
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (controller.exitCode !== null) throw new Error("Controller exited before becoming ready");
    try {
      const response = await fetch(`${origin}/api/rooms/aaaaaa`);
      if (response.status === 404 && (await response.json() as { error?: string }).error === "roomNotFound") { ready = true; break; }
    } catch {}
    await delay(200);
  }
  assert(ready, "Controller startup timed out");
  const create = await fetch(`${origin}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ romHash: "a".repeat(40), romName: "Integration test" }) });
  assert.equal(create.status, 201);
  const info = await create.json() as { id: string };
  async function join(name: string) {
    const client = new Client(`${origin.replace("http:", "ws:")}/api/rooms/${info.id}/ws`, origin);
    clients.push(client);
    await new Promise<void>((resolve, reject) => { client.ws.once("open", resolve); client.ws.once("error", reject); });
    client.send({ t: "hello", name, romHash: "a".repeat(40) });
    const welcome = await client.wait((m) => m.t === "welcome");
    return { client, welcome };
  }
  const host = await join("Host"); const guest = await join("Guest");
  assert.equal(guest.welcome.room.hostId, host.welcome.you);
  assert(!JSON.stringify(guest.welcome).includes(host.welcome.connectionToken), "Host capability leaked");
  guest.client.send({ t: "seat", seat: 1 });
  await host.client.wait((m) => m.t === "room" && m.room.players.some((p: any) => p.seat === 1));
  guest.client.send({ t: "relaySelect", selection: { mode: "manual", nodeId: "test" } });
  await guest.client.wait((m) => m.t === "error" && m.code === "notHost");
  host.client.send({ t: "relaySelect", selection: { mode: "manual", nodeId: "unknown" } });
  await host.client.wait((m) => m.t === "error" && m.code === "malformed");
  host.client.send({ t: "relaySelect", selection: { mode: "manual", nodeId: "test" } });
  await guest.client.wait((m) => m.t === "room" && m.room.relay.activeNodeId === "test");
  const probes = [{ nodeId: "main", rttMs: 200, jitterMs: 1 }, { nodeId: "test", rttMs: 10, jitterMs: 2 }];
  host.client.send({ t: "rtt", ms: 200 }); guest.client.send({ t: "rtt", ms: 200 });
  host.client.send({ t: "relayProbes", probes }); guest.client.send({ t: "relayProbes", probes });
  const probeView = await guest.client.wait((m) => m.t === "room" && m.room.players.every((p: any) =>
    p.rttMs === 200 && p.relayProbes?.some((probe: any) => probe.nodeId === "test")));
  assert(!JSON.stringify(probeView).includes(secret), "Signing key leaked into room state");
  assert(!JSON.stringify(probeView).includes(host.welcome.connectionToken), "Connection token leaked into room state");
  host.client.send({ t: "start" });
  const start = await guest.client.wait((m) => m.t === "start");
  assert.equal(start.delay, 4, "Unauthenticated relay probes must not shrink fallback input delay");
  host.client.send({ t: "relaySelect", selection: { mode: "manual", nodeId: null } });
  await host.client.wait((m) => m.t === "error" && m.code === "nodeLocked");
  const requestTicket = (token: string, requestOrigin = origin) => fetch(`${origin}/api/rooms/${info.id}/relay-ticket`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: requestOrigin }, body: JSON.stringify({ connectionToken: token }),
  });
  assert.equal((await requestTicket("forged")).status, 403);
  assert.equal((await requestTicket(host.welcome.connectionToken, "https://evil.example")).status, 403);
  for (const id of ["a", "abcdefg"]) {
    assert.equal((await fetch(`${origin}/api/rooms/${id}/relay-ticket`, {
      method: "POST", headers: { Origin: origin }, body: "{}",
    })).status, 404);
  }
  // Streaming fetch sends no Content-Length; a valid prefix must not bypass the byte cap.
  const body = new TextEncoder().encode(JSON.stringify({ connectionToken: host.welcome.connectionToken }) + " ".repeat(2000));
  const chunked = await fetch(`${origin}/api/rooms/${info.id}/relay-ticket`, {
    method: "POST", headers: { Origin: origin }, duplex: "half",
    body: new ReadableStream({ start(controller) {
      controller.enqueue(body.subarray(0, 100)); controller.enqueue(body.subarray(100)); controller.close();
    } }),
  } as RequestInit);
  assert.equal(chunked.status, 400);
  assert.equal((await fetch(`${origin}/api/relay-nodes`)).status, 404);
  assert.equal((await fetch(`${origin}/api/ping`)).status, 404);
  const hostResponse = await requestTicket(host.welcome.connectionToken);
  assert.equal(hostResponse.status, 200);
  assert.equal(hostResponse.headers.get("Cache-Control"), "no-store");
  const hostTicket = await hostResponse.json() as { ticket: string };
  assert.equal((await requestTicket(host.welcome.connectionToken)).status, 429);
  const guestResponse = await requestTicket(guest.welcome.connectionToken);
  assert.equal(guestResponse.status, 200);
  const guestTicket = await guestResponse.json() as { ticket: string };
  async function joinRelay(ticket: string) {
    const client = new Client(`${relayOrigin.replace("http:", "ws:")}/rooms/${info.id}/ws`, origin);
    clients.push(client);
    await new Promise<void>((resolve, reject) => { client.ws.once("open", resolve); client.ws.once("error", reject); });
    client.send({ t: "auth", ticket });
    await client.wait((m) => m.t === "authenticated");
    return client;
  }
  const a = await joinRelay(hostTicket.ticket); const b = await joinRelay(guestTicket.ticket);
  a.send({ t: "in", s: 0, f: 0, m: [16], a: 0, k: -1 });
  await b.wait((m) => m.t === "in" && m.s === 0 && m.m[0] === 16);
  const late = await join("Spectator");
  assert.equal(late.welcome.room.relay.activeNodeId, "test");
  await late.client.wait((m) => m.t === "start");
  await node.close(); nodeClosed = true;
  host.client.send({ t: "input", f: 1, m: 32, a: 0 });
  await guest.client.wait((m) => m.t === "input" && m.f === 1 && m.m === 32);
  console.log("PASS: real workerd + standalone relay; host-only selection, shared probes, private capabilities, bounded chunked bodies, room-code validation, origin checks, rate limiting, signed admission, input forwarding, late spectating and fallback");
} catch (error) {
  console.error(logs.replaceAll(secret, "[redacted]"));
  throw error;
} finally {
  for (const client of clients) client.ws.terminate();
  if (!nodeClosed) await node.close();
  if (controller.pid && controller.exitCode === null) {
    if (process.platform === "win32") {
      try { execFileSync("taskkill", ["/pid", String(controller.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); } catch {}
    } else controller.kill("SIGTERM");
  }
  unlinkSync(configPath);
  unlinkSync(envPath);
}
