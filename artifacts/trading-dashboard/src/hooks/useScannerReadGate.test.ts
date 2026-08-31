// Fail-closed guard test for useScannerReadGate.
//
// CONTRACT under test (see useScannerReadGate.ts):
//   - Only a RESOLVED truth whose analysis.level === "full" lifts the gate.
//   - A null truth (candles fetch failed, still resolving, or never ran) is
//     DOWNGRADED — the gate must fail closed, because a gate that fails open
//     would let confident GO/grade/score gauges render exactly when the
//     feed-truth check itself is broken.
//   - When truth is null, `reason` carries an honest explanation (never null),
//     so downgrade panels don't render an empty why.
//
// READ-ONLY / OFFLINE: useScannerTruth and useScannerTimeframe are mocked; no
// network, no react-query.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ScannerTruth } from "@/lib/scannerTruth";

const mockUseScannerTruth = vi.fn();
vi.mock("@/hooks/useScannerTruth", () => ({
  useScannerTruth: (...args: unknown[]) => mockUseScannerTruth(...args),
}));
vi.mock("@/hooks/useScannerTimeframe", () => ({
  useScannerTimeframe: () => ["M15", () => {}],
}));

// Imported AFTER the mocks (vi.mock is hoisted) so the hook binds the stubs.
import { useScannerReadGate } from "./useScannerReadGate";

function truthWithLevel(level: string, reason = "why"): ScannerTruth {
  return { analysis: { level, reason } } as unknown as ScannerTruth;
}

beforeEach(() => {
  mockUseScannerTruth.mockReset();
});

describe("useScannerReadGate (fail-closed)", () => {
  it("full truth → not downgraded", () => {
    mockUseScannerTruth.mockReturnValue({ truth: truthWithLevel("full") });
    const { result } = renderHook(() => useScannerReadGate("EURUSD"));
    expect(result.current.isFull).toBe(true);
    expect(result.current.downgraded).toBe(false);
  });

  it("non-full truth (limited) → downgraded with the truth's reason", () => {
    mockUseScannerTruth.mockReturnValue({
      truth: truthWithLevel("limited", "Feed delayed."),
    });
    const { result } = renderHook(() => useScannerReadGate("EURUSD"));
    expect(result.current.downgraded).toBe(true);
    expect(result.current.level).toBe("limited");
    expect(result.current.reason).toBe("Feed delayed.");
  });

  it("null truth (fetch failure / unresolved) → FAIL-CLOSED downgraded, honest reason", () => {
    mockUseScannerTruth.mockReturnValue({ truth: null });
    const { result } = renderHook(() => useScannerReadGate("EURUSD"));
    expect(result.current.isFull).toBe(false);
    // The old fail-open bug: truth == null used to yield downgraded=false,
    // letting GO pills / grades / score gauges render over a dead truth check.
    expect(result.current.downgraded).toBe(true);
    expect(result.current.level).toBeNull();
    expect(result.current.reason).toMatch(/hasn't confirmed/);
  });
});
