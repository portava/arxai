// ── Change-point driver — statistical structural-break watchdog (worker) ─────
//
// WHY: the platform's quarantine/response machinery (strategyQuarantine,
// continuous validation) reacts to threshold breaches — a process CHANGE was
// mostly revealed only after degradation. This worker runs REAL change-point
// statistics (CUSUM + Page–Hinkley, @workspace/domain/change-point) over
// series the system already produces:
//
//   * per-strategy/entity outcome series — the reward stream of reconciled
//     learning outcomes in aaci_learning_audit (real evidence, append-only);
//   * spread/cost series — the rolling relative-spread observations recorded
//     by the AACI quote path + this worker's own sampling pass.
//
// ON DETECTION it (1) journals an audit event with the full detection numbers
// and (2) feeds the EXISTING strategyQuarantine engine: the detection counts
// as a moderate concern, and the engine's verdict (SHADOW/RESTRICTED — an
// authority REDUCTION) is journaled with its permissions.
//
// SAFETY (inviolable):
//   * NO execution path. This worker never places, modifies, or approves
//     anything; it only reads, computes, and journals.
//   * Automatic authority changes may only REDUCE: the quarantine feed passes
//     recoveryEvidenceScore01 = 0 ALWAYS, so the engine can only WORSEN or
//     HOLD — recovery/promotion stays with the owner-gated machinery.
//   * FAIL SAFE: per-series try/catch; an unreadable series is skipped with an
//     honest log — never synthesized. A crash skips the pass; nothing is left
//     half-applied (journal rows are per-detection and idempotent-by-change).
//   * Opt-out via ARX_CHANGEPOINT_DRIVER_ENABLED (default enabled); disabling
//     is logged loudly.

import { and, asc, eq, gte } from "drizzle-orm";
import { db, aaciTrustScoresTable, aaciLearningAuditTable } from "@workspace/db";
import {
  detectSeriesBreak,
  type SeriesBreakResult,
} from "@workspace/domain/change-point";
import type {
  QuarantineState,
  StrategyQuarantineResult,
} from "@workspace/domain/continuous-validation";
import {
  changePointDriverEnabled,
  changePointSymbols,
  planQuarantineFeed,
} from "./changePointDriverPolicy.js";
import { logger } from "./logger.js";
import { shadowCaptureFAF } from "./auditVault.js";
import { getQuote } from "./marketDataLayer.js";
import {
  recordSpreadSample,
  getSpreadRelHistory,
  spreadHistorySymbols,
} from "./aaci/spreadHistoryRecorder.js";

/** Tick cadence — statistics over slow-moving series; 5 min is plenty. */
export const CHANGEPOINT_DRIVER_INTERVAL_MS = 5 * 60 * 1000;

/** Outcome series need the detectors' 100-sample estimated baseline plus a
 *  post-baseline window before they can say anything (honest silence below). */
const MIN_OUTCOME_EVIDENCE = 105;
const MAX_OUTCOME_ENTITIES_PER_PASS = 40;
const MAX_OUTCOME_SERIES_LEN = 200;
/** Spread series minimum before the detectors run (baseline 100 + post 5). */
const MIN_SPREAD_SAMPLES = 105;

export { changePointDriverEnabled, changePointSymbols, planQuarantineFeed };

export interface SeriesEvaluation {
  seriesKey: string;
  kind: "OUTCOME" | "SPREAD";
  points: number;
  result: SeriesBreakResult | null;
  newDetection: boolean;
  quarantine: StrategyQuarantineResult | null;
  error: string | null;
}

export interface ChangePointPassResult {
  evaluated: number;
  detections: number;
  evaluations: SeriesEvaluation[];
}

// Change-only memory: seriesKey → last journaled alarm signature (so a
// standing alarm on the same window never spams the journal every pass).
const lastAlarmSignature = new Map<string, string>();
// In-memory quarantine ledger per series (worsen/hold only; journaled).
const quarantineState = new Map<string, { state: QuarantineState; detections: number }>();

