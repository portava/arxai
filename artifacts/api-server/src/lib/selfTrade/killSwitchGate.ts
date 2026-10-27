// Self-Trade AI — Kill Switch Gate (Task #213).
//
// A single, honest read of the self_trade_kill_switches table that answers one
// question: "is ANY kill switch engaged that covers this agent / symbol /
// strategy right now?". The autonomous executor calls this at executor entry
// AND immediately before dispatch (TOCTOU guard) so a switch armed mid-cycle
// still refuses.
//
// SAFETY (inviolable):
// - This is a READ-ONLY safety check. It never mutates anything.
// - It can only REFUSE execution. It can never permit or weaken any of the 16
//   live gates downstream — those run regardless inside the existing pipeline.
// - Scope precedence and matching: see killSwitchScope.ts. GLOBAL and
//   NEWS use a null scopeRef (they always match). AGENT matches on agentKey,
//   STRATEGY on the decision's setup type, SYMBOL on the traded symbol.

import {
  readKillSwitchVerdict,
  type KillSwitchCheckInput,
  type KillSwitchVerdict,
} from "./killSwitchScope.js";

export type { KillSwitchCheckInput, KillSwitchVerdict };

/**
 * Return the highest-precedence engaged kill switch that covers this agent
 * context, or a not-killed verdict when none applies. Matching rules live in
 * killSwitchScope.ts (shared with the final entry-authority claim). A read
 * failure throws; callers must treat a throw as a refusal.
 */
export async function assertAgentNotKilled(
  input: KillSwitchCheckInput,
): Promise<KillSwitchVerdict> {
  return readKillSwitchVerdict(input);
}
