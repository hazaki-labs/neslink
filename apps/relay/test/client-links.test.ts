import { afterEach, expect, it, vi } from "vitest";
import { NetplayLink, type NetplayEvents } from "../../web/src/lib/emulator/netplay-link";
import { RelayLink } from "../../web/src/lib/emulator/relay-link";
import { summarizeProbe } from "../../web/src/lib/relay-probes";

class Socket {
  static OPEN = 1;
  static last: Socket;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen = () => {};
  onmessage = (_event: { data: string }) => {};
  onclose = () => {};
  constructor() { Socket.last = this; }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose(); }
  message(data: unknown) { this.onmessage({ data: JSON.stringify(data) }); }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("compares main and external routes using the same three-sample window", () => {
  expect(summarizeProbe("main", [900, 800, 20, 24, 22])).toEqual({ nodeId: "main", rttMs: 22, jitterMs: 4 });
  expect(summarizeProbe("east", [20, 24, 22])).toEqual({ nodeId: "east", rttMs: 22, jitterMs: 4 });
  expect(summarizeProbe("main", [20, 24])).toEqual({ nodeId: "main", rttMs: null, jitterMs: null });
});

it("retains one probe interval after repeated welcome messages and clears it on close", () => {
  vi.useFakeTimers(); vi.stubGlobal("WebSocket", Socket);
  const events = new Proxy({}, { get: () => vi.fn() }) as NetplayEvents;
  const link = new NetplayLink("ws://localhost/api/rooms/abcdef/ws", { name: "Test", romHash: "a".repeat(40) }, events);
  const welcome = { t: "welcome", you: "player", connectionToken: "private", room: {
    info: { id: "abcdef", romHash: "a".repeat(40), romName: "Test" }, hostId: "player", started: false, players: [],
    relay: { nodes: [], selection: { mode: "auto", nodeId: null }, activeNodeId: null, recommendedNodeId: null },
  } };
  Socket.last.message(welcome);
  Socket.last.message(welcome);
  Socket.last.message(welcome);
  expect(vi.getTimerCount()).toBe(1);
  link.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds input sends independently of 240 Hz and 1000 Hz rendering without dropping 60 Hz input", async () => {
  vi.useFakeTimers(); vi.stubGlobal("WebSocket", Socket);
  const node = { id: "east", name: "East", url: "https://east.example" };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ticket: "one-use", node }) })));
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const previous = Socket.last;
  const link = new RelayLink("https://game.example", "abcdef", "private", node, vi.fn(), vi.fn());
  await vi.waitFor(() => expect(Socket.last).not.toBe(previous));
  const socket = Socket.last;
  socket.onopen();
  const packet = { t: "in" as const, s: 0, f: 0, m: [0], a: 0, k: -1 };
  link.send(packet);
  expect(socket.sent).toHaveLength(1); // Auth only, until acknowledged.
  socket.message({ t: "authenticated" });
  for (const hz of [240, 1000, 60]) {
    const before = socket.sent.length;
    for (let tick = 0; tick < hz; tick++) { now += 1000 / hz; link.send({ ...packet, f: tick }); }
    const count = socket.sent.length - before;
    expect(count).toBeLessThanOrEqual(121);
    expect(count).toBeGreaterThanOrEqual(hz === 60 ? 59 : 80);
  }
  link.close();
});
