import type { RelaySelection, RoomState } from "@neslink/core";
import { useI18n } from "@/i18n";

export function RelaySelector({ room, isHost, onSelect }: {
  room: RoomState; isHost: boolean; onSelect: (selection: RelaySelection) => void;
}) {
  const { t } = useI18n();
  const relay = room.relay;
  if (!relay?.nodes.length) return null;
  const options = [{ id: "main", name: t.nodes.main }, ...relay.nodes];
  const selected = relay.selection.mode === "auto" ? "auto" : relay.selection.nodeId ?? "main";
  return (
    <section className="flex flex-col gap-2 rounded-md bg-white/5 p-3 text-xs" aria-label={t.nodes.title}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="relay-node" className="font-medium">{t.nodes.title}</label>
        <select id="relay-node" className="max-w-48 rounded border border-white/20 bg-neutral-900 px-2 py-1 disabled:opacity-70"
          disabled={!isHost || room.started} value={selected}
          onChange={(event) => onSelect(event.target.value === "auto" ? { mode: "auto", nodeId: null } :
            { mode: "manual", nodeId: event.target.value === "main" ? null : event.target.value })}>
          <option value="auto">{t.nodes.auto}</option>
          {options.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
        </select>
      </div>
      <p className="text-white/60">{isHost ? t.nodes.hostHint : t.nodes.readonlyHint}</p>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-left" title={t.nodes.probeHint}>
          <thead><tr><th className="py-1 pr-3 font-normal text-white/60">{t.nodes.node}</th>
            {room.players.map((player) => <th key={player.id} className="max-w-28 truncate px-2 py-1 font-normal text-white/60">{player.name}</th>)}
          </tr></thead>
          <tbody>{options.map((node) => <tr key={node.id} className={node.id === (relay.activeNodeId ?? "main") ? "bg-white/10" : ""}>
            <th className="py-1.5 pr-3 font-normal">{node.name}
              {node.id === (relay.recommendedNodeId ?? "main") && <span className="ml-1 text-emerald-300">{t.nodes.recommended}</span>}
            </th>
            {room.players.map((player) => {
              const probe = player.relayProbes?.find((probe) => probe.nodeId === node.id);
              return <td key={player.id} className="px-2 py-1.5 font-mono tabular-nums">
                {!probe ? t.nodes.measuring : probe.rttMs === null ? t.nodes.unreachable : `${probe.rttMs} ± ${probe.jitterMs ?? 0} ms`}
              </td>;
            })}
          </tr>)}</tbody>
        </table>
      </div>
      <p className="text-white/50">{t.nodes.probeHint}</p>
    </section>
  );
}
