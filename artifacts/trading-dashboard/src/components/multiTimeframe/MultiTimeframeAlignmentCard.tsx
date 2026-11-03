// (M) Build M — primary multi-timeframe display. Shows the alignment label,
// score, per-TF trend snapshots, and the AI summary. Includes a "Refresh"
// button that triggers a fresh /multi-timeframe/generate. SAFETY: never
// presents a buy/sell signal — only "preferred bias" with the disclaimer
// surfaced via the AI summary string.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { assessTimeframeFreshness } from "@workspace/domain/multi-timeframe";
import { TimeframeConflictWarning } from "./TimeframeConflictWarning";
import { HigherTimeframeBiasCard } from "./HigherTimeframeBiasCard";

type Trend = "UP" | "DOWN" | "SIDEWAYS" | "INSUFFICIENT_DATA";

/** Fewest candles a timeframe needs before the server reports a trend for it. */
const MIN_CANDLES_FOR_TREND = 20;
type Freshness = "CURRENT" | "STALE" | "UNKNOWN";
type Snap = {
  trend: Trend; strength: number; slope: number; fastSma: number; slowSma: number; candlesUsed: number;
  /** Newest bar's open time (ISO); null when the bars carried none; absent on older reports. */
  newestBarTime?: string | null;
  /** Whether the newest bar was current when the report was generated; absent on older reports. */
  freshness?: Freshness;
  /** Provider that served the bars; absent on older reports. */
  source?: string | null;
};

export interface MultiTimeframeReport {
  id: number;
  symbol: string;
  lowerTimeframe: string; middleTimeframe: string; higherTimeframe: string;
  lowerTrend: Snap; middleTrend: Snap; higherTrend: Snap;
  alignmentScore: number;
  alignmentLabel:
    | "STRONG_BULLISH_ALIGNMENT" | "STRONG_BEARISH_ALIGNMENT" | "MIXED_ALIGNMENT"
    | "LOWER_TIMEFRAME_CONFLICT" | "HIGHER_TIMEFRAME_WARNING" | "NO_CLEAR_BIAS"
    | "INSUFFICIENT_DATA" | "DATA_NOT_CURRENT";
  conflictWarning: string | null;
  bestBias: "BUY" | "SELL" | "NEUTRAL";
  aiSummary: string;
  createdAt: string;
}

const LABEL_STYLES: Record<MultiTimeframeReport["alignmentLabel"], string> = {
  STRONG_BULLISH_ALIGNMENT: "bg-green-700 text-white",
  STRONG_BEARISH_ALIGNMENT: "bg-red-700 text-white",
  MIXED_ALIGNMENT: "bg-amber-700 text-white",
  LOWER_TIMEFRAME_CONFLICT: "bg-amber-800 text-amber-100",
  HIGHER_TIMEFRAME_WARNING: "bg-orange-800 text-orange-100",
  NO_CLEAR_BIAS: "bg-slate-700 text-slate-200",
  INSUFFICIENT_DATA: "bg-slate-800 text-slate-300",
  DATA_NOT_CURRENT: "bg-amber-900 text-amber-100",
};
const TREND_STYLES: Record<Trend, string> = {
  UP: "text-green-400", DOWN: "text-red-400", SIDEWAYS: "text-slate-400",
  INSUFFICIENT_DATA: "text-slate-500",
};

/**
 * A timeframe the server read from fewer than MIN_CANDLES_FOR_TREND candles was
 * not observed. Older reports stored such a timeframe as "SIDEWAYS (0)"; the
 * client may only downgrade, so it re-labels them here.
 */
