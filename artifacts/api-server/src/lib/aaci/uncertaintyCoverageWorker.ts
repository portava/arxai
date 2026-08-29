// ── VoI coverage worker (capability #6) — recorder-first evidence pump ──────
//
// WHY THIS EXISTS: the value-of-information advisory can only say
// WAIT_FOR_EVIDENCE once per-channel resolution rates are MEASURED from
// recorded before/after observation pairs — and before this worker, pairs
// accumulated only when a user/agent happened to request two AACI decisions on
// the same symbol within the pairing window. History therefore grew at the
// pace of user presses. This worker samples the MEASURABLE uncertainty
// channels on a steady clock so honest resolution history accumulates at
// machine pace instead.
//
// HONESTY (inviolable):
//   * Only channels this worker can GENUINELY measure are recorded — today
//     that is `spreadInstability`, computed from the real quote-spread history
//     via the exact same pure penalty function the decision path uses. The
//     other channels need a full snapshot/trust-store read and keep
//     accumulating from real decisions; the worker NEVER writes a fabricated
//     or fail-closed placeholder penalty for a channel it did not measure
//     (a constant 1.0 stream would poison the resolution-rate estimate).
//   * A stale or unreadable quote contributes NOTHING this tick (no sample,
//     no observation) — degraded reads never become evidence.
//   * Observations are recorded under userId 0 (system scope). Recording is
//     observational only: nothing here can affect any decision output beyond
//     the journal-only VoI advisory numbers.
//
// Worker idiom (missionDriver): unref'd interval, non-overlapping pass,
// per-item try/catch, loud env opt-out.

import { spreadInstabilityPenalty } from "@workspace/domain/aaci";
import { logger } from "../logger.js";
import { getQuote } from "../marketDataLayer.js";
import { marketSimulator } from "../marketSimulator.js";
import {
  getSpreadRelHistory,
  recordSpreadSample,
  spreadHistorySymbols,
} from "./spreadHistoryRecorder.js";
import { recordChannelObservation } from "./uncertaintyResolutionRecorder.js";

export const UNCERTAINTY_COVERAGE_INTERVAL_MS = 30_000;
/** Bounded per-pass symbol budget so a large watchlist can't stall a tick. */
export const UNCERTAINTY_COVERAGE_MAX_SYMBOLS = 50;

export function uncertaintyCoverageEnabled(envValue: string | undefined): boolean {
  if (envValue === undefined) return true; // default ON — observational only
  return !/^(0|false|no|off)$/i.test(envValue.trim());
}

/** The symbols a pass covers: everything with live spread history plus the
 *  active feed's own symbol list (so coverage starts before any decision). */
export function coverageSymbols(): string[] {
  const set = new Set<string>();
  for (const s of spreadHistorySymbols()) set.add(s);
  try {
    for (const s of marketSimulator.symbols()) set.add(s.symbol);
  } catch {
    // Feed listing unavailable — spread-history symbols alone still count.
  }
  return [...set].slice(0, UNCERTAINTY_COVERAGE_MAX_SYMBOLS);
}

export interface CoveragePassResult {
  symbols: number;
  sampled: number;
  observations: number;
  pairsRecorded: number;
  errors: number;
}

/** One coverage pass. Exported for tests; never throws. */
export function runUncertaintyCoveragePass(nowMs: number = Date.now()): CoveragePassResult {
  const result: CoveragePassResult = {
    symbols: 0,
    sampled: 0,
    observations: 0,
    pairsRecorded: 0,
    errors: 0,
  };
  for (const symbol of coverageSymbols()) {
    result.symbols += 1;
    try {
      // 1. Feed the spread recorder from the live quote (refused when stale —
      //    recordSpreadSample itself refuses degenerate quotes).
      try {
        const q = getQuote(symbol);
        if (!q.isStale) {
          recordSpreadSample(symbol, q.spread, q.mid, nowMs);
          result.sampled += 1;
        }
      } catch {
        // A failed quote read is simply no new sample this tick.
      }

      // 2. Record the ONE channel we can genuinely measure from that history.
      //    An empty/thin history yields the fail-closed penalty 1 from the
      //    SAME pure function the decision path uses — that is a real
      //    measurement of real evidence-thinness, not a placeholder.
      const history = getSpreadRelHistory(symbol, { nowMs });
      const penalty = spreadInstabilityPenalty(history);
      result.observations += 1;
      result.pairsRecorded += recordChannelObservation(
        0,
        symbol,
        "spreadInstability",
        penalty,
        nowMs,
      );
    } catch (err) {
      result.errors += 1;
      logger.warn(
        { symbol, err: err instanceof Error ? err.message : String(err) },
        "uncertainty_coverage_symbol_failed",
      );
    }
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startUncertaintyCoverageWorker(): void {
  if (timer) return;

  if (!uncertaintyCoverageEnabled(process.env["ARX_VOI_COVERAGE_ENABLED"])) {
    logger.warn(
      { flag: "ARX_VOI_COVERAGE_ENABLED" },
      "voi_coverage_DISABLED_by_env — uncertainty-resolution history accumulates only from user-driven AACI decisions; WAIT_FOR_EVIDENCE advisories will stay INSUFFICIENT_HISTORY longer",
    );
    return;
  }

  timer = setInterval(() => {
    if (running) return;
    running = true;
    try {
      const r = runUncertaintyCoveragePass();
      if (r.errors > 0) {
        logger.warn(r, "uncertainty_coverage_pass_errors");
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "uncertainty_coverage_pass_failed",
      );
    } finally {
      running = false;
    }
  }, UNCERTAINTY_COVERAGE_INTERVAL_MS).unref();

  logger.info(
    { intervalMs: UNCERTAINTY_COVERAGE_INTERVAL_MS },
    "uncertainty_coverage_worker_started",
  );
}

export function stopUncertaintyCoverageWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
