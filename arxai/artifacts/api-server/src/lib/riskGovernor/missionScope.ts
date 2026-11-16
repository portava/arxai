// Risk Governor — mission-scope rules (Profit Missions).
//
// A Profit Mission adds limits of its own on top of the trader's: its loss
// ladder, blow-up protection, behavioural cooldown, emergency stop and risk
// budget. Those are strategy-scope limits, so they belong to the Risk
// Governor: this file evaluates them (pure composition in
// @workspace/domain/profit-mission) and writes every block to the trader's
// user_risk_events trail like any other governor decision. The mission
// service (lib/missionRiskState.ts) only supplies the state.
//
// Stricter-only: the order still faces the full pre-trade Risk Governor in
// the live pipeline afterwards; a mission can only add a refusal.

import { composeMissionGate, type MissionGateResult } from "@workspace/domain/profit-mission";
import type { MissionRiskState } from "../missionRiskState.js";
import { logRiskEvent } from "./riskEvents.js";

export async function enforceMissionScope(args: {
  userId: number;
  missionId: number;
  draftId: string;
  symbol: string;
  state: MissionRiskState;
  hasStopLoss: boolean;
  edgeTier: string | null;
}): Promise<MissionGateResult> {
  const s = args.state;
  const gate = composeMissionGate({
    // The trader's 13 rules run inside the live pipeline; mission scope starts
    // from "pass" and can only escalate.
    governorDecision: "pass",
    mode: s.mode,
    ladderAction: s.ladderAction,
    blowupAction: s.blowup.action,
    budgetExceeded: s.budgetUsedPct >= 100,
    cooldownActive: s.behavioral.cooldownTriggered,
    emergencyTriggered: s.emergency.triggered,
    hasStopLoss: args.hasStopLoss,
    edgeTier: args.edgeTier,
  });
  if (!gate.allow) {
    try {
      await logRiskEvent({
        userId: args.userId, eventType: "blocked_trade", severity: "critical", decision: "block",
        reason: `Mission risk rules blocked this trade: ${gate.blockReasons.join(", ")}.`,
        details: {
          source: "pre_trade_risk_governor", scope: "mission", missionId: args.missionId, draftId: args.draftId,
          intent: { symbol: args.symbol, origin: "strategy" }, blockReasons: gate.blockReasons,
          mode: s.mode, ladderAction: s.ladderAction, blowup: s.blowup.action, budgetUsedPct: s.budgetUsedPct,
        },
      });
    } catch { /* the block stands even if the audit row cannot be written */ }
  }
  return gate;
}
