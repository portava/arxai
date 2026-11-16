// ═══════════════════════════════════════════════════════════════════════════
// Post-Loss Behavior
//
// Compares trades that occur within `windowMinutes` after a closed-loss
// against the trader's baseline. Reports observable evidence — never
// labels emotional state.
//
// Outputs:
//   • postLossSampleCount, postLossWinRate01, postLossAvgLotMultiple,
//     postLossAvgRMultiple, postLossEntriesPerLossLoss
//   • postLossRiskScore01 (0..1, higher = more deviation from baseline,
//     evidence of pressured behavior)
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { Trade } from "../trade/trade.types";
import type { PersonalBaseline } from "./personalBaseline.engine";

export const PostLossProfileSchema = z.object({
  windowMinutes: z.number().nonnegative(),
  lossesScanned: z.number().int().nonnegative(),
  postLossSample: z.number().int().nonnegative(),
  postLossWinRate01: z.number().min(0).max(1),
  postLossAvgLotMultiple: z.number().nonnegative(),
  postLossAvgRMultiple: z.number(),
  postLossEntriesPerLoss: z.number().nonnegative(),
  postLossRiskScore01: z.number().min(0).max(1),
  evidence: z.array(z.string()),
});
export type PostLossProfile = z.infer<typeof PostLossProfileSchema>;

const DEFAULT_WINDOW_MIN = 60;

export function analyzePostLossBehavior(
  trades: Trade[],
  baseline: PersonalBaseline,
  windowMinutes: number = DEFAULT_WINDOW_MIN,
): PostLossProfile {
  const closed = trades.filter(isClosed);
  const ordered = [...closed].sort((a, b) =>
    new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime());

  const losses = ordered.filter(t => t.status === "CLOSED_LOSS" && t.closedAt);
  const windowMs = windowMinutes * 60_000;

  // Each follow-up trade is counted at most once, attributed to the
  // nearest preceding loss (prevents double-counting when post-loss
  // windows overlap).
  const seen = new Set<Trade["id"]>();
  const followUps: Trade[] = [];
  for (const t of ordered) {
    if (seen.has(t.id)) continue;
    const opened = new Date(t.openedAt).getTime();
    // find nearest preceding loss within window
    let attributed = false;
    for (let i = losses.length - 1; i >= 0; i--) {
      const lossClosed = new Date(losses[i].closedAt!).getTime();
      if (lossClosed >= opened) continue;
      if (opened - lossClosed <= windowMs && losses[i].id !== t.id) {
        attributed = true;
      }
      break;  // only consider the nearest preceding loss
    }
    if (attributed) { followUps.push(t); seen.add(t.id); }
  }

  const sample = followUps.length;
  const wins = followUps.filter(t => t.status === "CLOSED_WIN").length;
  const wr = sample ? wins / sample : 0;
  const avgLot = sample ? avg(followUps.map(t => t.lotSize)) : 0;
  const baseLot = baseline.lotSize.median > 0 ? baseline.lotSize.median : 1;
  const lotMult = avgLot / baseLot;
  const avgR = sample ? avg(followUps.map(t => t.rMultiple ?? 0)) : 0;
  const perLoss = losses.length ? sample / losses.length : 0;

  const evidence: string[] = [];
  if (sample === 0) {
    evidence.push(losses.length === 0 ? "no closed losses in window" : "no entries within post-loss window");
  } else {
    evidence.push(`${sample} entries within ${windowMinutes}m of a loss across ${losses.length} losses`);
    if (lotMult >= 1.5) evidence.push(`avg lot ${avgLot.toFixed(2)} = ${lotMult.toFixed(2)}× baseline median (${baseLot.toFixed(2)})`);
    if (perLoss >= 1.5) evidence.push(`${perLoss.toFixed(2)} follow-up entries per loss`);
    if (wr < Math.max(0, baseline.winRate01 - 0.1)) evidence.push(`post-loss win rate ${(wr*100).toFixed(0)}% vs baseline ${(baseline.winRate01*100).toFixed(0)}%`);
  }

  // Score: weighted blend of three deviations vs baseline.
  // Each component is in [0..1].
  const lotComp     = clamp01((lotMult - 1) / 2);              // 0 at parity, 1 at 3×
  const freqComp    = clamp01((perLoss - 1) / 2);              // 0 at 1, 1 at 3
  const wrDelta     = baseline.winRate01 - wr;                  // positive = worse
  const wrComp      = clamp01(wrDelta / 0.30);                  // 30pp worse → 1
  const sampleGate  = sample === 0 ? 0 : Math.min(1, sample / 5);  // <5 entries → throttle the score

  const postLossRiskScore01 = clamp01(
    sampleGate * (0.45 * lotComp + 0.30 * freqComp + 0.25 * wrComp),
  );

  return {
    windowMinutes,
    lossesScanned: losses.length,
    postLossSample: sample,
    postLossWinRate01: wr,
    postLossAvgLotMultiple: lotMult,
    postLossAvgRMultiple: avgR,
    postLossEntriesPerLoss: perLoss,
    postLossRiskScore01,
    evidence,
  };
}

function isClosed(t: Trade): boolean {
  return t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS" || t.status === "CLOSED_BREAKEVEN";
}
function avg(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function clamp01(x: number): number { return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0; }
