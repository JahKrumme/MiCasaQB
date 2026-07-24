// Minimal ambient typing for the subset of node:sqlite used by fakeD1.ts.
// Kept local (instead of pulling in @types/node globally) to avoid its DOM/lib
// globals colliding with @cloudflare/workers-types' ambient Request/Response.
declare module 'node:sqlite' {
  export interface StatementResultingChanges {
    changes: number;
    lastInsertRowid: number;
  }

  export class StatementSync {
    run(...params: unknown[]): StatementResultingChanges;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  }

  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
