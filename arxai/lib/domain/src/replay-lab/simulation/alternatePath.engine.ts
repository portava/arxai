// ═══════════════════════════════════════════════════════════════════════════
// Alternate Path
//
// Generates a canonical fan of 5 alternate paths for a snapshot:
//   AS_IS, HALF_SIZE, BLOCKED, EXIT_AT_1R, WIDER_STOP_2X
//
// Returns each alternate's outcome and a ranked recommendation. Pure.
// ═══════════════════════════════════════════════════════════════════════════

import type { ReplaySnapshot, TradeOutcome, WhatIfScenario } from "../replay.types";
import { runWhatIf } from "../whatIfEngine";
import { playbackCandles } from "../candlePlayback.engine";

export interface AlternatePathReport {
  snapshotId: string;
  paths: Array<{
    name: "AS_IS" | "HALF_SIZE" | "BLOCKED" | "EXIT_AT_1R" | "WIDER_STOP_2X";
    outcome: TradeOutcome;
    rMultiple: number;
    rDeltaVsAsIs: number;
  }>;
  bestPathName: string;
  worstPathName: string;
  asIsRank: number; // 1 = best
}

const NO_TRADE: TradeOutcome = {
  status: "NONE", exitTs: null, exitPrice: null, pnl: 0, rMultiple: 0,
  durationMin: 0, reason: "alternate-path: blocked",
};

export function exploreAlternatePaths(snapshot: ReplaySnapshot): AlternatePathReport {
  const intent = snapshot.intent;

  const asIs: TradeOutcome = intent
    ? playbackCandles({ candles: snapshot.candles, intent })
    : NO_TRADE;

  const half = intent
    ? runWhatIf(snapshot, { kind: "REDUCED_SIZE", sizeFactor: 0.5 } as WhatIfScenario).counterfactualOutcome
    : NO_TRADE;

  const blocked = NO_TRADE;

  const exit1R = intent
    ? runWhatIf(snapshot, { kind: "EXIT_EARLIER", atRMultiple: 1 } as WhatIfScenario).counterfactualOutcome
    : NO_TRADE;

  const widerStop = intent
    ? (() => {
        const dist = Math.abs(intent.entryPrice - intent.stopLoss);
        const newStop = intent.direction === "BUY"
          ? intent.entryPrice - dist * 2
          : intent.entryPrice + dist * 2;
        return runWhatIf(snapshot, { kind: "DIFFERENT_STOP", stopPrice: newStop } as WhatIfScenario)
                 .counterfactualOutcome;
      })()
    : NO_TRADE;

  const raw = [
    { name: "AS_IS"          as const, outcome: asIs },
    { name: "HALF_SIZE"      as const, outcome: half },
    { name: "BLOCKED"        as const, outcome: blocked },
    { name: "EXIT_AT_1R"     as const, outcome: exit1R },
    { name: "WIDER_STOP_2X"  as const, outcome: widerStop },
  ];

  const paths = raw.map(p => ({
    name: p.name,
    outcome: p.outcome,
    rMultiple: round2(p.outcome.rMultiple),
    rDeltaVsAsIs: round2(p.outcome.rMultiple - asIs.rMultiple),
  }));

  const sorted = [...paths].sort((a, b) => b.rMultiple - a.rMultiple);
  const asIsRank = sorted.findIndex(p => p.name === "AS_IS") + 1;
  return {
    snapshotId: snapshot.snapshotId, paths,
    bestPathName: sorted[0].name,
    worstPathName: sorted[sorted.length - 1].name,
    asIsRank,
  };
}
function round2(n: number) { return Math.round(n * 100) / 100; }
