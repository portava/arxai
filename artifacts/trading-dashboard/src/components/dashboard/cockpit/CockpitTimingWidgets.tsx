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

// Honest source/freshness footer (Task #611). A timing read is "measured" only
// when the server says it was computed from current candles; a read built from
// session constants alone (no candles, no quote) is never listed as a best or
// avoid market and never counted as live — it is named as not measured. The
// age comes from the measured reads' own generatedAt (the OLDEST one, the most
// conservative), never the browser fetch time, and the source line is derived
// from each row's dataQuality instead of a fixed "live market provider" string.
type TimingRow = Record<string, unknown>;

function rowQuality(row: TimingRow): { label: string; hasCandleData: boolean } {
  const dq = row["dataQuality"];
  if (!dq || typeof dq !== "object") return { label: "unknown", hasCandleData: false };
  const d = dq as Record<string, unknown>;
  return { label: String(d["label"] ?? "unknown"), hasCandleData: d["hasCandleData"] === true };
}

export function isMeasuredTimingRead(row: TimingRow): boolean {
  const q = rowQuality(row);
  return q.hasCandleData && (q.label === "real" || q.label === "partial");
}

/** Short caveat for a listed (measured) row that is not on full candle + quote data; null when it is. */
export function timingRowCaveat(row: TimingRow): string | null {
  const q = rowQuality(row);
  if (q.label === "real") return null;
  if (!q.hasCandleData) return "Session-only estimate";
  return "Partial data";
}

function asRows(results: unknown[]): TimingRow[] {
  return results.filter((r): r is TimingRow => !!r && typeof r === "object");
}

function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

export function timingFooter(rows: TimingRow[], opts: { isError?: boolean; now?: number } = {}): string {
  if (rows.length === 0) {
    return opts.isError ? "Timing reads could not be loaded." : "No timing reads returned.";
  }
  // React Query keeps the last rows after a failed refetch: say the refresh
  // failed, so the rows still on screen are not taken for a fresh poll.
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
  const coverage = `current candles for ${measured.length} of ${rows.length} markets, ${full} with a live quote`;
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

function TimingFooter({ rows, isError }: { rows: TimingRow[]; isError: boolean }) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, FOOTER_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return (
    <p className="mt-2 text-[10px] text-txt-muted" data-testid="timing-footer">{timingFooter(rows, { isError, now: Date.now() })}</p>
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

export function BestMarketsCard() {
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

  const rows = asRows((q.data as { results?: unknown[] })?.results ?? []);
  const measuredCount = rows.filter(isMeasuredTimingRead).length;

  const candidates = rows.filter((row) => PERMISSION_PASS.has(String(row["entryPermission"] ?? ""))
    && GRADE_GOOD.has(String(row["timingGrade"] ?? "")));
  const best = candidates.filter(isMeasuredTimingRead).slice(0, 3);
  // A session/clock-only estimate (no current candles) is not a market read, so
  // it can never be promoted to "best now"; say how many were left out.
  const skippedNoCandles = candidates.length - candidates.filter(isMeasuredTimingRead).length;

  return (
    <CockpitCard
      title="Best Markets Now"
      icon={<TrendingUp className="h-[18px] w-[18px]" />}
      accent="success"
      loading={q.isLoading}
      data-testid="cockpit-best-markets"
    >
      {!q.isLoading && best.length === 0 ? (
        <div className="py-4 text-center">
          <Flame className="mx-auto mb-1 h-5 w-5 text-txt-muted" />
          {rows.length > 0 && measuredCount === 0 ? (
            <p className="text-sm text-txt-secondary" data-testid="best-markets-empty">Timing not measured — no current candles.</p>
          ) : (
            <p className="text-sm text-txt-secondary" data-testid="best-markets-empty">
              {rows.length === 0 ? "No timing reads to rank right now." : "No A-grade setups right now."}
            </p>
          )}
          {skippedNoCandles > 0 ? (
            <p className="text-xs text-warning" data-testid="best-markets-skipped">
              {skippedNoCandles} grade A/B {skippedNoCandles === 1 ? "read was" : "reads were"} left out — {skippedNoCandles === 1 ? "it is" : "they are"} a session-only estimate without current candles.
            </p>
          ) : measuredCount > 0 ? (
            <p className="text-xs text-txt-muted">Check back when session conditions improve.</p>
          ) : null}
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
      <UnmeasuredLine rows={rows} />
      <TimingFooter rows={rows} isError={q.isError} />
      <div className="mt-3">
        <ActionButton href="/market-scanner" subtle icon={<Flame className="h-4 w-4" />} data-testid="best-markets-scanner">
          Open Scanner
        </ActionButton>
      </div>
    </CockpitCard>
  );
}

export function AvoidMarketsCard() {
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

  const rows = asRows((q.data as { results?: unknown[] })?.results ?? []);
  const measuredCount = rows.filter(isMeasuredTimingRead).length;

  const avoid = rows.filter((row) => {
    if (!isMeasuredTimingRead(row)) return false;
    return PERMISSION_BLOCK.has(String(row["entryPermission"] ?? ""))
      || GRADE_BAD.has(String(row["timingGrade"] ?? ""))
      || Number(row["dangerScore"] ?? 0) >= 65;
  }).slice(0, 3);

  return (
    <CockpitCard
      title="Avoid Right Now"
      icon={<ShieldAlert className="h-[18px] w-[18px]" />}
      accent="danger"
      loading={q.isLoading}
      data-testid="cockpit-avoid-markets"
    >
      {!q.isLoading && avoid.length === 0 ? (
        <div className="py-4 text-center">
          <ShieldAlert className="mx-auto mb-1 h-5 w-5 text-txt-muted" />
          {rows.length === 0 ? (
            <p className="text-sm text-txt-secondary" data-testid="avoid-markets-empty">No timing reads — red flags could not be checked.</p>
          ) : measuredCount === 0 ? (
            <p className="text-sm text-txt-secondary" data-testid="avoid-markets-empty">Timing not measured — no current candles.</p>
          ) : (
            <>
              <p className="text-sm text-txt-secondary" data-testid="avoid-markets-empty">No major red flags in {measuredCount} measured timing {measuredCount === 1 ? "read" : "reads"}.</p>
              <p className="text-xs text-txt-muted">Advisory only — based on the reads listed in the footer.</p>
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
      <UnmeasuredLine rows={rows} />
      <TimingFooter rows={rows} isError={q.isError} />
      <div className="mt-3">
        <ActionButton href="/market-heat-map" subtle icon={<TrendingDown className="h-4 w-4" />} data-testid="avoid-markets-heat">
          Heat Map
        </ActionButton>
      </div>
    </CockpitCard>
  );
}
