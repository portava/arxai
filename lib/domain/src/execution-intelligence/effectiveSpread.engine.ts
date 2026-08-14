// ═══════════════════════════════════════════════════════════════════════════
// Effective Spread
//
// Effective spread = 2 × |fillPrice − midAtSignal|, expressed in pips.
// Measures how far the actual fill was from the midpoint at signal time —
// a better cost measure than quoted spread because it captures slippage AND
// half-spread paid.
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export function computeEffectiveSpread(
  fillPrice: number,
  midAtSignal: number,
  pipSize: number,
): number {
  const denom = pipSize > 0 ? pipSize : 1e-9;
  return (2 * Math.abs(fillPrice - midAtSignal)) / denom;
}
