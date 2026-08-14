// ── DATA-SUFFICIENCY TRUTH (Phase 2) — live ENTRY gate adapter ──────────────
//
// Composes (never re-derives) the shared Phase-1 sufficiency engine onto the
// live-entry path. The trade-ticket / live-entry chokepoints — preflight
// (`createLiveDraft` → `preflight`) and dispatch (`dispatchLiveCommand`) — both
// call THIS one helper, so the two can never drift (lockstep).
//
// SAFETY:
//   - BLOCK-ONLY. The verdict can refuse a NEW entry; it can NEVER grant one,
//     relax the synthetic floor / SL policy / 18-gate dispatch, or authorize a
//     trade. It runs ADDITIVELY in front of the existing chain — every existing
//     gate still runs afterwards and keeps final say.
//   - NEW-ENTRY ONLY. Callers gate this on the entry command types only, so a
//     close / modify / cancel of an existing position is never affected.
//   - FAIL-CLOSED. If the chart state cannot be built (error or timeout), the
//     entry is treated as NOT sufficient and is refused — we never let an entry
//     through on an unverified feed.
//
// Entry orders carry no per-order timeframe (an `arx_live_command` row is symbol
// only), so the gate evaluates a fixed base ENTRY timeframe. M1 is the shortest
// real MT5 timeframe and is the most conservative freshness probe: if even the
// 1-minute feed is live with enough closed bars, every higher timeframe is too.

import type { MarketDataSufficiencyStatus } from "@workspace/domain/market";
import type { SymbolFeedVerdict } from "@workspace/domain/safety-contracts/syntheticLiveFloor";
// `buildChartIntelligenceState` is lazy-loaded inside the function (see below) so
// importing this gate does NOT eagerly pull the heavy chart/provider graph — a
// caller injecting `deps.buildState` (e.g. a unit test) never loads it. The type
// is import-only (erased), so it stays a static type import.
import type { ChartIntelligenceState } from "../data/chart/chartIntelligence.js";
import { evaluateSufficiencyFromChartState } from "../data/chart/chartSufficiency.js";
import type { ChartTimeframe } from "../data/chart/timeframes.js";

/**
 * The base timeframe the entry gate evaluates. Entry commands carry no
 * timeframe, so the gate probes the shortest real MT5 timeframe (most
 * conservative freshness check). Named const so the choice is explicit and
 * greppable.
 */
export const LIVE_ENTRY_SUFFICIENCY_TIMEFRAME: ChartTimeframe = "M1";

/** Closed-bar window pulled when building the entry-gate chart state. */
const ENTRY_SUFFICIENCY_CANDLE_LIMIT = 120;

/** Short fail-closed budget — the chart state is normally 3s-cached. */
const ENTRY_SUFFICIENCY_TIMEOUT_MS = 4_000;

export interface EntryDataSufficiencyResult {
  symbol: string;
  timeframe: ChartTimeframe;
  status: MarketDataSufficiencyStatus;
  /**
   * BLOCK affordance ONLY — true exactly when a NEW entry must be refused
   * (status !== "sufficient", OR the feed could not be verified). This is a
   * refusal flag, never an execution permission; it can only block.
   */
  shouldBlock: boolean;
  freshnessVerdict: SymbolFeedVerdict;
  availableClosedCandles: number;
  /** Plain-English, user-safe reason (from the shared engine / fail-closed copy). */
  humanReason: string;
}

/** Injectable seam so the gate can be unit-tested without provider IO. */
export interface EntrySufficiencyDeps {
  buildState?: (
    symbol: string,
    timeframe: ChartTimeframe,
    limit: number,
  ) => Promise<ChartIntelligenceState>;
}

const FAIL_CLOSED_REASON =
  "Live data for this market couldn't be confirmed right now, so a new entry is blocked. Try again once the feed is live.";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("entry_sufficiency_timeout")),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Evaluate whether there is enough proven, live market data to allow a NEW live
 * entry on `symbol`. BLOCK-ONLY + FAIL-CLOSED. Both the preflight and dispatch
 * chokepoints call this so they stay in lockstep.
 */
export async function evaluateEntryDataSufficiency(
  symbol: string,
  deps: EntrySufficiencyDeps = {},
): Promise<EntryDataSufficiencyResult> {
  try {
    // Lazy default: only loaded when no stub is injected. `??` short-circuits, so
    // a caller passing `deps.buildState` never triggers the dynamic import. In the
    // server bundle chartIntelligence is already loaded, so this is free at
    // runtime. Resolved INSIDE the try so a module-load failure also fails closed.
    const buildState =
      deps.buildState ??
      (await import("../data/chart/chartIntelligence.js")).buildChartIntelligenceState;
    const state = await withTimeout(
      buildState(
        symbol,
        LIVE_ENTRY_SUFFICIENCY_TIMEFRAME,
        ENTRY_SUFFICIENCY_CANDLE_LIMIT,
      ),
      ENTRY_SUFFICIENCY_TIMEOUT_MS,
    );
    const verdict = evaluateSufficiencyFromChartState(
      state,
      LIVE_ENTRY_SUFFICIENCY_TIMEFRAME,
    );
    return {
      symbol,
      timeframe: LIVE_ENTRY_SUFFICIENCY_TIMEFRAME,
      status: verdict.status,
      shouldBlock: !verdict.canShowTradeSetup,
      freshnessVerdict: verdict.freshnessVerdict,
      availableClosedCandles: verdict.availableClosedCandles,
      humanReason: verdict.humanReason,
    };
  } catch {
    // FAIL-CLOSED: an unverified feed never yields a live entry.
    return {
      symbol,
      timeframe: LIVE_ENTRY_SUFFICIENCY_TIMEFRAME,
      status: "insufficient",
      shouldBlock: true,
      freshnessVerdict: "AWAITING",
      availableClosedCandles: 0,
      humanReason: FAIL_CLOSED_REASON,
    };
  }
}
