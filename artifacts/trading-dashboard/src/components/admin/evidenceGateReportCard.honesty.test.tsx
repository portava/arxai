// The evidence-gate report card must not render a confident-looking
// dashboard over nothing.
//
// Both flags this card serves (#4 conformal authority, #27 execution-policy
// promotion) sit at a ZERO sample today. The failure mode is not a wrong
// number — it is a card that looks measured: an empty progress bar reading
// "0%", a green tick because nothing failed, a press button that is enabled
// because no blocker was found. Each of those would tell the owner the bar
// was checked when it was not.
//
// Locked here:
//   * a null measurement renders the words NOT MEASURED, never "0";
//   * an unreadable source renders visibly differently from a sample of 0;
//   * a feed with no production writer says so;
//   * the number rendered against the arming bar is the BARRED quantity, not
//     the feed total — the two count different things, and printing one
//     under the other lets a skimmer read an unmet bar as met;
//   * the card carries NO press — it informs one.
//
// Run: pnpm --filter @workspace/trading-dashboard run test:evidence-gate-card

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  EvidenceGateReportCard,
  type EvidenceGateReport,
} from "./EvidenceGateReportCard";

afterEach(cleanup);

function report(over: Partial<EvidenceGateReport> = {}): EvidenceGateReport {
  return {
    gateId: "conformal-authority",
    title: "Conformal authority",
    verdict: "INSUFFICIENT_HISTORY",
    verdictReason: "no labeled advisory predictions have been journaled",
    barMet: false,
    bar: {
      description: "empirical coverage within ±0.05 of 0.9 over ≥200 records",
      requiredSampleSize: 200,
      requiredSampleLabel: "labeled predictions in the LATER chronological evaluation window",
      requiredSampleMeasurementKey: "evaluationWindowSize",
    },
    sampleSize: 0,
    sampleLabel: "labeled predictions journaled in total",
    window: null,
    feed: {
      feedId: "CONFORMAL_ADVISORY_PREDICTION",
      writerWired: false,
      writerNote: "No production call site writes this feed.",
      rowsRead: 0,
      unreadableRows: 0,
      sourceError: null,
    },
    measurements: [
      {
        key: "evaluationWindowSize",
        label: "Evaluation-window records (later chronological window)",
        value: 0,
        unit: "count",
        target: "≥ 200",
        met: false,
        note: "no labeled predictions have been journaled at all",
      },
      {
        key: "empiricalCoverage",
        label: "Empirical coverage",
        value: null,
        unit: "ratio",
        target: "within ±0.05 of 0.9",
        met: null,
        note: "NOT MEASURED — the evaluation window is empty",
      },
    ],
    ownerPress: {
      label: "Set ARX_CONFORMAL_GATE_ENABLED=true",
      steps: ["Confirm the verdict is BAR_MET."],
      available: false,
      unavailableReason: "the arming bar is not met",
      whatItChanges: ["TODAY: NOTHING."],
    },
    generatedAtIso: "2026-08-29T00:00:00.000Z",
    readOnly: true,
    ...over,
  };
}

const noop = () => {};

