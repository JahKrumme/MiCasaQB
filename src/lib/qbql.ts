// Safe QBQL (QuickBooks Query Language) builder for entity list queries.
// QBQL is NOT ordinary SQL — Intuit's parser rejects some things a real SQL
// engine would accept (a bare `WHERE 1=1` no-op filter is one; this file
// exists because that exact pattern, previously inlined in
// src/routes/internal.ts's GET /invoices, made every *unfiltered* invoice
// list request fail with a 400 from Intuit's API). Every filter here is
// allowlisted and validated before being interpolated into the query
// string — no caller ever passes a raw QBQL fragment or arbitrary field
// name/operator.
export class InvalidQueryFilterError extends Error {}

const NUMERIC_ID_PATTERN = /^[0-9]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MAX_RESULTS = 100;
// Intuit's own documented hard ceiling for a single query response.
const HARD_MAX_RESULTS = 1000;

function validateCustomerId(id: string): void {
  if (!NUMERIC_ID_PATTERN.test(id)) {
    throw new InvalidQueryFilterError('customerId must be a numeric QuickBooks entity id');
  }
}

function validateDate(value: string, label: string): void {
  if (!DATE_PATTERN.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw new InvalidQueryFilterError(`${label} must be a valid YYYY-MM-DD date`);
  }
}

function clampMaxResults(maxResults: number | undefined): number {
  if (maxResults === undefined) return DEFAULT_MAX_RESULTS;
  if (!Number.isFinite(maxResults) || maxResults <= 0) {
    throw new InvalidQueryFilterError('maxResults must be a positive number');
  }
  return Math.min(Math.floor(maxResults), HARD_MAX_RESULTS);
}

function clampStartPosition(startPosition: number | undefined): number | undefined {
  if (startPosition === undefined) return undefined;
  if (!Number.isFinite(startPosition) || startPosition < 1) {
    throw new InvalidQueryFilterError('startPosition must be a positive number (QBQL positions are 1-based)');
  }
  return Math.floor(startPosition);
}

export interface InvoiceQueryFilters {
  /** QuickBooks Customer entity id — numeric only. */
  customerId?: string;
  /** 'open' = Balance > 0; 'overdue' = Balance > 0 AND past due as of today. No other value is accepted. */
  status?: 'open' | 'overdue';
  /** Inclusive TxnDate lower bound, YYYY-MM-DD. */
  dateFrom?: string;
  /** Inclusive TxnDate upper bound, YYYY-MM-DD. */
  dateTo?: string;
}

export interface QueryPagination {
  maxResults?: number;
  startPosition?: number;
}

/**
 * Builds a safe `SELECT * FROM Invoice ...` QBQL query. Every allowlisted
 * filter is validated first (throws InvalidQueryFilterError on anything
 * unrecognized/malformed) — nothing here ever concatenates a raw,
 * caller-supplied QBQL fragment. Produces no WHERE clause at all when no
 * filters are given, rather than a placeholder like `WHERE 1=1`.
 */
export function buildInvoiceQuery(filters: InvoiceQueryFilters = {}, pagination: QueryPagination = {}): string {
  const conditions: string[] = [];

  if (filters.customerId !== undefined) {
    validateCustomerId(filters.customerId);
    conditions.push(`CustomerRef = '${filters.customerId}'`);
  }

  if (filters.status !== undefined) {
    if (filters.status === 'open') {
      conditions.push(`Balance > '0'`);
    } else if (filters.status === 'overdue') {
      const today = new Date().toISOString().split('T')[0];
      conditions.push(`Balance > '0'`, `DueDate < '${today}'`);
    } else {
      throw new InvalidQueryFilterError(`Unsupported status filter: ${String(filters.status)}`);
    }
  }

  if (filters.dateFrom !== undefined) {
    validateDate(filters.dateFrom, 'dateFrom');
    conditions.push(`TxnDate >= '${filters.dateFrom}'`);
  }
  if (filters.dateTo !== undefined) {
    validateDate(filters.dateTo, 'dateTo');
    conditions.push(`TxnDate <= '${filters.dateTo}'`);
  }

  const maxResults = clampMaxResults(pagination.maxResults);
  const startPosition = clampStartPosition(pagination.startPosition);

  const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const startClause = startPosition !== undefined ? ` STARTPOSITION ${startPosition}` : '';
  return `SELECT * FROM Invoice${whereClause} ORDER BY TxnDate DESC${startClause} MAXRESULTS ${maxResults}`;
}
