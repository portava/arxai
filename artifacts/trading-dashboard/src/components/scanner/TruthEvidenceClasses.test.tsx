import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { classifyTruthEvidence, type TruthEvidence } from "@workspace/domain/truth";

// Render proof for the plain-English evidence-class ledger and its mount in the
// Ruby Market Read card. The card's network hooks are stubbed so this stays a
// pure render test; classification itself is proven in the domain and resolver
// suites.

const mockUseGetMeMarketEdge = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
  useGetMeMarketEdge: (...args: unknown[]) => mockUseGetMeMarketEdge(...args),
  getGetMeMarketEdgeQueryKey: () => ["get-me-market-edge"],
}));
vi.mock("@/components/scanner/ScannerReadGate", () => ({ ScannerReadGate: () => null }));
vi.mock("@/hooks/useScannerReadGate", () => ({
  useScannerReadGate: () => ({ truth: null, level: null, isFull: false, downgraded: true, reason: "Confirming market data." }),
}));
const mockUseSymbolTruth = vi.fn();
vi.mock("@/hooks/useSymbolTruth", () => ({
  useSymbolTruth: (...args: unknown[]) => mockUseSymbolTruth(...args),
}));

import { TruthEvidenceClasses } from "./TruthEvidenceClasses";
import { RubyMarketReadCard } from "./RubyMarketReadCard";

const NOW = Date.parse("2026-10-27T12:00:30.000Z");
const CLOSE = "2026-10-27T12:00:00.000Z";

function evidence(over: Partial<Parameters<typeof classifyTruthEvidence>[0]> = {}): TruthEvidence {
  return classifyTruthEvidence({
    nowMs: NOW,
    data: { state: "LIVE_CONFIRMED", source: "mt5_broker", price: 1.1, lastCandleAt: CLOSE, lastTickAt: null },
    news: { providerConnected: false },
    components: {
      scanner: { present: true, asOf: CLOSE },
      flame: { present: false, asOf: null },
      timing: { present: true, asOf: CLOSE },
      scalp: { present: false, asOf: null },
    },
    levels: { withheld: true },
    verdict: { bias: "BULLISH" },
    ...over,
  });
}

afterEach(() => cleanup());

describe("TruthEvidenceClasses", () => {
  it("renders nothing when no classification was supplied", () => {
    const { container } = render(<TruthEvidenceClasses evidence={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("labels each claim in plain English as verified, estimate or unavailable, with its data time", () => {
    render(<TruthEvidenceClasses evidence={evidence()} />);
    const row = (k: string) => screen.getByTestId(`truth-evidence-classes-${k}`);

    expect(row("price").dataset.evidenceClass).toBe("verified");
    expect(row("price").textContent).toContain("Verified");
    expect(row("price").textContent).toContain("Observed on the confirmed live feed.");
    expect(row("price").textContent).toContain("Data time 12:00:00 UTC.");

    expect(row("scanner").dataset.evidenceClass).toBe("estimate");
    expect(row("scanner").textContent).toContain("an estimate, not an observation");
    expect(row("verdict").dataset.evidenceClass).toBe("estimate");

    expect(row("lastTick").dataset.evidenceClass).toBe("unavailable");
    expect(row("lastTick").textContent).toContain("No value is available.");
    expect(row("lastTick").textContent).not.toContain("Data time");
    expect(row("flame").textContent).toContain("no current, matching evidence");
    expect(row("levels").textContent).toContain("withheld");
    expect(row("news").textContent).toContain("No economic calendar is connected.");

    const summary = screen.getByTestId("truth-evidence-classes-summary").textContent ?? "";
    expect(summary).toContain("2 verified");
    expect(summary).toContain("3 estimate");
    expect(summary).toContain("5 unavailable");
    expect(screen.getByTestId("truth-evidence-classes").textContent).toContain("never places or permits a trade");
  });

  it("shows stale claims as stale", () => {
    render(<TruthEvidenceClasses evidence={evidence({ data: { state: "STALE", source: "mt5_broker", price: 1.1, lastCandleAt: CLOSE, lastTickAt: null } })} />);
    const price = screen.getByTestId("truth-evidence-classes-price");
    expect(price.dataset.evidenceClass).toBe("stale");
    expect(price.textContent).toContain("Stale");
    expect(price.textContent).toContain("The feed behind this has gone stale.");
    expect(screen.getByTestId("truth-evidence-classes-summary").textContent).toContain("stale");
  });

  it("never leaks internal reason codes into the rendered copy", () => {
    render(<TruthEvidenceClasses evidence={evidence()} />);
    expect(screen.getByTestId("truth-evidence-classes").textContent).not.toMatch(/[A-Z0-9]+_[A-Z0-9_]+/);
  });
});

describe("RubyMarketReadCard mounts the evidence classes", () => {
  const edge = { data: undefined, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() };

  it("states unavailable claims even while the directional read is withheld", () => {
    mockUseGetMeMarketEdge.mockReturnValue(edge);
    mockUseSymbolTruth.mockReturnValue({
      news: null, data: null,
      evidence: evidence({ data: { state: "UNAVAILABLE", source: null, price: null, lastCandleAt: null, lastTickAt: null }, verdict: { bias: "UNKNOWN" } }),
    });
    render(<RubyMarketReadCard symbol="EURUSD" />);
    const ledger = screen.getByTestId("ruby-market-read-evidence-classes");
    expect(within(ledger).getByTestId("ruby-market-read-evidence-classes-price").dataset.evidenceClass).toBe("unavailable");
    expect(within(ledger).getByTestId("ruby-market-read-evidence-classes-verdict").textContent).toContain("not enough confirmed data");
  });

  it("renders no ledger when the snapshot carries no classification", () => {
    mockUseGetMeMarketEdge.mockReturnValue(edge);
    mockUseSymbolTruth.mockReturnValue({ news: null, data: null });
    render(<RubyMarketReadCard symbol="EURUSD" />);
    expect(screen.queryByTestId("ruby-market-read-evidence-classes")).toBeNull();
  });
});
