// ── The evidence-gated flag report card (read-only) ──────────────────────────
//
// Renders the shared EvidenceGateReport shape produced by
// @workspace/domain/evidence-gate for both held flags (#4 conformal
// authority, #27 execution-policy promotion).
//
// HONESTY RULES THIS COMPONENT ENFORCES IN THE UI:
//   * A `null` measurement renders as "NOT MEASURED" with the reason. It is
//     NEVER rendered as 0, "—" alone, or a full/empty progress bar. A
//     confident-looking dashboard over nothing is the failure mode this whole
//     surface exists to avoid.
//   * `sampleSize: null` (unreadable source) renders as "could not read",
//     visibly different from a sample of 0.
//   * A feed with no production writer says so, next to the sample size, so
//     "0" is never mistaken for a quiet period.
//   * THE NUMBER SHOWN AGAINST THE BAR IS THE BARRED QUANTITY, never the
//     feed total. `sampleSize` counts the whole feed; `bar.requiredSampleSize`
//     bars a narrower thing (#4 the later evaluation window, #27 the
//     qualifying subset). Printing "200 records / bar requires 200" from two
//     different quantities is a reassuring misread, so the tile labels what
//     it counts and renders the requirement against the measurement the
//     report points at.
//   * There is NO button here. This card informs a press; it never takes one.

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export type EvidenceGateVerdict =
  | "INSUFFICIENT_HISTORY"
  | "BAR_NOT_MET"
  | "BAR_MET"
  | "SOURCE_UNREADABLE";

export interface EvidenceMeasurement {
  key: string;
  label: string;
  value: number | null;
  unit: "ratio" | "count" | "percent" | "days";
  target: string;
  met: boolean | null;
  note: string;
}

export interface EvidenceGateReport {
  gateId: string;
  title: string;
  verdict: EvidenceGateVerdict;
  verdictReason: string;
  barMet: boolean;
  bar: {
    description: string;
    requiredSampleSize: number;
    /** What `requiredSampleSize` counts — NOT necessarily what sampleSize does. */
    requiredSampleLabel: string;
    /** `key` of the measurement carrying the barred quantity. */
    requiredSampleMeasurementKey: string | null;
  };
  sampleSize: number | null;
  /** What `sampleSize` counts, in words. */
  sampleLabel: string;
  window: { fromIso: string; toIso: string; spanDays: number } | null;
  feed: {
    feedId: string;
    writerWired: boolean;
    writerNote: string;
    rowsRead: number | null;
    unreadableRows: number;
    sourceError: string | null;
  };
  measurements: EvidenceMeasurement[];
  ownerPress: {
    label: string;
    steps: string[];
    available: boolean;
    unavailableReason: string | null;
    whatItChanges: string[];
  };
  generatedAtIso: string;
  readOnly: true;
}

const VERDICT_COPY: Record<EvidenceGateVerdict, { text: string; className: string }> = {
  INSUFFICIENT_HISTORY: {
    text: "INSUFFICIENT HISTORY — not enough evidence to judge the bar",
    className: "border-warning/40 bg-warning/10 text-warning",
  },
  BAR_NOT_MET: {
    text: "BAR NOT MET — enough evidence to judge, and it does not clear the bar",
    className: "border-danger/40 bg-danger/10 text-danger",
  },
  BAR_MET: {
    text: "BAR MET — the arming bar is satisfied; the press is the owner's",
    className: "border-success/40 bg-success/10 text-success",
  },
  SOURCE_UNREADABLE: {
    text: "SOURCE UNREADABLE — the evidence could not be read (this is not the same as empty)",
    className: "border-danger/40 bg-danger/10 text-danger",
  },
};

/**
 * The one line under the sample count. It must never place `sampleSize`
 * against `requiredSampleSize`: those two count different things. When the
 * report names the measurement the bar actually judges, that measurement's
 * value is what gets rendered against the requirement — and a measurement
 * that was not taken reads NOT MEASURED, never 0.
 */
function barRequirementText(report: EvidenceGateReport): string {
  const key = report.bar.requiredSampleMeasurementKey;
  const barred = key === null ? null : report.measurements.find((m) => m.key === key);
  const required = `${report.bar.requiredSampleSize} — ${report.bar.requiredSampleLabel}`;
  if (key === null) return `Bar requires ${required}.`;
  if (!barred) {
    // Defensive: the domain constructor refuses to emit this, but a surface
    // must degrade to an admission, never to the misreadable total.
    return `Bar requires ${required}. The measured value is NOT AVAILABLE in this report — do not read the sample above as the barred quantity.`;
  }
  const measured = barred.value === null ? "NOT MEASURED" : String(barred.value);
  return `Bar counts something narrower than the sample above: ${measured} of ${required}.`;
}

function formatValue(m: EvidenceMeasurement): string {
  if (m.value === null) return "NOT MEASURED";
  if (m.unit === "count") return String(m.value);
  if (m.unit === "percent") return `${m.value}%`;
  if (m.unit === "days") return `${m.value} d`;
  return m.value.toFixed(4);
}

