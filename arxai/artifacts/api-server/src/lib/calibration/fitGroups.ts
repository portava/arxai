// Fit groups: one strategy's samples → the fits the worker persists. PURE.
//
// Every sample enters three keys: exact symbol × timeframe, pooled symbols per
// timeframe, and pooled all (agents: pooled all only). Within each key the
// live and replay samples are combined by the precedence rule
// (provenance.composeEvidence) and fitted.

import {
  fitCalibration,
  fitKey,
  POOLED,
  type CalibrationFit,
} from "@workspace/domain/calibration";
import { composeEvidence, sourceLabel, type FitProvenance, type TimedSample } from "./provenance.js";

export interface FitGroup {
  fitKey: string;
  source: string;
  strategy: string;
  symbol: string;
  timeframe: string;
  fit: CalibrationFit;
  provenance: FitProvenance;
  dataFrom: Date | null;
  dataTo: Date | null;
}

export function buildFitGroups(strategy: string, samples: readonly TimedSample[], opts: { exact?: boolean } = {}): FitGroup[] {
  const groups = new Map<string, { symbol: string; timeframe: string; rows: TimedSample[] }>();
  const add = (symbol: string, timeframe: string, s: TimedSample) => {
    const k = fitKey(strategy, symbol, timeframe);
    let g = groups.get(k);
    if (!g) {
      g = { symbol, timeframe, rows: [] };
      groups.set(k, g);
    }
    g.rows.push(s);
  };
  for (const s of samples) {
    if (opts.exact !== false) add(s.symbol, s.timeframe, s);
    if (opts.exact !== false) add(POOLED, s.timeframe, s);
    add(POOLED, POOLED, s);
  }
  const out: FitGroup[] = [];
  for (const [key, g] of groups) {
    const { samples: rows, provenance } = composeEvidence(g.rows);
    out.push({
      fitKey: key,
      source: sourceLabel(provenance),
      strategy,
      symbol: g.symbol,
      timeframe: g.timeframe,
      fit: fitCalibration(rows),
      provenance,
      dataFrom: rows[0]?.at ?? null,
      dataTo: rows[rows.length - 1]?.at ?? null,
    });
  }
  return out;
}
