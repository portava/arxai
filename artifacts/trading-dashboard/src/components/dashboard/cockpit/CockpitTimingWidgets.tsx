// Cockpit Timing Widgets — Phase 3 Best Markets / Avoid Right Now.
// Uses useGetTimingBrainMulti to pull timing reads for major pairs and
// classifies them into "best now" (GO + grade A/B) and "avoid now"
// (STAND_DOWN / NO_TRADE / grade D/F). Only reads measured from current candles
// are classified; unmeasured reads are named as such.
// Honest empty when timing data is unavailable — never fabricated.

import { useEffect, useReducer } from "react";
import { cn } from "@/lib/utils";
import {
  useGetTimingBrainMulti,
  getGetTimingBrainMultiQueryKey,
} from "@workspace/api-client-react";
import { isApprovedArxMarket } from "@workspace/domain/market";
import { Flame, ShieldAlert, TrendingUp, TrendingDown } from "lucide-react";
import { Link } from "wouter";
import { CockpitCard, ActionButton } from "./primitives";

// Focus-Lock (Task #570): only scan markets that are in the approved ARX Focus
// universe. Any symbol outside the registry is dropped so the cockpit never
// requests timing for an unapproved market.
const SCAN_SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "BTCUSD"].filter(
  isApprovedArxMarket,
);
const GRADE_GOOD = new Set(["A+", "A", "B"]);
const GRADE_BAD = new Set(["D", "F"]);

const PERMISSION_PASS = new Set(["GO"]);
const PERMISSION_BLOCK = new Set(["STAND_DOWN", "NO_TRADE"]);

type TimingRow = Record<string, unknown>;

// The multi-read endpoint omits failed markets. An empty/partial response is
// not an all-clear, and HTTP receipt time is not provider data time. A row is
// usable only when it is well formed: a requested, non-duplicated symbol, a
// known grade and permission, 0–100 scores and a parseable generatedAt that is
// not in the future. Anything else is dropped (never shown, never counted).
function validTimingRows(data: unknown): { rows: TimingRow[]; dropped: number } {
  const results = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return { rows: [], dropped: 0 };
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const r of results) {
    const symbol = r && typeof r === "object" ? (r as TimingRow).symbol : null;
    if (typeof symbol === "string") { if (seen.has(symbol)) duplicates.add(symbol); seen.add(symbol); }
  }
  const rows = results.filter((r): r is TimingRow => {
    if (!r || typeof r !== "object") return false;
    const row = r as TimingRow;
    return typeof row.symbol === "string" && SCAN_SYMBOLS.includes(row.symbol) && !duplicates.has(row.symbol)
      && ["A+", "A", "B", "C", "D", "F"].includes(String(row.timingGrade))
      && ["GO", "WAIT_FOR_ENTRY", "WAIT_NEWS", "NO_TRADE", "STAND_DOWN"].includes(String(row.entryPermission))
      && [row.heatScore, row.tradeabilityScore, row.dangerScore].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100)
      && typeof row.generatedAt === "string" && Number.isFinite(Date.parse(row.generatedAt)) && Date.parse(row.generatedAt) <= Date.now();
  });
  return { rows, dropped: results.length - rows.length };
}

// Honest source/freshness footer (Task #611). A timing read is "measured" only
// when the server says it was computed from current candles; a read built from
// session constants alone (no candles, no quote) is never listed as a best or
// avoid market and never counted as live — it is named as not measured. The
// age comes from the measured reads' own generatedAt (the OLDEST one, the most
// conservative), never the browser fetch time, and the source line is derived
// from each row's dataQuality instead of a fixed "live market provider" string.
function rowQuality(row: TimingRow): { label: string; hasCandleData: boolean; hasQuoteData: boolean } {
  const dq = row["dataQuality"];
  if (!dq || typeof dq !== "object") return { label: "unknown", hasCandleData: false, hasQuoteData: false };
  const d = dq as Record<string, unknown>;
  return { label: String(d["label"] ?? "unknown"), hasCandleData: d["hasCandleData"] === true, hasQuoteData: d["hasQuoteData"] === true };
}

export function isMeasuredTimingRead(row: TimingRow): boolean {
  const q = rowQuality(row);
  return q.hasCandleData && (q.label === "real" || q.label === "partial");
}