function alarmSignature(r: SeriesBreakResult, points: number): string {
  const c = r.cusum;
  const p = r.pageHinkley;
  return `${c.alarm}:${c.alarmIndex}:${p.alarm}:${p.alarmIndex}:${points}`;
}

async function readOutcomeSeries(entityType: string, entityKey: string, userId: number): Promise<number[]> {
  const rows = await db
    .select({ newValue: aaciLearningAuditTable.newValue })
    .from(aaciLearningAuditTable)
    .where(
      and(
        eq(aaciLearningAuditTable.entityType, entityType),
        eq(aaciLearningAuditTable.entityKey, entityKey),
        eq(aaciLearningAuditTable.userId, userId),
        eq(aaciLearningAuditTable.changeType, "TRUST_UPDATE"),
      ),
    )
    .orderBy(asc(aaciLearningAuditTable.id))
    .limit(MAX_OUTCOME_SERIES_LEN);
  const series: number[] = [];
  for (const r of rows) {
    const rewarded = (r.newValue as { rewarded?: unknown } | null)?.rewarded;
    if (typeof rewarded === "boolean") series.push(rewarded ? 1 : 0);
  }
  return series;
}

function journalDetection(
  ev: SeriesEvaluation,
  result: SeriesBreakResult,
): void {
  shadowCaptureFAF({
    source: "CHANGE_POINT_DRIVER",
    systemMode: null,
    globalState: null,
    eventType: "CHANGE_POINT_DETECTED",
    severity: "WARN",
    payload: {
      seriesKey: ev.seriesKey,
      kind: ev.kind,
      points: ev.points,
      cusum: result.cusum,
      pageHinkley: result.pageHinkley,
    },
  });
}

function journalQuarantine(ev: SeriesEvaluation, q: StrategyQuarantineResult): void {
  shadowCaptureFAF({
    source: "CHANGE_POINT_DRIVER",
    systemMode: null,
    globalState: null,
    eventType: "CHANGE_POINT_QUARANTINE",
    severity: q.direction === "WORSEN" ? "DANGER" : "WARN",
    payload: {
      seriesKey: ev.seriesKey,
      kind: ev.kind,
      previousState: q.previousState,
      nextState: q.nextState,
      direction: q.direction,
      reasons: q.reasons,
      permissions: q.permissions,
      note: "Automatic feed: authority can only be reduced or held; recovery stays owner-gated.",
    },
  });
}

function evaluateSeries(
  seriesKey: string,
  kind: SeriesEvaluation["kind"],
  series: number[],
  trustScore01: number,
): SeriesEvaluation {
  const ev: SeriesEvaluation = {
    seriesKey,
    kind,
    points: series.length,
    result: null,
    newDetection: false,
    quarantine: null,
    error: null,
  };
  const result = detectSeriesBreak(series);
  ev.result = result;
  if (!result.anyAlarm) return ev;

  const signature = alarmSignature(result, series.length);
  if (lastAlarmSignature.get(seriesKey) === signature) return ev; // already journaled
  lastAlarmSignature.set(seriesKey, signature);
  ev.newDetection = true;
  journalDetection(ev, result);

  // Feed the EXISTING quarantine engine (authority reduction only).
  const ledger = quarantineState.get(seriesKey) ?? { state: "NONE" as QuarantineState, detections: 0 };
  ledger.detections += 1;
  const q = planQuarantineFeed({
    seriesKey,
    currentState: ledger.state,
    trustScore01,
    detectionCount: ledger.detections,
  });
  ledger.state = q.nextState;
  quarantineState.set(seriesKey, ledger);
  ev.quarantine = q;
  if (q.direction === "WORSEN") journalQuarantine(ev, q);
  return ev;
}

