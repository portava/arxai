import { describe, it, expect } from "vitest";
import type { OpportunityMapRow } from "@workspace/api-client-react";
import { DEFAULT_SCREEN, SCREEN_LIMIT, filterScreenRows, parseSavedScreens, parseScreen, prepareScreenRows,
  resolveScreenScope, saveScreen, scannerCsvCell, scannerScreenCsv, scannerSymbolKey, writeSavedScreens } from "./scannerScreen";

const now = Date.parse("2026-10-26T15:00:00Z");
const stamp = new Date(now - 1000).toISOString();
const row = (extra: Partial<OpportunityMapRow> = {}): OpportunityMapRow => ({ symbol: "EURUSD", displayName: "Euro",
  direction: "BUY", recommendedAction: "BUY", setupType: "Trend", edgeScore: 70, entryQuality: 60, executionQuality: 80,
  newsRisk: "none", hasLiveData: true, isLate: false, reason: "Rule-based setup", category: "READY_NOW", kind: "MOMENTUM",
  bestAction: "Consider", stageLabel: "Ready", ...extra });
const all = resolveScreenScope(null, [], false, [], []);
const prepared = (rows: OpportunityMapRow[], at = now) => prepareScreenRows(rows, stamp, at, false, () => null);
const saved = (name = "Focus") => ({ name, screen: { ...DEFAULT_SCREEN }, marketGroup: "forex", timeframe: "M5" });

describe("scanner view scope and filters", () => {
  it("matches canonical aliases but never fuzzy prefixes as watchlist membership", () => {
    expect(scannerSymbolKey("Volatility 75 Index")).toBe("V75");
    expect(scannerSymbolKey("eur")).toBe("EUR");
    const rows = [row(), row({ symbol: "V75" })];
    const scope = resolveScreenScope(2, [{ id: 2, name: "Scope", items: [
      { symbol: "Volatility 75 Index" }, { symbol: "V75" }, { symbol: "EUR" }, { symbol: "AUDUSD" },
    ] }], false, rows, [{ symbol: "AUDUSD" }]);
    expect([...scope.symbols!]).toEqual(["V75", "EUR", "AUDUSD"]);
    expect(scope.missingSymbols).toEqual(["EUR"]); expect(scope.skippedCount).toBe(1);
    expect(filterScreenRows(prepared(rows), DEFAULT_SCREEN, scope).map(({ row }) => row.symbol)).toEqual(["V75"]);
  });
  it.each([undefined, []])("fails closed when a saved watchlist is unavailable or deleted", (lists) => {
    const scope = resolveScreenScope(9, lists, false, [row()], []);
    expect(filterScreenRows(prepared([row()]), DEFAULT_SCREEN, scope)).toEqual([]);
    expect(scope.message).toBeTruthy();
  });
  it("does not reuse cached watchlist membership after a failed read", () => {
    const scope = resolveScreenScope(1, [{ id: 1, name: "Old", items: [{ symbol: "EURUSD" }] }], true, [row()], []);
    expect(scope.symbols?.size).toBe(0);
  });
  it("a saved watchlist scope with lists not loaded yet is unavailable, not missing", () => {
    const scope = resolveScreenScope(1, undefined, false, [row()], []);
    expect(scope.symbols?.size).toBe(0);
    expect(scope.message).toContain("Watchlists are unavailable");
    expect(resolveScreenScope(1, [], false, [row()], []).message).toContain("no longer exists");
  });
  it("combines filters without changing row identities or the original timestamp", () => {
    const input = [Object.assign(row(), { generatedAt: stamp }), row({ symbol: "GBPUSD", direction: "SELL", edgeScore: 90 })];
    const original = JSON.stringify(input);
    const result = filterScreenRows(prepared(input), { ...DEFAULT_SCREEN, search: "euro", direction: "BUY", minEdge: 60 }, all);
    expect(result.map(({ row }) => row.symbol)).toEqual(["EURUSD"]);
    expect(result[0].row).toBe(input[0]); expect(JSON.stringify(input)).toBe(original);
  });
  it.each(["category", "direction", "minEdge"])("does not leak expired values through %s filters", (key) => {
    const filters = { category: "READY_NOW", direction: "BUY", minEdge: 50 };
    const selected = { ...DEFAULT_SCREEN, [key]: filters[key as keyof typeof filters] };
    const expired = prepared([row()], now + 30_000);
    expect(filterScreenRows(expired, selected, all)).toEqual([]);
    expect(filterScreenRows(expired, DEFAULT_SCREEN, all)[0].metricsAvailable).toBe(false);
  });
  it("respects server feed limits and selected-symbol caps even in a fresh scan", () => {
    const input = [row(), row({ symbol: "GBPUSD", hasLiveData: false })];
    const entries = prepareScreenRows(input, stamp, now, false, () => "MARKET_CLOSED");
    expect(filterScreenRows(entries, { ...DEFAULT_SCREEN, availability: "confirmed" }, all)).toEqual([]);
    expect(entries.map((e) => e.limitation)).toEqual(["MARKET_CLOSED", "FEED_LIMITED"]);
  });
  it("caps supplied older row timestamps independently and never treats future timestamps as fresh", () => {
    const input = [Object.assign(row(), { generatedAt: new Date(now - 50_000).toISOString() }),
      Object.assign(row({ symbol: "GBPUSD" }), { generatedAt: new Date(now + 10_000).toISOString() })];
    expect(prepared(input).map((e) => e.limitation)).toEqual(["ROW_NEEDS_REFRESH", "ROW_NEEDS_REFRESH"]);
  });
  it("is deterministic for ties across input permutations and sorts unknown scores last", () => {
    const input = [row({ symbol: "USDJPY" }), row({ symbol: "GBPUSD", edgeScore: NaN }), row(), row({ symbol: "AUDUSD", hasLiveData: false, edgeScore: 99 })];
    const symbols = (rows: OpportunityMapRow[]) => filterScreenRows(prepared(rows), DEFAULT_SCREEN, all).map(({ row }) => row.symbol);
    expect(symbols(input)).toEqual(["EURUSD", "USDJPY", "AUDUSD", "GBPUSD"]);
    expect(symbols([...input].reverse())).toEqual(symbols(input));
  });
  it("entry and alphabetical sorts have independent meaning", () => {
    const rows = prepared([row({ entryQuality: 90 }), row({ symbol: "AUDUSD", edgeScore: 95, entryQuality: 20 })]);
    expect(filterScreenRows(rows, { ...DEFAULT_SCREEN, sort: "entry" }, all)[0].row.symbol).toBe("EURUSD");
    expect(filterScreenRows(rows, { ...DEFAULT_SCREEN, sort: "symbol" }, all)[0].row.symbol).toBe("AUDUSD");
  });
});

