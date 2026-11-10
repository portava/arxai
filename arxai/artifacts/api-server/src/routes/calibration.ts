// Calibration — trader-facing reliability + Brier score.
//
// GET /calibration/summary (any signed-in user)
//   The current version of every calibration fit the payloads read from:
//   N, base rate, out-of-sample Brier score of the served probability vs the
//   base-rate forecast and vs the raw heuristic read as a percentage, whether
//   an edge was detected, and the reliability diagram (predicted vs observed,
//   with N per bin). Nothing here is a projection: every number is measured
//   on graded outcomes, or the row says "unmeasured" with its N.
//
// Scope: agent trust fits are governance internals and are not listed here.
// Fits pooled from live-signal outcomes (eleanor / scanner) are listed at the
// pooled-symbol level only, so no single account's outcomes are singled out;
// strategy-replay fits (public price history) are listed per market.

import { Router } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import {
  calibrationCacheEntries,
  calibrationCacheLoadedAt,
  formatCalibrationLabel,
} from "../lib/calibration/cache.js";
import { getCalibrationRefitStatus } from "../lib/calibration/refitWorker.js";
import {
  CALIBRATION_EDGE_MIN_SAMPLE,
  CALIBRATION_METHOD,
  CALIBRATION_MIN_SAMPLE,
  POOLED,
} from "@workspace/domain/calibration";

const router = Router();

export interface CalibrationSummaryRow {
  fitKey: string;
  version: number;
  source: string;
  strategy: string;
  symbol: string;
  timeframe: string;
  status: "measured" | "unmeasured";
  model: string;
  n: number;
  baseRate: number | null;
  brier: number | null;
  brierBaseline: number | null;
  brierRaw: number | null;
  edgeDetected: boolean;
  label: string;
  reliability: { lo: number; hi: number; n: number; meanPredicted: number | null; observedRate: number | null }[];
  rawReliability: { lo: number; hi: number; n: number; meanPredicted: number | null; observedRate: number | null }[];
  fittedAt: string;
}

export function buildCalibrationSummary() {
  const rows: CalibrationSummaryRow[] = [];
  for (const [fitKey, e] of calibrationCacheEntries()) {
    const [strategy, symbol, timeframe] = fitKey.split("|");
    if (strategy.startsWith("agent:")) continue;
    if (e.source !== "strategy_replay" && symbol !== POOLED) continue;
    const f = e.fit;
    rows.push({
      fitKey,
      version: e.version,
      source: e.source,
      strategy,
      symbol,
      timeframe,
      status: f.status,
      model: f.model,
      n: f.n,
      baseRate: f.baseRate,
      brier: f.brier,
      brierBaseline: f.brierBaseline,
      brierRaw: f.brierRaw,
      edgeDetected: f.edgeDetected,
      label: formatCalibrationLabel(f.status === "measured" ? f.baseRate : null, f.n),
      reliability: f.reliability,
      rawReliability: f.rawReliability,
      fittedAt: e.fittedAt,
    });
  }
  rows.sort((a, b) => b.n - a.n || a.fitKey.localeCompare(b.fitKey));
  const refit = getCalibrationRefitStatus();
  return {
    ok: true as const,
    method: CALIBRATION_METHOD,
    minSample: CALIBRATION_MIN_SAMPLE,
    edgeMinSample: CALIBRATION_EDGE_MIN_SAMPLE,
    cacheLoadedAt: calibrationCacheLoadedAt(),
    lastRefitAt: refit.lastCycle?.at ?? null,
    measuredCount: rows.filter((r) => r.status === "measured").length,
    edgeCount: rows.filter((r) => r.edgeDetected).length,
    fits: rows,
  };
}

router.get("/calibration/summary", requireUser, (_req, res) => {
  res.json(buildCalibrationSummary());
});

export { router as calibrationRouter };
