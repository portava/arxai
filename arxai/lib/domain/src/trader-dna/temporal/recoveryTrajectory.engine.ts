// ═══════════════════════════════════════════════════════════════════════════
// Recovery Trajectory
//
// Tracks the trader's behavioral trajectory after a triggering event
// (loss streak, drawdown, rule violation). Compares pre-event vs
// post-event windows on: average rMultiple, win rate, size discipline,
// and pacing. Outputs a trajectory: IMPROVING / FLAT / DEGRADING.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { Trade } from "../../trade/trade.types";
import type { PersonalBaseline } from "../personalBaseline.engine";

export const TrajectoryStateSchema = z.enum(["IMPROVING", "FLAT", "DEGRADING", "INSUFFICIENT"]);
export type TrajectoryState = z.infer<typeof TrajectoryStateSchema>;

export const RecoveryTrajectorySchema = z.object({
  preWindowSample:  z.number().int().nonnegative(),
  postWindowSample: z.number().int().nonnegative(),
  trajectoryState:  TrajectoryStateSchema,
  trajectoryScore:  z.number(),
  deltas: z.object({
    avgRMultiple:    z.number(),
    winRate:         z.number(),
    sizeDiscipline:  z.number(),
    pacingMinutes:   z.number(),
  }),
  reasons: z.array(z.string()),
});
export type RecoveryTrajectoryReport = z.infer<typeof RecoveryTrajectorySchema>;

export interface RecoveryTrajectoryInput {
  trades: Trade[];
  triggerAt: string;             // ISO time of the event
  windowMinutes?: number;        // half-window
  baseline: PersonalBaseline;
}

export function analyzeRecoveryTrajectory(
  input: RecoveryTrajectoryInput,
): RecoveryTrajectoryReport {
  const half = (input.windowMinutes ?? 240) * 60_000;
  const t0 = new Date(input.triggerAt).getTime();
  const closed = input.trades.filter(t => t.closedAt && (t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS"));
  const pre  = closed.filter(t => {
    const ts = new Date(t.closedAt!).getTime();
    return ts < t0 && ts >= t0 - half;
  });
  const post = closed.filter(t => {
    const ts = new Date(t.openedAt).getTime();
    return ts > t0 && ts <= t0 + half;
  });
  const reasons: string[] = [];
  if (pre.length < 3 || post.length < 3) {
    reasons.push(`pre=${pre.length}, post=${post.length} — need ≥3 in each window`);
    return { preWindowSample: pre.length, postWindowSample: post.length,
      trajectoryState: "INSUFFICIENT", trajectoryScore: 0,
      deltas: { avgRMultiple: 0, winRate: 0, sizeDiscipline: 0, pacingMinutes: 0 },
      reasons };
  }

  const baseSize = input.baseline.lotSize.median || 1;
  const preR  = avg(pre.map(t => t.rMultiple ?? 0));
  const postR = avg(post.map(t => t.rMultiple ?? 0));
  const preWR  = pre.filter(t => t.status === "CLOSED_WIN").length / pre.length;
  const postWR = post.filter(t => t.status === "CLOSED_WIN").length / post.length;
  // Discipline: closer to baseline lot = higher discipline (1 - normalized deviation)
  const preDisc  = 1 - clamp01(avg(pre.map(t => Math.abs(t.lotSize - baseSize) / baseSize)));
  const postDisc = 1 - clamp01(avg(post.map(t => Math.abs(t.lotSize - baseSize) / baseSize)));
  const prePace  = medianGap(pre);
  const postPace = medianGap(post);

  const deltas = {
    avgRMultiple:   round4(postR - preR),
    winRate:        round4(postWR - preWR),
    sizeDiscipline: round4(postDisc - preDisc),
    pacingMinutes:  round4(postPace - prePace),
  };
  // Score: positive = improvement
  const score = round4(deltas.avgRMultiple * 0.4 + deltas.winRate * 0.3 +
                       deltas.sizeDiscipline * 0.2 + clamp(deltas.pacingMinutes / 30, -1, 1) * 0.1);
  let state: TrajectoryState;
  if (score >= 0.10) state = "IMPROVING";
  else if (score <= -0.10) state = "DEGRADING";
  else state = "FLAT";
  reasons.push(`score=${score} (R Δ${deltas.avgRMultiple} · WR Δ${deltas.winRate} · disc Δ${deltas.sizeDiscipline} · pace Δ${deltas.pacingMinutes}m)`);
  return { preWindowSample: pre.length, postWindowSample: post.length,
    trajectoryState: state, trajectoryScore: score, deltas, reasons };
}
function avg(xs: number[]) { return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0; }
function medianGap(ts: Trade[]) {
  const sorted = [...ts].sort((a,b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime());
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((new Date(sorted[i].openedAt).getTime() - new Date(sorted[i-1].openedAt).getTime()) / 60_000);
  }
  if (!gaps.length) return 0;
  const s = gaps.sort((a,b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
}
function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }
function clamp01(n: number) { return clamp(n, 0, 1); }
function round4(n: number) { return Math.round(n * 10000) / 10000; }
