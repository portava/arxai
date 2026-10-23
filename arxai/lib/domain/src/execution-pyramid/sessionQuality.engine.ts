import type { ExecutionPyramidContext, PyramidScoreReport } from "./executionPyramid.types";
import { PYRAMID_CATEGORY_WEIGHT } from "./executionPyramid.types";

export function scoreSessionQuality(ctx: ExecutionPyramidContext): PyramidScoreReport {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const s = ctx.session;

  if (s.current === "OFF_HOURS") {
    blockers.push("Currently OFF_HOURS — illiquid, avoid execution");
  }

  // 1. Session preferred for strategy (0..6)
  let prefScore: number;
  if (s.preferredForStrategy.length === 0) {
    prefScore = 4;
    warnings.push("Strategy has no preferred-session list — defaulting to 4/6");
  } else if (s.preferredForStrategy.includes(s.current)) {
    prefScore = 6;
  } else {
    prefScore = 1;
    blockers.push(`Strategy prefers ${s.preferredForStrategy.join("/")}, current is ${s.current}`);
  }

  // 2. Session timing window (0..4) — avoid open/close edges
  let timingScore = 4;
  if (s.minutesSinceSessionOpen < 15) {
    timingScore = 1;
    warnings.push(`Only ${s.minutesSinceSessionOpen}m since session open — wait for stabilisation`);
  } else if (s.minutesUntilSessionEnd < 30) {
    timingScore = 1;
    warnings.push(`Only ${s.minutesUntilSessionEnd}m until session close — limited room`);
    if (s.minutesUntilSessionEnd < 10) {
      blockers.push("Session closing in <10 min — insufficient time for trade to develop");
    }
  } else if (s.minutesSinceSessionOpen < 30 || s.minutesUntilSessionEnd < 60) {
    timingScore = 3;
  }

  const score = Math.max(0, Math.min(10, prefScore + timingScore));

  return {
    category: "sessionQuality",
    score, warnings, blockers,
    explanation: `Session ${s.current} (preferred: ${s.preferredForStrategy.join(", ") || "any"}) → ${prefScore}/6; timing ${s.minutesSinceSessionOpen}m in / ${s.minutesUntilSessionEnd}m left → ${timingScore}/4 — ${score}/10`,
    confidenceContribution: score * (PYRAMID_CATEGORY_WEIGHT / 10),
  };
}
