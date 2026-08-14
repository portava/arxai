// CI guard — scanner-selected-market-safety
//
// Asserts that the Scanner Direct Symbol Selection + Ruby Market
// Explanation panel cannot regress into a live-trading bypass and
// cannot leak secrets through its read-only surface.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult } from "./_lib.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
function read(p: string): string { return readFileSync(join(ROOT, p), "utf-8"); }

const FORBIDDEN_SECRETS = [
  "MT5_BRIDGE_TOKEN",
  "X-MT5-Bridge-Token",
  "SESSION_SECRET",
  "apiKeyHash",
];

export function checkScannerSelectedMarket(): CheckResult {
  const violations: string[] = [];

  let norm = "";
  try { norm = read("artifacts/api-server/src/lib/scannerSelected/symbolNormalize.ts"); }
  catch { violations.push("lib/scannerSelected/symbolNormalize.ts missing"); }
  if (norm && !/export function normalizeSymbol/.test(norm)) {
    violations.push("symbolNormalize.ts must export normalizeSymbol");
  }
  if (norm && !/SUPPORTED_SYMBOLS/.test(norm)) {
    violations.push("symbolNormalize.ts must export SUPPORTED_SYMBOLS");
  }

  let svc = "";
  try { svc = read("artifacts/api-server/src/lib/scannerSelected/selectedMarket.ts"); }
  catch { violations.push("lib/scannerSelected/selectedMarket.ts missing"); }
  if (svc && !/scoreNewsRisk/.test(svc)) {
    violations.push("selectedMarket.ts must reuse scoreNewsRisk (no parallel news scorer)");
  }
  if (svc && !/economicEventsTable/.test(svc)) {
    violations.push("selectedMarket.ts must read economic_events via Drizzle (no parallel calendar store)");
  }
  // Task #518: the selected-market panel must analyze REAL broker candles, not
  // simulator data. The builder must reuse the brain's candle-injectable signal
  // engine (analyzeMarketFromCandles) fed from the canonical chart pipeline
  // (getChartCandles), and apply the Task #512 stale-level guard
  // (evaluateLevelStaleness). It must NOT call the simulator-backed
  // analyzeMarket() — that is exactly the "different price world" regression
  // this surface was fixed to prevent.
  if (svc && !/analyzeMarketFromCandles\(/.test(svc)) {
    violations.push("selectedMarket.ts must reuse analyzeMarketFromCandles (brain signal engine on real candles — no parallel engine)");
  }
  if (svc && /\banalyzeMarket\(/.test(svc)) {
    violations.push("selectedMarket.ts must NOT call the simulator-backed analyzeMarket() (Task #518: real broker candles only)");
  }
  if (svc && !/getChartCandles/.test(svc)) {
    violations.push("selectedMarket.ts must source candles via getChartCandles (canonical chart pipeline — never the simulator)");
  }
  if (svc && !/evaluateLevelStaleness/.test(svc)) {
    violations.push("selectedMarket.ts must apply evaluateLevelStaleness (Task #512 stale-level guard)");
  }
  if (svc && /marketSimulator/.test(svc)) {
    violations.push("selectedMarket.ts must not reference marketSimulator (no simulator data on the live panel)");
  }
  for (const sec of FORBIDDEN_SECRETS) {
    if (svc && svc.includes(sec)) violations.push(`selectedMarket.ts contains forbidden literal: ${sec}`);
  }

  let route = "";
  try { route = read("artifacts/api-server/src/routes/scanner.ts"); }
  catch { violations.push("routes/scanner.ts missing"); }
  if (route && !/\/market-scanner\/selected-market/.test(route)) {
    violations.push("scanner.ts must expose GET /market-scanner/selected-market");
  }
  if (route && !/getSelectedMarketSnapshot/.test(route)) {
    violations.push("scanner.ts must delegate to getSelectedMarketSnapshot");
  }
  if (route && !/SCANNER_SELECTED_SYMBOL_VIEW/.test(route)) {
    violations.push("scanner.ts must audit SCANNER_SELECTED_SYMBOL_VIEW");
  }
  if (route && !/SCANNER_SELECTED_SYMBOL_REFRESH/.test(route)) {
    violations.push("scanner.ts must audit SCANNER_SELECTED_SYMBOL_REFRESH");
  }
  if (route && !/req\.log\.(info|error|warn)/.test(route)) {
    violations.push("scanner.ts must log via req.log (no console.log)");
  }
  // The selected-market handler must NOT dispatch trades; the only
  // place this whole module touches the live pipeline is via the
  // LiveTradeTicket on the client.
  // Strip comments before scanning so historical safety notes don't trip the guard.
  const routeCode = route.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  if (routeCode && /dispatchLiveCommand\(|placeLiveOrderGuarded\(|arx_live_commands/.test(routeCode)) {
    violations.push("scanner.ts must not dispatch or insert live commands");
  }
  for (const sec of FORBIDDEN_SECRETS) {
    if (route && route.includes(sec)) violations.push(`scanner.ts contains forbidden literal: ${sec}`);
  }

  let ticket = "";
  try { ticket = read("artifacts/trading-dashboard/src/components/live/LiveTradeTicket.tsx"); }
  catch { violations.push("components/live/LiveTradeTicket.tsx missing"); }
  if (ticket && !/\/api\/me\/one-click["`\s]/.test(ticket)) {
    violations.push("LiveTradeTicket must read /api/me/one-click settings");
  }
  if (ticket && !/\/api\/me\/one-click\/submit-live/.test(ticket)) {
    violations.push("LiveTradeTicket must be able to post to /api/me/one-click/submit-live");
  }
  if (ticket && !/\/api\/me\/live\/commands/.test(ticket)) {
    violations.push("LiveTradeTicket must keep the manual /api/me/live/commands path");
  }
  if (ticket && !/\/confirm/.test(ticket) || ticket && !/\/dispatch/.test(ticket)) {
    violations.push("LiveTradeTicket must keep manual draft → confirm → dispatch flow");
  }
  if (ticket && !/oneClickActive/.test(ticket)) {
    violations.push("LiveTradeTicket must gate the fast path on oneClickActive (liveOneClickEnabled && canEnableLive)");
  }
  for (const sec of FORBIDDEN_SECRETS) {
    if (ticket && ticket.includes(sec)) violations.push(`LiveTradeTicket contains forbidden literal: ${sec}`);
  }

  let panel = "";
  try { panel = read("artifacts/trading-dashboard/src/components/scanner/SelectedMarketPanel.tsx"); }
  catch { violations.push("components/scanner/SelectedMarketPanel.tsx missing"); }
  if (panel && !/\/api\/market-scanner\/selected-market/.test(panel)) {
    violations.push("SelectedMarketPanel must call /api/market-scanner/selected-market");
  }
  if (panel && !/LiveTradeTicket/.test(panel)) {
    violations.push("SelectedMarketPanel must open the existing LiveTradeTicket (no parallel ticket)");
  }
  for (const sec of FORBIDDEN_SECRETS) {
    if (panel && panel.includes(sec)) violations.push(`SelectedMarketPanel contains forbidden literal: ${sec}`);
  }
  // Name-agnostic after the assistant-name personalization (Task #640): the
  // panel renders "{name} Market Intelligence uses cached …" where {name} is the
  // per-user assistant display name. The safety intent — surfacing the
  // deterministic cached-analysis note — is unchanged; only the leading name is
  // now dynamic, so match the stable tail rather than the literal "Ruby".
  if (panel && !/Market Intelligence uses cached/.test(panel)) {
    violations.push("SelectedMarketPanel must show the deterministic cached-analysis note");
  }

  // Cache adapter — selectedMarket must use the pluggable adapter, not a
  // bare module-level Map (so the same path is ready for a distributed
  // adapter without touching this file).
  let adapter = "";
  try { adapter = read("artifacts/api-server/src/lib/cache/cacheAdapter.ts"); }
  catch { violations.push("lib/cache/cacheAdapter.ts missing"); }
  if (adapter && !/export function getCache\(/.test(adapter)) {
    violations.push("cacheAdapter.ts must export getCache()");
  }
  if (adapter && !/export function describeCacheRuntime\(/.test(adapter)) {
    violations.push("cacheAdapter.ts must export describeCacheRuntime()");
  }
  if (adapter && !/ARX_CACHE_MODE/.test(adapter)) {
    violations.push("cacheAdapter.ts must read ARX_CACHE_MODE for mode selection");
  }
  if (svc && !/getCache\(/.test(svc)) {
    violations.push("selectedMarket.ts must obtain its cache via getCache() (pluggable adapter)");
  }
  if (svc && /new Map<string,\s*\{\s*at:\s*number/.test(svc)) {
    violations.push("selectedMarket.ts must not keep its own ad-hoc TTL Map after cache-adapter refactor");
  }

  // Admin diagnostics surface must expose cache mode + warning to operators.
  let adminPerf = "";
  try { adminPerf = read("artifacts/api-server/src/routes/adminPerformance.ts"); }
  catch { violations.push("routes/adminPerformance.ts missing"); }
  if (adminPerf && !/describeCacheRuntime/.test(adminPerf)) {
    violations.push("adminPerformance.ts must expose describeCacheRuntime() to operators");
  }
  if (adminPerf && !/\/admin\/performance\/cache-mode/.test(adminPerf)) {
    violations.push("adminPerformance.ts must expose GET /admin/performance/cache-mode");
  }
  let diagPage = "";
  try { diagPage = read("artifacts/trading-dashboard/src/pages/admin-diagnostics.tsx"); }
  catch { /* page is optional */ }
  if (diagPage && !/cache-mode/.test(diagPage)) {
    violations.push("admin-diagnostics page must surface the cache-mode endpoint");
  }
  if (diagPage && !/Horizontal-scale warning|horizontally scaled|in-process/.test(diagPage)) {
    violations.push("admin-diagnostics page must show the horizontal-scale / in-process warning");
  }

  return {
    name: "scanner-selected-market-safety",
    ok: violations.length === 0,
    violations,
  };
}
