import { expect, it } from "vitest";
import { relayNodes } from "../../server/src/relays";

it("keeps HTTPS as the default and allows plain HTTP node origins only with an explicit controller opt-in", () => {
  const metadata = [{ id: "test", name: "Test", url: "http://192.0.2.1:18888" }];
  const env = { RELAY_NODES: JSON.stringify(metadata) } as Parameters<typeof relayNodes>[0];
  expect(() => relayNodes(env)).toThrow();
  expect(relayNodes({ ...env, RELAY_ALLOW_INSECURE: "1" })).toEqual(metadata);
  expect(() => relayNodes({ ...env, RELAY_ALLOW_INSECURE: "1", RELAY_NODES: JSON.stringify([{ ...metadata[0], url: "http://user:secret@192.0.2.1:18888" }]) })).toThrow();
});