describe("EvidenceGateReportCard honesty", () => {
  it("renders a null measurement as NOT MEASURED, never as 0", () => {
    render(<EvidenceGateReportCard report={report()} error="" loading={false} onReload={noop} testid="c" />);
    const cell = screen.getByTestId("c-value-empiricalCoverage");
    expect(cell.textContent).toBe("NOT MEASURED");
    expect(cell.textContent).not.toMatch(/^0/);
  });

  it("states the verdict as INSUFFICIENT HISTORY rather than a pass", () => {
    render(<EvidenceGateReportCard report={report()} error="" loading={false} onReload={noop} testid="c" />);
    expect(screen.getByTestId("c-verdict").textContent).toMatch(/INSUFFICIENT HISTORY/);
    expect(screen.getByTestId("c-verdict").textContent).not.toMatch(/BAR MET/);
  });

  it("distinguishes an unreadable source from a sample of zero", () => {
    const { unmount } = render(
      <EvidenceGateReportCard report={report()} error="" loading={false} onReload={noop} testid="c" />,
    );
    expect(screen.getByTestId("c-sample").textContent).toMatch(
      /^0 — labeled predictions journaled in total/,
    );
    unmount();

    render(
      <EvidenceGateReportCard
        report={report({
          verdict: "SOURCE_UNREADABLE",
          sampleSize: null,
          feed: { ...report().feed, rowsRead: null, sourceError: "connection refused" },
        })}
        error=""
        loading={false}
        onReload={noop}
        testid="d"
      />,
    );
    expect(screen.getByTestId("d-sample").textContent).toMatch(/could not read/);
    expect(screen.getByTestId("d-sample").textContent).not.toMatch(/^0/);
    expect(screen.getByTestId("d-feed").textContent).toMatch(/connection refused/);
  });

  // ── The sample tile must never invite "sample ≥ requirement, so met" ─────
  //
  // The regression this locks: at exactly 200 journaled records the report's
  // chronological split leaves an evaluation window of 100 and the verdict is
  // INSUFFICIENT_HISTORY — yet the tile used to print "200 records" over "Bar
  // requires 200." An owner glancing at the one number would read it as met.

  it("renders the BARRED quantity against the requirement, not the feed total", () => {
    render(
      <EvidenceGateReportCard
        report={report({
          // Exactly at the requirement by total, nowhere near it by window.
          sampleSize: 200,
          measurements: [
            {
              key: "evaluationWindowSize",
              label: "Evaluation-window records (later chronological window)",
              value: 100,
              unit: "count",
              target: "≥ 200",
              met: false,
              note: "200 journaled; 100 spent on calibration",
            },
          ],
        })}
        error=""
        loading={false}
        onReload={noop}
        testid="c"
      />,
    );
    const requirement = screen.getByTestId("c-bar-requirement").textContent ?? "";
    // The measured value of the BARRED quantity is present…
    expect(requirement).toMatch(/100 of 200/);
    // …and the tile never renders the bare "Bar requires 200." that let the
    // adjacent 200 read as satisfying it.
    expect(requirement).not.toMatch(/^Bar requires 200\.$/);
    expect(requirement).toMatch(/narrower than the sample above/);
    // The sample itself says what it counts, so it cannot be read as the bar.
    expect(screen.getByTestId("c-sample").textContent).toMatch(
      /^200 — labeled predictions journaled in total/,
    );
  });

  it("renders an unmeasured barred quantity as NOT MEASURED, never as 0", () => {
    render(
      <EvidenceGateReportCard
        report={report({
          verdict: "SOURCE_UNREADABLE",
          sampleSize: null,
          measurements: [
            {
              key: "evaluationWindowSize",
              label: "Evaluation-window records",
              value: null,
              unit: "count",
              target: "≥ 200",
              met: null,
              note: "NOT MEASURED — source unreadable",
            },
          ],
        })}
        error=""
        loading={false}
        onReload={noop}
        testid="c"
      />,
    );
    const requirement = screen.getByTestId("c-bar-requirement").textContent ?? "";
    expect(requirement).toMatch(/NOT MEASURED of 200/);
    expect(requirement).not.toMatch(/\b0 of 200\b/);
  });

  it("admits it when the report names no barred measurement it can render", () => {
    render(
      <EvidenceGateReportCard
        report={report({
          sampleSize: 200,
          bar: { ...report().bar, requiredSampleMeasurementKey: "notInThisReport" },
        })}
        error=""
        loading={false}
        onReload={noop}
        testid="c"
      />,
    );
    const requirement = screen.getByTestId("c-bar-requirement").textContent ?? "";
    expect(requirement).toMatch(/NOT AVAILABLE/);
    expect(requirement).toMatch(/do not read the sample above/);
  });

  it("says out loud that the feed has no production writer", () => {
    render(<EvidenceGateReportCard report={report()} error="" loading={false} onReload={noop} testid="c" />);
    expect(screen.getByTestId("c-feed").textContent).toMatch(/NO PRODUCTION WRITER/);
  });

  it("shows no window rather than inventing one", () => {
    render(<EvidenceGateReportCard report={report()} error="" loading={false} onReload={noop} testid="c" />);
    expect(screen.getByTestId("c-window").textContent).toMatch(/no evidence to span a window/);
  });

  it("presents the press as unavailable, with the reason, and takes no press itself", () => {
    const { container } = render(
      <EvidenceGateReportCard report={report()} error="" loading={false} onReload={noop} testid="c" />,
    );
    expect(screen.getByTestId("c-press-availability").textContent).toMatch(/Not available/);
    expect(screen.getByTestId("c-press-availability").textContent).toMatch(/arming bar is not met/);
    // The only buttons are Reload and the raw-response toggle. No arm/enable.
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.sort()).toEqual(["Reload", "Show raw server response"]);
    for (const l of labels) expect(l).not.toMatch(/enable|arm|press/i);
  });

  it("does not paint a met tick when the bar IS met without saying whose press it is", () => {
    render(
      <EvidenceGateReportCard
        report={report({
          verdict: "BAR_MET",
          barMet: true,
          sampleSize: 400,
          ownerPress: { ...report().ownerPress, available: true, unavailableReason: null },
        })}
        error=""
        loading={false}
        onReload={noop}
        testid="c"
      />,
    );
    expect(screen.getByTestId("c-verdict").textContent).toMatch(/the press is the owner's/);
    expect(screen.getByTestId("c-press-availability").textContent).toMatch(/it is yours/);
  });

  it("renders a read failure as a failure, not as an empty report", () => {
    render(
      <EvidenceGateReportCard report={null} error="Read failed (500): BOOM" loading={false} onReload={noop} testid="c" />,
    );
    expect(screen.getByTestId("c-error").textContent).toMatch(/Read failed \(500\)/);
    expect(screen.queryByTestId("c-verdict")).toBeNull();
  });
});
