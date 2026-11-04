// Owner screenshot 2026-10-27 12:02 ET (V75 · 1m, Deriv public data, no MT5
// bridge, auto-scan off): the header identity row read
//   "V75 · 1m · 33,588.01 · Idle · Bullish · Developing"
// — three producers glued with dots. "Idle" was the operator auto-scan engine
// (nothing about V75); "Developing" was the composed verdict's engine-agreement
// count (one engine bullish, nothing corroborating), printed bare next to the
// Market Read card's signal-lifecycle "Setup forming". This pins the honest
// labels: no engine state in the market row, and the stage named as what it
// counted, reproduced from the same tally the composer used.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ScannerTruth } from "@/lib/scannerTruth";
import type { TruthComponents, TruthVerdict } from "@workspace/api-client-react";
import { describeEngineAgreement } from "@/lib/engineAgreement";

const OWNER_COMPONENTS: TruthComponents = {
  scanner: { present: true, alignment: "BULLISH", label: "Bullish · Setup forming", asOf: "2026-10-27T16:01:00.000Z" },
  flame: { present: false, alignment: "UNKNOWN", label: "No read.", asOf: null },
  timing: { present: true, alignment: "NEUTRAL", label: "Grade D · Wait for entry", asOf: "2026-10-27T16:01:00.000Z" },
  scalp: { present: false, alignment: "UNKNOWN", label: "No read.", asOf: null },
};

let verdict: Pick<TruthVerdict, "bias" | "stage"> | null = { bias: "BULLISH", stage: "DEVELOPING" };
let components: TruthComponents | null = OWNER_COMPONENTS;

function makeTruth(): ScannerTruth {
  return {
    strip: {
      data: { verdict: "Live", detail: "Live, confirmed candles." },
      ruby: { detail: "" },
      trading: { verdict: "Blocked", detail: "" },
    },
    candles: { lastClose: 33588.01, sourceTechnical: "deriv", count: 200, minRequired: 150, status: "live" },
    consolidated: {
      rubyReadStatus: "FULL_READ",
      scannerActionability: "WAIT_FOR_CONFIRMATION",
      userMessage: "",
      internalReasonCode: "",
    },
    dataHealth: { sourceNote: "Synthetic market." },
  } as unknown as ScannerTruth;
}

vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => ["V75", () => {}],
  bareSymbol: (s: string) => s,
  setChartSymbol: () => {},
}));
vi.mock("@/hooks/useScannerTimeframe", () => ({
  useScannerTimeframe: () => ["1m", () => {}],
}));
vi.mock("@/hooks/useSymbolTruth", () => ({
  useSymbolTruth: () => ({ scannerTruth: makeTruth(), verdict, components }),
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ shouldShowAdminDiagnostics: true }),
}));

import { ScannerHeaderSummary } from "./ScannerHeaderSummary";

afterEach(() => {
  cleanup();
  verdict = { bias: "BULLISH", stage: "DEVELOPING" };
  components = OWNER_COMPONENTS;
});

describe("ScannerHeaderSummary — engine agreement, not three unlabelled stages", () => {
  it("owner state: names the single-engine lean and drops Idle/Developing from the market row", () => {
    render(<ScannerHeaderSummary running={false} />);
    const row = screen.getByTestId("scanner-header-agreement").parentElement!;
    expect(row.textContent).not.toContain("Idle");
    expect(row.textContent).not.toContain("Developing");
    expect(screen.getByTestId("scanner-header-bias").textContent).toBe("Bullish lean");
    const chip = screen.getByTestId("scanner-header-agreement");
    expect(chip.textContent).toBe("1 of 2 engines bullish · unconfirmed");
    const title = chip.getAttribute("title") ?? "";
    expect(title).toContain("Scanner — bullish (Bullish · Setup forming)");
    expect(title).toContain("Timing — neutral (Grade D · Wait for entry)");
    expect(title).toContain("Flame (momentum) — no read");
    expect(title).toContain("Scalp — no read");
  });

  it("never prints the auto-scan engine state in the header, running or not", () => {
    render(<ScannerHeaderSummary running />);
    expect(screen.queryByText("Scanning")).toBeNull();
    expect(screen.queryByText(/Auto-scan/)).toBeNull();
  });

  it("UNKNOWN stage (capped / unreadable) renders no count and no stage word", () => {
    verdict = { bias: "UNKNOWN", stage: "UNKNOWN" };
    render(<ScannerHeaderSummary />);
    expect(screen.queryByTestId("scanner-header-agreement")).toBeNull();
    expect(screen.queryByTestId("scanner-header-bias")).toBeNull();
  });

  it("components missing from the payload: no count is invented", () => {
    components = null;
    render(<ScannerHeaderSummary />);
    expect(screen.queryByTestId("scanner-header-agreement")).toBeNull();
    // Bias stays the server's plain word; it is not qualified with a guessed count.
    expect(screen.getByTestId("scanner-header-bias").textContent).toBe("Bullish");
  });
});

describe("describeEngineAgreement — count reproduces the composer's stage", () => {
  it("ALIGNED: two bullish engines agree", () => {
    const c: TruthComponents = {
      ...OWNER_COMPONENTS,
      flame: { present: true, alignment: "BULLISH", label: "Igniting", asOf: null },
    };
    expect(describeEngineAgreement({ bias: "BULLISH", stage: "ALIGNED" }, c)?.chip).toBe("2 of 3 engines bullish · agree");
  });

  it("CONFLICT: names both sides", () => {
    const c: TruthComponents = {
      ...OWNER_COMPONENTS,
      scalp: { present: true, alignment: "BEARISH", label: "Ready (short)", asOf: null },
    };
    const out = describeEngineAgreement({ bias: "CONFLICT", stage: "CONFLICT" }, c);
    expect(out?.chip).toBe("Engines disagree · 1 bullish, 1 bearish");
    expect(out?.biasLabel).toBeNull();
  });

  it("DEVELOPING with only neutral readers says none leans", () => {
    const c: TruthComponents = {
      ...OWNER_COMPONENTS,
      scanner: { present: true, alignment: "NEUTRAL", label: "Neutral · Watching", asOf: null },
    };
    expect(describeEngineAgreement({ bias: "NEUTRAL", stage: "DEVELOPING" }, c)?.chip).toBe("2 engines read · none leans either way");
  });

  it("a stage the components cannot reproduce is not labelled (fail closed)", () => {
    expect(describeEngineAgreement({ bias: "BULLISH", stage: "ALIGNED" }, OWNER_COMPONENTS)).toBeNull();
  });
});
