// Unit tests for durable state/attachments; the controller integration test
// separately exercises the real workerd runtime and WebSocket transport.
import { afterEach, expect, it, vi } from "vitest";
import { verifyTicket } from "@neslink/relay-auth";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {
  constructor(protected ctx: unknown, protected env: unknown) {}
} }));

import { Room } from "../../server/src/room";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const secret = "dGVzdC1vbmx5LW5vdC1hLXByb2R1Y3Rpb24ta2V5LTEyMzQ1Njc4OTA";
const origin = "https://game.example";
const info = { id: "abcdef", romHash: "a".repeat(40), romName: "Test" };
const env = { RELAY_NODES: JSON.stringify([{ id: "east", name: "East", url: "https://east.example" }]),
  RELAY_SIGNING_KEYS: JSON.stringify({ east: { kid: "test", secret } }) };

class Socket {
  attachment: any = null;
  messages: any[] = [];
  serializeAttachment(data: unknown) { this.attachment = structuredClone(data); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  send(data: string) { this.messages.push(JSON.parse(data)); }
  close() {}
}

function harness(config = env) {
  const data = new Map<string, unknown>();
  const sockets: Socket[] = [];
  const storage = {
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      for (const [name, item] of typeof key === "string" ? [[key, value]] : Object.entries(key)) data.set(name as string, structuredClone(item));
    },
    setAlarm: async () => {},
    delete: async (key: string) => data.delete(key),
    deleteAll: async () => data.clear(),
  };
  async function load() {
    let ready: Promise<unknown>;
    const ctx = { storage, getWebSockets: () => sockets, setWebSocketAutoResponse() {},
      blockConcurrencyWhile: (fn: () => Promise<unknown>) => { ready = fn(); } };
    vi.stubGlobal("WebSocketRequestResponsePair", class {});
    const room = new Room(ctx as any, config as any);
    await ready!;
    return room;
  }
  async function join(room: Room, name: string) {
    const socket = new Socket(); sockets.push(socket);
    await send(room, socket, { t: "hello", name, romHash: info.romHash });
    return socket;
  }
  return { data, load, join };
}
const send = (room: Room, socket: Socket, data: unknown) => room.webSocketMessage(socket as any, JSON.stringify(data));

it("restores the frozen node and game identity, reissues tickets, and waits for a snapshot before late joining", async () => {
  const h = harness(); const first = await h.load(); await first.init(info);
  const host = await h.join(first, "Host");
  await send(first, host, { t: "relaySelect", selection: { mode: "manual", nodeId: "east" } });
  await send(first, host, { t: "start" });
  const active = h.data.get("activeGame") as { id: string };
  const restored = await h.load();
  const spectator = await h.join(restored, "Spectator");
  expect(spectator.messages.find((m) => m.t === "welcome").room).toMatchObject({ started: true, relay: { activeNodeId: "east" } });
  expect(spectator.messages.some((m) => m.t === "start")).toBe(false);
  const response = await restored.relayTicket(host.attachment.connectionToken, origin);
  expect(response.status).toBe(200);
  const grant = await verifyTicket((response.body as { ticket: string }).ticket, "east", info.id, origin, new Map([["test", secret]]));
  expect(grant.gameId).toBe(active.id);
  expect(grant.seat).toBe(0);
  // Another recovery must also preserve the spectator's pending admission.
  const again = await h.load();
  await send(again, host, { t: "input", f: 600, m: 16 });
  await send(again, host, { t: "snapshot", f: 600, s: "saved-state" });
  expect(spectator.messages.find((m) => m.t === "start")).toMatchObject({ from: { f: 600, s: "saved-state" }, inputs: [[0, 600, 16]] });
  // Leaving on purpose ("Leave room") ends the game at once; a drop would keep the seat.
  await again.webSocketClose(host as any, 1000, "leave");
  expect(h.data.get("started")).toBe(false);
  expect(h.data.get("activeGame")).toBe(null);
  await expect((await h.load()).relayTicket("forged", origin)).resolves.toMatchObject({ status: 403 });
  vi.unstubAllGlobals();
});

