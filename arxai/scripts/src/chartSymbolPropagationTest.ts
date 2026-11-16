// Static regression test for chart symbol propagation.
//
// Asserts the architectural rule that every UI surface listed in the
// "selectedSymbol single source of truth" contract reads from the
// shared chart-symbol bus (`useChartSymbol`) rather than defining its
// own local `useState` for the symbol.
//
// Also asserts:
//   - ChartTradeEntry renders BOTH LiveSharedTradeTicket and
//     LiveTradeTicket (one-modal, routed by access.canTrade) so chart
//     Buy/Sell inherits the current chart symbol via the same bus.
//   - ChartTradeEntry no longer ships the long "Nothing fires from this
//     card" copy.
//   - LiveSharedTradeTicket clears stale SL/TP and validation when the
//     defaultSymbol prop changes while the dialog is already open.
//
// Run: pnpm --filter @workspace/scripts run test:chart-symbol-propagation

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd(), "..");
const F = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const must = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

const liveAi = F("artifacts/trading-dashboard/src/pages/live-ai-assist.tsx");
must(
  "live-ai-assist imports useChartSymbol",
  /from\s+"@\/lib\/use-chart-symbol"/.test(liveAi) && /useChartSymbol\s*\(/.test(liveAi),
);
must(
  "live-ai-assist no longer holds a local useState for the symbol",
  !/useState\s*\(\s*SYMBOLS\s*\[\s*0\s*\]\s*\.\s*value\s*\)/.test(liveAi),
);
must(
  "live-ai-assist dropdown writes through setChartSymbol",
  /setChartSymbol\s*\(/.test(liveAi),
);

const chartEntry = F("artifacts/trading-dashboard/src/components/charts/ChartTradeEntry.tsx");
must(
  "ChartTradeEntry reads the shared bus",
  /useChartSymbol\s*\(\s*\)/.test(chartEntry),
);
must(
  "ChartTradeEntry routes to LiveSharedTradeTicket when canTrade",
  /LiveSharedTradeTicket/.test(chartEntry) && /useMasterLiveAccess/.test(chartEntry),
);
must(
  "ChartTradeEntry still has the standard ticket fallback",
  /LiveTradeTicket/.test(chartEntry),
);
must(
  'ChartTradeEntry removed the verbose "Nothing fires from this card" copy',
  !/Nothing fires from this card/i.test(chartEntry),
);
must(
  'ChartTradeEntry uses the short "Opens trade ticket. Final confirmation required." copy',
  /Opens trade ticket\. Final confirmation required\./.test(chartEntry),
);

const tvChart = F("artifacts/trading-dashboard/src/components/charts/TradingViewLiveChart.tsx");
must(
  "TradingViewLiveChart broadcasts symbol changes via setChartSymbol",
  /broadcastChartSymbol|setChartSymbol/.test(tvChart),
);
must(
  "TradingViewLiveChart disables in-widget symbol search (forces React-controlled changes)",
  /allow_symbol_change:\s*false/.test(tvChart),
);

const sharedTicket = F("artifacts/trading-dashboard/src/components/live/LiveSharedTradeTicket.tsx");
must(
  "LiveSharedTradeTicket clears stale state when defaultSymbol changes while open",
  /useEffect\s*\(\s*\(\s*\)\s*=>\s*{[\s\S]*?if\s*\(\s*!\s*open\s*\)\s*return[\s\S]*?setSL\(\s*""\s*\)[\s\S]*?setExecResult\(\s*null\s*\)[\s\S]*?},\s*\[\s*defaultSymbol\s*\]/m.test(
    sharedTicket,
  ),
  "expected dedicated useEffect on [defaultSymbol] that resets SL/TP and the prior exec result when open",
);
must(
  "LiveSharedTradeTicket still locks actions while preview/mode-unresolved",
  /actionsLocked\s*=\s*isPreviewing\s*\|\|\s*modeUnresolved/.test(sharedTicket),
);
must(
  "LiveSharedTradeTicket has the preview banner",
  /live-shared-preview-banner/.test(sharedTicket),
);

const useTradability = F("artifacts/trading-dashboard/src/lib/useTradability.ts");
must(
  "useTradability has an AbortController 8s timeout (stale-request cancellation)",
  /AbortController/.test(useTradability) && /(8_?000|8000)/.test(useTradability),
);

const scannerModal = F("artifacts/trading-dashboard/src/components/scanner/ScannerTradeModal.tsx");
must(
  "ScannerTradeModal short-circuits to LiveSharedTradeTicket for approved live-shared users (one-modal)",
  /LiveSharedTradeTicket/.test(scannerModal) && /liveSharedAccess.*canTrade/.test(scannerModal),
);
must(
  'ScannerTradeModal removed the "Use LIVE SHARED above" intermediate prompt',
  !/Use\s+LIVE\s+SHARED\s+above/i.test(scannerModal),
);

// --- Scope A (T007): top-bar SymbolPicker propagates to the shared chart bus ---
const symbolPicker = F("artifacts/trading-dashboard/src/components/layout/SymbolPicker.tsx");
must(
  "SymbolPicker writes the shared chart bus on selection (setChartSymbol)",
  /from\s+"@\/lib\/use-chart-symbol"/.test(symbolPicker) && /setChartSymbol\s*\(/.test(symbolPicker),
);
must(
  "SymbolPicker canonicalises the picked symbol via resolveSymbol before writing the bus",
  /from\s+"@\/lib\/symbolRegistry"/.test(symbolPicker) && /resolveSymbol\s*\(/.test(symbolPicker),
);
must(
  "SymbolPicker label reflects the chart bus (useChartSymbol) so it never drifts from the explorer",
  /useChartSymbol\s*\(/.test(symbolPicker) && /bareSymbol\s*\(/.test(symbolPicker),
);
must(
  "SymbolPicker still keeps the legacy SymbolProvider in sync (setActive)",
  /setActive\s*\(/.test(symbolPicker),
);

// --- Scope B (T007): mobile trade-modal close control stays on-screen ---
must(
  "ScannerTradeModal uses dvh (visible viewport) so the modal fits a mobile viewport",
  /max-h-\[90dvh\]/.test(scannerModal),
);
must(
  "ScannerTradeModal disables horizontal overflow (no sideways scroll on mobile)",
  /overflow-x-hidden/.test(scannerModal),
);
must(
  "ScannerTradeModal header clears the absolute close (X) so it stays tappable (pr-9)",
  /min-w-0 pr-9/.test(scannerModal),
);
must(
  "ScannerTradeModal footer honours the bottom safe-area inset",
  /env\(safe-area-inset-bottom\)/.test(scannerModal),
);
must(
  "ScannerTradeModal Cancel control is addressable for tests (data-testid)",
  /data-testid="scanner-trade-cancel"/.test(scannerModal),
);

let pass = 0, fail = 0;
for (const c of checks) {
  if (c.ok) { pass++; continue; }
  fail++;
  console.log(`  FAIL ${c.name}${c.detail ? " — " + c.detail : ""}`);
}
console.log(`chart-symbol-propagation: ${pass}/${pass + fail} PASS`);
process.exit(fail === 0 ? 0 : 1);