export function EvidenceGateReportCard({
  report,
  error,
  loading,
  onReload,
  testid,
}: {
  report: EvidenceGateReport | null;
  error: string;
  loading: boolean;
  onReload: () => void;
  testid: string;
}) {
  const [showRaw, setShowRaw] = useState(false);

  return (
    <Card data-testid={testid}>
      <CardHeader>
        <CardTitle className="text-base">
          {report?.title ?? "Evidence report"} <span className="text-muted-foreground">— read only</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && (
          <p className="text-danger" data-testid={`${testid}-error`}>
            {error}
          </p>
        )}
        {loading && !report && <p className="text-muted-foreground">Loading…</p>}
        {!loading && !report && !error && (
          <p className="text-muted-foreground">Not loaded.</p>
        )}

        {report && (
          <>
            <div
              className={`rounded-md border px-3 py-2 font-medium ${VERDICT_COPY[report.verdict].className}`}
              data-testid={`${testid}-verdict`}
            >
              {VERDICT_COPY[report.verdict].text}
            </div>
            <p className="text-muted-foreground" data-testid={`${testid}-verdict-reason`}>
              {report.verdictReason}
            </p>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-md border border-border p-2">
                <div className="text-muted-foreground">Sample</div>
                <div className="font-mono" data-testid={`${testid}-sample`}>
                  {report.sampleSize === null
                    ? "could not read (not zero — the source failed)"
                    : `${report.sampleSize} — ${report.sampleLabel}`}
                </div>
                <div
                  className="mt-1 text-xs text-muted-foreground"
                  data-testid={`${testid}-bar-requirement`}
                >
                  {barRequirementText(report)}
                </div>
              </div>
              <div className="rounded-md border border-border p-2">
                <div className="text-muted-foreground">Evaluation window</div>
                <div className="font-mono" data-testid={`${testid}-window`}>
                  {report.window
                    ? `${report.window.fromIso} → ${report.window.toIso} (${report.window.spanDays} d)`
                    : "none — there is no evidence to span a window"}
                </div>
              </div>
            </div>

            <div
              className={`rounded-md border p-2 text-xs ${
                report.feed.writerWired ? "border-border text-muted-foreground" : "border-warning/40 bg-warning/10"
              }`}
              data-testid={`${testid}-feed`}
            >
              <span className="font-medium">Feed {report.feed.feedId}: </span>
              {report.feed.writerWired
                ? "a production writer exists — the sample grows as the system runs."
                : "NO PRODUCTION WRITER. "}
              {report.feed.writerNote}
              {report.feed.sourceError && (
                <div className="mt-1 text-danger">Read error: {report.feed.sourceError}</div>
              )}
              {report.feed.unreadableRows > 0 && (
                <div className="mt-1">
                  {report.feed.unreadableRows} row(s) were read but could not be interpreted honestly and were
                  excluded — never guessed at.
                </div>
              )}
            </div>

            <div>
              <div className="mb-1 text-muted-foreground">What the bar measures</div>
              <p className="mb-2 text-xs text-muted-foreground">{report.bar.description}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs" data-testid={`${testid}-measurements`}>
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-2">Measurement</th>
                      <th className="py-1 pr-2">Value</th>
                      <th className="py-1 pr-2">Target</th>
                      <th className="py-1">Met</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.measurements.map((m) => (
                      <tr key={m.key} className="border-t border-border align-top">
                        <td className="py-1 pr-2">
                          {m.label}
                          <div className="text-muted-foreground">{m.note}</div>
                        </td>
                        <td
                          className={`py-1 pr-2 font-mono ${m.value === null ? "text-warning" : ""}`}
                          data-testid={`${testid}-value-${m.key}`}
                        >
                          {formatValue(m)}
                        </td>
                        <td className="py-1 pr-2 font-mono">{m.target}</td>
                        <td className="py-1 font-mono">
                          {m.met === null ? "—" : m.met ? "yes" : "no"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-md border border-border p-2">
              <div className="font-medium">The owner press</div>
              <div className="mt-1 font-mono text-xs" data-testid={`${testid}-press-label`}>
                {report.ownerPress.label}
              </div>
              <div className="mt-1 text-xs" data-testid={`${testid}-press-availability`}>
                {report.ownerPress.available
                  ? "Available: the bar is met. This card does not take the press — it is yours."
                  : `Not available: ${report.ownerPress.unavailableReason ?? "the bar is not met"}`}
              </div>
              <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
                {report.ownerPress.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              <div className="mt-2 text-xs">
                <div className="font-medium">What pressing would change</div>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                  {report.ownerPress.whatItChanges.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={onReload} disabled={loading} data-testid={`${testid}-reload`}>
                Reload
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowRaw((v) => !v)} data-testid={`${testid}-raw-toggle`}>
                {showRaw ? "Hide" : "Show"} raw server response
              </Button>
              <span className="text-xs text-muted-foreground">Generated {report.generatedAtIso}</span>
            </div>
            {showRaw && (
              <pre
                className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-snug"
                data-testid={`${testid}-raw`}
              >
                {JSON.stringify(report, null, 2)}
              </pre>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
