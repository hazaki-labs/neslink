import { expect, it, vi } from "vitest";
import { relayNodes } from "../../server/src/relays";

it("keeps HTTPS as the default and allows plain HTTP node origins only with an explicit controller opt-in", () => {
  const metadata = [{ id: "test", name: "Test", url: "http://192.0.2.1:18888" }];
  const env = { RELAY_NODES: JSON.stringify(metadata) } as Parameters<typeof relayNodes>[0];
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(relayNodes(env)).toEqual([]);
  expect(relayNodes({ ...env, RELAY_ALLOW_INSECURE: "1" })).toEqual(metadata);
  expect(relayNodes({ ...env, RELAY_ALLOW_INSECURE: "1", RELAY_NODES: JSON.stringify([{ ...metadata[0], url: "http://user:secret@192.0.2.1:18888" }]) })).toEqual([]);
  errors.mockRestore();
});

it("disables only optional nodes on malformed configuration, caches failures, and picks up corrections", () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const env = (RELAY_NODES: string) => ({ RELAY_NODES }) as Parameters<typeof relayNodes>[0];
  for (const raw of ["{", "null", "{}", JSON.stringify(Array(17).fill({})), JSON.stringify([{ id: "east", name: "East", url: "broken" }])]) {
    const before = errors.mock.calls.length;
    const config = env(raw);
    expect(relayNodes(config)).toEqual([]);
    expect(relayNodes(config)).toEqual([]);
    expect(errors.mock.calls.length).toBe(before + 1);
  }
  const config = env(JSON.stringify([{ id: "east", name: "East", url: "https://east.example" }]));
  const nodes = relayNodes(config);
  expect(nodes).toHaveLength(1);
  expect(relayNodes(config)).toBe(nodes);
  errors.mockRestore();
});
