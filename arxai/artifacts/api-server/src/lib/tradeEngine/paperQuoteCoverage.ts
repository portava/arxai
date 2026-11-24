/** Markets whose public bid/ask recorder can verify every scheduled tick. */
export function hasPaperQuoteCoverage(provider: string, symbol: string): boolean {
  return provider === "deriv_public" && /^V(10|25|50|75|100)(_1S)?$/.test(symbol);
}
