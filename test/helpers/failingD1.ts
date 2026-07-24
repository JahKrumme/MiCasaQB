// Wraps a real D1Database so that prepare() calls whose SQL contains
// `failOnSqlSubstring` throw on `.run()`, simulating a database write failure
// after a successful upstream (Intuit) call.
export function withFailingWrite(db: D1Database, failOnSqlSubstring: string): D1Database {
  return {
    ...db,
    prepare(sql: string) {
      const real = db.prepare(sql);
      if (sql.includes(failOnSqlSubstring)) {
        return {
          ...real,
          bind: (...args: unknown[]) => {
            const boundReal = real.bind(...args);
            return {
              ...boundReal,
              run: async () => {
                throw new Error('simulated database write failure');
              },
              first: boundReal.first.bind(boundReal),
              all: boundReal.all.bind(boundReal)
            };
          }
        };
      }
      return real;
    }
  } as unknown as D1Database;
}
