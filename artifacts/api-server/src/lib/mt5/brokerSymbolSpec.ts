// Task #30 — Broker symbol-spec resolver.
//
// Single place that turns the EA-reported per-user broker truth
// (arx_symbol_specs) into a PreTradeBrokerSpec the pure guard consumes, and
// merges in static registry display info. Used by the live preflight and the
// brain symbol route so both stop guessing broker rules.
//
// SAFETY: read-only. When no broker row exists we return all-null spec numbers
// so the pure guard fails-OPEN on spec checks (cannot prove a violation) while
// the quote/spread/market checks still fail-CLOSED on missing live inputs.
// This NEVER enables execution.

import { db, arxSymbolSpecsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { PreTradeBrokerSpec, PreTradeTradeMode } from "@workspace/domain/safety-contracts";
import type { BrokerContractSpec } from "@workspace/domain/execution-preview";
import { getSymbolInfo } from "../instruments/index.js";

export interface ResolvedBrokerSymbolSpec {
  symbol: string;
  /** PreTradeBrokerSpec for the pure guard. All-null when no broker row. */
  spec: PreTradeBrokerSpec;
  /** True when the numbers came from a real EA report (not the static guess). */
  hasBrokerTruth: boolean;
  /** When the EA last reported this symbol (ISO) or null. */
  reportedAt: string | null;
  /** Static registry display metadata (or null when unknown). */
  registry: ReturnType<typeof getSymbolInfo> | null;
  /** Last known spread snapshot in points, when reported. */
  spreadPoints: number | null;
  /**
   * The money half of the broker's report (contract size, tick size/value,
   * profit currency), exactly as the EA sent it; null when no broker row.
   */
  contract: BrokerContractSpec | null;
}

const EMPTY_SPEC: PreTradeBrokerSpec = {
  visible: null,
  tradeAllowed: null,
  tradeMode: null,
  marketOpen: null,
  point: null,
  minVolume: null,
  maxVolume: null,
  volumeStep: null,
  stopsLevelPoints: null,
  freezeLevelPoints: null,
};

function coerceTradeMode(v: string | null): PreTradeTradeMode | null {
  if (v === "FULL" || v === "LONGONLY" || v === "SHORTONLY" || v === "CLOSEONLY" || v === "DISABLED") return v;
  return null;
}

/**
 * Resolve the broker spec for one user+symbol. Returns the merged view; spec
 * numbers are null when the EA has not reported this symbol yet.
 */
export async function getBrokerSymbolSpec(userId: number, symbol: string): Promise<ResolvedBrokerSymbolSpec> {
  const registry = getSymbolInfo(symbol) ?? null;
  const rows = await db.select().from(arxSymbolSpecsTable)
    .where(and(eq(arxSymbolSpecsTable.userId, userId), eq(arxSymbolSpecsTable.symbol, symbol)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { symbol, spec: { ...EMPTY_SPEC }, hasBrokerTruth: false, reportedAt: null, registry, spreadPoints: null, contract: null };
  }
  const spec: PreTradeBrokerSpec = {
    visible: row.visible,
    tradeAllowed: row.tradeAllowed,
    tradeMode: coerceTradeMode(row.tradeMode),
    marketOpen: row.marketOpen,
    point: row.point,
    minVolume: row.minVolume,
    maxVolume: row.maxVolume,
    volumeStep: row.volumeStep,
    stopsLevelPoints: row.stopsLevelPoints,
    freezeLevelPoints: row.freezeLevelPoints,
  };
  const reportedAt = row.reportedAt ? row.reportedAt.toISOString() : null;
  return {
    symbol,
    spec,
    hasBrokerTruth: true,
    reportedAt,
    registry,
    spreadPoints: row.spreadPoints,
    contract: {
      contractSize: row.contractSize ?? null,
      tickSize: row.tickSize ?? null,
      tickValue: row.tickValue ?? null,
      profitCurrency: typeof row.profitCurrency === "string" && row.profitCurrency.trim() ? row.profitCurrency.trim() : null,
      reportedAt,
    },
  };
}
