import type {
  AgentSystemSnapshot, ClosedTradeOutcome, RegimeMemoryUpdate,
} from "../agentSystem.types";

// regimeMemory — updates the system's belief about how well it performs
// in the current regime. Pure computation: returns the proposed update;
// caller persists via storage.
//
// Update rule: exponential moving average. Win contributes +0.1 toward
// 1.0, loss contributes +0.1 toward 0.0. Health stays in [0, 1].
export function updateRegimeMemory(
  snap: AgentSystemSnapshot,
  outcome: ClosedTradeOutcome,
): RegimeMemoryUpdate {
  const reasons: string[] = [];
  const cur = snap.policy.regime.currentRegimeHealth01;
  const target = outcome.pnlR > 0 ? 1.0 : outcome.pnlR < 0 ? 0.0 : 0.5;
  const alpha = 0.1;
  let newHealth01 = cur + alpha * (target - cur);
  newHealth01 = Math.max(0, Math.min(1, newHealth01));

  reasons.push(
    `regime "${snap.policy.regime.currentRegimeId}" health ${cur.toFixed(2)} → ${newHealth01.toFixed(2)} ` +
    `(target ${target.toFixed(1)} for pnl ${outcome.pnlR.toFixed(2)}R)`,
  );
  if (snap.policy.regime.regimeChangedRecently) {
    reasons.push("note: regime recently changed — early samples reset trustworthiness slowly");
  }
  return { currentRegimeId: snap.policy.regime.currentRegimeId, newHealth01, reasons };
}
