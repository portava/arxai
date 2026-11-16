// THEME B — hand-weighted heuristics must not be presented as probabilities.
//
// Every "confidence" in this system is an arbitrary weighted sum. None is
// calibrated against realized outcomes — no reliability diagram, no Brier
// score, nothing that would justify reading "82" as "82% of these work out".
// Rendering such a number with a "%" is the misrepresentation: a percentage
// sign is a claim about frequency, and no frequency has been measured.
//
// The audit's minimum fix was "rename in the payload + UI and stop appending
// %". This commit does the part that removes the actual misrepresentation and
// is safe to do now:
//
//   1. NO "%" on an uncalibrated heuristic in the UI. Two surfaces did it:
//        ScannerTradeModal      "Scanner confidence  82%"
//        PreTradeChecklistModal "AI Confidence       88%"
//      Both now show a bounded score with its scale ("82 / 100") and say what
//      it is.
//
//   2. AN EXPLICIT `calibrated: false` MARKER on the review-engine payload,
//      which is the contract the audit asked for: no confidence-shaped field
//      leaves without declaring it is uncalibrated.
//
//   3. `aiReviewEngine.aiConfidence` is documented for what it measures. It is
//      `40 + 6 × (non-null input count)` — a rescaled COUNT of how much data
//      the review had. A trade with every field filled scores 100 whether the
//      review is right or wrong. `inputDataPoints` now carries that fact under
//      an honest name; the old field stays for stored-row compatibility.
//
// NOT DONE HERE (deliberate, flagged for the owner): the full rename of
// `confidenceScore` across scalp/flame/liveScanner/aiBrain payloads. Those
// names are persisted in DB columns and consumed by several UIs, so renaming
// them is a contract migration rather than a patch — and the audit itself
// defers real calibration to the validation harness.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { reviewTrade } from "../aiReviewEngine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

describe("B — the review engine declares itself uncalibrated", () => {
  const out = reviewTrade({
    trade: {
      entryPrice: 1.1,
      exitPrice: 1.105,
      stopLoss: 1.095,
      takeProfit: 1.11,
      entryType: "market",
    } as never,
  } as never);

  it("carries an explicit calibrated:false marker", () => {
    assert.equal(out.calibrated, false);
  });

  it("exposes the honest input count alongside the legacy field", () => {
    assert.equal(typeof out.inputDataPoints, "number");
    assert.ok(out.inputDataPoints >= 0 && out.inputDataPoints <= 10);
  });

  it("aiConfidence is exactly the rescaled input count, nothing more", () => {
    // Proves the field measures the DATA, not the review: it is fully
    // determined by how many inputs were supplied.
    assert.equal(out.aiConfidence, Math.max(0, Math.min(100, 40 + out.inputDataPoints * 6)));
  });

  it("more inputs raise it even when the trade is identical", () => {
    const sparse = reviewTrade({
      trade: { entryPrice: 1.1, entryType: "market" } as never,
    } as never);
    const rich = reviewTrade({
      trade: {
        plannedEntryPrice: 1.1, entryPrice: 1.1, exitPrice: 1.105,
        stopLoss: 1.095, takeProfit: 1.11, riskAmount: 50,
        strategyTag: "bos", reasonForEntry: "break", reasonForExit: "target",
        entryType: "market",
      } as never,
      journalNotes: "a".repeat(40),
    } as never);
    assert.ok(
      rich.aiConfidence > sparse.aiConfidence,
      "confirms it tracks input completeness — which is why it must not read as a probability",
    );
  });
});

describe("B — no uncalibrated heuristic is rendered as a percentage", () => {
  const SURFACES: Array<[string, string]> = [
    ["ScannerTradeModal", "artifacts/trading-dashboard/src/components/scanner/ScannerTradeModal.tsx"],
    ["PreTradeChecklistModal", "artifacts/trading-dashboard/src/components/execution/PreTradeChecklistModal.tsx"],
  ];

  for (const [name, rel] of SURFACES) {
    it(`${name} does not append % to a confidence value`, () => {
      const src = read(rel);
      // Any interpolation of a confidence-ish field immediately followed by "%".
      const offender =
        /\{[^{}]*(confidenceScore|aiConfidence)[^{}]*\}\s*%/.test(src) ||
        /(confidenceScore|aiConfidence)[^\n]*\.toFixed\([^)]*\)\}%/.test(src);
      assert.equal(offender, false, `${name} still presents a heuristic as a percentage`);
    });

    it(`${name} states the scale or the caveat instead`, () => {
      const src = read(rel);
      assert.ok(
        /\/ 100/.test(src) || /not a probability/i.test(src),
        `${name} must show the bounded scale or say it is not a probability`,
      );
    });
  }
});

describe("B — the honest wording is present", () => {
  it("the scanner labels it signal strength, not confidence", () => {
    const src = read("artifacts/trading-dashboard/src/components/scanner/ScannerTradeModal.tsx");
    assert.ok(/Scanner signal strength/.test(src));
    assert.ok(/not a calibrated win probability/i.test(src));
  });

  it("the pre-trade checklist says it is not a probability", () => {
    const src = read("artifacts/trading-dashboard/src/components/execution/PreTradeChecklistModal.tsx");
    assert.ok(/not a probability/i.test(src));
  });
});
