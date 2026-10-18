import type { PeerPacket, RelayNode } from "@neslink/core/netplay";

export interface RelayStatus { nodeId: string; state: "connecting" | "open" | "failed"; rttMs: number | null }

/** Optional input accelerator. The control-room connection remains the fallback. */
export class RelayLink {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private attempts = 0;

  constructor(private readonly controlOrigin: string, private readonly roomId: string,
    private readonly connectionToken: string, private readonly node: RelayNode,
    private readonly receive: (packet: PeerPacket) => void, private readonly status: (status: RelayStatus) => void) {
    void this.connect();
  }

  send(packet: PeerPacket): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.ping && this.ws.bufferedAmount < 64 * 1024) {
      this.ws.send(JSON.stringify(packet));
    }
  }

  close(): void {
    this.stopped = true;
    this.abort?.abort();
    if (this.retry) clearTimeout(this.retry);
    this.clearTimers();
    this.ws?.close(1000, "leave");
    this.ws = null;
  }

  private clearTimers() {
    if (this.ping) clearInterval(this.ping);
    if (this.authTimer) clearTimeout(this.authTimer);
    this.ping = null; this.authTimer = null;
  }

  private async connect() {
    if (this.stopped) return;
    this.status({ nodeId: this.node.id, state: "connecting", rttMs: null });
    const abort = new AbortController(); this.abort = abort;
    try {
      // Every attempt obtains a fresh single-use ticket. Nothing is persisted in browser storage.
      const response = await fetch(`${this.controlOrigin}/api/rooms/${this.roomId}/relay-ticket`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionToken: this.connectionToken }), cache: "no-store",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) throw new Error("Ticket unavailable");
      const grant = await response.json() as { ticket: string; node: RelayNode };
      if (this.stopped) return;
      if (grant.node.id !== this.node.id || grant.node.url !== this.node.url) throw new Error("Node changed");
      const url = new URL(`/rooms/${this.roomId}/ws`, this.node.url);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url); this.ws = ws;
      this.authTimer = setTimeout(() => ws.close(1008, "Authentication timeout"), 5000);
      ws.onopen = () => { ws.send(JSON.stringify({ t: "auth", ticket: grant.ticket })); grant.ticket = ""; };
      ws.onmessage = (event) => {
        if (this.stopped || ws !== this.ws) return;
        let message: PeerPacket | { t: "authenticated" };
        try { message = JSON.parse(event.data as string); } catch { ws.close(1008, "Malformed relay message"); return; }
        if (message.t === "authenticated" && !this.ping) {
          if (this.authTimer) clearTimeout(this.authTimer);
          this.authTimer = null; this.attempts = 0;
          this.status({ nodeId: this.node.id, state: "open", rttMs: null });
          const probe = () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "ping", ts: performance.now() })); };
          this.ping = setInterval(probe, 1000); probe();
        } else if (this.ping && message.t === "pong") {
          const rttMs = performance.now() - message.ts;
          if (Number.isFinite(rttMs) && rttMs >= 0) this.status({ nodeId: this.node.id, state: "open", rttMs });
        } else if (this.ping && message.t === "in") this.receive(message);
      };
      ws.onclose = () => { this.clearTimers(); if (this.ws === ws) this.ws = null; this.reconnect(); };
      ws.onerror = () => ws.close();
    } catch { this.reconnect(); }
  }

  private reconnect() {
    if (this.stopped || this.retry) return;
    this.status({ nodeId: this.node.id, state: "failed", rttMs: null });
    this.retry = setTimeout(() => { this.retry = null; void this.connect(); }, Math.min(30_000, 3000 * 2 ** Math.min(this.attempts++, 4)));
  }
}
