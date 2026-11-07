import type { StatementSync } from 'node:sqlite';
import type { ServerEventData, ServerEventType } from '@holdmyspot/shared';
import type { Database } from '../db/database.ts';

/**
 * Event outbox. Commands record events inside their SQLite transaction; the
 * bus hands them to SSE subscribers only after the commit (and drops them on
 * rollback). Stored events allow replay on reconnect (docs/ARCHITECTURE.md
 * section 7). Audience decides who may see an event; per-viewer field
 * redaction happens at delivery (app/views.ts).
 */

/** Everyone, or only these users (ops always sees everything). */
export type Audience = { all: true } | { users: string[] };

export interface StoredEvent<T extends ServerEventType = ServerEventType> {
  seq: number;
  type: T;
  at: number;
  audience: Audience;
  data: ServerEventData[T];
}

export const EVENTS_KEPT = 10_000;

export class EventBus {
  readonly #db: Database;
  #pending: StoredEvent[] = [];
  readonly #subs = new Set<(e: StoredEvent) => void>();
  readonly #insert: StatementSync;

  constructor(db: Database) {
    this.#db = db;
    this.#insert = db.prepare('INSERT INTO events (type, at, audience, data) VALUES (?, ?, ?, ?)');
  }

  /** Records an event inside the current transaction; delivered after commit. */
  record<T extends ServerEventType>(type: T, at: number, audience: Audience, data: ServerEventData[T]): StoredEvent<T> {
    const res = this.#insert.run(type, at, JSON.stringify(audience), JSON.stringify(data));
    const ev: StoredEvent<T> = { seq: Number(res.lastInsertRowid), type, at, audience, data: structuredClone(data) };
    this.#pending.push(ev as StoredEvent);
    return ev;
  }

  /** Delivers an event to live subscribers without storing it (for example queuer.moved samples). */
  live<T extends ServerEventType>(ev: StoredEvent<T>): void {
    for (const fn of this.#subs) fn(ev as StoredEvent);
  }

  flush(): void {
    const batch = this.#pending;
    this.#pending = [];
    for (const ev of batch) for (const fn of this.#subs) fn(ev);
  }

  discard(): void {
    this.#pending = [];
  }

  subscribe(fn: (e: StoredEvent) => void): () => void {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }

  /** The last sequence number issued (survives deletes, so it keeps rising across resets). */
  latestSeq(): number {
    const row = this.#db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as { seq: number } | undefined;
    return row ? Number(row.seq) : 0;
  }

  oldestSeq(): number | null {
    const row = this.#db.prepare('SELECT MIN(seq) AS s FROM events').get() as { s: number | null };
    return row.s === null ? null : Number(row.s);
  }

  after(seq: number, limit = 5000): StoredEvent[] {
    const rows = this.#db.prepare('SELECT seq, type, at, audience, data FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(seq, limit) as {
      seq: number;
      type: ServerEventType;
      at: number;
      audience: string;
      data: string;
    }[];
    return rows.map((r) => ({ seq: Number(r.seq), type: r.type, at: Number(r.at), audience: JSON.parse(r.audience) as Audience, data: JSON.parse(r.data) }));
  }

  prune(keep = EVENTS_KEPT): void {
    this.#db.prepare('DELETE FROM events WHERE seq <= ?').run(this.latestSeq() - keep);
  }

  clear(): void {
    this.#db.exec('DELETE FROM events;');
    this.#pending = [];
  }
}
