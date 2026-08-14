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
// - Scope precedence is GLOBAL > NEWS > AGENT > STRATEGY > SYMBOL. GLOBAL and
//   NEWS use a null scopeRef (they always match). AGENT matches on agentKey,
//   STRATEGY on the decision's setup type, SYMBOL on the traded symbol.

import { eq } from "drizzle-orm";
import { db, selfTradeKillSwitchesTable } from "@workspace/db";

export interface KillSwitchCheckInput {
  agentKey: string;
  symbol?: string | null;
  strategy?: string | null;
}

export interface KillSwitchVerdict {
  killed: boolean;
  scope: string | null;
  scopeRef: string | null;
  reason: string | null;
}

// Higher precedence first — the most authoritative engaged switch wins.
const SCOPE_PRECEDENCE = ["GLOBAL", "NEWS", "AGENT", "STRATEGY", "SYMBOL"] as const;

function scopeRank(scope: string): number {
  const i = SCOPE_PRECEDENCE.indexOf(scope as (typeof SCOPE_PRECEDENCE)[number]);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

/**
 * Return the highest-precedence engaged kill switch that covers this agent
 * context, or a not-killed verdict when none applies.
 */
export async function assertAgentNotKilled(
  input: KillSwitchCheckInput,
): Promise<KillSwitchVerdict> {
  const rows = await db
    .select()
    .from(selfTradeKillSwitchesTable)
    .where(eq(selfTradeKillSwitchesTable.engaged, true));

  let best: KillSwitchVerdict | null = null;
  for (const r of rows) {
    let matches = false;
    switch (r.scope) {
      case "GLOBAL":
      case "NEWS":
        matches = true; // null scopeRef — always covers.
        break;
      case "AGENT":
        matches = r.scopeRef === input.agentKey;
        break;
      case "STRATEGY":
        matches = !!input.strategy && r.scopeRef === input.strategy;
        break;
      case "SYMBOL":
        matches = !!input.symbol && r.scopeRef === input.symbol;
        break;
      default:
        matches = false;
    }
    if (!matches) continue;
    const candidate: KillSwitchVerdict = {
      killed: true,
      scope: r.scope,
      scopeRef: r.scopeRef ?? null,
      reason: r.reason ?? `${r.scope} kill switch engaged`,
    };
    if (best === null || scopeRank(r.scope) < scopeRank(best.scope ?? "")) {
      best = candidate;
    }
  }

  return best ?? { killed: false, scope: null, scopeRef: null, reason: null };
}
