import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bareSymbol } from "@/lib/use-chart-symbol";
import type { ChartOverlay } from "@/lib/chart-overlays";
import { useAssistantName, DEFAULT_ASSISTANT_NAME } from "@/lib/assistant-name";
import {
  canUseScannerOpportunity,
  nextScannerMapFreshnessChange,
} from "@/components/scanner/scannerMapFreshness";
import { normalizeChartTimeframe } from "@/lib/chartCandlesQuery";
import { useEvidenceDeadline } from "@/hooks/useEvidenceDeadline";

// A chart read describes the chart until the next candle closes: observedAt
// (the latest CLOSED candle's close) + one interval. A gated read has nothing
// directional to expire (null); an unknown data time or interval reads as
// already expired (NaN), never as "still valid".
function chartReadExpiresAtMs(read: { observedAt: string | null; gated?: boolean }, intervalMs: number): number | null {
  if (read.gated) return null;
  const t = read.observedAt ? Date.parse(read.observedAt) : Number.NaN;
  if (!Number.isFinite(t) || !Number.isFinite(intervalMs) || intervalMs <= 0) return Number.NaN;
  return t + intervalMs;
}
// "HH:MM UTC" data time of a read, or null when unknown.
function chartReadAsOfLabel(read: { observedAt: string | null }): string | null {
  const t = read.observedAt ? Date.parse(read.observedAt) : Number.NaN;
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(11, 16)} UTC` : null;
}
// Interval of a normalized chart timeframe ("15m", "4h", "1d"); null when the
// label is not a fixed-length interval (months are not).
function candleIntervalMs(timeframe: string): number | null {
  const m = /^(\d+)(m|h|d|w)$/.exec(timeframe);
  if (!m) return null;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "m" | "h" | "d" | "w"];
  return Number(m[1]) * unit;
}

// useAiChartOverlays — ARX Native Chart Level 5 AI-overlay FOUNDATION.
//
// Maps REAL Eleanor + scanner outputs into the EXISTING Level 4 ChartOverlay
// contract so ARXNativeChart renders them with no renderer change. It does THREE
// things and nothing else:
//   1. Polls the existing market-scanner endpoint on its OWN throttled interval
//      (paused on a hidden tab, independent of the candle stream) and maps a
//      matching, ACTIONABLE opportunity into `source:"signal"` overlays
//      (entry / SL / TP lines + a BUY/SELL marker).
//   2. Exposes an on-demand `requestEleanorRead()` that calls the read-only Eleanor
//      assistant (`POST /api/me/assistant/read-chart`) and maps its support /
//      resistance zones into `source:"eleanor"` zone overlays.
//   3. SUPPRESSES every AI overlay when the chart feed is not AI-confirmed
//      (Level 3 `aiUsable=false`) — overlays go empty and a reason is surfaced.
//
// HONESTY / SAFETY:
//   - Never fabricates a marker: scanner overlays are built ONLY for a real
//     BUY/SELL opportunity with finite levels, and the opportunity's honest
//     `dataSource` (SIMULATOR / LIVE_FEED / …) is carried in metadata + label.
//   - Any fetch failure renders NOTHING (no fake lines), and never throws into
//     the chart — chart rendering and the Eleanor/scanner pages keep working.
//   - This hook never re-runs per candle: scanner polling is on a fixed
//     interval and the Eleanor read is strictly user-initiated.
//   - Only user-safe scanner fields are read (bias / confidence / status badge /
//     entry / SL / TP / final-read label) — no admin-only agent internals.

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const u = (p: string) => `${BASE}${p}`;

// Independent of the candle poll. Throttled so agents are never re-evaluated per
// candle update — this is the ONLY cadence at which scanner overlays refresh.
const SCANNER_POLL_MS = 20_000;

function normSym(s: string | null | undefined): string {
  if (!s) return "";
  const bare = s.includes(":") ? s.split(":")[1]! : s;
  return bare.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// --- Scanner opportunity (user-safe projection we actually consume) ----------

type ScannerSide = "BUY" | "SELL";

interface ScannerOpportunityLite {
  symbol: string;
  timeframe: string;
  bias: string;
  recommendedAction: string;
  confidenceScore: number;
  statusBadge: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  dataSource: string;
  finalRead?: { label?: string; headline?: string } | null;
  /** HTF Trend FVG Pullback advisory block (Task #675). Display-only. */
  fvgRead?: {
    direction: "BUY" | "SELL" | "WAIT";
    stage: string;
    htfAligned: boolean;
    activeFvg: { high: number; low: number; midpoint: number; direction: "bullish" | "bearish"; isMitigated: boolean } | null;
    canSignal: boolean;
    overlays: Array<{
      id: string;
      kind: "zone" | "line" | "marker";
      label: string;
      color: string;
      price?: number;
      priceMin?: number;
      priceMax?: number;
      style: "solid" | "dashed";
      lineWidth?: number;
      side?: "BUY" | "SELL";
    }>;
  } | null;
}

export interface AiSignalSummary {
  symbol: string;
  /** The opportunity's own timeframe (may differ from the chart's). */
  timeframe: string;
  /** True when this opportunity's timeframe matches the chart's timeframe. */
  timeframeMatchesChart: boolean;
  side: ScannerSide;
  bias: string;
  /** 0..1 (confidenceScore / 100). */
  confidence: number;
  statusBadge: string;
  dataSource: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  finalReadHeadline: string | null;
}

export type EleanorReadStatus = "idle" | "loading" | "ok" | "insufficient" | "error";

export interface EleanorReadSummary {
  bias: string;
  confidence: string;
  supportZone: string;
  resistanceZone: string;
  dataQuality: "ok" | "insufficient";
  /**
   * Data time of the read (latest CLOSED candle close, ISO) as the server sent
   * it. The read stops describing the chart once the next candle closes
   * (chartReadExpiresAtMs); unknown → treated as already expired.
   */
  observedAt?: string | null;
  /** Server gated the read (not confirmed); nothing directional to expire. */
  gated?: boolean;
  /**
   * Gold Strategy Mode block (Task #657) — present ONLY for gold symbols.
   * Display/decision-support only; carries no trade affordance.
   */
  goldStrategyRead?: {
    active: true;
    macroBias: string;
    macroNote: string;
    atrState: string;
    wickRisk: string;
    scalpBlocked: boolean;
    riskWarning: string;
  } | null;
}

function isFinitePositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Map a user-safe scanner opportunity to its panel summary (BUY/SELL only). */
function toSignalSummary(
  o: ScannerOpportunityLite,
  symbol: string,
  chartTimeframe: string,
): AiSignalSummary | null {
  const action = (o.recommendedAction || "").toUpperCase();
  const side: ScannerSide | null =
    action === "BUY" ? "BUY" : action === "SELL" ? "SELL" : null;
  if (!side) return null;
  if (!isFinitePositive(o.entry) || !isFinitePositive(o.stopLoss) || !isFinitePositive(o.takeProfit)) {
    return null;
  }
  const conf = Number.isFinite(o.confidenceScore)
    ? Math.max(0, Math.min(1, o.confidenceScore / 100))
    : 0;
  const tf = o.timeframe || "";
  return {
    symbol,
    timeframe: tf,
    timeframeMatchesChart: tf.toUpperCase() === (chartTimeframe || "").toUpperCase(),
    side,
    bias: o.bias || "",
    confidence: conf,
    statusBadge: o.statusBadge || "",
    dataSource: o.dataSource || "",
    entry: o.entry,
    stopLoss: o.stopLoss,
    takeProfit: o.takeProfit,
    finalReadHeadline: o.finalRead?.headline?.trim() || null,
  };
}

/** Build `source:"signal"` overlays from a scanner summary. */
export function buildSignalOverlays(
  sig: AiSignalSummary,
  symbol: string,
): ChartOverlay[] {
  const arrow = sig.side === "BUY" ? "▲" : "▼";
  const tag = sig.dataSource && sig.dataSource !== "LIVE_FEED" ? ` · ${sig.dataSource}` : "";
  const meta = {
    source: "signal",
    side: sig.side,
    statusBadge: sig.statusBadge,
    dataSource: sig.dataSource,
  };
  return [
    {
      id: `sig-${symbol}-entry`,
      type: "line",
      symbol,
      price: sig.entry,
      label: `Scanner ${sig.side} ${arrow} Entry${tag}`,
      severity: "info",
      source: "signal",
      confidence: sig.confidence,
      style: "solid",
      lineWidth: 2,
      metadata: meta,
    },
    {
      id: `sig-${symbol}-sl`,
      type: "line",
      symbol,
      price: sig.stopLoss,
      label: "Scanner SL",
      severity: "danger",
      source: "signal",
      confidence: sig.confidence,
      style: "dashed",
      lineWidth: 1,
      metadata: { ...meta, role: "invalidation" },
    },
    {
      id: `sig-${symbol}-tp`,
      type: "line",
      symbol,
      price: sig.takeProfit,
      label: "Scanner TP",
      severity: "success",
      source: "signal",
      confidence: sig.confidence,
      style: "dashed",
      lineWidth: 1,
      metadata: { ...meta, role: "target" },
    },
    {
      id: `sig-${symbol}-marker`,
      type: "marker",
      symbol,
      price: sig.entry,
      label: `Scanner ${sig.side}`,
      severity: sig.side === "BUY" ? "success" : "danger",
      source: "signal",
      confidence: sig.confidence,
      marker: { side: sig.side },
      metadata: meta,
    },
  ];
}

// Map Eleanor's textual confidence to a 0..1 opacity hint (display only).
function eleanorConfidence(conf: string): number {
  const c = (conf || "").toLowerCase();
  if (c === "high") return 0.9;
  if (c === "medium") return 0.6;
  return 0.3;
}

// Extract the finite numbers from a Eleanor zone string ("1.16500 – 1.17200",
// "1.16500", or "Not enough data" → []). Returns [] when none parse.
function parseZoneNumbers(zone: string | null | undefined): number[] {
  if (!zone) return [];
  const matches = zone.match(/-?\d+(?:\.\d+)?/g);
  if (!matches) return [];
  return matches
    .map((m) => Number(m))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** Build a single `source:"eleanor"` overlay (zone when 2 numbers, line when 1). */
function buildEleanorZoneOverlay(
  id: string,
  zone: string,
  label: string,
  severity: ChartOverlay["severity"],
  color: string,
  symbol: string,
  confidence: number,
): ChartOverlay | null {
  const nums = parseZoneNumbers(zone);
  if (nums.length >= 2) {
    return {
      id,
      type: "zone",
      symbol,
      priceMin: Math.min(...nums),
      priceMax: Math.max(...nums),
      label,
      severity,
      source: "eleanor",
      confidence,
      color,
      style: "dashed",
      metadata: { source: "eleanor", raw: zone },
    };
  }
  if (nums.length === 1) {
    return {
      id,
      type: "line",
      symbol,
      price: nums[0]!,
      label,
      severity,
      source: "eleanor",
      confidence,
      color,
      style: "dashed",
      lineWidth: 1,
      metadata: { source: "eleanor", raw: zone },
    };
  }
  return null;
}

/**
 * Build `source:"signal"` overlays from an opportunity's FVG analysis block
 * (Task #675 — HTF Trend FVG Pullback). Purely additive: when the block is
 * absent, empty, or canSignal=false the function returns an empty array.
 * Never fabricates a line — all overlay values come from the backend engine.
 */
export function buildFvgOverlays(
  opp: Pick<ScannerOpportunityLite, "fvgRead" | "symbol">,
): ChartOverlay[] {
  const fvg = opp.fvgRead;
  if (!fvg || !fvg.canSignal || !Array.isArray(fvg.overlays) || fvg.overlays.length === 0) {
    return [];
  }
  const out: ChartOverlay[] = [];
  for (const raw of fvg.overlays) {
    const kind = raw.kind;
    if (kind === "zone") {
      if (
        typeof raw.priceMin === "number" && Number.isFinite(raw.priceMin) &&
        typeof raw.priceMax === "number" && Number.isFinite(raw.priceMax) &&
        raw.priceMax > raw.priceMin
      ) {
        out.push({
          id: raw.id,
          type: "zone",
          symbol: opp.symbol,
          priceMin: raw.priceMin,
          priceMax: raw.priceMax,
          label: raw.label,
          severity: "info",
          source: "signal",
          style: raw.style,
          lineWidth: raw.lineWidth ?? 1,
          confidence: fvg.canSignal ? 0.75 : 0.4,
          metadata: { strategy: "HTF_TREND_FVG_PULLBACK" },
        });
      }
    } else if (kind === "line") {
      if (typeof raw.price === "number" && Number.isFinite(raw.price) && raw.price > 0) {
        out.push({
          id: raw.id,
          type: "line",
          symbol: opp.symbol,
          price: raw.price,
          label: raw.label,
          severity: "info",
          source: "signal",
          style: raw.style,
          lineWidth: raw.lineWidth ?? 1,
          confidence: fvg.canSignal ? 0.75 : 0.4,
          metadata: { strategy: "HTF_TREND_FVG_PULLBACK" },
        });
      }
    } else if (kind === "marker") {
      if (typeof raw.price === "number" && Number.isFinite(raw.price) && raw.price > 0 && raw.side) {
        out.push({
          id: raw.id,
          type: "marker",
          symbol: opp.symbol,
          price: raw.price,
          label: raw.label,
          severity: "info",
          source: "signal",
          marker: { side: raw.side },
          style: raw.style,
          lineWidth: raw.lineWidth ?? 1,
          confidence: fvg.canSignal ? 0.75 : 0.4,
          metadata: { strategy: "HTF_TREND_FVG_PULLBACK" },
        });
      }
    }
  }
  return out;
}

/** Map a Eleanor read into `source:"eleanor"` overlays (only when dataQuality ok). */
export function buildEleanorOverlays(
  read: EleanorReadSummary,
  symbol: string,
  assistantName: string = DEFAULT_ASSISTANT_NAME,
): ChartOverlay[] {
  if (read.dataQuality !== "ok") return [];
  const conf = eleanorConfidence(read.confidence);
  const overlays: ChartOverlay[] = [];
  const support = buildEleanorZoneOverlay(
    `eleanor-${symbol}-support`,
    read.supportZone,
    `${assistantName} support`,
    "success",
    "#34d399",
    symbol,
    conf,
  );
  const resistance = buildEleanorZoneOverlay(
    `eleanor-${symbol}-resistance`,
    read.resistanceZone,
    `${assistantName} resistance`,
    "warning",
    "#f472b6",
    symbol,
    conf,
  );
  if (support) overlays.push(support);
  if (resistance) overlays.push(resistance);
  return overlays;
}

/**
 * Whether the last scanner poll answered. "unavailable" = the request failed
 * (network error, outage, throttled) — NOT "the scanner found nothing".
 */
export type ScannerFetchStatus = "loading" | "ok" | "unavailable";

export interface UseAiChartOverlaysResult {
  /** Combined AI overlays for the chart (scanner + Eleanor). Empty when suppressed. */
  overlays: ChartOverlay[];
  /** User-safe scanner-signal summary for the panel legend, when one matches. */
  signal: AiSignalSummary | null;
  /** Whether the scanner could be reached on the last poll. */
  scannerStatus?: ScannerFetchStatus;
  /** FVG advisory currently drawn from the scanner row (canSignal only), for the legend. */
  fvg?: { direction: "BUY" | "SELL" | "WAIT"; stage: string; entryTimeframe: string; asOf: string | null } | null;
  /** On-demand Eleanor read state for the panel. */
  eleanor: {
    status: EleanorReadStatus;
    read: EleanorReadSummary | null;
    error: string | null;
    /** True once the next candle has closed after the read (zones no longer drawn). */
    expired?: boolean;
    /** "HH:MM UTC" data time of the read, or null when unknown. */
    asOf?: string | null;
  };
  /** True when the chart feed is not AI-confirmed (Level 3) — overlays hidden. */
  suppressed: boolean;
  /** Honest reason overlays are hidden, else null. */
  suppressedReason: string | null;
  /** Trigger a Eleanor read of the current symbol/timeframe (user-initiated only). */
  requestEleanorRead: () => void;
}

/**
 * Source AI overlays for the chart's current symbol/timeframe. Suppresses all
 * AI overlays when `aiUsable` is false (unconfirmed feed). The symbol is
 * normalised the same way ARXNativeChart normalises its symbol so overlays line
 * up with the rendered candles.
 */
export function useAiChartOverlays({
  symbol,
  timeframe,
  aiUsable,
}: {
  symbol: string;
  timeframe: string;
  aiUsable: boolean;
}): UseAiChartOverlaysResult {
  const { name } = useAssistantName();
  const normalized = useMemo(
    () => bareSymbol(symbol || "").toUpperCase(),
    [symbol],
  );

  const [signal, setSignal] = useState<AiSignalSummary | null>(null);
  const [scannerStatus, setScannerStatus] = useState<ScannerFetchStatus>("loading");
  // FVG advisory block from the raw scanner opportunity — separate from signal
  // so buildFvgOverlays can always access fvgRead even when signal is null.
  const [fvgOpp, setFvgOpp] = useState<Pick<ScannerOpportunityLite, "fvgRead" | "symbol"> | null>(null);
  const [eleanorStatus, setEleanorStatus] = useState<EleanorReadStatus>("idle");
  const [eleanorRead, setEleanorRead] = useState<EleanorReadSummary | null>(null);
  const [eleanorError, setEleanorError] = useState<string | null>(null);

  const suppressed = !aiUsable;
  const suppressedReason = suppressed
    ? "Feed is not AI-confirmed — AI overlays hidden until the live feed is clean."
    : null;

  // Poll the scanner on our OWN throttled interval; pause while tab is hidden.
  // Independent of the candle stream — this never re-runs per candle.
  useEffect(() => {
    if (!normalized || suppressed) {
      setSignal(null);
      return;
    }
    let cancelled = false;
    // Clear any prior-context signal immediately so the chart never paints the
    // previous symbol/timeframe's levels while the new fetch is in flight. The
    // `cancelled` cleanup below already prevents an old in-flight response from
    // overwriting newer context.
    setSignal(null);
    setFvgOpp(null);
    setScannerStatus("loading");
    const load = async () => {
      try {
        const r = await fetch(u("/api/market-scanner/opportunities?limit=50"), {
          credentials: "include",
        });
        // A failed / throttled request is "scanner unavailable", never "no signal".
        if (!r.ok) throw new Error(`scanner ${r.status}`);
        const res = await r.json();
        if (cancelled) return;
        const list: ScannerOpportunityLite[] = Array.isArray(res?.opportunities)
          ? res.opportunities
          : [];
        // Prefer an opportunity on the chart's own timeframe; otherwise fall
        // back to any same-symbol opportunity (its timeframe is surfaced
        // honestly so a different-timeframe read is never shown as this one).
        const symMatches = list.filter((o) => normSym(o.symbol) === normSym(normalized));
        const tfUpper = (timeframe || "").toUpperCase();
        const match =
          symMatches.find((o) => (o.timeframe || "").toUpperCase() === tfUpper) ??
          symMatches[0] ??
          null;
        setSignal(match ? toSignalSummary(match, normalized, timeframe) : null);
        setFvgOpp(match ? { symbol: match.symbol, fvgRead: match.fvgRead ?? null } : null);
        setScannerStatus("ok");
      } catch {
        // Honest empty on failure — never fabricate a signal — and say the
        // scanner could not be reached rather than "no signal".
        if (!cancelled) { setSignal(null); setFvgOpp(null); setScannerStatus("unavailable"); }
      }
    };
    void load();
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (id == null) id = setInterval(load, SCANNER_POLL_MS); };
    const stop = () => { if (id != null) { clearInterval(id); id = null; } };
    const onVis = () => { if (document.hidden) stop(); else { void load(); start(); } };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [normalized, timeframe, suppressed]);

  // Monotonic request token. Bumped on every new Eleanor request AND whenever the
  // instrument changes, so a slow in-flight read can never apply its result to a
  // different symbol/timeframe (the "no stale read across symbol change" rule).
  const eleanorReqRef = useRef(0);

  // Reset the Eleanor read whenever the instrument changes — a stale read must
  // never sit on a different symbol's chart. Bumping the token invalidates any
  // in-flight request so its late response is discarded.
  useEffect(() => {
    eleanorReqRef.current += 1;
    setEleanorStatus("idle");
    setEleanorRead(null);
    setEleanorError(null);
  }, [normalized, timeframe]);

  // A read taken before the feed went unconfirmed must not come back when the
  // feed recovers: drop it (and any in-flight request) as soon as we suppress.
  useEffect(() => {
    if (!suppressed) return;
    eleanorReqRef.current += 1;
    setEleanorStatus("idle");
    setEleanorRead(null);
    setEleanorError(null);
  }, [suppressed]);

  // A Eleanor read describes the chart only until the next candle closes
  // (observedAt + one interval) — the same rule the scanner's Eleanor read uses.
  const eleanorExpiresAtMs = eleanorRead
    ? chartReadExpiresAtMs(
        { observedAt: eleanorRead.observedAt ?? null, gated: eleanorRead.gated },
        candleIntervalMs(normalizeChartTimeframe(timeframe)) ?? Number.NaN,
      )
    : null;
  const eleanorNowMs = useEvidenceDeadline(
    eleanorExpiresAtMs != null && Number.isFinite(eleanorExpiresAtMs) ? eleanorExpiresAtMs : null,
  );
  const eleanorExpired =
    eleanorRead != null &&
    eleanorExpiresAtMs != null &&
    !(Number.isFinite(eleanorExpiresAtMs) && eleanorNowMs < eleanorExpiresAtMs);
  const eleanorAsOf = eleanorRead
    ? chartReadAsOfLabel({ observedAt: eleanorRead.observedAt ?? null })
    : null;

  const requestEleanorRead = useCallback(() => {
    if (!normalized || suppressed) return;
    const reqId = (eleanorReqRef.current += 1);
    setEleanorStatus("loading");
    setEleanorError(null);
    void (async () => {
      try {
        const r = await fetch(u("/api/me/assistant/read-chart"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ symbol: normalized, timeframe }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { chartRead?: EleanorReadSummary };
        if (reqId !== eleanorReqRef.current) return;
        const read = j.chartRead ?? null;
        if (!read) {
          setEleanorStatus("error");
          setEleanorError(`${name} returned no read.`);
          return;
        }
        setEleanorRead(read);
        setEleanorStatus(read.dataQuality === "ok" ? "ok" : "insufficient");
      } catch (e) {
        if (reqId !== eleanorReqRef.current) return;
        setEleanorStatus("error");
        setEleanorError(e instanceof Error ? e.message : "network error");
      }
    })();
  }, [normalized, timeframe, suppressed, name]);

  const overlays = useMemo(() => {
    if (suppressed) return [];
    const out: ChartOverlay[] = [];
    if (signal) out.push(...buildSignalOverlays(signal, normalized));
    if (eleanorRead && !eleanorExpired) out.push(...buildEleanorOverlays(eleanorRead, normalized, name));
    // HTF Trend FVG Pullback overlays (Task #675) — additive, display-only.
    // Emits chart zones/lines ONLY when the backend engine set canSignal=true.
    if (fvgOpp) out.push(...buildFvgOverlays(fvgOpp));
    return out;
  }, [suppressed, signal, eleanorRead, eleanorExpired, fvgOpp, normalized, name]);

  const fvgRead = fvgOpp?.fvgRead ?? null;
  const fvg =
    !suppressed && fvgRead && fvgRead.canSignal && buildFvgOverlays(fvgOpp!).length > 0
      ? {
          direction: fvgRead.direction,
          stage: fvgRead.stage,
          // Optional on this line's scanner row: read loosely.
          entryTimeframe: (fvgRead as { entryTimeframe?: string }).entryTimeframe || "M5",
          asOf: typeof (fvgRead as { asOf?: unknown }).asOf === "string" ? ((fvgRead as { asOf?: string }).asOf ?? null) : null,
        }
      : null;

  return {
    overlays,
    signal: suppressed ? null : signal,
    scannerStatus,
    fvg,
    eleanor: { status: eleanorStatus, read: eleanorRead, error: eleanorError, expired: eleanorExpired, asOf: eleanorAsOf },
    suppressed,
    suppressedReason,
    requestEleanorRead,
  };
}
