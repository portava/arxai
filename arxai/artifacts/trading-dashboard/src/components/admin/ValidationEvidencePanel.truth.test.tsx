// Real-data validation evidence panel: shows what the server verified, as it is.
//   - zero survivors is shown as a finding ("0 survivors of m tests")
//   - a family that never traded reads "Not searched", never "Rejected"/"no edge"
//   - a hash-verification failure is shown as such, not as evidence
//   - there is no promote / approve / go-live control

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const state: { list: unknown; detail: unknown } = { list: undefined, detail: undefined };
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) =>
    ({ data: queryKey.length > 3 ? state.detail : state.list, isLoading: false }),
}));

const { ValidationEvidencePanel, rowStatus } = await import("./ValidationEvidencePanel");

const manifest = {
  id: "11111111-1111-4111-8111-111111111111", datasetSource: "fixture:real-history-v1",
  datasetHash: "fa83f149997cb8f96f7adfba349a60d409f689712311d32728755549dbc6d232", paramsHash: "a".repeat(64),
  resultHash: "b".repeat(64), codeCommit: "0123456789abcdef0123456789abcdef01234567", codeDirty: false,
  trials: 540, survivors: 0, recordedAt: "2026-11-09T12:00:00.000Z", liveAllowed: false, promotionCeiling: "SHADOW",
};
const row = (over: Record<string, unknown>) => ({
  symbol: "EURUSD", familyKey: "TrendContinuation", variants: 12, activeVariants: 12, survivors: 0,
  bestAnnualisedSharpe: 0.01, bestDsr: 0, pbo: 0.94, walkForwardAnnualisedSharpe: 0.06, walkForwardSurvivor: false,
  rangesDerived: false, ...over,
});
const detail = {
  ok: true,
  run: {
    summary: [row({}), row({ familyKey: "LiquiditySweepReversal", activeVariants: 0, variants: 6, rangesDerived: true })],
    survivors: [],
    fdr: { q: 0.05, familySize: 540, rejections: 0 },
    checks: { cpcvSplitsChecked: 150, cpcvViolations: 0, walkForwardFoldsChecked: 350, walkForwardViolations: 0,
      lookaheadVariantsChecked: 470, lookaheadViolations: [] },
  },
};

afterEach(() => cleanup());

describe("ValidationEvidencePanel", () => {
  it("shows zero survivors as a finding, with the multiplicity it was charged for", () => {
    state.list = { ok: true, items: [{ manifest }] };
    state.detail = detail;
    render(<ValidationEvidencePanel />);
    expect(screen.getByTestId("validation-evidence-survivors").textContent).toContain("0 survivors of 540 tests");
    expect(screen.getByTestId("validation-evidence-checks").textContent).toContain("m=540");
    expect(screen.getByText(/dataset fa83f149997c/)).toBeTruthy();
  });

  it("labels a never-traded family 'Not searched', never as a rejection", () => {
    state.list = { ok: true, items: [{ manifest }] };
    state.detail = detail;
    render(<ValidationEvidencePanel />);
    expect(screen.getByText("Not searched — never traded")).toBeTruthy();
    expect(rowStatus(row({ activeVariants: 0 }) as never)).toBe("Not searched — never traded");
    expect(rowStatus(row({ survivors: 1 }) as never)).toBe("Survived — SHADOW proposal only");
  });

  it("shows an integrity failure as a failure, not as evidence", () => {
    state.list = { ok: true, items: [{ manifest }] };
    state.detail = { ok: false, error: "VALIDATION_EVIDENCE_INTEGRITY", message: "Stored evidence failed hash verification and is not shown as evidence." };
    render(<ValidationEvidencePanel />);
    expect(screen.getByTestId("validation-evidence-integrity").textContent).toContain("failed hash verification");
    expect(screen.queryByText("Rejected")).toBeNull();
  });

  it("reports an unmigrated table honestly", () => {
    state.list = { ok: false, error: "VALIDATION_EVIDENCE_UNAVAILABLE", message: "validation_evidence_v1 could not be read" };
    state.detail = undefined;
    render(<ValidationEvidencePanel />);
    expect(screen.getByTestId("validation-evidence-unavailable").textContent).toContain("could not be read");
  });

  it("offers no promote, approve or live control", () => {
    state.list = { ok: true, items: [{ manifest }] };
    state.detail = detail;
    render(<ValidationEvidencePanel />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(document.body.textContent ?? "").not.toMatch(/go live|approve|promote to live/i);
  });
});