/** One full driver pass. Fail-soft per series. */
export async function runChangePointPass(
  opts: { nowMs?: number; symbols?: string[] } = {},
): Promise<ChangePointPassResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const evaluations: SeriesEvaluation[] = [];

  // 1. Sample quotes → feed the spread recorder (bad quotes are refused).
  const symbols = opts.symbols ?? changePointSymbols(process.env["ARX_CHANGEPOINT_SYMBOLS"]);
  for (const symbol of symbols) {
    try {
      const q = getQuote(symbol);
      if (!q.isStale) recordSpreadSample(symbol, q.spread, q.mid, nowMs);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), symbol },
        "change_point_driver quote sample failed (symbol skipped, honest gap)",
      );
    }
  }

  // 2. Spread series per symbol with enough fresh samples.
  for (const symbol of spreadHistorySymbols()) {
    const key = `spread:${symbol}`;
    try {
      const history = getSpreadRelHistory(symbol, { minSamples: MIN_SPREAD_SAMPLES, nowMs });
      if (!history) continue; // honest: not enough evidence to test
      evaluations.push(evaluateSeries(key, "SPREAD", history, 0.5));
    } catch (err) {
      evaluations.push({
        seriesKey: key, kind: "SPREAD", points: 0, result: null,
        newDetection: false, quarantine: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Per-entity outcome series from the append-only learning audit.
  try {
    const entities = await db
      .select({
        entityType: aaciTrustScoresTable.entityType,
        entityKey: aaciTrustScoresTable.entityKey,
        userId: aaciTrustScoresTable.userId,
        alpha: aaciTrustScoresTable.alpha,
        beta: aaciTrustScoresTable.beta,
      })
      .from(aaciTrustScoresTable)
      .where(gte(aaciTrustScoresTable.evidenceCount, MIN_OUTCOME_EVIDENCE))
      .limit(MAX_OUTCOME_ENTITIES_PER_PASS);
    for (const e of entities) {
      const key = `outcome:${e.entityType}:${e.entityKey}:${e.userId}`;
      try {
        const series = await readOutcomeSeries(e.entityType, e.entityKey, e.userId);
        const trustMean =
          e.alpha + e.beta > 0 ? e.alpha / (e.alpha + e.beta) : 0.5;
        evaluations.push(evaluateSeries(key, "OUTCOME", series, trustMean));
      } catch (err) {
        evaluations.push({
          seriesKey: key, kind: "OUTCOME", points: 0, result: null,
          newDetection: false, quarantine: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    // Store unreachable → honest empty pass for outcomes; spreads already ran.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "change_point_driver could not read trust entities (outcome series skipped this pass)",
    );
  }

  return {
    evaluated: evaluations.length,
    detections: evaluations.filter((e) => e.newDetection).length,
    evaluations,
  };
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startChangePointDriverWorker(): void {
  if (timer) return;

  if (!changePointDriverEnabled(process.env["ARX_CHANGEPOINT_DRIVER_ENABLED"])) {
    logger.warn(
      { flag: "ARX_CHANGEPOINT_DRIVER_ENABLED" },
      "change_point_driver_DISABLED_by_env — structural breaks in outcome/spread series will NOT be detected statistically; only threshold-based health checks remain",
    );
    return;
  }

  timer = setInterval(() => {
    if (running) return; // non-overlapping pass
    running = true;
    runChangePointPass()
      .then((r) => {
        if (r.detections > 0) {
          logger.warn(
            { evaluated: r.evaluated, detections: r.detections },
            "change_point_driver_pass detected structural break(s) — journaled + quarantine feed applied",
          );
        }
      })
      .catch((err) =>
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "change_point_driver_pass_failed (fail-safe: nothing applied)",
        ),
      )
      .finally(() => {
        running = false;
      });
  }, CHANGEPOINT_DRIVER_INTERVAL_MS).unref();

  logger.info({ intervalMs: CHANGEPOINT_DRIVER_INTERVAL_MS }, "change_point_driver_started");
}

export function stopChangePointDriverWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Tests only. */
export function resetChangePointDriverState(): void {
  lastAlarmSignature.clear();
  quarantineState.clear();
}