/**
 * Provider-backed: current candles AND a live quote (label "real"). Only these
 * may be promoted to a "best now" candidate; a partial-data read is not.
 */
export function isProviderBackedTimingRead(row: TimingRow): boolean {
  const q = rowQuality(row);
  return q.label === "real" && q.hasCandleData && q.hasQuoteData;
}

/** Short caveat for a listed (measured) row that is not on full candle + quote data; null when it is. */
export function timingRowCaveat(row: TimingRow): string | null {
  const q = rowQuality(row);
  if (q.label === "real" && q.hasQuoteData) return null;
  if (!q.hasCandleData) return "Session-only estimate";
  return "Partial data";
}

function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

export function timingFooter(rows: TimingRow[], opts: { isError?: boolean; now?: number; dropped?: number } = {}): string {
  if (rows.length === 0) {
    if (opts.isError) return "Timing reads could not be loaded.";
    return opts.dropped ? "Timing reads were returned in an unusable form and are not shown." : "No timing reads returned.";
  }
  // React Query keeps the last rows after a failed refetch: say the refresh
  // failed, so the rows still on screen are not taken for a fresh poll. (The
  // cockpit cards withdraw those rows instead; other callers may not.)
  const body = timingFooterBody(rows, opts.now ?? Date.now());
  return opts.isError ? `Last refresh failed · ${body}` : body;
}

function timingFooterBody(rows: TimingRow[], now: number): string {
  const measured = rows.filter(isMeasuredTimingRead);
  if (measured.length === 0) {
    return "No current candles for any scanned market — timing not measured.";
  }
  const tfs = Array.from(new Set(measured.map((r) => String(r["timeframe"] ?? "")).filter(Boolean)));
  const tf = tfs.length === 1 ? `${tfs[0]} ` : "";
  const full = measured.filter((r) => rowQuality(r).label === "real").length;
  // Coverage is counted against the markets the cockpit asked for, not the rows
  // that came back: the multi-read endpoint omits failed markets and malformed
  // rows are dropped, so "2 of 2" would read as full coverage when 3 of the 5
  // requested markets have no read at all.
  const requested = Math.max(SCAN_SYMBOLS.length, rows.length);
  const coverage = `current candles for ${measured.length} of ${requested} requested markets, ${full} with a live quote`;
  const times = measured
    .map((r) => Date.parse(String(r["generatedAt"] ?? "")))
    .filter((t) => Number.isFinite(t));
  if (times.length < measured.length) return `${tf}timing reads · read time not reported · ${coverage}`;
  return `${tf}timing reads computed ${formatAge(now - Math.min(...times))} · ${coverage}`;
}

// The cards poll every 90 s and re-render only when data or isError changes,
// so the footer keeps its own clock: "computed Xs ago" counts up between polls
// instead of freezing at the age it had when the data arrived.
const FOOTER_TICK_MS = 1_000;

function TimingFooter({ rows, isError, dropped }: { rows: TimingRow[]; isError: boolean; dropped: number }) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, FOOTER_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return (
    <>
      <p className="mt-2 text-[10px] text-txt-muted" data-testid="timing-footer">{timingFooter(rows, { isError, now: Date.now(), dropped })}</p>
      <p className="text-[10px] text-txt-muted">Advisory only; not a trading approval.</p>
    </>
  );
}

function UnmeasuredLine({ rows }: { rows: TimingRow[] }) {
  const unmeasured = rows.filter((r) => !isMeasuredTimingRead(r)).map((r) => String(r["symbol"] ?? "")).filter(Boolean);
  if (unmeasured.length === 0) return null;
  return (
    <p className="mt-2 text-[10px] text-txt-muted" data-testid="timing-unmeasured">
      Not measured (no current candles): {unmeasured.join(", ")}
    </p>
  );
}

/** Requested markets with no usable read: omitted by the server or dropped as malformed. */
function MissingLine({ rows }: { rows: TimingRow[] }) {
  // With no rows at all the card already says timing data is unavailable.
  if (rows.length === 0) return null;
  const returned = new Set(rows.map((r) => String(r["symbol"] ?? "")));
  const missing = SCAN_SYMBOLS.filter((s) => !returned.has(s));
  if (missing.length === 0) return null;
  return (
    <p className="mt-2 text-[10px] text-txt-muted" data-testid="timing-missing">
      No usable read returned: {missing.join(", ")}
    </p>
  );
}

