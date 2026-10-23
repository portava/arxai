// ═══════════════════════════════════════════════════════════════════════════
// Decision Tree Replay
//
// Branches a single snapshot into N alternate decision paths and replays
// each path. Each branch is a named sequence of what-if mutations applied
// in order. Returns the original outcome plus a tree of alternate outcomes
// with R-deltas vs the original.
//
// Pure. Replay Lab cannot place trades.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { ReplaySnapshot, TradeOutcome, WhatIfScenario } from "../replay.types";
import { WhatIfScenarioSchema } from "../replay.types";
import { runWhatIf } from "../whatIfEngine";
import { playbackCandles } from "../candlePlayback.engine";

export const DecisionBranchSchema = z.object({
  name: z.string().min(1),
  mutations: z.array(WhatIfScenarioSchema).min(1),
}).strict();
export type DecisionBranch = z.infer<typeof DecisionBranchSchema>;

export const DecisionBranchOutcomeSchema = z.object({
  name: z.string(),
  finalOutcome: z.unknown(), // TradeOutcome
  rDelta: z.number(),
  rankByR: z.number().int(),
  notes: z.array(z.string()),
});

export interface DecisionTreeResult {
  rootSnapshotId: string;
  originalOutcome: TradeOutcome;
  branches: Array<{
    name: string;
    finalOutcome: TradeOutcome;
    rDelta: number;
    rankByR: number;
    notes: string[];
  }>;
  bestBranchName: string;
  worstBranchName: string;
}

const NO_TRADE: TradeOutcome = {
  status: "NONE", exitTs: null, exitPrice: null, pnl: 0, rMultiple: 0,
  durationMin: 0, reason: "decision-tree: no trade taken",
};

export function exploreDecisionTree(
  snapshot: ReplaySnapshot, branches: DecisionBranch[],
): DecisionTreeResult {
  const original = baselineOutcome(snapshot);

  const evaluated = branches.map(branch => {
    // Apply mutations sequentially; each mutation is run against the
    // *current* snapshot/intent. Some mutations (BLOCKED_INSTEAD,
    // TAKE_BLOCKED_INSTEAD) are terminal for the path.
    let workingSnapshot = snapshot;
    let last: TradeOutcome = original;
    const notes: string[] = [];

    for (const mut of branch.mutations) {
      const r = runWhatIf(workingSnapshot, mut);
      last = r.counterfactualOutcome;
      notes.push(...r.notes);
      // Persist mutation state into snapshot for the next step
      workingSnapshot = applyMutationToSnapshot(workingSnapshot, mut);
      // BLOCKED_INSTEAD / TAKE_BLOCKED_INSTEAD are terminal for the path:
      // once the trade is blocked (or the previously-blocked trade is taken
      // and resolved), no subsequent mutation can re-mutate that decision.
      if (mut.kind === "BLOCKED_INSTEAD" || mut.kind === "TAKE_BLOCKED_INSTEAD") {
        notes.push(`branch terminated at ${mut.kind}`);
        break;
      }
    }

    return {
      name: branch.name, finalOutcome: last,
      rDelta: round2(last.rMultiple - original.rMultiple),
      notes,
    };
  });

  // Rank by R (descending = best first)
  const byR = [...evaluated].sort((a, b) => b.finalOutcome.rMultiple - a.finalOutcome.rMultiple);
  const ranked = evaluated.map(b => ({
    ...b, rankByR: byR.findIndex(x => x.name === b.name) + 1,
  }));
  const best  = byR[0]?.name ?? "";
  const worst = byR[byR.length - 1]?.name ?? "";

  return {
    rootSnapshotId: snapshot.snapshotId,
    originalOutcome: original,
    branches: ranked,
    bestBranchName: best,
    worstBranchName: worst,
  };
}

function baselineOutcome(snapshot: ReplaySnapshot): TradeOutcome {
  if (snapshot.recordedOutcome && snapshot.recordedOutcome.status !== "NONE") {
    return snapshot.recordedOutcome;
  }
  if (snapshot.intent && (snapshot.decisionKind === "EXECUTED" || snapshot.decisionKind === "OVERRIDE")) {
    return playbackCandles({ candles: snapshot.candles, intent: snapshot.intent });
  }
  return NO_TRADE;
}

/** Persist a mutation into the snapshot so subsequent mutations stack. */
function applyMutationToSnapshot(snapshot: ReplaySnapshot, mut: WhatIfScenario): ReplaySnapshot {
  if (!snapshot.intent) return snapshot;
  switch (mut.kind) {
    case "REDUCED_SIZE":
      return { ...snapshot, intent: { ...snapshot.intent, lotSize: snapshot.intent.lotSize * mut.sizeFactor } };
    case "DIFFERENT_STOP":
      return { ...snapshot, intent: { ...snapshot.intent, stopLoss: mut.stopPrice } };
    case "DIFFERENT_TP":
      return { ...snapshot, intent: { ...snapshot.intent, takeProfit: mut.takeProfitPrice } };
    case "ENTER_EARLIER":
    case "ENTER_LATER":
    case "INCREASED_DELAY": {
      const ms = ("deltaSeconds" in mut ? mut.deltaSeconds
              : "delaySeconds" in mut ? mut.delaySeconds : 0) * 1000;
      const sign = mut.kind === "ENTER_EARLIER" ? -1 : 1;
      return { ...snapshot, intent: { ...snapshot.intent,
        intendedAt: new Date(new Date(snapshot.intent.intendedAt).getTime() + sign * ms).toISOString() } };
    }
    default:
      return snapshot;
  }
}
function round2(n: number) { return Math.round(n * 100) / 100; }
