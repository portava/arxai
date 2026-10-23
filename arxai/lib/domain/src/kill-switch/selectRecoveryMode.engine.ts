import type {
  KillSwitchState, KillTrigger, RecoveryMode,
} from "./killSwitch.types";

// selectRecoveryMode — given the fired trigger set, pick the strictest
// applicable RecoveryMode. Strictness order:
//
//   BLOCK_ALL  > PAPER_ONLY  > A_PLUS_ONLY  > REDUCED_SIZE  > NORMAL
//
// Rules:
//   • Any CRITICAL DAILY_LOSS_HIT          → BLOCK_ALL
//   • Any CRITICAL LOSING_STREAK           → BLOCK_ALL
//   • Any CRITICAL REVENGE_BEHAVIOR        → PAPER_ONLY
//   • OVERTRADING (any severity)           → PAPER_ONLY
//   • WARN LOSING_STREAK                   → A_PLUS_ONLY
//   • RULE_BREAKING                        → A_PLUS_ONLY
//   • ABNORMAL_SLIPPAGE                    → REDUCED_SIZE
//   • No triggers                          → NORMAL
export function selectRecoveryMode(
  triggers: KillTrigger[],
  enteredAt: string = new Date().toISOString(),
): KillSwitchState {
  const reasons: string[] = [];
  let mode: RecoveryMode = "NORMAL";
  const upgrade = (target: RecoveryMode, why: string) => {
    if (rank(target) > rank(mode)) {
      mode = target;
      reasons.push(`→ ${target} (${why})`);
    }
  };

  for (const t of triggers) {
    if (t.kind === "DAILY_LOSS_HIT" && t.severity === "CRITICAL") upgrade("BLOCK_ALL", t.reason);
    if (t.kind === "LOSING_STREAK"  && t.severity === "CRITICAL") upgrade("BLOCK_ALL", t.reason);
    if (t.kind === "REVENGE_BEHAVIOR" && t.severity === "CRITICAL") upgrade("PAPER_ONLY", t.reason);
    if (t.kind === "OVERTRADING") upgrade("PAPER_ONLY", t.reason);
    if (t.kind === "LOSING_STREAK" && t.severity === "WARN") upgrade("A_PLUS_ONLY", t.reason);
    if (t.kind === "RULE_BREAKING") upgrade("A_PLUS_ONLY", t.reason);
    if (t.kind === "ABNORMAL_SLIPPAGE") upgrade("REDUCED_SIZE", t.reason);
  }

  if (triggers.length === 0) reasons.push("no triggers fired — NORMAL");
  return { mode, activeTriggers: triggers, enteredAt, reasons };
}

function rank(m: RecoveryMode): number {
  switch (m) {
    case "NORMAL":       return 0;
    case "REDUCED_SIZE": return 1;
    case "A_PLUS_ONLY":  return 2;
    case "PAPER_ONLY":   return 3;
    case "BLOCK_ALL":    return 4;
  }
}
