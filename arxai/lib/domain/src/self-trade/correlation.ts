// CorrelationGuard — pure. Prevents the fleet from stacking correlated exposure.
// Forex shares a small static family map (USD legs etc.); for everything else
// (e.g. Deriv synthetics, which are independent random feeds) correlation is
// only used when a REAL measured value is supplied by the caller. We never
// assume a relationship we have not measured.

export type CorrelationLookup = (a: string, b: string) => number | null;

// Coarse, well-known forex correlations (|r| ≥ ~0.6). Symmetric. Values are
// directional sign × magnitude. This is a guardrail input, never a price source.
const FOREX_PAIRS: Record<string, number> = {
  "EURUSD|GBPUSD": 0.8,
  "EURUSD|AUDUSD": 0.65,
  "EURUSD|NZDUSD": 0.6,
  "GBPUSD|AUDUSD": 0.6,
  "AUDUSD|NZDUSD": 0.85,
  "USDCHF|EURUSD": -0.85,
  "USDCAD|AUDUSD": -0.6,
  "USDJPY|EURJPY": 0.7,
  "XAUUSD|EURUSD": 0.6,
};

function norm(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function staticForexCorrelation(a: string, b: string): number | null {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 1;
  return FOREX_PAIRS[`${na}|${nb}`] ?? FOREX_PAIRS[`${nb}|${na}`] ?? null;
}

/** Resolve correlation: prefer a measured value, fall back to the static map. */
export function resolveCorrelation(
  a: string,
  b: string,
  measured?: CorrelationLookup,
): number | null {
  if (norm(a) === norm(b)) return 1;
  const m = measured?.(a, b);
  if (m != null && Number.isFinite(m)) return m;
  return staticForexCorrelation(a, b);
}

export interface CorrelationConflict {
  conflict: boolean;
  /** "STACKED" = same-direction correlated exposure; "HEDGE" = opposing. */
  kind: "STACKED" | "HEDGE" | "NONE";
  correlation: number | null;
  note: string;
}

const STACK_THRESHOLD = 0.6;

/**
 * Compare a candidate trade against an already-owned trade on another symbol.
 * Same-direction exposure on strongly +correlated (or opposite-direction on
 * strongly −correlated) symbols stacks the same risk and is flagged.
 */
export function evaluateCorrelationConflict(args: {
  symbolA: string;
  sideA: "BUY" | "SELL";
  symbolB: string;
  sideB: "BUY" | "SELL";
  measured?: CorrelationLookup;
}): CorrelationConflict {
  const { symbolA, sideA, symbolB, sideB, measured } = args;
  const r = resolveCorrelation(symbolA, symbolB, measured);
  if (r == null || Math.abs(r) < STACK_THRESHOLD) {
    return { conflict: false, kind: "NONE", correlation: r, note: "No material correlation." };
  }
  const sameSide = sideA === sideB;
  // Positive corr + same side ⇒ stacked. Negative corr + opposite side ⇒ stacked.
  const stacked = (r > 0 && sameSide) || (r < 0 && !sameSide);
  if (stacked) {
    return {
      conflict: true,
      kind: "STACKED",
      correlation: r,
      note: `Correlated exposure (r=${r}) duplicates existing ${symbolB} risk.`,
    };
  }
  return {
    conflict: false,
    kind: "HEDGE",
    correlation: r,
    note: `Correlated but opposing ${symbolB} — partial hedge.`,
  };
}
