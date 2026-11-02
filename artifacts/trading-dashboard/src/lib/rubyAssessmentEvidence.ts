import { assessmentHigherTimeframe, validHigherTimeframeObservationKey } from "@workspace/domain/truth";
import { rubyChartReadContext } from "./rubyChartReadContext";

/** Identity of the inputs the server actually analyzed. This is not a
 * probability, a trading permission, or an expiry policy. */
export interface RubyAssessmentEvidence {
  symbol: string;
  timeframe: string;
  source: string;
  sourceIdentity: string;
  lastClosedCandleAt: string;
  closedWindowIdentity: string;
  userId: number;
  higherTimeframeObservation: string | null;
}

export function rubyAssessmentEvidenceKey(value: unknown, nowMs = Date.now()): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const e = value as Record<string, unknown>;
  if (typeof e.symbol !== "string" || !e.symbol.trim() || typeof e.timeframe !== "string" || !e.timeframe.trim()
    || typeof e.source !== "string" || !e.source.trim()
    || typeof e.sourceIdentity !== "string" || !/^[a-f0-9]{64}$/.test(e.sourceIdentity)
    || typeof e.closedWindowIdentity !== "string" || !/^[a-f0-9]{64}$/.test(e.closedWindowIdentity)
    || typeof e.lastClosedCandleAt !== "string" || !Number.isSafeInteger(e.userId) || (e.userId as number) <= 0) return null;
  const at = Date.parse(e.lastClosedCandleAt);
  if (!Number.isFinite(at) || at > nowMs || new Date(at).toISOString() !== e.lastClosedCandleAt) return null;
  const market = rubyChartReadContext(e.symbol, e.timeframe);
  if (!validHigherTimeframeObservationKey(e.higherTimeframeObservation, assessmentHigherTimeframe(market.timeframe))) return null;
  return JSON.stringify([market.symbol, market.timeframe, e.source, e.sourceIdentity, e.closedWindowIdentity, at, e.userId, e.higherTimeframeObservation]);
}

export function matchesRubyAssessmentEvidence(actual: unknown, expected: unknown): boolean {
  const key = rubyAssessmentEvidenceKey(expected);
  return key !== null && key === rubyAssessmentEvidenceKey(actual);
}
