import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// ScannerReadGate is the user-facing surface of the shared scanner-truth
// downgrade decision (Task #391). It must:
//   1. render nothing while truth is still loading,
//   2. render nothing when the read is fully actionable (level === "full"),
//   3. surface a downgrade banner (full) / caption (compact) for every
//      non-full level — so a card can never present a confident read while the
//      shared truth says the data is historical / limited / blocked.
// We mock the shared hooks so this is a pure decision-render proof.

const mockTruth = vi.fn();

vi.mock("@/hooks/useScannerTimeframe", () => ({
  useScannerTimeframe: () => ["5m"],
}));
vi.mock("@/hooks/useScannerTruth", () => ({
  useScannerTruth: () => mockTruth(),
}));

import { ScannerReadGate } from "./ScannerReadGate";

function truthAt(level: string) {
  return { truth: { analysis: { level, reason: `reason for ${level}` } } };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ScannerReadGate — shared-truth downgrade surface", () => {
  it("renders nothing while truth is unresolved", () => {
    mockTruth.mockReturnValue({ truth: null });
    const { container } = render(<ScannerReadGate symbol="EURUSD" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the read is fully actionable", () => {
    mockTruth.mockReturnValue(truthAt("full"));
    const { container } = render(<ScannerReadGate symbol="EURUSD" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the full banner on a non-full level", () => {
    mockTruth.mockReturnValue(truthAt("historical_only"));
    render(<ScannerReadGate symbol="EURUSD" />);
    expect(screen.getByTestId("scanner-read-gate")).toBeTruthy();
    expect(screen.queryByTestId("scanner-read-gate-compact")).toBeNull();
  });

  it("renders the compact caption on a non-full level", () => {
    mockTruth.mockReturnValue(truthAt("blocked"));
    render(<ScannerReadGate symbol="EURUSD" compact />);
    expect(screen.getByTestId("scanner-read-gate-compact")).toBeTruthy();
    expect(screen.queryByTestId("scanner-read-gate")).toBeNull();
  });

  it("compact gate stays silent when the read is full", () => {
    mockTruth.mockReturnValue(truthAt("full"));
    const { container } = render(<ScannerReadGate symbol="EURUSD" compact />);
    expect(container.firstChild).toBeNull();
  });
});
