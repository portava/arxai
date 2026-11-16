// Which agents have a replayable market read, and why the others do not. PURE.
//
// Imported by agentReplay (the replay itself) and by advisoryInfluence (the
// "no replayable record" basis an agent without a graded record reports), so
// it carries no runtime imports of either.

import { CORE_AGENTS } from "@workspace/domain/agent-system";

export type AgentReplaySpec =
  | { replayable: true; reads: string; department: string }
  | { replayable: false; reason: string };

const OPS_REASON = "operations agent: it governs the agent ecosystem and makes no market call, so there is no prediction to grade";

/**
 * Every core agent, replayable or not. Replayable agents are the scanner
 * departments whose strength is computed from closed bars only.
 */
export const AGENT_REPLAY_SPECS: Readonly<Record<string, AgentReplaySpec>> = Object.freeze({
  STRUCT: { replayable: true, department: "MARKET_STRUCTURE", reads: "scanner trend alignment (+ S/R quality, pinned 0)" },
  PRECISION: { replayable: true, department: "ENTRY", reads: "scanner entry-timing factor" },
  RISK: { replayable: true, department: "RISK", reads: "1 - scanner riskScore" },
  SCANNER_AI: { replayable: true, department: "SCANNER", reads: "scanner opportunity score" },
  EXEC: {
    replayable: false,
    reason: "reads the live quote spread against the stop; real-history bars carry no spread, so a replay would only grade the neutral constant",
  },
  SCALP_AI: {
    replayable: false,
    reason: "reads the scalp engine's quality score, which needs the broker's live symbol spec (spread points, stops level) and quote timing that OHLC history does not carry",
  },
  ELEANOR: {
    replayable: false,
    reason: "a language-model desk read, not a deterministic function of market data",
  },
  EXIT_TP_AI: { replayable: false, reason: "makes no pre-trade call on any advisory surface (no alignment mapping), so there is nothing to replay" },
  TRADE_REVIEW_AI: { replayable: false, reason: "reviews decisions after the fact and makes no forecast, so there is nothing to replay" },
  TRAFFIC_CONTROLLER: { replayable: false, reason: OPS_REASON },
  IMMUNE_SYSTEM: { replayable: false, reason: OPS_REASON },
  LEARNING_CAMP: { replayable: false, reason: OPS_REASON },
  AGENT_FACTORY: { replayable: false, reason: OPS_REASON },
  PROMOTION_BOARD: { replayable: false, reason: OPS_REASON },
});

/** Why an agent has no replayed record, or null when it is replayable. */
export function agentNoReplayReason(agentKey: string): string | null {
  const spec = AGENT_REPLAY_SPECS[agentKey];
  if (!spec) return "not a core agent with a known market read; no replay rule is defined for it";
  return spec.replayable ? null : spec.reason;
}

export const REPLAYABLE_AGENT_KEYS: readonly string[] = CORE_AGENTS
  .map((a) => a.agentKey)
  .filter((k) => AGENT_REPLAY_SPECS[k]?.replayable === true);

