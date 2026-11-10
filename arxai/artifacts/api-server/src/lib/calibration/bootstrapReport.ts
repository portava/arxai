// What the historical bootstrap measures, per strategy and per agent. No DB.
//
// Fits every replayed strategy and agent at its pooled key (strategy|*|*) the
// same way the refit worker does (composeEvidence → fitCalibration) and
// reports N, base rate, served model, edge detected, and for agents the
// measured influence. Used by the bootstrap script and the CI tests, so the
// numbers in a report are the numbers the worker persists.

import {
  agentTrustFromFit,
  CALIBRATION_MIN_SAMPLE,
  fitCalibration,
  type CalibrationFit,
} from "@workspace/domain/calibration";
import { CORE_AGENTS } from "@workspace/domain/agent-system";
import { agentCalibrationKey, strategyCalibrationKey } from "./cache.js";
import { composeEvidence, type FitProvenance, type TimedSample } from "./provenance.js";
import { REPLAYABLE_STRATEGIES } from "./strategyReplay.js";
import { agentNoReplayReason } from "./agentReplaySpecs.js";
import type { ReplayEvidence } from "./historicalBootstrap.js";

export interface StrategyReportRow {
  strategy: string;
  key: string;
  n: number;
  status: CalibrationFit["status"];
  baseRate: number | null;
  model: CalibrationFit["model"];
  edgeDetected: boolean;
  improvementLower95: number | null;
  /** Per timeframe N (pooled symbols). */
  byTimeframe: Record<string, number>;
  note: string | null;
  provenance: FitProvenance;
}

export interface AgentReportRow {
  agentKey: string;
  n: number;
  status: CalibrationFit["status"];
  baseRate: number | null;
  edgeDetected: boolean;
  influence: number;
  basis: string;
}

const round = (x: number | null, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

export function strategyReport(ev: ReplayEvidence): StrategyReportRow[] {
  return REPLAYABLE_STRATEGIES.map(({ name }) => {
    const key = strategyCalibrationKey(name);
    const samples: TimedSample[] = ev.strategies.get(key) ?? [];
    const { samples: rows, provenance } = composeEvidence(samples);
    const fit = fitCalibration(rows);
    const byTimeframe: Record<string, number> = {};
    for (const s of rows) byTimeframe[s.timeframe] = (byTimeframe[s.timeframe] ?? 0) + 1;
    let note: string | null = null;
    if (fit.n < CALIBRATION_MIN_SAMPLE) {
      note = name === "Session Breakout" && Object.keys(byTimeframe).every((tf) => tf === "D1" || tf === "W1")
        ? "fires only in the London / London-NY sessions of the signal bar; a daily bar opens 00:00 UTC (Asia), so daily history cannot trigger it"
        : `fired ${fit.n} time(s) on the replayed history; below the ${CALIBRATION_MIN_SAMPLE} needed to measure`;
    }
    return {
      strategy: name,
      key,
      n: fit.n,
      status: fit.status,
      baseRate: round(fit.baseRate),
      model: fit.model,
      edgeDetected: fit.edgeDetected,
      improvementLower95: fit.cv ? round(fit.cv.improvementLower95, 6) : null,
      byTimeframe,
      note,
      provenance,
    };
  });
}

export function agentReport(ev: ReplayEvidence): AgentReportRow[] {
  return CORE_AGENTS.map(({ agentKey }) => {
    const samples = ev.agents.get(agentCalibrationKey(agentKey)) ?? [];
    const { samples: rows } = composeEvidence(samples);
    const fit = rows.length ? fitCalibration(rows) : null;
    const t = agentTrustFromFit(agentKey, fit, agentNoReplayReason(agentKey));
    return {
      agentKey,
      n: t.n,
      status: t.status,
      baseRate: round(t.fit.baseRate),
      edgeDetected: t.fit.edgeDetected,
      influence: t.influence,
      basis: t.basis,
    };
  });
}

export function formatReport(strategies: StrategyReportRow[], agents: AgentReportRow[]): string {
  const lines: string[] = [];
  lines.push("strategy | N | base rate | model | edge detected | note");
  for (const r of strategies) {
    lines.push(`${r.strategy} | ${r.n} | ${r.baseRate ?? "-"} | ${r.model} | ${r.edgeDetected ? "yes" : "no"} | ${r.note ?? ""}`);
  }
  lines.push("");
  lines.push("agent | N | base rate | edge detected | influence | basis");
  for (const a of agents) {
    lines.push(`${a.agentKey} | ${a.n} | ${a.baseRate ?? "-"} | ${a.edgeDetected ? "yes" : "no"} | ${a.influence} | ${a.basis}`);
  }
  return lines.join("\n");
}