/** Measured reads (current candles) left out of "best now" because the live quote is missing. */
function NoQuoteLine({ rows }: { rows: TimingRow[] }) {
  const partial = rows.filter((r) => isMeasuredTimingRead(r) && !isProviderBackedTimingRead(r)).map((r) => String(r["symbol"] ?? "")).filter(Boolean);
  if (partial.length === 0) return null;
  return (
    <p className="mt-2 text-[10px] text-txt-muted" data-testid="timing-no-quote">
      Not ranked (partial data, no live quote): {partial.join(", ")}
    </p>
  );
}

function useTimingReads() {
  const q = useGetTimingBrainMulti(
    { symbols: SCAN_SYMBOLS.join(",") },
    {
      query: {
        queryKey: getGetTimingBrainMultiQueryKey({ symbols: SCAN_SYMBOLS.join(",") }),
        refetchInterval: 90_000,
        retry: false,
      },
    },
  );
  // A failed refresh withdraws the last rows: React Query keeps them, but they
  // are no longer current and are not shown as candidates or cautions.
  const { rows, dropped } = q.isError ? { rows: [] as TimingRow[], dropped: 0 } : validTimingRows(q.data);
  const fullCount = rows.filter(isProviderBackedTimingRead).length;
  const measuredCount = rows.filter(isMeasuredTimingRead).length;
  return { q, rows, dropped, fullCount, measuredCount };
}

// Partial coverage is judged against the requested markets and against what the
// card itself lists: Timing Candidates ranks provider-backed reads only, Timing
// Cautions lists every read with current candles. Any requested market without
// such a read (omitted, dropped, unmeasured or, for candidates, no live quote)
// makes the card's coverage partial, even when none of the returned reads is
// provider-backed.
function isPartialCoverage(rows: TimingRow[], listedCount: number): boolean {
  return rows.length > 0 && listedCount < SCAN_SYMBOLS.length;
}

const HEAT_STATE_SHORT: Record<string, string> = {
  CLEAN_MOMENTUM:  "Clean",
  DIRTY_HEAT:      "Dirty heat",
  TRAP_HEAT:       "Trap risk",
  NEWS_HEAT:       "News-driven",
  EXHAUSTION_HEAT: "Exhausted",
  FALSE_HEAT:      "False heat",
  COMPRESSION:     "Coiling",
  WAKE_UP:         "Breaking out",
  COOL:            "Quiet",
};