function snapObserved(s: Snap): boolean {
  return s.trend !== "INSUFFICIENT_DATA" &&
    Number.isFinite(s.candlesUsed) && s.candlesUsed >= MIN_CANDLES_FOR_TREND;
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** "Mon 2026-10-26 09:55 UTC" — with the date, since a stored report can be days old. */
function utcStamp(iso: string): string | null {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return `${WEEKDAY[d.getUTCDay()]} ${d.toISOString().slice(0, 10)} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** How often the card re-checks a stored report's bar times against the clock. */
const CLOCK_TICK_MS = 30_000;
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * The server's clock as of a GET /multi-timeframe/latest answer: the
 * response's Date header, and this browser's time when it arrived. The bar
 * times and the freshness verdict are on the server's clock; this browser's
 * clock can be minutes off, and an M5 bar is current for only 10 minutes, so
 * a stored report's age is measured on the server's clock: its time at the
 * answer plus the time elapsed here since.
 */
type ServerClock = { serverNowMs: number; receivedAtMs: number };
type LatestRead = { report: MultiTimeframeReport; clock: ServerClock | null };

function serverClockOf(res: Response, receivedAtMs: number): ServerClock | null {
  const header = res.headers.get("date");
  const serverNowMs = header ? Date.parse(header) : NaN;
  return Number.isFinite(serverNowMs) ? { serverNowMs, receivedAtMs } : null;
}

/** The server's time now, or null when the answer carried no server time. */
function serverNow(clock: ServerClock | null, nowMs: number): number | null {
  return clock ? clock.serverNowMs + Math.max(0, nowMs - clock.receivedAtMs) : null;
}

/** True when the report predates bar-time recording (no freshness on the snapshot). */
function freshnessUnrecorded(s: Snap): boolean {
  return s.freshness === undefined && s.newestBarTime === undefined;
}

/** A recorded freshness other than CURRENT means the timeframe was not a current read. */
function snapNotCurrent(s: Snap): boolean {
  return !freshnessUnrecorded(s) && s.freshness !== "CURRENT";
}

/**
 * The report stores freshness once, when it was generated, and GET
 * /multi-timeframe/latest returns it unchanged however old the report is. A
 * timeframe recorded CURRENT is re-checked on the server's clock with the
 * same rule the server used (newest bar opened within two bars of now):
 * "aged" when it is no longer current, "unchecked" when the answer carried no
 * server time (this browser's clock is not used for it).
 */
function recheckSinceScan(timeframe: string, s: Snap, serverNowMs: number | null): "current" | "aged" | "unchecked" | null {
  if (s.freshness !== "CURRENT" || !s.newestBarTime) return null;
  if (serverNowMs == null) return "unchecked";
  const newest = { open: 0, high: 0, low: 0, close: 0, time: s.newestBarTime };
  return assessTimeframeFreshness(timeframe, newest, serverNowMs).freshness === "CURRENT" ? "current" : "aged";
}

/**
 * Plain-English line for a timeframe's newest bar: when it opened and whether
 * it was current when the report was generated (and, if it was, whether it
 * still is), or that the bars carried no time, or (older reports) that it was
 * never recorded.
 */
function barTimeText(s: Snap, recheck: "current" | "aged" | "unchecked" | null = null): string {
  if (freshnessUnrecorded(s)) return "bar time not recorded";
  const stamp = s.newestBarTime ? utcStamp(s.newestBarTime) : null;
  if (!stamp) return "bars carried no time · age not checked";
  const word = s.freshness === "CURRENT"
    ? recheck === "aged" ? "current when scanned, not current now"
      : recheck === "unchecked" ? "current when scanned, not re-checked now"
      : "current when scanned"
    : s.freshness === "STALE" ? "stale" : "age not checked";
  return `newest bar ${stamp} · ${word}`;
}

export function MultiTimeframeAlignmentCard({ symbol }: { symbol: string | null }) {
  const qc = useQueryClient();
  const nowMs = useNow();
  const enabled = !!symbol;
  const latest = useQuery<LatestRead>({
    queryKey: ["mtf-latest", symbol],
    queryFn: async () => {
      const r = await fetch(`/api/multi-timeframe/latest?symbol=${encodeURIComponent(symbol!)}`);
      if (r.status === 404) throw new Error("no-report");
      if (!r.ok) throw new Error("Failed to load report");
      const clock = serverClockOf(r, Date.now());
      return { report: (await r.json()) as MultiTimeframeReport, clock };
    },
    enabled,
    retry: false,
  });
  const generate = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/multi-timeframe/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      if (!r.ok) throw new Error("Failed to generate report");
      return r.json() as Promise<MultiTimeframeReport>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mtf-latest", symbol] }),
  });

  if (!symbol) {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4 text-sm text-slate-400">
        Set a symbol on the plan to enable multi-timeframe analysis.
      </div>
    );
  }

  const r = latest.data?.report;
  const clock = latest.data?.clock ?? null;
  const serverNowMs = serverNow(clock, nowMs);
  const tiles = r
    ? [
        { label: r.lowerTimeframe,  s: r.lowerTrend,  tag: "Lower" },
        { label: r.middleTimeframe, s: r.middleTrend, tag: "Middle" },
        { label: r.higherTimeframe, s: r.higherTrend, tag: "Higher" },
      ]
    : [];
  const unobserved = tiles.filter((tf) => !snapObserved(tf.s));
  const observed = r != null && unobserved.length === 0 && r.alignmentLabel !== "INSUFFICIENT_DATA";
  // The server labels a report DATA_NOT_CURRENT when any timeframe's newest bar
  // is stale or untimestamped. The client may only downgrade, so a report with
  // a current label but a recorded stale/unknown timeframe is treated the same.
  const staleTiles = tiles.filter((tf) => snapNotCurrent(tf.s));
  // Current when scanned, but no longer current now: an old report is not a
  // current alignment either. One whose age could not be re-checked (no
  // server time) is not shown as current, nor called not current.
  const recheck = (tf: (typeof tiles)[number]) => recheckSinceScan(tf.label, tf.s, serverNowMs);
  const agedTiles = tiles.filter((tf) => recheck(tf) === "aged");
  const uncheckedTiles = tiles.filter((tf) => recheck(tf) === "unchecked");
  const isAged = (tf: (typeof tiles)[number]) => agedTiles.includes(tf);
  const provenNotCurrent = observed && (r!.alignmentLabel === "DATA_NOT_CURRENT" || staleTiles.length > 0 || agedTiles.length > 0);
  const notCurrent = provenNotCurrent || (observed && uncheckedTiles.length > 0);
  const scanStamp = r ? utcStamp(r.createdAt) : null;
  const measured = observed && !notCurrent;
  const legacyFreshness = measured && tiles.some((tf) => freshnessUnrecorded(tf.s));

  return (
    <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <header className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Multi-Timeframe Alignment</h3>
          <p className="text-xs text-slate-500">
            {symbol} · {r ? new Date(r.createdAt).toLocaleString() : "no report yet"}
          </p>
        </div>
        <button
          onClick={() => generate.mutate()}
          disabled={generate.isPending}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {generate.isPending ? "Scanning…" : (r ? "Refresh scan" : "Run scan")}
        </button>
      </header>

      {!r && !latest.isLoading && (
        <p className="text-sm text-slate-400">No report for this symbol yet. Click "Run scan" to generate one.</p>
      )}

      {/* Only a report with a timeframe that was really not observed (too few
          candles) or labelled INSUFFICIENT_DATA; a not-current report has its
          own block below and is not a not-enough-data report. */}
      {r && !observed && (
        <>
          <div className="flex flex-wrap items-center gap-3" data-testid="mtf-insufficient">
            <span className={`rounded px-2 py-0.5 text-xs font-semibold ${LABEL_STYLES.INSUFFICIENT_DATA}`}>
              NOT ENOUGH DATA
            </span>
            <span className="text-sm text-slate-300">Alignment not measured</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {tiles.map((tf) => (
              <div key={tf.tag} className="rounded-md border border-slate-800 bg-slate-950/60 p-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{tf.tag} · {tf.label}</div>
                {snapObserved(tf.s) ? (
                  <div className={`text-sm font-semibold ${TREND_STYLES[tf.s.trend]}`}>{tf.s.trend}</div>
                ) : (
                  <div className={`text-sm font-semibold ${TREND_STYLES.INSUFFICIENT_DATA}`}>No read</div>
                )}
                <div className="text-xs text-slate-400" data-testid="mtf-candles-used">
                  {tf.s.candlesUsed} of {MIN_CANDLES_FOR_TREND}+ candles
                </div>
              </div>
            ))}
          </div>
          <p className="rounded-md border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-300">
            Not enough candles were received for{" "}
            {unobserved.map((tf) => `${tf.label} (${tf.s.candlesUsed})`).join(", ") || "one or more timeframes"}
            {" "}when this report was generated, so no trend, alignment or bias is shown. Run the scan again once
            market data is available.
          </p>
        </>
      )}

      {r && notCurrent && (
        <>
          <div className="flex flex-wrap items-center gap-3" data-testid="mtf-not-current">
            <span
              className={`rounded px-2 py-0.5 text-xs font-semibold ${provenNotCurrent ? LABEL_STYLES.DATA_NOT_CURRENT : LABEL_STYLES.NO_CLEAR_BIAS}`}
              data-testid="mtf-label"
            >
              {provenNotCurrent ? "DATA NOT CURRENT" : "NOT RE-CHECKED"}
            </span>
            <span className="text-sm text-slate-300">
              {provenNotCurrent ? "Alignment not current · no bias given" : "Alignment not shown as current · no bias given"}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {tiles.map((tf) => (
              <div key={tf.tag} className="rounded-md border border-slate-800 bg-slate-950/60 p-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{tf.tag} · {tf.label}</div>
                <div className="text-sm font-semibold text-slate-400">{tf.s.trend} on these bars</div>
                <div className="text-[10px] text-slate-500" data-testid="mtf-candles-used">
                  from {tf.s.candlesUsed} candles
                </div>
                <div
                  className={`text-[10px] ${snapNotCurrent(tf.s) || isAged(tf) || uncheckedTiles.includes(tf) ? "text-amber-400/90" : "text-slate-500"}`}
                  data-testid="mtf-bar-time"
                >
                  {barTimeText(tf.s, recheck(tf))}
                </div>
              </div>
            ))}
          </div>
          {r.alignmentLabel === "DATA_NOT_CURRENT" && r.conflictWarning ? (
            <TimeframeConflictWarning warning={r.conflictWarning} label={r.alignmentLabel} />
          ) : (
            <p className="rounded-md border border-amber-800 bg-amber-950/30 p-3 text-xs text-amber-200" data-testid="mtf-not-current-reason">
              {(agedTiles.length > 0 || uncheckedTiles.length > 0) && `This scan is from ${scanStamp ?? "a time that was not recorded"}. `}
              {provenNotCurrent ? "Not a current read" : "Not shown as a current read"}:{" "}
              {[
                ...staleTiles.map((tf) => `${tf.label} newest bar is not current (${barTimeText(tf.s)})`),
                ...agedTiles.map((tf) => `${tf.label} newest bar is no longer current (${barTimeText(tf.s, "aged")})`),
                ...uncheckedTiles.map((tf) => `${tf.label} newest bar was current when scanned; whether it still is was not checked`),
              ].join("; ")}.
              {uncheckedTiles.length > 0 && clock == null && " No server time came with this report, and this device's clock is not used to judge its age."}
              {" "}No alignment score or bias is shown.{" "}
              {staleTiles.length > 0 ? "Run the scan again once market data is current." : "Run the scan again for a current read."}
            </p>
          )}
          {r.alignmentLabel === "DATA_NOT_CURRENT" && (
            <p className="rounded-md border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-300">
              {r.aiSummary}
            </p>
          )}
        </>
      )}

      {r && measured && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`rounded px-2 py-0.5 text-xs font-semibold ${LABEL_STYLES[r.alignmentLabel] ?? LABEL_STYLES.NO_CLEAR_BIAS}`}
              data-testid="mtf-label"
            >
              {r.alignmentLabel.replace(/_/g, " ")}
            </span>
            <span className="text-sm text-slate-300">
              Alignment <span className="font-semibold text-slate-100">{Math.round(r.alignmentScore)}/100</span>
            </span>
            <span className="text-sm text-slate-300">
              Best bias <span className="font-semibold text-slate-100">{r.bestBias}</span>
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {tiles.map((tf) => (
              <div key={tf.tag} className="rounded-md border border-slate-800 bg-slate-950/60 p-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{tf.tag} · {tf.label}</div>
                <div className={`text-sm font-semibold ${TREND_STYLES[tf.s.trend]}`}>{tf.s.trend}</div>
                <div className="text-xs text-slate-400">strength {tf.s.strength}</div>
                <div className="text-[10px] text-slate-500" data-testid="mtf-candles-used">
                  from {tf.s.candlesUsed} candles
                </div>
                <div className="text-[10px] text-slate-500" data-testid="mtf-bar-time">
                  {barTimeText(tf.s)}
                </div>
              </div>
            ))}
          </div>

          {legacyFreshness && (
            <p className="text-[11px] text-slate-500" data-testid="mtf-legacy-freshness">
              This report was stored before bar times were recorded, so whether its candles were current
              when it was generated was not checked.
            </p>
          )}

          <TimeframeConflictWarning warning={r.conflictWarning} label={r.alignmentLabel} />
          <HigherTimeframeBiasCard
            higherTimeframe={r.higherTimeframe}
            higherTrend={r.higherTrend}
            bestBias={r.bestBias}
          />

          <p className="rounded-md border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-300">
            {r.aiSummary}
          </p>
        </>
      )}
    </div>
  );
}
