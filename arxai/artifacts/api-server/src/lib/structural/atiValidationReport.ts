import {
  ATI_STRUCTURAL_VALIDATION, calibrationBins, forecastHorizonBars, forecastHorizonId,
  forecastStepMs, hasAtiStructuralScope, independentForecasts, scenarioIndex,
} from "@workspace/domain/structural";
import { STRUCTURAL_HISTORY_LIMIT, type StoredForecast } from "./service.js";

export function reportAtiStructuralValidation(rows: readonly StoredForecast[]) {
  const groups = new Map<string, StoredForecast[]>();
  let unsupportedSource = 0, legacy = 0, invalidIssuance = 0;
  for (const row of rows) {
    const f = row.forecast;
    if (!hasAtiStructuralScope(f)) { unsupportedSource++; continue; }
    if (!f.atiEarlyBreak) { legacy++; continue; }
    const firstClose = f.asOf + forecastStepMs(f);
    if (row.recordedAt == null || ![row.recordedAt, row.issuedAt, f.asOf, firstClose].every(Number.isFinite) ||
        row.issuedAt < f.asOf || row.recordedAt < f.asOf || Math.max(row.issuedAt, row.recordedAt) >= firstClose) {
      invalidIssuance++;
      continue;
    }
    const key = JSON.stringify([f.origin.symbol, f.origin.provider, f.version, f.featureVersion, f.eventDefinitionVersion,
      forecastHorizonId(f), forecastStepMs(f), forecastHorizonBars(f)]);
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }
  const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return {
    version: ATI_STRUCTURAL_VALIDATION,
    scope: { historyLimit: STRUCTURAL_HISTORY_LIMIT, receiptsRead: rows.length, atHistoryLimit: rows.length >= STRUCTURAL_HISTORY_LIMIT },
    unsupportedSource, legacy, invalidIssuance,
    cohorts: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => {
      const first = group[0]!.forecast;
      const bars = forecastHorizonBars(first), stepMs = forecastStepMs(first);
      // Select the windows before reading outcomes, including unsettled anchors.
      const samples = independentForecasts([...group].sort((a, b) => a.id.localeCompare(b.id)).map((row) => ({
        row, asOf: row.forecast.asOf, update: Boolean(row.forecast.update),
      })), bars * stepMs);
      const scored = samples.flatMap(({ row, asOf }) => {
        const score = row.scores.find((s) => s.horizon === bars && s.observedThrough === asOf + bars * stepMs &&
          s.atiValidation?.version === ATI_STRUCTURAL_VALIDATION);
        return score?.atiValidation ? [{ row, score, validation: score.atiValidation }] : [];
      });
      const ghosts = scored.flatMap(({ validation }) => validation.ghost ? [validation.ghost] : []);
      const probabilityRows = scored.flatMap(({ row, score }) => {
        const p = row.forecast.horizons.find((h) => h.bars === bars)?.probabilities;
        return p?.length === 3 && p.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) &&
          Math.abs(p[0] + p[1] + p[2] - 1) < 1e-8 && [score.shownBrier, score.baselineBrier].every(Number.isFinite)
          ? [{ p, outcome: scenarioIndex(score.outcome), shown: score.shownBrier!, baseline: score.baselineBrier }]
          : [];
      });
      return {
        symbol: first.origin.symbol, provider: first.origin.provider, forecastVersion: first.version,
        featureVersion: first.featureVersion, eventDefinitionVersion: first.eventDefinitionVersion,
        horizon: forecastHorizonId(first), stepMs, bars,
        receipts: group.length, independentWindows: samples.length, overlappingOrUpdates: group.length - samples.length,
        scoredWindows: scored.length, unresolvedWindows: samples.length - scored.length,
        earlyBreak: {
          prepared: samples.filter(({ row }) => row.forecast.atiEarlyBreak?.stage === "PREPARE").length,
          confirmed: scored.filter(({ validation }) => validation.pattern === "CONFIRMED").length,
          invalidated: scored.filter(({ validation }) => validation.pattern === "INVALIDATED").length,
        },
        firstStructuralBreak: {
          scored: probabilityRows.length, shownBrier: mean(probabilityRows.map((r) => r.shown)),
          baselineBrier: mean(probabilityRows.map((r) => r.baseline)), reliability: calibrationBins(probabilityRows),
        },
        ghostClosePaths: {
          scored: ghosts.length, unavailablePaths: scored.length - ghosts.length, pathProbability: null,
          upperBeforeLower: ghosts.filter((g) => g.firstBoundary === "UPPER").length,
          lowerBeforeUpper: ghosts.filter((g) => g.firstBoundary === "LOWER").length,
          neitherBoundary: ghosts.filter((g) => g.firstBoundary === "NEITHER").length,
          terminalInside: ghosts.filter((g) => g.terminalInside).length,
          meanInBandShare: mean(ghosts.map((g) => g.inBandCloses / g.totalCloses)),
          middleMae: mean(ghosts.map((g) => g.middleMae)), flatMae: mean(ghosts.map((g) => g.flatMae)),
        },
      };
    }),
  };
}
