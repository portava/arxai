// Source-scan guard — "no chart surface renders a live-price marker outside
// isLivePriceDisplay()" (Task #351).
//
// The behavioural truth table for the honesty rule lives in
// chart-display-status.test.ts. THIS test is the cross-cutting guard: it walks
// every chart component that renders a candlestick series and asserts each one
// routes its live-price affordance (the series' last-value / price-line label)
// through the shared chart-display-status module, instead of re-implementing the
// live/stale decision locally or relying on lightweight-charts' live-by-default
// last-value label.
//
// Why a source-scan: lightweight-charts can't be rendered headlessly here, and
// the failure mode we must prevent is structural — a NEW chart (or an edit to an
// existing one) that draws a candlestick series while either (a) not gating the
// last-value/price-line label, or (b) hardcoding it to `true`. Both make the
// chart look more live than the feed actually is.
//
// TradingViewLiveChart is intentionally NOT covered: it embeds the third-party
// TradingView widget (no ARX candlestick series, badged "REFERENCE FEED"), so it
// has no ARX live-price affordance to gate. The scan keys off `CandlestickSeries`
// precisely so reference-only charts are excluded automatically.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENTS_DIR = join(HERE, "..", "components");

// Recursively collect every .tsx/.ts file under src/components.
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if ((full.endsWith(".tsx") || full.endsWith(".ts")) && !full.endsWith(".test.tsx") && !full.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

// A chart "renders a candlestick series" iff it references the v5
// CandlestickSeries definition AND actually instantiates one via addSeries.
function rendersCandlestickSeries(src: string): boolean {
  return src.includes("CandlestickSeries") && /addSeries\(\s*CandlestickSeries/.test(src);
}

const candlestickCharts = collectSourceFiles(COMPONENTS_DIR)
  .filter((f) => rendersCandlestickSeries(readFileSync(f, "utf8")))
  .map((f) => ({ path: f, src: readFileSync(f, "utf8") }));

// ── Marker / overlay live-affordance detection (Task #352) ──────────────────
//
// The checks above only cover the series' last-value / price-line LABEL. A
// future chart could imply a live price a DIFFERENT way: a price line or a
// series marker explicitly titled "Live" / "Now" / "Current" (a pulsing live
// dot, a "now" marker, a dashed "Current" line). Those must ALSO be suppressed
// on a non-LIVE feed, i.e. gated by the shared isLivePriceDisplay() verdict.
//
// The detector below scans the *argument span* of every chart-drawing call
// (createPriceLine / createSeriesMarkers / setMarkers / the local addLine
// helpers) for a string literal whose text names a live price ("live" / "now" /
// "current") and flags it unless an isLive* gate is present at the call site
// (same line, or the immediately-preceding block). Comments are stripped first
// so the many honest "// …current…" explanatory comments can't trip it.

// Words that, used as a price-line title or marker text, claim a LIVE/current
// price. "Last" is deliberately excluded — the latest-close line is titled
// "Last" and is already covered by the last-value/price-line label checks above.
const LIVE_WORD_RE = /\b(live|now|current)\b/i;

// Chart-drawing calls whose argument span may carry a live-titled affordance.
const DRAW_CALL_RE = /\b(createPriceLine|createSeriesMarkers|setMarkers|addLine)\s*\(/g;

// Strip block + line comments so explanatory prose ("the dashed 'Current' line
// …") can't be mistaken for an affordance literal. The [^:] guard before //
// avoids eating the // inside a "https://" string literal.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// Blank out the CONTENTS of every string / template literal (preserving the
// quotes, length, and newlines) so the *structural* analysis below — paren
// balancing, brace walking, statement boundaries — can never be skewed by a
// stray "(", "{", ";" or the word "if" sitting inside a string literal. The
// unmasked `clean` source is still used to read the literal text itself.
function maskStrings(s: string): string {
  const out = s.split("");
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === "\\") {
          if (j + 1 < s.length && s[j + 1] !== "\n") out[j + 1] = " ";
          out[j] = " ";
          j += 2;
          continue;
        }
        if (s[j] === quote) break;
        if (s[j] !== "\n") out[j] = " ";
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

// Return [start, end) of the balanced "( … )" argument list starting at the
// call's "(" (run on masked source — string parens are already blanked).
function argSpanRange(masked: string, openParenIdx: number): [number, number] {
  let depth = 0;
  for (let i = openParenIdx; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return [openParenIdx, i + 1];
    }
  }
  return [openParenIdx, masked.length];
}

// Does this argument span (read from the UNMASKED source) contain a string /
// template literal whose text claims a live price?
function spanHasLiveLiteral(span: string): boolean {
  const literalRe = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(span)) !== null) {
    if (LIVE_WORD_RE.test(m[2]!)) return true;
  }
  return false;
}

