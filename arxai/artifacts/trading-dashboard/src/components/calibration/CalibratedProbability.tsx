// Calibrated probability with its N — or "unmeasured" with its N.
//
// Every confidence-shaped number the server sends now carries a calibration
// reading (lib/calibration on the API): a probability measured on graded
// outcomes, or null below the minimum sample. This is the one way the UI shows
// it. A percentage sign appears ONLY on a measured probability, and always
// next to the N it was measured on.

export interface CalibrationReading {
  probability: number | null;
  status: "measured" | "unmeasured";
  n: number;
  scope?: string;
  edgeDetected?: boolean;
  reason?: string | null;
}

export function calibrationText(c: CalibrationReading | null | undefined): string {
  if (!c) return "unmeasured (N=0)";
  if (c.probability == null || c.status !== "measured") return `unmeasured (N=${c.n})`;
  return `${Math.round(c.probability * 100)}% (N=${c.n})`;
}

function scopeText(scope: string | undefined): string {
  if (!scope || scope === "exact") return "measured on this market and timeframe";
  if (scope.startsWith("timeframe_fallback:")) return `borrowed from ${scope.split(":")[1]} on this market (no measured fit on this timeframe yet)`;
  if (scope === "pooled_symbols") return "pooled across markets on this timeframe";
  if (scope === "pooled_all") return "pooled across all markets and timeframes";
  return "no measured fit";
}

export function calibrationTitle(c: CalibrationReading | null | undefined): string {
  if (!c || c.probability == null) {
    return c?.reason ?? "Not enough graded outcomes to measure a probability yet.";
  }
  const edge = c.edgeDetected
    ? "This score beat the base rate out of sample."
    : "This score did not beat the base rate out of sample, so the base rate is shown.";
  return `Measured win rate on ${c.n} graded outcomes, ${scopeText(c.scope)}. ${edge}`;
}

export function CalibratedProbability({
  calibration,
  testId,
  className,
}: {
  calibration: CalibrationReading | null | undefined;
  testId?: string;
  className?: string;
}) {
  const measured = calibration?.probability != null && calibration.status === "measured";
  return (
    <span
      className={`font-mono ${measured ? "" : "text-muted-foreground"} ${className ?? ""}`}
      title={calibrationTitle(calibration)}
      data-testid={testId ?? "calibrated-probability"}
      data-calibration-status={measured ? "measured" : "unmeasured"}
    >
      {calibrationText(calibration)}
    </span>
  );
}
