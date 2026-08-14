import type { AgentSystemSnapshot, HardBlockVerdict } from "../agentSystem.types";

// News Agent — analyzes news blackouts ONLY.
export function newsAgent(snap: AgentSystemSnapshot): HardBlockVerdict {
  const reasons: string[] = [];
  let vetoReason: string | null = null;
  const n = snap.news;

  for (const ev of n.upcomingEvents) {
    if (!ev.affectsSymbol || ev.severity !== "HIGH") continue;
    if (ev.minutesUntil >= 0 && ev.minutesUntil <= n.blackoutMinutesBeforeHigh) {
      vetoReason = `HIGH news "${ev.title}" in ${ev.minutesUntil}m (blackout ${n.blackoutMinutesBeforeHigh}m before)`;
      break;
    }
    if (ev.minutesUntil < 0 && Math.abs(ev.minutesUntil) <= n.blackoutMinutesAfterHigh) {
      vetoReason = `HIGH news "${ev.title}" was ${Math.abs(ev.minutesUntil)}m ago (blackout ${n.blackoutMinutesAfterHigh}m after)`;
      break;
    }
  }

  reasons.push(vetoReason ? `VETO: ${vetoReason}` : "no high-impact news within blackout windows");
  return {
    agentId: "NEWS", agentName: "News Agent", category: "HARD_BLOCK",
    vetoed: vetoReason !== null, vetoReason, reasons,
    observedAt: snap.now.toISOString(),
  };
}