it("keeps rooms joinable and playable with malformed optional relay metadata", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const h = harness({ ...env, RELAY_NODES: "{invalid" });
  const room = await h.load(); await room.init(info);
  const host = await h.join(room, "Host"); const guest = await h.join(room, "Guest");
  expect(host.messages.find((m) => m.t === "welcome").room.relay.nodes).toEqual([]);
  await send(room, guest, { t: "seat", seat: 1 });
  await send(room, host, { t: "start" });
  await send(room, host, { t: "input", f: 0, m: 16 });
  expect(guest.messages.some((m) => m.t === "start")).toBe(true);
  expect(guest.messages).toContainEqual({ t: "input", s: 0, f: 0, m: 16 });
});

it("ends legacy games that lack recoverable metadata instead of leaving a started room stuck", async () => {
  const h = harness(); h.data.set("info", info); h.data.set("started", true);
  const room = await h.load(); const host = await h.join(room, "Host");
  expect(host.messages.find((m) => m.t === "welcome").room.started).toBe(false);
  await send(room, host, { t: "start" });
  expect(host.messages.some((m) => m.t === "start")).toBe(true);
  vi.unstubAllGlobals();
});

it("compares the oldest retained hash frame at capacity, including after pruning an incomplete frame", async () => {
  const h = harness(); const room = await h.load(); await room.init(info);
  const host = await h.join(room, "Host"); const guest = await h.join(room, "Guest");
  await send(room, guest, { t: "seat", seat: 1 }); await send(room, host, { t: "start" });
  for (let f = 0; f < 121; f++) await send(room, host, { t: "hash", f, h: 1 });
  await send(room, guest, { t: "hash", f: 1, h: 2 });
  expect(host.messages.filter((m) => m.t === "desync")).toEqual([{ t: "desync", f: 1 }]);
  // A matching report also completes and frees a cached frame without a false desync.
  await send(room, guest, { t: "hash", f: 2, h: 1 });
  expect(host.messages.filter((m) => m.t === "desync")).toHaveLength(1);
  vi.unstubAllGlobals();
});

it("keeps a dropped player's seat and game, lets them rejoin, and frees the seat when they never come back", async () => {
  const h = harness(); const room = await h.load(); await room.init(info);
  const host = await h.join(room, "Host"); const guest = await h.join(room, "Guest");
  await send(room, guest, { t: "seat", seat: 1 });
  await send(room, host, { t: "start" });
  await send(room, host, { t: "input", f: 2, m: 1 });
  await send(room, guest, { t: "input", f: 2, m: 2 });
  const { you, resumeToken } = guest.messages.find((m) => m.t === "welcome");

  // A refresh or network drop: the seat and the game wait for the guest.
  await room.webSocketClose(guest as any, 1006, "");
  expect(h.data.get("started")).toBe(true);
  const waiting = host.messages.filter((m) => m.t === "room").at(-1).room;
  expect(waiting.players.find((p: any) => p.id === you)).toMatchObject({ seat: 1, connected: false });

  // A wrong token gets a new identity; the right one gets the seat back and the game's history.
  const impostor = new Socket(); (room as any).ctx.getWebSockets().push(impostor);
  await send(room, impostor, { t: "hello", name: "X", romHash: info.romHash, resume: { id: you, token: "nope" } });
  expect(impostor.messages.find((m) => m.t === "welcome").you).not.toBe(you);
  const back = new Socket(); (room as any).ctx.getWebSockets().push(back);
  await send(room, back, { t: "hello", name: "Guest", romHash: info.romHash, resume: { id: you, token: resumeToken } });
  expect(back.messages.find((m) => m.t === "welcome")).toMatchObject({ you });
  expect(back.attachment).toMatchObject({ id: you, seat: 1 });
  expect(back.messages.find((m) => m.t === "start")).toMatchObject({ seats: [0, 1], inputs: [[0, 2, 1], [1, 2, 2]] });

  // Gone for longer than the grace period: 2P falls vacant and 1P fills it in from there.
  await room.webSocketClose(back as any, 1006, "");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  await room.alarm();
  expect(h.data.get("started")).toBe(true);
  const last = host.messages.filter((m) => m.t === "room").at(-1).room;
  expect(last.players.some((p: any) => p.id === you)).toBe(false);
  expect(last.vacantSeats).toEqual([1]);
  expect(host.messages).toContainEqual({ t: "standIn", s: 1, f: 3 });
});