describe("saved scanner views", () => {
  it("round-trips only validated filters and context, never result data", () => {
    let raw = "";
    writeSavedScreens({ setItem: (_key, value) => { raw = value; } }, [saved()]);
    expect(parseSavedScreens(raw)).toEqual([saved()]);
    expect(parseScreen({ ...DEFAULT_SCREEN, generatedAt: stamp })).toEqual(DEFAULT_SCREEN);
  });
  it.each(["bad json", '{"version":2,"screens":[]}', JSON.stringify({ version: 1, screens: [saved(), { ...saved("Bad"), screen: { ...DEFAULT_SCREEN, minEdge: 101 } }] })])("rejects invalid saved data without losing a valid sibling", (raw) => {
    const parsed = parseSavedScreens(raw);
    expect(parsed.length).toBe(raw.includes('"Bad"') ? 1 : 0);
  });
  it("rejects oversized content and invalid scope/filter values", () => {
    expect(parseSavedScreens(" ".repeat(50_001))).toEqual([]);
    for (const value of [{ watchlistId: -1 }, { direction: "EXECUTE" }, { minEdge: Infinity }, { availability: "LIVE" }, { search: "x".repeat(101) }]) {
      expect(parseScreen({ ...DEFAULT_SCREEN, ...value })).toBeNull();
    }
  });
  it("replaces a matching name deliberately and enforces the saved-view bound", () => {
    expect(saveScreen([saved("Focus")], { ...saved("FOCUS"), screen: { ...DEFAULT_SCREEN, direction: "SELL" } })).toHaveLength(1);
    const full = Array.from({ length: SCREEN_LIMIT }, (_, i) => saved(String(i)));
    expect(() => saveScreen(full, saved("Another"))).toThrow(/up to 20/);
    expect(saveScreen(full, saved("0"))).toHaveLength(20);
  });
  it("propagates quota/storage failure instead of claiming a successful save", () => {
    expect(() => writeSavedScreens({ setItem: () => { throw new Error("quota"); } }, [saved()])).toThrow("quota");
  });
});

describe("scanner CSV", () => {
  it.each(["=1+1", "+SUM(A1:A2)", "-2+3", "@SUM(1)", "＝1+1", "＋1", "－1", "＠SUM(1)", "\t\r =HYPERLINK(\"url\")", "\uFEFF\u200b+1", "\n\u2060@SUM(1)"])("neutralizes formula text %j", (value) => {
    expect(scannerCsvCell(value).startsWith('"\'')).toBe(true);
  });
  it("quotes embedded delimiters, newlines and quotes without changing plain text", () => {
    expect(scannerCsvCell('Euro, \"Dollar\"\nname')).toBe('"Euro, ""Dollar""\nname"');
    expect(scannerCsvCell("EURUSD")).toBe('"EURUSD"');
  });
  it("keeps the original scan and row times separate from export time", () => {
    const olderRowStamp = new Date(now - 10_000).toISOString();
    const rows = prepared([Object.assign(row(), { generatedAt: olderRowStamp }), row({ symbol: "GBPUSD" })]);
    const csv = scannerScreenCsv(rows, { generatedAt: stamp, timeframe: "M5", marketGroup: "forex", exportedAt: new Date(now).toISOString() });
    expect(csv).toContain(`"${stamp}","${olderRowStamp}","2026-10-26T15:00:00.000Z"`);
    expect(csv).toContain(`"${stamp}","","2026-10-26T15:00:00.000Z"`);
    expect(csv).toContain("edge_heuristic"); expect(csv).not.toContain("probability");
  });
  it("exports limited rows without any hidden signal, reason or score", () => {
    const csv = scannerScreenCsv(prepared([row({ direction: "SELL", hasLiveData: false, reason: "secret old setup" })]),
      { generatedAt: stamp, timeframe: "M5", marketGroup: "forex", exportedAt: stamp });
    expect(csv).toContain('"false","FEED_LIMITED","","","","","",""');
    expect(csv).not.toContain("SELL"); expect(csv).not.toContain("secret old setup");
  });
  it("does not export invalid metrics", () => {
    const csv = scannerScreenCsv(prepared([row({ edgeScore: NaN, entryQuality: 101, executionQuality: -1 })]),
      { generatedAt: stamp, timeframe: "M5", marketGroup: "forex", exportedAt: stamp });
    expect(csv).toContain('"BUY","","","","Rule-based setup"');
  });
});
