import type { OpportunityMapRow, OpportunityMapRowCategory, WatchlistDetail } from "@workspace/api-client-react";
import { resolveSymbol } from "@/lib/symbolRegistry";
import { isScannerMapFresh } from "./scannerMapFreshness";

export const SCREEN_STORAGE_KEY = "arx.scanner.screens.v1";
export const SCREEN_LIMIT = 20;
export const SCREEN_CATEGORIES = ["READY_NOW", "FORMING_SOON", "WATCH_AFTER_NEWS", "TOO_LATE", "AVOID", "NO_CLEAN_SETUP"] as const;
export type ScannerScreen = {
  search: string;
  watchlistId: number | null;
  category: "all" | OpportunityMapRowCategory;
  direction: "all" | "BUY" | "SELL" | "NEUTRAL";
  availability: "all" | "confirmed" | "limited";
  minEdge: number;
  sort: "edge" | "entry" | "symbol";
};
export const DEFAULT_SCREEN: ScannerScreen = {
  search: "", watchlistId: null, category: "all", direction: "all", availability: "all", minEdge: 0, sort: "edge",
};
export type SavedScannerScreen = { name: string; screen: ScannerScreen; marketGroup: string; timeframe: string | null };
export type ScreenWatchlist = Pick<WatchlistDetail, "id" | "name"> & { items: { symbol: string }[] };
export type ScreenScope = { symbols: ReadonlySet<string> | null; missingSymbols: string[]; skippedCount: number; message: string | null };
export type ScreenRow = { row: OpportunityMapRow; metricsAvailable: boolean; limitation: string | null };

export function scannerSymbolKey(raw: string): string {
  const resolved = resolveSymbol(raw.trim());
  return resolved && ["exact", "alias", "broker"].includes(resolved.matchSource)
    ? resolved.canonicalSymbol.toUpperCase() : raw.trim().toUpperCase();
}

/** An unavailable saved scope is empty, never a silent fallback to all markets. */
export function resolveScreenScope(id: number | null, lists: readonly ScreenWatchlist[] | undefined,
  listsUnavailable: boolean, rows: readonly OpportunityMapRow[], skipped: readonly { symbol: string }[]): ScreenScope {
  if (id === null) return { symbols: null, missingSymbols: [], skippedCount: 0, message: null };
  const list = listsUnavailable ? undefined : lists?.find((item) => item.id === id);
  if (!list) return { symbols: new Set(), missingSymbols: [], skippedCount: 0,
    message: listsUnavailable || !lists ? "Watchlists are unavailable. This view stays empty until its watchlist can be checked."
      : "This saved watchlist no longer exists. Choose a watchlist or all scanned symbols." };
  const symbols = new Set(list.items.map((item) => scannerSymbolKey(item.symbol)));
  const scannedKeys = new Set(rows.map((row) => scannerSymbolKey(row.symbol)));
  const skippedKeys = new Set(skipped.map((item) => scannerSymbolKey(item.symbol)));
  const missingSymbols = [...symbols].filter((key) => !scannedKeys.has(key) && !skippedKeys.has(key)).sort();
  const skippedCount = [...symbols].filter((key) => skippedKeys.has(key) && !scannedKeys.has(key)).length;
  return { symbols, missingSymbols, skippedCount, message: symbols.size ? null : "This watchlist is empty." };
}

/** Existing feed/selection caps remain authoritative. No screen grants actionability. */
export function prepareScreenRows(rows: readonly OpportunityMapRow[], generatedAt: string | null | undefined,
  now: number, failedRead: boolean, cap: (row: OpportunityMapRow) => string | null): ScreenRow[] {
  const snapshotFresh = !failedRead && isScannerMapFresh(generatedAt, now);
  return rows.map((row) => {
    // The current API has no row timestamp; if a future/cache payload supplies one,
    // keep it and cap its age independently. Never substitute the envelope time.
    const stamp = (row as OpportunityMapRow & { generatedAt?: unknown }).generatedAt;
    const rowFresh = stamp === undefined || (typeof stamp === "string" && isScannerMapFresh(stamp, now));
    const limitation = !snapshotFresh ? "SCAN_NEEDS_REFRESH" : !rowFresh ? "ROW_NEEDS_REFRESH"
      : !row.hasLiveData ? "FEED_LIMITED" : cap(row);
    return { row, limitation, metricsAvailable: limitation === null };
  });
}

