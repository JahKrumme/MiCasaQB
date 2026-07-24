// A real SQLite-backed D1Database stand-in for tests, using Node's built-in
// node:sqlite. This exercises actual SQL semantics (including the UPSERT and
// optimistic-concurrency UPDATE...WHERE clauses the token repository relies
// on) without needing Miniflare.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

class FakePreparedStatement {
  private params: unknown[] = [];
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string
  ) {}

  bind(...values: unknown[]): this {
    this.params = values;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    return (row as T) ?? null;
  }

  async run<T = Record<string, unknown>>(): Promise<{ success: true; meta: { changes: number; last_row_id: number }; results: T[] }> {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid }, results: [] };
  }

  async all<T = Record<string, unknown>>(): Promise<{ success: true; meta: { changes: number; last_row_id: number }; results: T[] }> {
    const rows = this.db.prepare(this.sql).all(...this.params);
    return { success: true, meta: { changes: 0, last_row_id: 0 }, results: rows as T[] };
  }
}

export class FakeD1Database {
  private readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(':memory:');
    const migrationFiles = readdirSync(MIGRATIONS_DIR)
      .filter(name => name.endsWith('.sql'))
      .sort();
    for (const name of migrationFiles) {
      this.db.exec(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf-8'));
    }
  }

  prepare(sql: string): FakePreparedStatement {
    return new FakePreparedStatement(this.db, sql);
  }

  async batch(statements: FakePreparedStatement[]): Promise<unknown[]> {
    const results = [];
    for (const stmt of statements) {
      results.push(await stmt.run());
    }
    return results;
  }

  close(): void {
    this.db.close();
  }
}

export function createFakeD1(): D1Database {
  return new FakeD1Database() as unknown as D1Database;
}