// Same-statement gate: from the previous statement boundary (`;` `{` `}`) up to
// the call, the text both names isLive AND uses a guarding construct — e.g.
// `if (currentPrice != null && isLive) addLine(…, "Current")` or
// `isLive ? series.createPriceLine(…) : null`. (`\?(?!\.)` excludes optional
// chaining `?.` so it isn't mistaken for a ternary guard.)
function gatedBySameStatement(masked: string, callIdx: number): boolean {
  let start = 0;
  for (const ch of [";", "{", "}"]) {
    const idx = masked.lastIndexOf(ch, callIdx - 1);
    if (idx > start) start = idx;
  }
  const stmt = masked.slice(start, callIdx);
  return /isLive/i.test(stmt) && /(\bif\b|&&|\?(?!\.))/.test(stmt);
}

// Enclosing-block gate: walk OUTWARD through every brace that actually encloses
// the call (depth-balanced so sibling `{…}` blocks are skipped) and accept it if
// any enclosing block is controlled by an `if (… isLive …)` / `else if (…)`.
function gatedByEnclosingIf(masked: string, callIdx: number): boolean {
  let depth = 0;
  for (let i = callIdx - 1; i >= 0; i--) {
    const c = masked[i];
    if (c === "}") {
      depth++;
    } else if (c === "{") {
      if (depth === 0) {
        const head = masked.slice(Math.max(0, i - 200), i);
        const ifMatch = /(?:\belse\s+)?\bif\s*\(([\s\S]*)\)\s*$/.exec(head);
        if (ifMatch && /isLive/i.test(ifMatch[1]!)) return true;
        // not an isLive gate — keep walking to the next outer enclosing block.
      } else {
        depth--;
      }
    }
  }
  return false;
}

// A live-titled affordance is honest only when its draw call is structurally
// governed by an isLive* verdict — either on its own statement or inside an
// enclosing `if (isLive…)` block. Mere proximity of an `isLive` token (e.g. an
// earlier `const isLiveDisplay = …`) is NOT sufficient.
function isGatedAtCall(masked: string, callIdx: number): boolean {
  return gatedBySameStatement(masked, callIdx) || gatedByEnclosingIf(masked, callIdx);
}

/**
 * Find every live-titled price-line / marker affordance in `src` that is NOT
 * structurally gated by an isLive* verdict. Returns a human-readable
 * description per violation (empty array = honest).
 */
export function findUngatedLiveAffordances(src: string): string[] {
  const clean = stripComments(src);
  const masked = maskStrings(clean);
  const violations: string[] = [];
  let m: RegExpExecArray | null;
  DRAW_CALL_RE.lastIndex = 0;
  while ((m = DRAW_CALL_RE.exec(masked)) !== null) {
    const callName = m[1]!;
    const openParen = m.index + m[0].length - 1;
    const [spanStart, spanEnd] = argSpanRange(masked, openParen);
    if (!spanHasLiveLiteral(clean.slice(spanStart, spanEnd))) continue;
    if (isGatedAtCall(masked, m.index)) continue;
    const lineNo = clean.slice(0, m.index).split("\n").length;
    violations.push(
      `${callName}(...) near line ${lineNo} draws a live-titled affordance ("live"/"now"/"current") without an isLive* gate — wrap it in isLivePriceDisplay(...)`,
    );
  }
  return violations;
}

