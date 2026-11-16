// ── AACI Edge Decay / Speed Validity — pure ─────────────────────────────────
//
// Every setup has edge decay: the longer since the signal formed, the less edge
// remains. AACI models this as EdgeDecay = e^(-signalAge / halfLife) with a
// per-strategy half-life. Speed validity (a multiplicative factor on the final
// score) combines edge decay with execution-speed confidence. A signal that has
// decayed past usefulness downgrades the recommended action to WATCH_ONLY /
// WAIT_FOR_CONFIRMATION — AACI adds caution, never forces execution.

import type {
  AaciEdgeDecayResult,
  AaciSpeedState,
  AaciStrategyKind,
} from "./types";

// Per-strategy edge half-lives (ms). Midpoints of the spec's suggested ranges.
export const AACI_EDGE_HALF_LIFE_MS: Record<AaciStrategyKind, number> = {
  flame_scalp: 30_000, // 15–45s
  fast_scalp: 60_000, // 30–90s
  m5_pullback: 5 * 60_000, // 2–8m
  m15_setup: 12 * 60_000, // 5–20m
  swing: 75 * 60_000, // 30–120m
  news_first_reaction: 8_000, // very short
  post_news_confirmation: 3 * 60_000, // a few minutes
};

export const AACI_DEFAULT_STRATEGY_KIND: AaciStrategyKind = "m5_pullback";

/**
 * EdgeDecay = e^(-signalAge / halfLife), clamped to 0–1. signalAgeMs < 0 or
 * non-finite is treated as 0 (fresh). Also classifies a speed state from the
 * fraction of half-lives elapsed.
 */
export function computeEdgeDecay(
  signalAgeMs: number,
  strategy: AaciStrategyKind = AACI_DEFAULT_STRATEGY_KIND,
): AaciEdgeDecayResult {
  const halfLifeMs = AACI_EDGE_HALF_LIFE_MS[strategy] ?? AACI_EDGE_HALF_LIFE_MS[AACI_DEFAULT_STRATEGY_KIND];
  const age = Number.isFinite(signalAgeMs) && signalAgeMs > 0 ? signalAgeMs : 0;
  const edgeDecay = clamp01(Math.exp(-age / halfLifeMs));
  return { edgeDecay, halfLifeMs, signalAgeMs: age, speedState: classifySpeedState(age, halfLifeMs) };
}

// Classify the speed state from elapsed half-lives. Boundaries: EARLY (< 0.25
// half-lives), ON_TIME (< 1), DECAYING (< 2), LATE (< 3), EXPIRED (< 5),
// TOO_SLOW_TO_EXECUTE (≥ 5). These bands map directly onto edge decay: ~0.78,
// 0.37, 0.14, 0.05, 0.007.
export function classifySpeedState(signalAgeMs: number, halfLifeMs: number): AaciSpeedState {
  if (halfLifeMs <= 0) return "EXPIRED";
  const elapsed = signalAgeMs / halfLifeMs;
  if (elapsed < 0.25) return "EARLY";
  if (elapsed < 1) return "ON_TIME";
  if (elapsed < 2) return "DECAYING";
  if (elapsed < 3) return "LATE";
  if (elapsed < 5) return "EXPIRED";
  return "TOO_SLOW_TO_EXECUTE";
}

// A signal whose edge has effectively gone — used by the action resolver to
// force WATCH_ONLY / WAIT_FOR_CONFIRMATION.
export function isSignalExpired(state: AaciSpeedState): boolean {
  return state === "EXPIRED" || state === "TOO_SLOW_TO_EXECUTE";
}

/**
 * SPEED_VALIDITY — the multiplicative validity factor for the master formula:
 * edge decay × execution-speed confidence, clamped 0–1. executionSpeedConfidence
 * (0–1) reflects how fast the execution path can act on the signal; default 1
 * (no penalty) when unknown so missing latency data never fabricates a penalty
 * nor a bonus.
 */
export function computeSpeedValidity(
  edgeDecay: number,
  executionSpeedConfidence = 1,
): number {
  return clamp01(clamp01(edgeDecay) * clamp01(executionSpeedConfidence));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
