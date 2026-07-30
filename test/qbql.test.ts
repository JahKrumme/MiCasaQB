// Regression coverage for the invoice-query bug: GET /internal/invoices
// used to build `SELECT * FROM Invoice WHERE 1=1 ...` for the unfiltered
// case, which Intuit's real QBQL parser rejects with a 400 (QBQL is not
// ordinary SQL). buildInvoiceQuery() is the fix — these tests pin its
// exact output shape so the bug can't silently come back.
import { describe, expect, it } from 'vitest';
import { buildInvoiceQuery, InvalidQueryFilterError } from '../src/lib/qbql';

describe('buildInvoiceQuery — unfiltered', () => {
  it('has no WHERE clause at all when no filters are given', () => {
    const query = buildInvoiceQuery();
    expect(query).toBe('SELECT * FROM Invoice ORDER BY TxnDate DESC MAXRESULTS 100');
  });

  it('never contains the literal "WHERE 1=1", under any input', () => {
    const cases = [
      buildInvoiceQuery(),
      buildInvoiceQuery({ customerId: '123' }),
      buildInvoiceQuery({ status: 'open' }),
      buildInvoiceQuery({ status: 'overdue' }),
      buildInvoiceQuery({ customerId: '123', status: 'open' })
    ];
    for (const query of cases) expect(query).not.toContain('1=1');
  });
});

describe('buildInvoiceQuery — single filters', () => {
  it('customer filter produces one valid WHERE clause', () => {
    const query = buildInvoiceQuery({ customerId: '123' });
    expect(query).toBe(`SELECT * FROM Invoice WHERE CustomerRef = '123' ORDER BY TxnDate DESC MAXRESULTS 100`);
  });

  it('date filter (dateFrom) produces one valid WHERE clause', () => {
    const query = buildInvoiceQuery({ dateFrom: '2026-01-01' });
    expect(query).toBe(`SELECT * FROM Invoice WHERE TxnDate >= '2026-01-01' ORDER BY TxnDate DESC MAXRESULTS 100`);
  });

  it('dateTo produces one valid WHERE clause', () => {
    const query = buildInvoiceQuery({ dateTo: '2026-12-31' });
    expect(query).toBe(`SELECT * FROM Invoice WHERE TxnDate <= '2026-12-31' ORDER BY TxnDate DESC MAXRESULTS 100`);
  });

  it('open status filters on Balance only', () => {
    const query = buildInvoiceQuery({ status: 'open' });
    expect(query).toBe(`SELECT * FROM Invoice WHERE Balance > '0' ORDER BY TxnDate DESC MAXRESULTS 100`);
  });

  it('overdue status filters on Balance and DueDate', () => {
    const query = buildInvoiceQuery({ status: 'overdue' });
    expect(query).toMatch(/^SELECT \* FROM Invoice WHERE Balance > '0' AND DueDate < '\d{4}-\d{2}-\d{2}' ORDER BY TxnDate DESC MAXRESULTS 100$/);
  });
});

describe('buildInvoiceQuery — multiple filters join with AND', () => {
  it('customer + status combine into one WHERE clause with AND', () => {
    const query = buildInvoiceQuery({ customerId: '123', status: 'open' });
    expect(query).toBe(`SELECT * FROM Invoice WHERE CustomerRef = '123' AND Balance > '0' ORDER BY TxnDate DESC MAXRESULTS 100`);
  });

  it('customer + dateFrom + dateTo all combine with AND, in filter-declaration order', () => {
    const query = buildInvoiceQuery({ customerId: '123', dateFrom: '2026-01-01', dateTo: '2026-12-31' });
    expect(query).toBe(
      `SELECT * FROM Invoice WHERE CustomerRef = '123' AND TxnDate >= '2026-01-01' AND TxnDate <= '2026-12-31' ORDER BY TxnDate DESC MAXRESULTS 100`
    );
  });
});

describe('buildInvoiceQuery — empty/undefined optional filters are ignored', () => {
  it('an empty filters object behaves identically to no argument', () => {
    expect(buildInvoiceQuery({})).toBe(buildInvoiceQuery());
  });

  it('explicit undefined fields are ignored, not treated as present', () => {
    const query = buildInvoiceQuery({ customerId: undefined, status: undefined, dateFrom: undefined, dateTo: undefined });
    expect(query).toBe('SELECT * FROM Invoice ORDER BY TxnDate DESC MAXRESULTS 100');
  });
});

describe('buildInvoiceQuery — rejects invalid filters', () => {
  it('rejects a non-numeric customerId', () => {
    expect(() => buildInvoiceQuery({ customerId: "123' OR '1'='1" })).toThrow(InvalidQueryFilterError);
    expect(() => buildInvoiceQuery({ customerId: 'abc' })).toThrow(InvalidQueryFilterError);
  });

  it('rejects an unsupported status value', () => {
    // @ts-expect-error deliberately invalid at the type level too
    expect(() => buildInvoiceQuery({ status: 'cancelled' })).toThrow(InvalidQueryFilterError);
  });

  it('rejects an invalid dateFrom', () => {
    expect(() => buildInvoiceQuery({ dateFrom: 'not-a-date' })).toThrow(InvalidQueryFilterError);
    expect(() => buildInvoiceQuery({ dateFrom: '2026-13-40' })).toThrow(InvalidQueryFilterError);
  });

  it('rejects an invalid dateTo', () => {
    expect(() => buildInvoiceQuery({ dateTo: '01/01/2026' })).toThrow(InvalidQueryFilterError);
  });
});

describe('buildInvoiceQuery — pagination bounds', () => {
  it('MAXRESULTS defaults to 100', () => {
    expect(buildInvoiceQuery()).toContain('MAXRESULTS 100');
  });

  it('MAXRESULTS is clamped to the 1000 hard ceiling', () => {
    const query = buildInvoiceQuery({}, { maxResults: 50000 });
    expect(query).toContain('MAXRESULTS 1000');
  });

  it('rejects a zero or negative maxResults', () => {
    expect(() => buildInvoiceQuery({}, { maxResults: 0 })).toThrow(InvalidQueryFilterError);
    expect(() => buildInvoiceQuery({}, { maxResults: -5 })).toThrow(InvalidQueryFilterError);
  });

  it('STARTPOSITION is included, 1-based, when given', () => {
    const query = buildInvoiceQuery({}, { startPosition: 101 });
    expect(query).toBe('SELECT * FROM Invoice ORDER BY TxnDate DESC STARTPOSITION 101 MAXRESULTS 100');
  });

  it('rejects a startPosition below 1', () => {
    expect(() => buildInvoiceQuery({}, { startPosition: 0 })).toThrow(InvalidQueryFilterError);
  });

  it('omits STARTPOSITION entirely when not given', () => {
    expect(buildInvoiceQuery()).not.toContain('STARTPOSITION');
  });
});
