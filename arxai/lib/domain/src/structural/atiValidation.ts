import {
  forecastHorizonBars, forecastStepMs, type Cause, type StructuralBar, type StructuralEvent,
  type StructuralForecast, type StructureRead, type TrajectoryKind,
} from "./contracts.js";

export const ATI_STRUCTURAL_VALIDATION = "public-deriv-closed-bar-v1";

export type AtiEarlyBreak =
  | { stage: "OBSERVE"; checkpoints: { met: 0 | 1; total: 3 }; pivotKnownAt: number | null }
  | { stage: "PREPARE"; checkpoints: { met: 2; total: 3 }; cause: Cause; pivot: number;
      pivotKnownAt: number; signalAt: number; confirmsAt: number }
  | { stage: "CONFIRMED"; checkpoints: { met: 3; total: 3 }; cause: Cause; pivot: number;
      signalAt: number; confirmedAt: number };

export function readAtiEarlyBreak(structure: StructureRead, asOf: number, stepMs: number): AtiEarlyBreak {
  const lastEvent = structure.events.at(-1);
  if (lastEvent?.time === asOf) return {
    stage: "CONFIRMED", checkpoints: { met: 3, total: 3 }, cause: lastEvent.cause, pivot: lastEvent.pivot,
    signalAt: lastEvent.precursorTime, confirmedAt: asOf,
  };
  const pending = structure.precursor;
  if (pending) {
    const family = structure.trend !== 0 && structure.trend !== pending.direction ? "CHOCH" : "BOS";
    return {
      stage: "PREPARE", checkpoints: { met: 2, total: 3 }, cause: `${family}_${pending.direction === 1 ? "UP" : "DOWN"}`,
      pivot: pending.pivot.price, pivotKnownAt: pending.pivot.knownAt, signalAt: asOf, confirmsAt: asOf + stepMs,
    };
  }
  const pivotKnownAt = Math.max(structure.high?.knownAt ?? 0, structure.low?.knownAt ?? 0) || null;
  return { stage: "OBSERVE", checkpoints: { met: pivotKnownAt == null ? 0 : 1, total: 3 }, pivotKnownAt };
}

export interface AtiStructuralOutcome {
  version: typeof ATI_STRUCTURAL_VALIDATION;
  pattern: "CONFIRMED" | "INVALIDATED" | "NO_PENDING_PATTERN";
  ghost: {
    lower: number;
    upper: number;
    firstBoundary: "UPPER" | "LOWER" | "NEITHER";
    firstBoundaryAt: number | null;
    terminalInside: boolean;
    inBandCloses: number;
    totalCloses: number;
    middleMae: number;
    flatMae: number;
  } | null;
}

export function hasAtiStructuralScope(f: Pick<StructuralForecast, "origin">) {
  const { provider, kind } = f.origin;
  return provider === "deriv_public" && (kind === "BROKER_HISTORY" || kind === "LIVE_OBSERVED");
}

/**
 * Called only with the existing evaluator's complete, contiguous window and
 * causal events. Close prices carry ordering even in a bar open at issue time.
 * Intrabar highs/lows and training analog shares cannot answer these outcomes.
 */
export function gradeAtiStructural(
  f: StructuralForecast, bars: readonly StructuralBar[], events: readonly StructuralEvent[], issuedAt: number,
): AtiStructuralOutcome | undefined {
  const firstClose = f.asOf + forecastStepMs(f);
  if (!f.atiEarlyBreak || !hasAtiStructuralScope(f) || !Number.isFinite(issuedAt) ||
      issuedAt < f.asOf || issuedAt >= firstClose || bars[0]?.closeTime !== firstClose ||
      bars.length !== forecastHorizonBars(f)) return undefined;
  const phase = f.atiEarlyBreak;
  if (phase.stage === "PREPARE" && (phase.signalAt !== f.asOf || phase.confirmsAt !== firstClose ||
      phase.pivotKnownAt > f.asOf)) return undefined;
  const confirmed = phase.stage === "PREPARE" && events.some((event) => event.time === phase.confirmsAt &&
    event.precursorTime === phase.signalAt && event.cause === phase.cause && event.pivot === phase.pivot);
  return {
    version: ATI_STRUCTURAL_VALIDATION,
    pattern: phase.stage !== "PREPARE" ? "NO_PENDING_PATTERN" : confirmed ? "CONFIRMED" : "INVALIDATED",
    ghost: gradeGhostCloses(f, bars),
  };
}

function gradeGhostCloses(f: StructuralForecast, bars: readonly StructuralBar[]): AtiStructuralOutcome["ghost"] {
  const length = bars.length;
  const start = f.history.at(-1)?.close;
  if (start == null) return null;
  const path = (kind: TrajectoryKind) => {
    const series = f.trajectories?.filter((item) => item.kind === kind);
    const item = series?.length === 1 ? series[0] : undefined;
    if (!item || item.sourceEnd == null || !Number.isFinite(item.sourceEnd) ||
        item.sourceEnd > f.asOf || item.candles.length !== length) return null;
    return item.candles.every((bar, i) => bar.closeTime === bars[i]!.closeTime && bar.openTime === bars[i]!.openTime &&
      Number.isFinite(bar.close) && bar.close > 0) ? item.candles : null;
  };
  const bull = path("BULL"), bear = path("BEAR"), middle = path("MIDDLE");
  if (!bull || !bear || !middle) return null;
  const upper = bull.at(-1)!.close, lower = bear.at(-1)!.close;
  if (!(lower < start && start < upper) ||
      middle.some((point, i) => point.close < bear[i]!.close || point.close > bull[i]!.close)) return null;

  const first = bars.find((bar) => bar.close >= upper || bar.close <= lower);
  const end = bars.at(-1)!.close;
  let inBandCloses = 0, middleError = 0, flatError = 0;
  bars.forEach((bar, i) => {
    if (bar.close >= bear[i]!.close && bar.close <= bull[i]!.close) inBandCloses++;
    middleError += Math.abs(bar.close - middle[i]!.close);
    flatError += Math.abs(bar.close - start);
  });
  return {
    lower, upper, firstBoundary: !first ? "NEITHER" : first.close >= upper ? "UPPER" : "LOWER",
    firstBoundaryAt: first?.closeTime ?? null, terminalInside: end >= lower && end <= upper,
    inBandCloses, totalCloses: length, middleMae: middleError / length, flatMae: flatError / length,
  };
}
