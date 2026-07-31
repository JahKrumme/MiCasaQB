// Integer-cents helpers — invoice totals must never be summed as floating
// point dollars (0.1 + 0.2 !== 0.3). Every money calculation in the
// invoice-preview flow goes through cents internally and only converts
// back to dollars once, at the response boundary.
export function dollarsToCents(amount: number): number {
  return Math.round(amount * 100);
}

export function centsToDollars(cents: number): number {
  return cents / 100;
}

export function sumCents(centsValues: number[]): number {
  return centsValues.reduce((sum, c) => sum + c, 0);
}