export function BestMarketsCard({ compactWorkspace = false }: { compactWorkspace?: boolean }) {
  const { q, rows, dropped, fullCount, measuredCount } = useTimingReads();
  const partialCoverage = isPartialCoverage(rows, fullCount);

  const candidates = rows.filter((row) => PERMISSION_PASS.has(String(row["entryPermission"] ?? ""))
    && GRADE_GOOD.has(String(row["timingGrade"] ?? "")));
  // Only provider-backed reads (current candles + live quote) are promoted.
  const best = candidates.filter(isProviderBackedTimingRead).slice(0, 3);
  // A session/clock-only estimate (no current candles) is not a market read, so
  // it can never be promoted to "best now"; say how many were left out.
  const skippedNoCandles = candidates.filter((r) => !isMeasuredTimingRead(r)).length;
  const skippedNoQuote = candidates.filter((r) => isMeasuredTimingRead(r) && !isProviderBackedTimingRead(r)).length;

  if (compactWorkspace) {
    const first = best[0];
    return <div className="arx-intel-compact is-best" data-testid="cockpit-best-markets">
      <b>Timing</b>
      {q.isLoading ? <span>Checking verified reads…</span> : !first ? <span>{rows.length === 0 ? "Unavailable · opportunities not assessed" : fullCount === 0 ? "Not measured · no provider-backed reads" : "No A/B candidate in returned reads"}</span> : <span title={String(first["bestAction"] ?? "")}>{String(first["symbol"])} · {String(first["timingGrade"])} · {HEAT_STATE_SHORT[String(first["heatState"] ?? "")] ?? String(first["heatState"] ?? "")}</span>}
      {partialCoverage && <span className="is-warning">Partial coverage</span>}
      <Link href="/market-scanner" data-testid="best-markets-scanner">Scanner</Link>
    </div>;
  }

  return (
    <CockpitCard
      title="Timing Candidates"
      icon={<TrendingUp className="h-[18px] w-[18px]" />}
      accent="success"
      loading={q.isLoading}
      data-testid="cockpit-best-markets"
    >
      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-txt-secondary" data-testid="best-markets-empty">Timing data unavailable. Market opportunities have not been assessed.</p>
      ) : best.length === 0 ? (
        <div className="py-4 text-center">
          <Flame className="mx-auto mb-1 h-5 w-5 text-txt-muted" />
          {fullCount === 0 ? (
            <>
              <p className="text-sm text-txt-secondary" data-testid="best-markets-empty">
                {measuredCount === 0 ? "Timing not measured — no current candles." : "No read has both current candles and a live quote."}
              </p>
              <p className="text-xs text-txt-muted">Provider-backed timing unavailable. Market opportunities have not been assessed.</p>
            </>
          ) : (
            <>
              <p className="text-sm text-txt-secondary" data-testid="best-markets-empty">No A/B candidates in the returned timing reads.</p>
              <p className="text-xs text-txt-muted">These reads do not cover every market or every risk.</p>
            </>
          )}
          {skippedNoCandles > 0 && (
            <p className="text-xs text-warning" data-testid="best-markets-skipped">
              {skippedNoCandles} grade A/B {skippedNoCandles === 1 ? "read was" : "reads were"} left out — {skippedNoCandles === 1 ? "it is" : "they are"} a session-only estimate without current candles.
            </p>
          )}
          {skippedNoQuote > 0 && (
            <p className="text-xs text-warning" data-testid="best-markets-skipped-no-quote">
              {skippedNoQuote} grade A/B {skippedNoQuote === 1 ? "read was" : "reads were"} left out — no live quote, so {skippedNoQuote === 1 ? "it is" : "they are"} not provider-backed.
            </p>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {best.map((r) => {
            const sym = String(r["symbol"] ?? "");
            const grade = String(r["timingGrade"] ?? "");
            const action = String(r["bestAction"] ?? "").replace(/_/g, " ");
            const state = HEAT_STATE_SHORT[String(r["heatState"] ?? "")] ?? String(r["heatState"] ?? "");
            const heat = Number(r["heatScore"] ?? 0);
            const trade = Number(r["tradeabilityScore"] ?? 0);
            return (
              <li
                key={sym}
                className="flex items-center justify-between gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-sm">{sym}</span>
                    <span className="rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-400">{grade}</span>
                    {timingRowCaveat(r) && (
                      <span className="text-[10px] font-medium text-warning" data-testid="timing-row-caveat">{timingRowCaveat(r)}</span>
                    )}
                  </div>
                  <div className="text-[10px] text-txt-muted">Read generated {new Date(String(r["generatedAt"])).toLocaleString()}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-txt-muted capitalize">{state}</span>
                    <span className="text-[10px] text-txt-muted">·</span>
                    <span className="text-[10px] text-txt-muted capitalize">{action.toLowerCase()}</span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  <span className="text-[10px] text-txt-muted">H:{heat} T:{trade}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {partialCoverage && <p className="mt-2 text-xs text-warning">Partial coverage. Missing or estimated market reads are excluded.</p>}
      <MissingLine rows={rows} />
      <UnmeasuredLine rows={rows} />
      <NoQuoteLine rows={rows} />
      <TimingFooter rows={rows} isError={q.isError} dropped={dropped} />
      <div className="mt-3">
        <ActionButton href="/market-scanner" subtle icon={<Flame className="h-4 w-4" />} data-testid="best-markets-scanner">
          Open Scanner
        </ActionButton>
      </div>
    </CockpitCard>
  );
}

export function AvoidMarketsCard({ compactWorkspace = false }: { compactWorkspace?: boolean }) {
  const { q, rows, dropped, measuredCount } = useTimingReads();
  const partialCoverage = isPartialCoverage(rows, measuredCount);

  // A caution from a measured read (current candles) is listed, labelled
  // "Partial data" when the live quote is missing; a session-only estimate is
  // never listed as a red flag.
  const avoid = rows.filter((row) => {
    if (!isMeasuredTimingRead(row)) return false;
    return PERMISSION_BLOCK.has(String(row["entryPermission"] ?? ""))
      || GRADE_BAD.has(String(row["timingGrade"] ?? ""))
      || Number(row["dangerScore"] ?? 0) >= 65;
  }).slice(0, 3);

  if (compactWorkspace) {
    const first = avoid[0];
    return <div className="arx-intel-compact is-caution" data-testid="cockpit-avoid-markets">
      <b>Caution</b>
      {q.isLoading ? <span>Checking verified reads…</span> : !first ? <span>{rows.length === 0 ? "Unavailable · cautions not assessed" : measuredCount === 0 ? "Not measured · cautions not assessed" : "No listed caution · not an all-clear"}</span> : <span title={String(first["entryPermission"] ?? "")}>{String(first["symbol"])} · {String(first["timingGrade"])} · danger {String(first["dangerScore"])}{timingRowCaveat(first) ? ` · ${timingRowCaveat(first)}` : ""}</span>}
      {partialCoverage && <span className="is-warning">Partial coverage</span>}
      <Link href="/market-heat-map" data-testid="avoid-markets-heat">Details</Link>
    </div>;
  }

  return (
    <CockpitCard
      title="Timing Cautions"
      icon={<ShieldAlert className="h-[18px] w-[18px]" />}
      accent="danger"
      loading={q.isLoading}
      data-testid="cockpit-avoid-markets"
    >
      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-txt-secondary" data-testid="avoid-markets-empty">Timing data unavailable. Market cautions have not been assessed.</p>
      ) : avoid.length === 0 ? (
        <div className="py-4 text-center">
          <ShieldAlert className="mx-auto mb-1 h-5 w-5 text-txt-muted" />
          {measuredCount === 0 ? (
            <p className="text-sm text-txt-secondary" data-testid="avoid-markets-empty">Timing not measured — no current candles.</p>
          ) : (
            <>
              <p className="text-sm text-txt-secondary" data-testid="avoid-markets-empty">No listed cautions in {measuredCount} measured timing {measuredCount === 1 ? "read" : "reads"}.</p>
              <p className="text-xs text-txt-muted">This is not an all-clear for trading.</p>
            </>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {avoid.map((r) => {
            const sym = String(r["symbol"] ?? "");
            const grade = String(r["timingGrade"] ?? "");
            const perm = String(r["entryPermission"] ?? "").replace(/_/g, " ").toLowerCase();
            const danger = Number(r["dangerScore"] ?? 0);
            const state = HEAT_STATE_SHORT[String(r["heatState"] ?? "")] ?? String(r["heatState"] ?? "");
            return (
              <li
                key={sym}
                className="flex items-center justify-between gap-3 rounded-lg border border-rose-500/20 bg-rose-500/[0.04] px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-sm">{sym}</span>
                    <span className={cn(
                      "rounded border px-1.5 py-0.5 text-[10px] font-bold",
                      GRADE_BAD.has(grade)
                        ? "border-rose-500/40 bg-rose-500/15 text-rose-400"
                        : "border-amber-500/40 bg-amber-500/15 text-amber-400",
                    )}>{grade}</span>
                    {timingRowCaveat(r) && (
                      <span className="text-[10px] font-medium text-warning" data-testid="timing-row-caveat">{timingRowCaveat(r)}</span>
                    )}
                  </div>
                  <div className="text-[10px] text-txt-muted">Read generated {new Date(String(r["generatedAt"])).toLocaleString()}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-txt-muted capitalize">{state}</span>
                    <span className="text-[10px] text-txt-muted">·</span>
                    <span className="text-[10px] text-txt-muted capitalize">{perm}</span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  <span className={cn("text-[10px] font-mono", danger >= 65 ? "text-rose-400" : "text-amber-400")}>
                    D:{danger}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {partialCoverage && <p className="mt-2 text-xs text-warning">Partial coverage. Missing or estimated market reads are excluded.</p>}
      <MissingLine rows={rows} />
      <UnmeasuredLine rows={rows} />
      <TimingFooter rows={rows} isError={q.isError} dropped={dropped} />
      <div className="mt-3">
        <ActionButton href="/market-heat-map" subtle icon={<TrendingDown className="h-4 w-4" />} data-testid="avoid-markets-heat">
          Heat Map
        </ActionButton>
      </div>
    </CockpitCard>
  );
}