describe("chart live-price affordance guard", () => {
  it("finds the known candlestick chart surfaces (sanity check the scan is wired)", () => {
    const names = candlestickCharts.map((c) => c.path.replace(/^.*\/components\//, "components/"));
    // If the scan returns nothing the assertions below would vacuously pass, so
    // anchor it to the surfaces we know directly instantiate a CandlestickSeries
    // today. (ARXNativeChart.tsx now drives lightweight-charts through
    // createChartEngineAdapter() — Task #373 — so it no longer calls
    // addSeries(CandlestickSeries) inline and is intentionally out of this
    // direct-scan's reach.)
    expect(names).toEqual(
      expect.arrayContaining([
        "components/scanner/ScannerChartPanel.tsx",
        "components/positions/PositionMiniChart.tsx",
      ]),
    );
  });

  it("every candlestick chart imports the shared honesty helper isLivePriceDisplay", () => {
    for (const chart of candlestickCharts) {
      const importsHelper =
        chart.src.includes("isLivePriceDisplay") &&
        /from\s+["']@\/lib\/chart-display-status["']/.test(chart.src);
      expect(
        importsHelper,
        `${chart.path} renders a candlestick series but does not import isLivePriceDisplay from @/lib/chart-display-status`,
      ).toBe(true);
    }
  });

  it("every candlestick chart explicitly gates the last-value AND price-line labels (never live-by-default)", () => {
    for (const chart of candlestickCharts) {
      // Both options must be set explicitly so the chart can't fall back to
      // lightweight-charts' live-by-default last-value label.
      expect(
        chart.src.includes("lastValueVisible:"),
        `${chart.path} must explicitly set lastValueVisible (it defaults to true → looks live)`,
      ).toBe(true);
      expect(
        chart.src.includes("priceLineVisible:"),
        `${chart.path} must explicitly set priceLineVisible`,
      ).toBe(true);
    }
  });

  it("no candlestick chart hardcodes its live-price affordance to a literal true/false", () => {
    // The label value must be bound to a live-gated variable (a name containing
    // "isLive" — e.g. isLiveDisplay, isLive, isLivePriceAffordance), never a
    // literal. A literal `true` is the exact regression this guard prevents.
    const optionRe = /(lastValueVisible|priceLineVisible)\s*:\s*([A-Za-z0-9_]+)/g;
    for (const chart of candlestickCharts) {
      let m: RegExpExecArray | null;
      while ((m = optionRe.exec(chart.src)) !== null) {
        const [, option, value] = m;
        expect(
          value === "true" || value === "false",
          `${chart.path} sets ${option}: ${value} — must be a live-gated variable, not a literal`,
        ).toBe(false);
        expect(
          /isLive/i.test(value!),
          `${chart.path} sets ${option}: ${value} — must be derived from isLivePriceDisplay (name should contain "isLive")`,
        ).toBe(true);
      }
    }
  });
});

describe("chart live-marker / overlay affordance guard (Task #352)", () => {
  it("no candlestick chart draws an ungated live-titled price line or marker", () => {
    for (const chart of candlestickCharts) {
      const violations = findUngatedLiveAffordances(chart.src);
      expect(
        violations,
        `${chart.path}:\n  ${violations.join("\n  ")}`,
      ).toEqual([]);
    }
  });

  // Positive controls — prove the detector actually fires, so the real-file
  // assertion above can never pass vacuously after a refactor of the detector.
  it("flags an ungated live-titled createPriceLine", () => {
    const sample = `
      series.createPriceLine({ price: last.close, axisLabelVisible: true, title: "Live" });
    `;
    expect(findUngatedLiveAffordances(sample).length).toBe(1);
  });

  it("flags an ungated 'Now'/'Current' marker drawn via createSeriesMarkers", () => {
    const sample = `
      createSeriesMarkers(series, [{ time: t, position: "aboveBar", shape: "circle", text: "Now" }]);
    `;
    expect(findUngatedLiveAffordances(sample).length).toBe(1);
  });

  it("flags an ungated live marker drawn via the removed v4 setMarkers API", () => {
    const sample = `
      series.setMarkers([{ time: t, position: "aboveBar", shape: "circle", text: "Current" }]);
    `;
    expect(findUngatedLiveAffordances(sample).length).toBe(1);
  });

  it("PASSES the same affordance once it is gated by an isLive* verdict (same line)", () => {
    const sample = `
      if (currentPrice != null && isLive) addLine(currentPrice, "#a1a1aa", "Current", true);
    `;
    expect(findUngatedLiveAffordances(sample)).toEqual([]);
  });

  it("PASSES a live-titled price line gated by isLivePriceDisplay in the enclosing block", () => {
    const sample = `
      const isLiveDisplay = isLivePriceDisplay(resolveDisplayStatus(feedStatus, hasCandles));
      if (isLiveDisplay) {
        series.createPriceLine({ price: last.close, axisLabelVisible: true, title: "Live" });
      }
    `;
    expect(findUngatedLiveAffordances(sample)).toEqual([]);
  });

  it("PASSES a live affordance nested deeper inside an isLive-gated block", () => {
    const sample = `
      if (isLiveDisplay) {
        for (const o of overlays) {
          series.createPriceLine({ price: o.price, axisLabelVisible: true, title: "Now" });
        }
      }
    `;
    expect(findUngatedLiveAffordances(sample)).toEqual([]);
  });

  // Structural-gating regression: an isLive* variable merely DECLARED earlier
  // must NOT count as a gate when the live-titled call sits OUTSIDE the
  // if (isLive…) block. Proximity alone used to false-pass this.
  it("FLAGS a live-titled call outside the if-block even when an isLive var is declared earlier", () => {
    const sample = `
      const isLiveDisplay = isLivePriceDisplay(status);
      if (isLiveDisplay) { drawSomethingElse(); }
      series.createPriceLine({ price: x, axisLabelVisible: true, title: "Live" });
    `;
    expect(findUngatedLiveAffordances(sample).length).toBe(1);
  });

  it("FLAGS a live affordance after a sibling isLive block (not enclosed by it)", () => {
    const sample = `
      if (isLiveDisplay) { foo(); }
      createSeriesMarkers(series, [{ time: t, position: "aboveBar", shape: "circle", text: "Current" }]);
    `;
    expect(findUngatedLiveAffordances(sample).length).toBe(1);
  });

  it("does NOT flag non-live markers/lines (Entry / SL / TP / BUY-SELL arrows)", () => {
    const sample = `
      addLine(entryPrice, "#3b82f6", "Entry");
      addLine(stopLoss, "#ef4444", "SL");
      addLine(takeProfit, "#10b981", "TP");
      createSeriesMarkers(series, [{ time: t, position: "belowBar", shape: "arrowUp", text: "BUY @ 1.2345" }]);
    `;
    expect(findUngatedLiveAffordances(sample)).toEqual([]);
  });

  it("does NOT trip on the word 'current' appearing only in a comment", () => {
    const sample = `
      // The dashed "Current" line is a live-price affordance — draw it only when live.
      addLine(takeProfit, "#10b981", "TP");
    `;
    expect(findUngatedLiveAffordances(sample)).toEqual([]);
  });
});
