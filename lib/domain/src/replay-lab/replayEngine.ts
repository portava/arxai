// ═══════════════════════════════════════════════════════════════════════════
// Replay Engine — orchestrator
//
// Runs the full replay pipeline for a snapshot:
//   market view → candle playback → agent replay → judge replay →
//   execution replay → trader DNA replay → global state replay → scoring
//   → lesson generation.
//
// Pure. Replay Lab cannot place trades. The "outcome" is either the
// recorded outcome (preferred for fidelity) or a freshly simulated one.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { ReplaySnapshot, ReplayResult, TradeOutcome } from "./replay.types";
import { ReplayResultSchema } from "./replay.types";
import { playbackCandles } from "./candlePlayback.engine";
import { replayMarketSnapshot, type MarketReplayView } from "./marketSnapshotReplay.engine";
import { replayAgents, type AgentReplayReport } from "./agentReplay.engine";
import { replayJudge, type JudgeReplayReport } from "./judgeReplay.engine";
import { replayExecution, type ExecutionReplayReport } from "./executionReplay.engine";
import { replayTraderDNA, type TraderDNAReplayReport } from "./traderDNAReplay.engine";
import { replayGlobalState, type GlobalStateReplayReport } from "./globalStateReplay.engine";
import { scoreReplay } from "./replayScoring.engine";
import { generateLessons } from "./lessonGenerator.engine";
import { replayBlockedTrade } from "./blockedTradeReplay.engine";
import { replayMissedTrade } from "./missedTradeReplay.engine";
import { replayOverride, type OverrideReplayResult } from "./overrideReplay.engine";
import { runWhatIf, type WhatIfResult } from "./whatIfEngine";
import { WhatIfScenarioSchema, type WhatIfScenario } from "./replay.types";

const NO_TRADE: TradeOutcome = {
  status: "NONE", exitTs: null, exitPrice: null,
  pnl: 0, rMultiple: 0, durationMin: 0, reason: "no trade simulated",
};

export interface FullReplayReport {
  result: ReplayResult;
  market: MarketReplayView;
  agent: AgentReplayReport;
  judge: JudgeReplayReport;
  execution: ExecutionReplayReport;
  dna: TraderDNAReplayReport;
  global: GlobalStateReplayReport;
  override: OverrideReplayResult | null;
  blocked: ReturnType<typeof replayBlockedTrade> | null;
  missed:  ReturnType<typeof replayMissedTrade>  | null;
  whatIfs: WhatIfResult[];
  lessons: ReturnType<typeof generateLessons>;
}

export interface RunReplayInput {
  snapshot: ReplaySnapshot;
  whatIfs?: WhatIfScenario[];
}

export function runReplay(input: RunReplayInput): FullReplayReport {
  const snapshot = input.snapshot;

  // 1. Market view
  const market = replayMarketSnapshot(snapshot.market, snapshot.candles);

  // 2. Outcome — use recorded outcome when present, else simulate
  let outcome: TradeOutcome;
  if (snapshot.recordedOutcome && snapshot.recordedOutcome.status !== "NONE") {
    outcome = snapshot.recordedOutcome;
  } else if (snapshot.intent && (snapshot.decisionKind === "EXECUTED" || snapshot.decisionKind === "OVERRIDE")) {
    outcome = playbackCandles({ candles: snapshot.candles, intent: snapshot.intent });
  } else {
    outcome = NO_TRADE;
  }

  // 3-6. Sub-reports
  const directionForAgents: "BUY"|"SELL"|"NONE" =
    outcome.status === "CLOSED_WIN" || outcome.status === "TARGET_HIT"
      ? (snapshot.intent?.direction ?? "NONE")
      : outcome.status === "CLOSED_LOSS" || outcome.status === "STOPPED_OUT"
      ? (snapshot.intent?.direction === "BUY" ? "SELL" : snapshot.intent?.direction === "SELL" ? "BUY" : "NONE")
      : "NONE";
  const agent     = replayAgents(snapshot.agentVotes, directionForAgents);
  const judge     = replayJudge(snapshot.judgeVerdict, outcome);
  const execution = replayExecution(snapshot.execution, snapshot.intent);
  const dna       = replayTraderDNA(snapshot);
  const global    = replayGlobalState(snapshot);

  // 7. Decision-kind specific replays
  const blocked  = snapshot.decisionKind === "BLOCKED"  ? replayBlockedTrade(snapshot) : null;
  const missed   = snapshot.decisionKind === "MISSED"   ? replayMissedTrade(snapshot)  : null;
  const override = snapshot.decisionKind === "OVERRIDE" ? replayOverride(snapshot)     : null;

  // 8. Scoring
  const scores = scoreReplay({ snapshot, outcome, agent, judge, execution, dna });

  const result: ReplayResult = ReplayResultSchema.parse({
    snapshotId: snapshot.snapshotId,
    simulatedOutcome: outcome,
    scores,
    notes: [
      ...market.notes,
      ...(global.consistent ? [] : global.inconsistencies),
    ],
  });

  // 9. What-ifs
  const whatIfs: WhatIfResult[] = (input.whatIfs ?? []).map(s =>
    runWhatIf(snapshot, WhatIfScenarioSchema.parse(s)));

  // 10. Lessons
  const lessons = generateLessons({
    snapshot, result, outcome, agent, judge, execution, dna, override: override ?? null,
  });

  return { result, market, agent, judge, execution, dna, global, override, blocked, missed, whatIfs, lessons };
}

export const RunReplayInputSchema = z.object({
  snapshot: z.unknown(),       // validated by caller against ReplaySnapshotSchema
  whatIfs: z.array(WhatIfScenarioSchema).optional(),
});
