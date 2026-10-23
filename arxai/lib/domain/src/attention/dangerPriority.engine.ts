import {
  type AttentionItem, type DangerReport, type RankedItem,
  SEVERITY_WEIGHT, clamp01,
} from "./attention.types";

// ═══════════════════════════════════════════════════════════════════════════
// Danger Priority — restricted ranking over DANGER + RISK_EVENT items.
// Always promotes CRITICAL severity to the top regardless of freshness.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export function prioritizeDangers(
  items: ReadonlyArray<AttentionItem>, topK = 5,
): DangerReport {
  const reasons: string[] = [];
  const dangerItems = items.filter((it) => it.kind === "DANGER" || it.kind === "RISK_EVENT");
  const scored: RankedItem[] = dangerItems.map((it, i) => {
    const sev = SEVERITY_WEIGHT[it.severity];
    const freshness = clamp01(Math.exp(-Math.LN2 * (it.freshnessMs / it.decayHalfLifeMs)));
    const isCritical = it.severity === "CRITICAL" ? 1 : 0;
    const score01 = clamp01(0.55 * sev + 0.20 * freshness + 0.25 * clamp01(it.signalStrength01) + 0.50 * isCritical);
    return {
      itemId: it.itemId, rank: i,
      score01: clamp01(Math.min(1, score01)),
      reasons: [`sev ${sev.toFixed(2)} · fresh ${freshness.toFixed(2)} · CRITICAL boost ${isCritical}`],
    };
  });
  const sorted = scored.sort((a, b) => b.score01 - a.score01).slice(0, topK).map((s, i) => ({ ...s, rank: i }));
  reasons.push(`${dangerItems.length} danger items → top ${sorted.length}`);
  return { topDangers: sorted, reasons };
}
