// Source-scan guard — "the Scanner chart reload button spins + disables while
// busy, and can never double-fire" (Task #544).
//
// ScannerChartPanel is a ~2.3k-line component that imports lightweight-charts
// (which cannot render headlessly here), so a full DOM render is impractical and
// brittle — the same constraint the sibling market-scanner.scan-feedback test
// documents. The affordance we must lock is structural, so this test asserts the
// reload button's source contract directly:
//
//   1. The reload button is DISABLED while a fetch is in flight, so a user can
//      never double-fire candlesQuery.refetch() (the "no double-fire" rule that
//      every other scanner read card already honours via disabled={...isFetching}).
//   2. Both the disabled guard AND the spinner are keyed to candlesQuery.isFetching
//      (true during a manual refetch), NOT the stale candlesQuery.isLoading — which
//      is only true on the FIRST load, so it would leave the button live and
//      un-spinning during a real manual refresh on a card that already has candles.
//
// Comment text is stripped before token assertions so a reworded code comment can
// never false-pass (or false-fail) these checks (see the
// "source-scan-test-false-pass" lesson).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, "ScannerChartPanel.tsx");

const raw = readFileSync(PANEL, "utf8");

// Strip block comments and line comments so token assertions only see
// executable code, never prose in comments.
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => (line.trim().startsWith("//") ? "" : line))
  .join("\n");

// Extract the reload <Button> ... </Button> block around its testid.
function reloadButtonBlock(): string {
  const testIdIdx = code.indexOf('data-testid="scanner-chart-reload"');
  expect(testIdIdx, "the scanner-chart-reload button must exist").toBeGreaterThan(-1);
  const openIdx = code.lastIndexOf("<Button", testIdIdx);
  const closeIdx = code.indexOf("</Button>", testIdIdx);
  expect(openIdx, "reload button open tag").toBeGreaterThan(-1);
  expect(closeIdx, "reload button close tag").toBeGreaterThan(testIdIdx);
  return code.slice(openIdx, closeIdx + "</Button>".length);
}

describe("ScannerChartPanel reload button — spins + disables, never double-fires", () => {
  it("disables the reload button while a fetch is in flight (no double-fire)", () => {
    const block = reloadButtonBlock();
    expect(block).toContain("disabled={candlesQuery.isFetching}");
  });

  it("keys the spinner to the in-flight fetch, not the first-load-only isLoading", () => {
    const block = reloadButtonBlock();
    // NEW: the spinner swap is driven by isFetching (true during a manual refetch).
    expect(block).toMatch(/candlesQuery\.isFetching\s*\?\s*<Loader2/);
    // OLD bug absent: the reload button must not gate its disabled/spin off the
    // bare `loading` (= candlesQuery.isLoading), which is false during a refetch.
    expect(block).not.toMatch(/\{\s*loading\s*\?/);
    expect(block).not.toContain("candlesQuery.isLoading");
  });

  it("still wires the click to a real candle refetch", () => {
    const block = reloadButtonBlock();
    expect(block).toContain("candlesQuery.refetch()");
  });
});
