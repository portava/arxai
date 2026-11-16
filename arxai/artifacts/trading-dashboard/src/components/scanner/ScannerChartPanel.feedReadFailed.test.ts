// Source-scan guard — a failed feed read is stated on every trade surface.
//
// resolveTradeAffordance warns "Feed status couldn't be checked" only when the
// caller passes the feed read's failure ({ isError }). With truth=null and no
// third argument a FAILED /api/chart/candles read is indistinguishable from
// "still loading" and the surface stays silent. Round 1 wired this into the
// Scanner trade modal only; the chart trade controls (ScannerChartPanel) and
// the Selected Market panel + its live ticket stayed silent for the same
// unknown feed.
//
// ScannerChartPanel imports lightweight-charts and cannot render headlessly
// (see ScannerChartPanel.refresh-affordance.test.ts), so this asserts the
// source contract: every resolveTradeAffordance call in a trade surface passes
// the feed read's isError from useScannerTruth. Comments are stripped first.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

function code(file: string): string {
  return readFileSync(join(HERE, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line))
    .join("\n");
}

/** Every resolveTradeAffordance(...) call's argument text (balanced parens). */
function affordanceCalls(src: string): string[] {
  const out: string[] = [];
  const re = /resolveTradeAffordance\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

describe.each(["ScannerChartPanel.tsx", "SelectedMarketPanel.tsx", "ScannerTradeModal.tsx"])(
  "%s passes the feed read's failure to resolveTradeAffordance",
  (file) => {
    const src = code(file);
    const calls = affordanceCalls(src);

    it("has at least one affordance call", () => {
      expect(calls.length).toBeGreaterThan(0);
    });

    it("reads isError from useScannerTruth", () => {
      expect(src).toMatch(/const\s*\{[^}]*\bisError\s*:\s*(\w+)[^}]*\}\s*=\s*useScannerTruth\(/);
    });

    it("every call passes { isError: <that flag> }", () => {
      const flag = /const\s*\{[^}]*\bisError\s*:\s*(\w+)[^}]*\}\s*=\s*useScannerTruth\(/.exec(src)?.[1];
      expect(flag).toBeTruthy();
      for (const args of calls) {
        expect(args).toMatch(new RegExp(`\\{\\s*isError:\\s*${flag}\\s*\\}`));
      }
    });
  },
);
