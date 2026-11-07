import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { ContractError } from '@holdmyspot/shared';

/**
 * SQLite through node:sqlite (synchronous). Market records are stored as
 * JSON documents (the contract types) with a few indexed columns for
 * filtering. Money inside documents is integer cents; times are epoch ms.
 */

export type SqlValue = string | number | null;

export interface ColumnSpec<T> {
  name: string;
  get: (doc: T) => string | number | boolean | null;
  unique?: boolean;
}

export const SCHEMA_VERSION = 1;

/** Tables that are not document tables. */
const FIXED_TABLES = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ledger_requests (ledger_id TEXT PRIMARY KEY, request TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  audience TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  persona TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key, route, persona)
);
CREATE TABLE IF NOT EXISTS fake_paypal (kind TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (kind, id));
CREATE TABLE IF NOT EXISTS paypal_sync (
  object_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  reference TEXT,
  last_status TEXT,
  last_polled_at INTEGER
);
CREATE TABLE IF NOT EXISTS webhook_events (event_id TEXT PRIMARY KEY, type TEXT NOT NULL, verified INTEGER NOT NULL, processed_at INTEGER);
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  mode TEXT NOT NULL,
  fixture_key TEXT,
  latency_ms INTEGER,
  ok INTEGER NOT NULL,
  at INTEGER NOT NULL
);
`;

export class Database {
  readonly raw: DatabaseSync;
  #depth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA synchronous = NORMAL;');
    this.raw.exec(FIXED_TABLES);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return this.raw.prepare(sql);
  }

  get inTransaction(): boolean {
    return this.#depth > 0;
  }

  /** Runs `fn` in one transaction. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T, hooks: { commit: () => void; rollback: () => void }): T {
    if (this.#depth > 0) {
      this.#depth++;
      try {
        return fn();
      } finally {
        this.#depth--;
      }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.#depth = 1;
    try {
      const out = fn();
      if (out instanceof Promise) throw new Error('Transactions must be synchronous.');
      this.raw.exec('COMMIT');
      this.#depth = 0;
      hooks.commit();
      return out;
    } catch (err) {
      this.#depth = 0;
      try {
        this.raw.exec('ROLLBACK');
      } finally {
        hooks.rollback();
      }
      throw err;
    }
  }

  getMeta(key: string): string | null {
    const row = this.raw.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  close(): void {
    this.raw.close();
  }
}

const toSql = (v: string | number | boolean | null): SqlValue => (typeof v === 'boolean' ? (v ? 1 : 0) : v);

/** A table of JSON documents with indexed columns derived from each document. */
export class DocTable<T extends { id: string }> {
  readonly name: string;
  readonly #db: Database;
  readonly #cols: readonly ColumnSpec<T>[];
  readonly #stmts = new Map<string, StatementSync>();

  constructor(db: Database, name: string, cols: readonly ColumnSpec<T>[]) {
    this.name = name;
    this.#db = db;
    this.#cols = cols;
    const colDdl = cols.map((c) => `, ${c.name}${c.unique ? ' UNIQUE' : ''}`).join('');
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY${colDdl}, doc TEXT NOT NULL);`);
    for (const c of cols) {
      if (!c.unique) db.exec(`CREATE INDEX IF NOT EXISTS ${name}_${c.name} ON ${name} (${c.name});`);
    }
  }

  #stmt(sql: string): StatementSync {
    let s = this.#stmts.get(sql);
    if (!s) {
      s = this.#db.prepare(sql);
      this.#stmts.set(sql, s);
    }
    return s;
  }

  get(id: string): T | null {
    const row = this.#stmt(`SELECT doc FROM ${this.name} WHERE id = ?`).get(id) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as T) : null;
  }

  must(id: string, what: string = this.name.replace(/s$/, ''), code: 'NOT_FOUND' | 'HOLD_NOT_FOUND' = 'NOT_FOUND'): T {
    const doc = this.get(id);
    if (!doc) throw new ContractError(code, `No ${what} with id ${id}.`, { id });
    return doc;
  }

  insert(doc: T): T {
    const names = ['id', ...this.#cols.map((c) => c.name), 'doc'];
    const sql = `INSERT INTO ${this.name} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
    this.#stmt(sql).run(doc.id, ...this.#cols.map((c) => toSql(c.get(doc))), JSON.stringify(doc));
    return doc;
  }

  update(doc: T): T {
    const sets = [...this.#cols.map((c) => `${c.name} = ?`), 'doc = ?'].join(', ');
    const res = this.#stmt(`UPDATE ${this.name} SET ${sets} WHERE id = ?`).run(...this.#cols.map((c) => toSql(c.get(doc))), JSON.stringify(doc), doc.id);
    if (Number(res.changes) !== 1) throw new ContractError('NOT_FOUND', `No ${this.name} row ${doc.id} to update.`);
    return doc;
  }

  /** Documents matching a WHERE clause over the indexed columns, in insertion order. */
  where(clause: string, ...params: SqlValue[]): T[] {
    const rows = this.#stmt(`SELECT doc FROM ${this.name} WHERE ${clause} ORDER BY rowid`).all(...params) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as T);
  }

  first(clause: string, ...params: SqlValue[]): T | null {
    const row = this.#stmt(`SELECT doc FROM ${this.name} WHERE ${clause} ORDER BY rowid LIMIT 1`).get(...params) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as T) : null;
  }

  all(): T[] {
    const rows = this.#stmt(`SELECT doc FROM ${this.name} ORDER BY rowid`).all() as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as T);
  }

  count(clause = '1 = 1', ...params: SqlValue[]): number {
    const row = this.#stmt(`SELECT COUNT(*) AS n FROM ${this.name} WHERE ${clause}`).get(...params) as { n: number };
    return Number(row.n);
  }

  clear(): void {
    this.#db.exec(`DELETE FROM ${this.name};`);
  }
}