it("plays a solo game with 2P stood in for, and hands 2P to a spectator who sits down", async () => {
  const h = harness(); const room = await h.load(); await room.init(info);
  const host = await h.join(room, "Host"); const watcher = await h.join(room, "Watcher");
  await send(room, host, { t: "start" });
  expect(watcher.messages.find((m) => m.t === "start")).toMatchObject({ seats: [0, 1], vacant: [1] });
  await send(room, host, { t: "input", f: 4, m: 1 });
  await send(room, host, { t: "input", f: 4, m: 0, s: 1 });
  // Nobody else may stand in, or claim a seat that is not vacant.
  await send(room, watcher, { t: "input", f: 5, m: 0, s: 1 });
  expect(watcher.messages).toContainEqual({ t: "input", s: 1, f: 4, m: 0 });

  await send(room, watcher, { t: "seat", seat: 1 });
  expect(host.messages).toContainEqual({ t: "handover", s: 1 });
  // Stand-in inputs already on the way still count, then the stand-in reports where it stopped.
  await send(room, host, { t: "input", f: 5, m: 0, s: 1 });
  const starts = () => watcher.messages.filter((m) => m.t === "start");
  expect(starts()).toHaveLength(1);
  await send(room, host, { t: "handedOver", s: 1, f: 5 });
  expect(starts()).toHaveLength(2);
  expect(starts()[1]).toMatchObject({ seats: [0, 1], vacant: [], inputs: [[0, 4, 1], [1, 4, 0], [1, 5, 0]] });
  expect(watcher.attachment).toMatchObject({ seat: 1 });
  // The seat is theirs now: the host can no longer stand in.
  await send(room, host, { t: "input", f: 6, m: 0, s: 1 });
  expect(watcher.messages.some((m) => m.t === "input" && m.f === 6)).toBe(false);
});

it("keeps standing in when the spectator taking over leaves first", async () => {
  const h = harness(); const room = await h.load(); await room.init(info);
  const host = await h.join(room, "Host"); const watcher = await h.join(room, "Watcher");
  await send(room, host, { t: "start" });
  await send(room, watcher, { t: "seat", seat: 1 });
  await room.webSocketClose(watcher as any, 1006, "");
  await send(room, host, { t: "handedOver", s: 1, f: 9 });
  expect(host.messages).toContainEqual({ t: "standIn", s: 1, f: 10 });
  expect(host.messages.filter((m) => m.t === "room").at(-1).room.vacantSeats).toEqual([1]);
});

it("relays thumbs-ups and renames", async () => {
  const h = harness(); const room = await h.load(); await room.init(info);
  const host = await h.join(room, "Host"); const guest = await h.join(room, "Guest");
  await send(room, guest, { t: "react", kind: "thumbs" });
  await send(room, guest, { t: "react", kind: "thumbs" }); // too soon: dropped
  const hostId = host.messages.find((m) => m.t === "welcome").you;
  const guestId = guest.messages.find((m) => m.t === "welcome").you;
  expect(host.messages.filter((m) => m.t === "react")).toEqual([{ t: "react", from: guestId, kind: "thumbs" }]);
  expect(guest.messages.some((m) => m.t === "react")).toBe(false);
  await send(room, host, { t: "rename", name: "  New name  " });
  expect(guest.messages.filter((m) => m.t === "room").at(-1).room.players.find((p: any) => p.id === hostId).name).toBe("New name");
});

it("relays and logs the host's reset input", async () => {
  const h = harness(); const room = await h.load(); await room.init(info);
  const host = await h.join(room, "Host"); const guest = await h.join(room, "Guest");
  await send(room, guest, { t: "seat", seat: 1 });
  await send(room, host, { t: "start" });
  await send(room, host, { t: "input", f: 5, m: 0x101 });
  await send(room, host, { t: "input", f: 6, m: 0x800 });
  expect(guest.messages).toContainEqual({ t: "input", s: 0, f: 5, m: 0x101 });
  expect(guest.messages.some((m) => m.t === "input" && m.f === 6)).toBe(false);
});

