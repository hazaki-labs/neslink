import type { RelayNode, RelayProbe } from "@neslink/core/netplay";

/** Public health requests; no ticket, cookies, or signing material is needed. */
export async function probeRelays(nodes: readonly RelayNode[]): Promise<RelayProbe[]> {
  return Promise.all(nodes.map(async (node) => {
    const samples: number[] = [];
    const endpoint = `${node.url}/health`;
    for (let i = 0; i < 4; i++) {
      const start = performance.now();
      try {
        const response = await fetch(`${endpoint}?probe=${crypto.randomUUID()}`, {
          mode: "cors", credentials: "omit", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(1500),
        });
        if (!response.ok || await response.text() !== "ok") throw new Error("Probe failed");
        // Warm the connection first, so DNS/TLS startup doesn't skew the comparison.
        if (i > 0) samples.push(performance.now() - start);
      } catch { /* Failed probes remain unavailable instead of looking fast. */ }
    }
    if (samples.length < 3) return { nodeId: node.id, rttMs: null, jitterMs: null };
    samples.sort((a, b) => a - b);
    return { nodeId: node.id, rttMs: Math.round(samples[1]), jitterMs: Math.round(samples[2] - samples[0]) };
  }));
}
