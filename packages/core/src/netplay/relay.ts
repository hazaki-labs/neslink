export interface RelayNode { id: string; name: string; url: string }
export interface RelayProbe { nodeId: string; rttMs: number | null; jitterMs: number | null }
export interface RelaySelection { mode: "auto" | "manual"; nodeId: string | null }
export interface RelayState {
  nodes: RelayNode[];
  selection: RelaySelection;
  /** null means the built-in room server. Frozen while a game is running. */
  activeNodeId: string | null;
  recommendedNodeId: string | null;
}
export interface ProbePlayer { seat: number | null; relayProbes?: RelayProbe[] }

/** Minimize the slower player-to-player path, with measured jitter as headroom. */
export function recommendRelay(nodes: readonly RelayNode[], players: readonly ProbePlayer[]): string | null {
  const seated = players.filter((p) => p.seat !== null);
  const voters = seated.length ? seated : players;
  if (!voters.length) return null;
  let best: string | null = null;
  let bestScore = Infinity;
  // Include the main server so automatic mode never forces a worse external route.
  for (const id of ["main", ...nodes.map((node) => node.id)]) {
    const probes = voters.map((p) => p.relayProbes?.find((probe) => probe.nodeId === id));
    if (probes.some((p) => !p || p.rttMs === null || p.jitterMs === null)) continue;
    const legs = probes.map((p) => p!.rttMs! / 2 + p!.jitterMs!).sort((a, b) => b - a);
    const score = legs[0] + (legs[1] ?? legs[0]);
    if (score < bestScore) { bestScore = score; best = id === "main" ? null : id; }
  }
  return best;
}