it("hands a player's loaded state to the others and to newcomers", async () => {
  const h = harness(); const room = await h.load(); await room.init(info);
  const host = await h.join(room, "Host"); const guest = await h.join(room, "Guest");
  await send(room, guest, { t: "seat", seat: 1 });
  await send(room, host, { t: "start" });
  await send(room, host, { t: "snapshot", f: 600, s: "periodic" });
  await send(room, guest, { t: "load", f: 600, s: "guest-save" });
  await send(room, guest, { t: "input", f: 600, m: 0x200 });
  expect(host.messages).toContainEqual({ t: "load", s: 1, f: 600, data: "guest-save" });
  // A later periodic snapshot for the same frame must not replace the loaded state.
  await send(room, host, { t: "snapshot", f: 600, s: "periodic-again" });
  const late = await h.join(room, "Late");
  expect(late.messages.find((m) => m.t === "start")).toMatchObject({
    from: { f: 600, s: "guest-save", loaded: true }, inputs: [[1, 600, 0x200]],
  });
});

it("passes the host's cheats on, and gives newcomers the ones in force at the snapshot and after", async () => {
  const h = harness(); const room = await h.load(); await room.init(info);
  const host = await h.join(room, "Host"); const guest = await h.join(room, "Guest");
  await send(room, guest, { t: "seat", seat: 1 });
  await send(room, host, { t: "start" });
  // Only the host may change cheats.
  await send(room, guest, { t: "cheats", f: 10, codes: ["SXIOPO"] });
  expect(host.messages.some((m) => m.t === "cheats")).toBe(false);
  await send(room, host, { t: "cheats", f: 100, codes: ["SXIOPO"] });
  await send(room, host, { t: "cheats", f: 500, codes: [] });
  await send(room, host, { t: "cheats", f: 700, codes: ["0032:09"] });
  expect(guest.messages).toContainEqual({ t: "cheats", f: 100, codes: ["SXIOPO"] });
  // A snapshot at 600: the change at 500 is in force there; 100 is no longer needed.
  await send(room, host, { t: "snapshot", f: 600, s: "state" });
  const late = await h.join(room, "Late");
  expect(late.messages.find((m) => m.t === "start").cheats).toEqual([
    { f: 500, codes: [] },
    { f: 700, codes: ["0032:09"] },
  ]);
  // Too many codes is malformed and ignored.
  await send(room, host, { t: "cheats", f: 800, codes: Array.from({ length: 65 }, () => "SXIOPO") });
  expect(guest.messages.some((m) => m.t === "cheats" && m.f === 800)).toBe(false);
});

it("streams the room's ROM from a player who has it, without keeping it", async () => {
  const h = harness(); const room = await h.load(); await room.init(info);
  const host = await h.join(room, "Host");
  const other = await h.join(room, "Other");
  const res = await room.fetch(new Request(`https://neslink.test/api/rooms/${info.id}/rom`));
  expect(res.status).toBe(200);
  const request = host.messages.find((m) => m.t === "romRequest");
  expect(request).toBeTruthy();
  const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
  // Someone else cannot slip chunks in.
  await send(room, other, { t: "romChunk", id: request.id, i: 0, n: 2, d: b64([9, 9]) });
  await send(room, host, { t: "romChunk", id: request.id, i: 0, n: 2, d: b64([1, 2, 3]) });
  await send(room, host, { t: "romChunk", id: request.id, i: 1, n: 2, d: b64([4, 5]) });
  expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
});

it("says no ROM is available when nobody in the room has it, and fails a transfer whose sender leaves", async () => {
  const h = harness(); const room = await h.load(); await room.init(info);
  const url = `https://neslink.test/api/rooms/${info.id}/rom`;
  expect((await room.fetch(new Request(url))).status).toBe(404);
  const host = await h.join(room, "Host");
  const res = await room.fetch(new Request(url));
  await room.webSocketClose(host as any, 1000, "leave");
  await expect(res.arrayBuffer()).rejects.toThrow();
});
