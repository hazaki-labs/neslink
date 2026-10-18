import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Durable, atomic consumption. Keep the volume across restarts; one process per node ID. */
export class ReplayCache {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS used_tickets (jti TEXT PRIMARY KEY, expires INTEGER NOT NULL)");
    this.db.exec("CREATE INDEX IF NOT EXISTS ticket_expiry ON used_tickets(expires)");
  }
  consume(jti: string, expires: number, now = Math.floor(Date.now() / 1000)): boolean {
    if (expires <= now) return false;
    // This synchronous unique insert is the serialization point, including concurrent auth handshakes.
    return this.db.prepare("INSERT OR IGNORE INTO used_tickets(jti, expires) VALUES (?, ?)").run(jti, expires).changes === 1;
  }
  prune(now = Math.floor(Date.now() / 1000)): void {
    this.db.prepare("DELETE FROM used_tickets WHERE expires <= ?").run(now);
  }
  close(): void { this.db.close(); }
}
