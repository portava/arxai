// Source-scan guard — "every scanner trade surface consults feed truth before
// letting a user act" (Task #464).
//
// The behavioural truth table for the affordance rule lives in
// trade-affordance.test.ts. THIS test is the cross-cutting structural guard: it
// asserts that each trade-action surface on the scanner imports the shared
// resolveTradeAffordance helper AND reads the shared scanner truth, so a new
// surface (or an edit) can't silently let a user trade on a stale/historical
// read while it looks live.
//
// Why a source-scan: the components can't be rendered headlessly here, and the
// failure mode is structural — a surface that opens a trade ticket / places an
// order WITHOUT routing through the feed-truth affordance. We pin the known
// surfaces so this can never pass vacuously.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

// The scanner surfaces from which a user can initiate a trade and which must
// therefore consult feed truth (resolveTradeAffordance) before acting.
const TRADE_SURFACES = [
  "components/scanner/ScannerTradeModal.tsx",
  "components/scanner/SelectedMarketPanel.tsx",
  "components/scanner/ScannerChartPanel.tsx",
];

describe("scanner trade surfaces consult feed truth (Task #464)", () => {
  it("every trade surface imports resolveTradeAffordance from the shared helper", () => {
    for (const rel of TRADE_SURFACES) {
      const src = readFileSync(join(SRC, rel), "utf8");
      const importsHelper =
        src.includes("resolveTradeAffordance") &&
        /from\s+["']@\/lib\/trade-affordance["']/.test(src);
      expect(
        importsHelper,
        `${rel} initiates a trade but does not import resolveTradeAffordance from @/lib/trade-affordance`,
      ).toBe(true);
    }
  });

  it("every trade surface reads the shared scanner truth (useScannerTruth)", () => {
    for (const rel of TRADE_SURFACES) {
      const src = readFileSync(join(SRC, rel), "utf8");
      expect(
        src.includes("useScannerTruth"),
        `${rel} must read shared scanner truth via useScannerTruth before offering a trade action`,
      ).toBe(true);
    }
  });
});
