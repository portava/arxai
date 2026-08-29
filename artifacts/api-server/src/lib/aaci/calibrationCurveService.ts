// ── AACI calibration-curve service (capability #2) ──────────────────────────
//
// Assembles REAL resolution records — (stated confidence at decision time,
// realized outcome) — and computes the reliability curve with the pure domain
// engine. The record source is the same real-evidence seam the trust learning
// loop uses: CLOSED self-trade executions with a non-null realizedPnl, joined
// to their originating self_trade_decision for the stated confidence.
//
// HONESTY:
//   * Only CLOSED executions with a real realizedPnl AND a linked decision
//     count — a dispatch is not an outcome, and an execution whose decision
//     (and therefore stated confidence) cannot be located is NOT evidence of
//     anything and is dropped, never back-filled with a default confidence.
//   * Below the domain minimums the curve is an honest INSUFFICIENT_HISTORY.
//   * A failed read degrades to INSUFFICIENT_HISTORY with a typed reason —
//     never a synthesized curve.
//
// ADVISORY / journal-display only. Nothing consumes this as authority.

import { and, eq, isNotNull } from "drizzle-orm";
import {
  db,
  selfTradeAgentExecutionsTable,
  selfTradeDecisionsTable,
} from "@workspace/db";
import {
  computeCalibrationCurve,
  type CalibrationCurve,
  type CalibrationRecord,
  type ComputeCalibrationCurveOptions,
} from "@workspace/domain/aaci";
import { logger } from "../logger.js";

/** Normalise a stored confidence (0..1 OR 0..100 historically) to 0..1. */
export function toConfidence01(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  const v = raw > 1 ? raw / 100 : raw;
  if (v < 0 || v > 1) return null;
  return v;
}

const MAX_RECORDS = 5_000;

/**
 * Read the resolution records backing the calibration curve. Every record is
 * a real (stated confidence, realized P/L sign) pair; unlocatable confidence
 * drops the row.
 */
export async function readCalibrationRecords(): Promise<CalibrationRecord[]> {
  const rows = await db
    .select({
      confidence: selfTradeDecisionsTable.confidence,
      realizedPnl: selfTradeAgentExecutionsTable.realizedPnl,
    })
    .from(selfTradeAgentExecutionsTable)
    .innerJoin(
      selfTradeDecisionsTable,
      eq(selfTradeAgentExecutionsTable.decisionId, selfTradeDecisionsTable.id),
    )
    .where(
      and(
        eq(selfTradeAgentExecutionsTable.status, "CLOSED"),
        isNotNull(selfTradeAgentExecutionsTable.realizedPnl),
      ),
    )
    .limit(MAX_RECORDS);

  const records: CalibrationRecord[] = [];
  for (const row of rows) {
    const conf = toConfidence01(row.confidence);
    if (conf === null) continue; // no stated confidence → not a calibration record
    if (row.realizedPnl == null || !Number.isFinite(row.realizedPnl)) continue;
    records.push({ statedConfidence01: conf, outcomeGood: row.realizedPnl > 0 });
  }
  return records;
}

export interface AaciCalibrationCurveReport {
  curve: CalibrationCurve;
  source: "self_trade_executions_closed";
  /** Set when the read itself failed (curve is then INSUFFICIENT_HISTORY). */
  readError: string | null;
}

/** Compute the live calibration curve. Never throws. */
export async function getAaciCalibrationCurve(
  opts: ComputeCalibrationCurveOptions = {},
): Promise<AaciCalibrationCurveReport> {
  try {
    const records = await readCalibrationRecords();
    return {
      curve: computeCalibrationCurve(records, opts),
      source: "self_trade_executions_closed",
      readError: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "aaci_calibration_curve_read_failed");
    return {
      curve: {
        status: "INSUFFICIENT_HISTORY",
        bins: [],
        samples: 0,
        requiredSamples: 0,
        reason: `resolution records unreadable: ${message}`,
      },
      source: "self_trade_executions_closed",
      readError: message,
    };
  }
}
