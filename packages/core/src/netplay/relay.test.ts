import { describe, expect, it } from "vitest";
import { recommendRelay, type ProbePlayer } from "./relay";
import { chooseNetplayDelay } from "./delay";

const nodes = [{ id: "east", name: "East", url: "https://east.example" }, { id: "west", name: "West", url: "https://west.example" }];
const player = (seat: number | null, main: number | null, east: number | null, west: number | null, jitter = 0): ProbePlayer => ({
  seat, relayProbes: [main, east, west].map((rttMs, i) => ({ nodeId: ["main", "east", "west"][i], rttMs, jitterMs: rttMs === null ? null : jitter })),
});
describe("relay recommendation", () => {
  it("uses both players rather than only the host's fastest node", () => {
    expect(recommendRelay(nodes, [player(0, 150, 10, 60), player(1, 150, 200, 60)])).toBe("west");
  });
  it("excludes nodes unreachable by either seated player", () => {
    expect(recommendRelay(nodes, [player(0, 100, 5, 30), player(1, 100, null, 30)])).toBe("west");
  });
  it("shows spectators' measurements without letting them distort players' recommendation", () => {
    expect(recommendRelay(nodes, [player(0, 100, 20, 90), player(1, 100, 20, 90), player(null, 1, null, 1)])).toBe("east");
  });
  it("keeps the main route if it is best or measurements are incomplete", () => {
    expect(recommendRelay(nodes, [player(0, 10, 50, 100)])).toBe(null);
    expect(recommendRelay(nodes, [{ seat: 0 }])).toBe(null);
  });
  it("penalizes jitter and uses everyone when nobody is seated", () => {
    const jittery = player(null, 100, 10, 20);
    jittery.relayProbes![1].jitterMs = 50;
    expect(recommendRelay(nodes, [jittery])).toBe("west");
  });
  it("keeps the fallback input delay even when an unauthenticated relay probes faster", () => {
    const players = [0, 1].map((seat) => ({ ...player(seat, 200, 10, 100), rttMs: 200, directRttMs: null }));
    expect(chooseNetplayDelay(players)).toBe(4);
  });
});
