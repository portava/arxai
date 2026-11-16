import {
  type AttentionItem, type SetupReport, type RankedItem,
  SEVERITY_WEIGHT, clamp01,
} from "./attention.types";

// ═══════════════════════════════════════════════════════════════════════════
// Setup Priority — restricted ranking over TRADE_SETUP items only.
// Heavy weight on signal strength and freshness; severity acts as a
// confidence-of-quality proxy. Non-actionable setups are deprioritised.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export function prioritizeSetups(
  items: ReadonlyArray<AttentionItem>, topK = 5,
): SetupReport {
  const reasons: string[] = [];
  const setups = items.filter((it) => it.kind === "TRADE_SETUP");
  const scored: RankedItem[] = setups.map((it, i) => {
    const sev = SEVERITY_WEIGHT[it.severity];
    const freshness = clamp01(Math.exp(-Math.LN2 * (it.freshnessMs / it.decayHalfLifeMs)));
    const signal = clamp01(it.signalStrength01);
    const actionable = it.actionable ? 1 : 0.4;
    const score01 = clamp01((0.45 * signal + 0.30 * freshness + 0.25 * sev) * actionable);
    return { itemId: it.itemId, rank: i, score01, reasons: [`sig ${signal.toFixed(2)} · fresh ${freshness.toFixed(2)} · sev ${sev.toFixed(2)} · act× ${actionable}`] };
  });
  const sorted = scored.sort((a, b) => b.score01 - a.score01).slice(0, topK).map((s, i) => ({ ...s, rank: i }));
  reasons.push(`${setups.length} setups → top ${sorted.length}`);
  return { topSetups: sorted, reasons };
}
