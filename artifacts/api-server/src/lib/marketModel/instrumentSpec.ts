// Minimal instrument-spec resolution — the pip/point unit, closed honestly.
//
// WHY THIS MODULE EXISTS
//
// Pip math was scattered and wrong in three different ways: liveScanner
// multiplied every price distance by 10,000 (admitting in a comment that JPY
// would need symbol meta), positionSizing had its own JPY check, and the
// mission execution-quality path simply gave up (expectedMovePips: null,
// spreadPips: null). A wrong pip size does not look wrong — it produces a
// plausible number in the wrong unit, which then feeds spread-share-of-move
// and TP-distance displays.
//
// THE UNIT CONTRACT (single definition — consumers must not re-derive it)
//
//   - STRICT ISO-4217 fiat pair (EURUSD, GBPJPY): the classic FX pip —
//     0.01 for JPY-quoted pairs, 0.0001 otherwise. This is a market-wide
//     convention, not a broker setting, so it is honest static truth.
//   - Everything else (synthetics, metals, crypto, indices): the broker-
//     reported POINT (`arx_symbol_specs.point`, EA truth) IS the pip unit.
//     There is no universal pip convention for these instruments; the broker
//     point is the unit the EA's own `spread_points` snapshot uses, so any
//     future spread-vs-move ratio stays unit-consistent by construction.
//   - Neither known ⇒ null WITH a reason. Never a guessed unit.
//
// Mirrors the decide/resolve split of `../mt5/contractSize.ts`: the decision
// half is pure (unit-testable without a database), the resolver is a thin DB
// wrapper over the per-user EA-reported spec row. The DB is imported LAZILY
// inside the resolver so this module stays importable from pure display
// adapters (opportunityAdapters) without a DATABASE_URL at init.

import { splitForexPair } from "../mt5/forexPair.js";

export type PipSizeSource = "FX_PIP_CONVENTION" | "BROKER_POINT";

export interface ResolvedPipSize {
  /** Price increment of one pip. null = unknown; do NOT guess. */
  pipSize: number | null;
  source: PipSizeSource | null;
  /** Machine-readable reason when pipSize is null. */
  reason: "NO_BROKER_POINT_AND_NOT_FOREX" | "BROKER_POINT_INVALID" | null;
}

/**
 * PURE decision half of pip-size resolution.
 *
 * Order of authority:
 *   1. For a STRICT ISO-4217 fiat pair, the classic FX pip convention
 *      (JPY-quoted 0.01, else 0.0001) — convention beats broker point here
 *      because "pips" on FX universally means the convention, not the
 *      5-digit broker point a tenth its size.
 *   2. Broker truth (`arx_symbol_specs.point`) for everything else.
 *   3. Otherwise null — synthetics, metals, crypto and indices have no
 *      universal pip and we refuse to invent one.
 */
export function decidePipSize(args: {
  symbol: string;
  brokerPoint: number | null;
}): ResolvedPipSize {
  const pair = splitForexPair(args.symbol);
  if (pair) {
    return {
      pipSize: pair.quote === "JPY" ? 0.01 : 0.0001,
      source: "FX_PIP_CONVENTION",
      reason: null,
    };
  }
  if (args.brokerPoint != null) {
    if (!Number.isFinite(args.brokerPoint) || args.brokerPoint <= 0) {
      return { pipSize: null, source: null, reason: "BROKER_POINT_INVALID" };
    }
    return { pipSize: args.brokerPoint, source: "BROKER_POINT", reason: null };
  }
  return { pipSize: null, source: null, reason: "NO_BROKER_POINT_AND_NOT_FOREX" };
}

/**
 * Static-only pip size (no user context, no DB): the FX convention or null.
 * For surfaces like the live scanner that have no per-user broker spec to
 * consult — non-FX symbols honestly resolve to null there.
 */
export function staticPipSize(symbol: string): number | null {
  return decidePipSize({ symbol, brokerPoint: null }).pipSize;
}

/**
 * Resolve the pip unit for one user+symbol, reading the EA-reported broker
 * point for non-FX instruments. Thin DB wrapper around {@link decidePipSize}.
 */
export async function resolvePipSize(userId: number, symbol: string): Promise<ResolvedPipSize> {
  // The FX convention needs no DB read at all.
  const staticDecision = decidePipSize({ symbol, brokerPoint: null });
  if (staticDecision.pipSize != null) return staticDecision;

  const [{ db, arxSymbolSpecsTable }, { and, eq }] = await Promise.all([
    import("@workspace/db"),
    import("drizzle-orm"),
  ]);
  const rows = await db
    .select({ point: arxSymbolSpecsTable.point })
    .from(arxSymbolSpecsTable)
    .where(and(eq(arxSymbolSpecsTable.userId, userId), eq(arxSymbolSpecsTable.symbol, symbol)))
    .limit(1);
  return decidePipSize({ symbol, brokerPoint: rows[0]?.point ?? null });
}
