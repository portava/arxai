// Market memory — the PURE "what changed since last read" diff. The per-user
// persistence (load previous / store current) lives in the api-server service;
// this module only compares two snapshots and never touches IO.
//
// HONEST: on the first read for a user+symbol+timeframe there is no previous
// snapshot, so hasPrevious=false and changes is empty — never a fabricated
// transition.

import type {
  ConfidenceBand,
  PreviousSignalSnapshot,
  SignalChange,
  WhatChanged,
} from "./signalIntelligence.types.js";

const BAND_ORDER: ConfidenceBand[] = [
  "NONE",
  "LOW",
  "MODEST",
  "FAIR",
  "STRONG",
  "VERY_STRONG",
];

function bandRank(b: ConfidenceBand): number {
  const i = BAND_ORDER.indexOf(b);
  return i < 0 ? 0 : i;
}

export interface CurrentSnapshot {
  bias: PreviousSignalSnapshot["bias"];
  direction: PreviousSignalSnapshot["direction"];
  regime: PreviousSignalSnapshot["regime"];
  lifecycleStage: PreviousSignalSnapshot["lifecycleStage"];
  confidenceBand: ConfidenceBand;
  edgeScore: number;
  overallScore: number;
}

export function diffSignal(
  previous: PreviousSignalSnapshot | null,
  current: CurrentSnapshot,
): WhatChanged {
  if (!previous) {
    return {
      hasPrevious: false,
      changes: [],
      summary: "First read for this symbol/timeframe.",
    };
  }

  const changes: SignalChange[] = [];

  if (previous.bias !== current.bias) {
    changes.push({ field: "bias", from: previous.bias, to: current.bias });
  }
  if (previous.direction !== current.direction) {
    changes.push({ field: "direction", from: previous.direction, to: current.direction });
  }
  if (previous.regime !== current.regime) {
    changes.push({ field: "regime", from: previous.regime, to: current.regime });
  }
  if (previous.lifecycleStage !== current.lifecycleStage) {
    changes.push({ field: "lifecycleStage", from: previous.lifecycleStage, to: current.lifecycleStage });
  }
  if (previous.confidenceBand !== current.confidenceBand) {
    const dir = bandRank(current.confidenceBand) > bandRank(previous.confidenceBand) ? "up" : "down";
    changes.push({
      field: `confidence (${dir})`,
      from: previous.confidenceBand,
      to: current.confidenceBand,
    });
  }
  // Edge moves are reported only when they are meaningful (≥10 points).
  if (Math.abs(current.edgeScore - previous.edgeScore) >= 10) {
    changes.push({
      field: "edge",
      from: String(Math.round(previous.edgeScore)),
      to: String(Math.round(current.edgeScore)),
    });
  }

  let summary: string;
  if (changes.length === 0) {
    summary = "No meaningful change since the last read.";
  } else {
    const stageChange = changes.find((c) => c.field === "lifecycleStage");
    if (stageChange) {
      summary = `Stage moved ${stageChange.from} → ${stageChange.to}.`;
    } else {
      summary = `${changes.length} change${changes.length === 1 ? "" : "s"} since last read.`;
    }
  }

  return { hasPrevious: true, changes, summary };
}
