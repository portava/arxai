import { resolveSupervisor, type DecisionCandidate } from "@workspace/domain/self-trade";
import { stableStringify } from "@workspace/features/event-chain";
import { createHash } from "node:crypto";
import type { SelfTradeObservationInput } from "./decisionEngine.js";

const base = { version: "ati-demo-fleet-chart-comparison-v1", scope: "OWNER_FLEET_AFTER_SUPERVISION",
  executionAuthority: "NONE" } as const;

function unavailable(reason: string) {
  return { ...base, state: "UNAVAILABLE" as const, reason };
}

// Preserve every field the production supervisor reads or changes. The supervisor
// checks thesis presence only. Keep price levels and account inputs out of the tape.
function supervisorInput(c: DecisionCandidate) {
  return { agentId: c.agentId, agentKey: c.agentKey, symbol: c.symbol, outcome: c.outcome, side: c.side,
    rankScore: c.rankScore, thesis: c.thesis == null ? null : true, ownerAgentKey: c.ownerAgentKey,
    conflictState: c.conflictState, reason: c.reason, plannedAction: c.plannedAction };
}
type Input = ReturnType<typeof supervisorInput>;
type Tape = { candidates: Input[]; replacement: Input };

export function replayAtiDemoFleet(tape: Tape) {
  const { candidates, replacement } = tape;
  const key = (candidate: Input) => JSON.stringify([candidate.agentId, candidate.symbol]);
  const keys = candidates.map(key);
  const index = keys.indexOf(key(replacement));
  if (index < 0 || new Set(keys).size !== keys.length || candidates[index]!.agentKey !== replacement.agentKey) return null;
  const baseline = resolveSupervisor(candidates).candidates;
  const challenger = resolveSupervisor(candidates.map((c, i) => i === index ? replacement : c)).candidates;
  const decision = (c: Input) => ({ agentId: c.agentId, symbol: c.symbol, outcome: c.outcome, reason: c.reason,
    ownerAgentKey: c.ownerAgentKey, conflictState: c.conflictState });
  const changes = baseline.flatMap((row, i) => {
    const before = decision(row), after = decision(challenger[i]!);
    return stableStringify(before) === stableStringify(after) ? [] : [{ before, after }];
  });
  return { baseline: decision(baseline[index]!), challenger: decision(challenger[index]!), changes };
}

export function compareAtiDemoFleet(candidates: DecisionCandidate[], alternate: DecisionCandidate,
  actual: DecisionCandidate[], complete: boolean) {
  if (!complete) return unavailable("INCOMPLETE_OWNER_CYCLE");
  const tape = { candidates: candidates.map(supervisorInput), replacement: supervisorInput(alternate) };
  const replay = replayAtiDemoFleet(tape);
  if (!replay) return unavailable("AMBIGUOUS_CANDIDATE_IDENTITY");
  // The production feed is sorted after supervision. Compare by identity, preserving
  // the original evaluation order in the tape for tie-breaking during replay.
  const sort = (a: Input, b: Input) => a.agentId - b.agentId || a.symbol.localeCompare(b.symbol);
  const expected = resolveSupervisor(tape.candidates).candidates.sort(sort);
  if (stableStringify(expected) !== stableStringify(actual.map(supervisorInput).sort(sort)))
    return unavailable("NATIVE_SUPERVISOR_REPLAY_MISMATCH");
  const tapeHash = createHash("sha256").update(stableStringify(tape)).digest("hex");
  return { ...base, state: "COMPARED" as const, tapeHash, tape, ...replay };
}

export type AtiDemoFleetComparison = ReturnType<typeof compareAtiDemoFleet>;

// Validate the join before the observation and its native decision ID commit together.
export function bindAtiDemoFleet(comparison: AtiDemoFleetComparison | undefined, observation: SelfTradeObservationInput,
  native: DecisionCandidate, cycleStartedAt: number, availableAt: number): AtiDemoFleetComparison {
  const chart = observation.demoChartComparison;
  if (!chart || chart.state !== "MEASURED") return unavailable(chart?.reason ?? "DEMO_CHART_COMPARISON_UNAVAILABLE");
  if (chart.evaluatedAt < cycleStartedAt || chart.evaluatedAt > availableAt ||
      chart.receiptId !== observation.mt5QuoteOrigin?.receiptId || chart.brokerSymbol !== observation.mt5QuoteOrigin.brokerSymbol ||
      chart.sourceIdentity !== observation.input.signal.marketEvidence?.sourceIdentity ||
      chart.tickAt !== observation.boundQuote?.observedAt || chart.bid !== observation.boundQuote.bid || chart.ask !== observation.boundQuote.ask)
    return unavailable("DEMO_CHART_RECEIPT_MISMATCH");
  if (!comparison || comparison.state === "UNAVAILABLE") return comparison ?? unavailable("SUPERVISOR_REPLAY_UNAVAILABLE");
  const { replacement, candidates } = comparison.tape;
  const raw = candidates.find(c => c.agentId === native.agentId && c.symbol === native.symbol);
  if (raw?.outcome !== chart.baseline.outcome || raw.reason !== chart.baseline.reason ||
      replacement.agentId !== native.agentId || replacement.symbol !== native.symbol || replacement.outcome !== chart.challenger.outcome ||
      replacement.reason !== chart.challenger.reason || comparison.baseline.outcome !== native.outcome ||
      comparison.baseline.reason !== native.reason || comparison.baseline.ownerAgentKey !== native.ownerAgentKey ||
      comparison.baseline.conflictState !== native.conflictState) return unavailable("DEMO_CHART_CANDIDATE_MISMATCH");
  return comparison;
}
