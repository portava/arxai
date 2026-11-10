// The scanner row's raw score. `score` is the field (0-100, an UNCALIBRATED
// heuristic: never a probability or a confidence); `confidenceScore` is its
// deprecated alias, still sent by the API for older clients and stored rows.

/** The row's uncalibrated 0-100 score: `score`, or the deprecated
 *  `confidenceScore` alias from an older server. */
export function rowScore(o: { score?: number | null; confidenceScore: number }): number {
  return typeof o.score === "number" && Number.isFinite(o.score) ? o.score : o.confidenceScore;
}