export function validHeuristic(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function filterScreenRows(rows: readonly ScreenRow[], screen: ScannerScreen, scope: ScreenScope): ScreenRow[] {
  const search = screen.search.trim().toLowerCase();
  const matched = rows.filter(({ row, metricsAvailable }) => {
    if (scope.symbols && !scope.symbols.has(scannerSymbolKey(row.symbol))) return false;
    if (search && !`${row.symbol} ${row.displayName}`.toLowerCase().includes(search)) return false;
    if (screen.availability === "confirmed" && !metricsAvailable) return false;
    if (screen.availability === "limited" && metricsAvailable) return false;
    // A hidden stale direction/score/category must not leak through a filter.
    if (screen.category !== "all" && (!metricsAvailable || row.category !== screen.category)) return false;
    if (screen.direction !== "all" && (!metricsAvailable || row.direction !== screen.direction)) return false;
    return screen.minEdge === 0 || (metricsAvailable && validHeuristic(row.edgeScore) && row.edgeScore >= screen.minEdge);
  });
  return matched.sort((a, b) => {
    if (screen.sort !== "symbol") {
      const field = screen.sort === "entry" ? "entryQuality" : "edgeScore";
      const score = (entry: ScreenRow) => entry.metricsAvailable && validHeuristic(entry.row[field]) ? entry.row[field] : -1;
      const delta = score(b) - score(a);
      if (delta) return delta;
    }
    return compareText(scannerSymbolKey(a.row.symbol), scannerSymbolKey(b.row.symbol)) ||
      compareText(a.row.kind, b.row.kind) || compareText(a.row.category, b.row.category);
  });
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function parseScreen(value: unknown): ScannerScreen | null {
  if (!record(value) || typeof value.search !== "string" || value.search.length > 100 ||
    !(value.watchlistId === null || (Number.isSafeInteger(value.watchlistId) && Number(value.watchlistId) > 0)) ||
    !["all", ...SCREEN_CATEGORIES].includes(value.category as never) ||
    !["all", "BUY", "SELL", "NEUTRAL"].includes(value.direction as string) ||
    !["all", "confirmed", "limited"].includes(value.availability as string) ||
    typeof value.minEdge !== "number" || !validHeuristic(value.minEdge) ||
    !["edge", "entry", "symbol"].includes(value.sort as string)) return null;
  return { search: value.search, watchlistId: value.watchlistId as number | null,
    category: value.category as ScannerScreen["category"], direction: value.direction as ScannerScreen["direction"],
    availability: value.availability as ScannerScreen["availability"], minEdge: value.minEdge,
    sort: value.sort as ScannerScreen["sort"] };
}
export function parseSavedScreens(raw: string | null): SavedScannerScreen[] {
  if (!raw || raw.length > 50_000) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!record(data) || data.version !== 1 || !Array.isArray(data.screens) || data.screens.length > SCREEN_LIMIT) return [];
    const result: SavedScannerScreen[] = [];
    for (const value of data.screens) {
      if (!record(value) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 60 ||
        typeof value.marketGroup !== "string" || !["all", "forex", "metals", "crypto", "stocks", "synthetic"].includes(value.marketGroup) ||
        !(value.timeframe === null || (typeof value.timeframe === "string" && /^[A-Z0-9]{1,6}$/.test(value.timeframe)))) continue;
      const screen = parseScreen(value.screen);
      const name = value.name.trim();
      if (screen && !result.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
        result.push({ name, screen, marketGroup: value.marketGroup, timeframe: value.timeframe as string | null });
      }
    }
    return result;
  } catch { return []; }
}
export function saveScreen(screens: readonly SavedScannerScreen[], value: SavedScannerScreen): SavedScannerScreen[] {
  const name = value.name.trim().slice(0, 60);
  const next = [...screens.filter((item) => item.name.toLowerCase() !== name.toLowerCase()), { ...value, name }];
  if (!name || next.length > SCREEN_LIMIT) throw new Error(`Keep up to ${SCREEN_LIMIT} saved views. Delete one before adding another.`);
  return next;
}
export function writeSavedScreens(storage: Pick<Storage, "setItem">, screens: readonly SavedScannerScreen[]): void {
  storage.setItem(SCREEN_STORAGE_KEY, JSON.stringify({ version: 1, screens }));
}

/** Quote every cell and stop spreadsheet formulas after leading invisible text. */
export function scannerCsvCell(value: string): string {
  const dangerous = /^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]*[=+@\-＝＋－＠]/u.test(value);
  return `"${(dangerous ? `'${value}` : value).replaceAll('"', '""')}"`;
}
export function scannerScreenCsv(rows: readonly ScreenRow[], context: {
  generatedAt: string | null | undefined; timeframe: string | null; marketGroup: string; exportedAt: string;
}): string {
  const header = ["symbol", "name", "market_group", "scan_timeframe", "scan_generated_at", "row_generated_at",
    "exported_at", "server_has_live_data", "availability", "category", "direction", "edge_heuristic", "entry_heuristic", "feed_heuristic", "reason"];
  const body = rows.map(({ row, metricsAvailable, limitation }) => {
    const originalStamp = (row as OpportunityMapRow & { generatedAt?: unknown }).generatedAt;
    const score = (value: number) => metricsAvailable && validHeuristic(value) ? String(value) : "";
    return [row.symbol, row.displayName, context.marketGroup, context.timeframe ?? "", context.generatedAt ?? "",
      typeof originalStamp === "string" ? originalStamp : "", context.exportedAt, String(row.hasLiveData),
      metricsAvailable ? "LIVE_CONFIRMED" : limitation ?? "FEED_LIMITED", metricsAvailable ? row.category : "",
      metricsAvailable ? row.direction : "", score(row.edgeScore), score(row.entryQuality), score(row.executionQuality),
      metricsAvailable ? row.reason ?? "" : ""];
  });
  return [header, ...body].map((line) => line.map(scannerCsvCell).join(",")).join("\r\n") + "\r\n";
}
