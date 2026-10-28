// Source-scan guard — the Scanner chart's chips describe what actually
// happened, using the same props and helpers as the ARX Native chart.
//
// ScannerChartPanel imports lightweight-charts, which cannot render headlessly
// here (see ScannerChartPanel.refresh-affordance.test.ts), so the wiring is
// locked structurally; the shared chips themselves are behaviour-tested in
// components/charts/*.test.tsx.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(HERE, "ScannerChartPanel.tsx"), "utf8");
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => (line.trim().startsWith("//") ? "" : line))
  .join("\n");

function jsxBlock(open: string): string {
  const idx = code.indexOf(open);
  expect(idx, `${open} must exist`).toBeGreaterThan(-1);
  return code.slice(idx, code.indexOf("/>", idx) + 2);
}

describe("ScannerChartPanel — deep-history badge", () => {
  it("passes the failed back-page reason, so a failed scroll-back never reads as cached depth", () => {
    const badge = jsxBlock("<ChartHistoryBadge");
    expect(badge).toMatch(/loadError=\{deepHistory\.loadError\}/);
  });
});
