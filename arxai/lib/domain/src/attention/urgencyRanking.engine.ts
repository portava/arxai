import {
  type AttentionItem, type UrgencyReport, type RankedItem,
  SEVERITY_WEIGHT, clamp01,
} from "./attention.types";

// ═══════════════════════════════════════════════════════════════════════════
// Urgency Ranking — assigns each item a [0,1] urgency score. Components:
//   • severity weight
//   • freshness via exponential decay (halfLife per item)
//   • signal strength
//   • actionable bonus (0.10)
// Pure. Ties broken by itemId (stable).
// ═══════════════════════════════════════════════════════════════════════════

export function rankByUrgency(items: ReadonlyArray<AttentionItem>): UrgencyReport {
  const reasons: string[] = [];
  const scored = items.map((it) => {
    const sev = SEVERITY_WEIGHT[it.severity];
    const freshness = clamp01(Math.exp(-Math.LN2 * (it.freshnessMs / it.decayHalfLifeMs)));
    const signal = clamp01(it.signalStrength01);
    const actionable = it.actionable ? 0.10 : 0;
    const score01 = clamp01(0.40 * sev + 0.25 * freshness + 0.25 * signal + actionable);
    const r = [`sev ${sev.toFixed(2)} · fresh ${freshness.toFixed(2)} · sig ${signal.toFixed(2)} · act ${actionable.toFixed(2)} → ${score01.toFixed(3)}`];
    return { itemId: it.itemId, score01, reasons: r };
  });
  const sorted = [...scored].sort((a, b) => b.score01 - a.score01 || a.itemId.localeCompare(b.itemId));
  const ranked: RankedItem[] = sorted.map((s, i) => ({ ...s, rank: i }));
  reasons.push(`ranked ${ranked.length} items`);
  return { ranked, reasons };
}
