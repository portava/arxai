// Smart Chart Layers & News Radar — PURE BUILDERS (Task #197).
//
// All functions here are pure & deterministic (no IO, DB, HTTP, Date.now, or
// randomness — callers pass `now`/age in). They convert real upstream reads
// (Ruby signal geometry, structure levels, the economic calendar, the news
// provider connection state) into the visual layer model + radar + behavior +
// overlay handshake.
//
// HONESTY: when an input is missing the output degrades honestly — empty layers,
// a NOT_AVAILABLE check, or a NO_PROVIDER behavior — never a fabricated value.
// No internal enum token (UPPER_SNAKE) is ever placed in a user-facing string.

import type { HandshakeOverallStatus } from "../handshake/handshake.types";
import type {
  NewsBehaviorMode,
  NewsRadarEvent,
  NewsRadarSeverity,
  NewsRadarState,
  SmartChartLayer,
  SmartChartNewsBehavior,
  SmartChartOverlayCheck,
  SmartChartOverlayHandshake,
} from "./smartChart.types";

// ── Severity / priority mapping ──────────────────────────────────────────────

/** Alert priority used by the alert manager (LOW/MEDIUM/HIGH/CRITICAL). */
export type SmartChartAlertPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * Map a radar severity to an alert priority. The two ladders are intentionally
 * 1:1 so the alert manager's CRITICAL-bypass semantics apply directly.
 */
export function mapEventSeverityToAlertPriority(
  severity: NewsRadarSeverity,
): SmartChartAlertPriority {
  return severity;
}

/**
 * Classify an economic event's severity from its calendar impact and how close
 * it is to firing. A high-impact event that is LIVE or IMMINENT is elevated to
 * CRITICAL (trader must see it); otherwise high → HIGH, medium → MEDIUM, low →
 * LOW.
 */
export function classifyNewsSeverity(
  impact: "low" | "medium" | "high",
  state: NewsRadarState,
): NewsRadarSeverity {
  if (impact === "high") {
    return state === "LIVE" || state === "IMMINENT" ? "CRITICAL" : "HIGH";
  }
  if (impact === "medium") return "MEDIUM";
  return "LOW";
}

/** Numeric rank so callers can pick the "top" severity affecting a symbol. */
export function severityRank(severity: NewsRadarSeverity): number {
  switch (severity) {
    case "CRITICAL":
      return 4;
    case "HIGH":
      return 3;
    case "MEDIUM":
      return 2;
    case "LOW":
    default:
      return 1;
  }
}

/**
 * The highest severity among the events that actually affect the selected
 * symbol (null when none do). Pure — shared by the radar service and the
 * scanner-risk reflection so the two can never drift.
 */
export function topAffectingSeverity(
  events: readonly NewsRadarEvent[],
): NewsRadarSeverity | null {
  let top: NewsRadarSeverity | null = null;
  for (const e of events) {
    if (!e.affectsSymbol) continue;
    if (top == null || severityRank(e.severity) > severityRank(top)) {
      top = e.severity;
    }
  }
  return top;
}

/**
 * Detect synthetic / non-real-world instruments (e.g. Deriv Volatility, Crash,
 * Boom, Jump, Step, R_* indices). These are immune to real-world macro events,
 * so the radar never maps an economic event onto them. Pure.
 */
export function isSyntheticInstrument(symbol: string): boolean {
  const s = symbol.toUpperCase();
  return (
    s.includes("VOLATILITY") ||
    s.includes("CRASH") ||
    s.includes("BOOM") ||
    s.includes("JUMP") ||
    s.includes("STEP") ||
    /\bR_\d+\b/.test(s) ||
    /\b(1S)\b/.test(s)
  );
}

// ── Scanner news-risk reflection ─────────────────────────────────────────────

/** Scanner-side news-risk ladder (mirrors the scanner news service). */
export type ScannerNewsRiskLevel = "none" | "low" | "medium" | "high" | "critical";

const SCANNER_RISK_RANK: Record<ScannerNewsRiskLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Map a radar severity onto the scanner's news-risk ladder. */
export function radarSeverityToScannerRisk(
  severity: NewsRadarSeverity | null,
): ScannerNewsRiskLevel {
  switch (severity) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MEDIUM":
      return "medium";
    case "LOW":
      return "low";
    default:
      return "none";
  }
}

/**
 * Reflect the Market Impact Radar's severity into the scanner's news-risk
 * level. The scanner risk is only ever ESCALATED by the radar (a higher-severity
 * economic window for the symbol), never downgraded. Honest: a null radar
 * severity (no connected calendar / no affecting event) maps to "none" and
 * leaves the scanner risk untouched. Pure.
 */
export function escalateNewsRiskLevel(
  current: ScannerNewsRiskLevel,
  radarSeverity: NewsRadarSeverity | null,
): ScannerNewsRiskLevel {
  const radar = radarSeverityToScannerRisk(radarSeverity);
  return SCANNER_RISK_RANK[radar] > SCANNER_RISK_RANK[current] ? radar : current;
}

/**
 * Is a given UTC hour inside the user's quiet-hours window? Pure.
 *
 * `start`/`end` are 0–23 UTC hours (or null when unset → no quiet window).
 * Handles wrap-around windows (e.g. 22→6 spans midnight). A window where
 * start === end is treated as empty (no quiet hours), never "all day".
 */
export function isWithinQuietHoursUtc(
  start: number | null | undefined,
  end: number | null | undefined,
  hourUtc: number,
): boolean {
  if (start == null || end == null) return false;
  if (start === end) return false;
  if (start < end) return hourUtc >= start && hourUtc < end;
  // wrap-around midnight
  return hourUtc >= start || hourUtc < end;
}

/**
 * Decide whether a news event should INTERRUPT the user with a toast alert,
 * versus staying visual-only on the radar/chart. Pure and deterministic so it
 * can be unit-tested independently of the React component.
 *
 * Rules (mirror the Alert Preferences page):
 *  - Only events that affect the active symbol and are firing now / about to
 *    fire (LIVE or IMMINENT) are ever eligible to interrupt.
 *  - CRITICAL always interrupts — it can never be silenced by preferences or
 *    quiet hours.
 *  - HIGH interrupts only when preferences are LOADED, market alerts are
 *    enabled, and we are outside quiet hours. Until prefs load we do NOT
 *    interrupt (no permissive default), so a user who disabled market alerts or
 *    is in quiet hours never gets a stray HIGH toast during the load race.
 *  - MEDIUM / LOW never interrupt — visual only.
 */
export function newsToastDecision(input: {
  severity: NewsRadarSeverity;
  state: NewsRadarState;
  affectsSymbol: boolean;
  prefsLoaded: boolean;
  marketAlertsEnabled: boolean;
  quietHoursActive: boolean;
}): boolean {
  if (!input.affectsSymbol) return false;
  if (input.state !== "LIVE" && input.state !== "IMMINENT") return false;
  if (input.severity === "CRITICAL") return true;
  if (input.severity !== "HIGH") return false;
  if (!input.prefsLoaded) return false;
  return input.marketAlertsEnabled && !input.quietHoursActive;
}

// ── Event timing / symbol mapping ────────────────────────────────────────────

const IMMINENT_WINDOW_S = 15 * 60; // ≤ 15 min out
const RECENT_WINDOW_S = 30 * 60; // up to 30 min after

/** Derive an event state from a signed countdown (seconds). Pure. */
export function eventState(countdownSeconds: number): NewsRadarState {
  if (countdownSeconds <= -RECENT_WINDOW_S) return "RECENT";
  if (countdownSeconds < 0) return "LIVE";
  if (countdownSeconds <= IMMINENT_WINDOW_S) return "IMMINENT";
  return "UPCOMING";
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * Does an economic event map onto a symbol? Schedule-based mapping:
 *   - the event's currency appears in the symbol (e.g. USD in EURUSD), or
 *   - the symbol is listed in the event's affected markets (indices/stocks).
 * Synthetic / non-real-world instruments are handled by the caller (they are
 * immune to real-world news) — here we only do the textual mapping.
 */
export function eventAffectsSymbol(
  symbol: string,
  currency: string,
  affectedMarkets: readonly string[],
): boolean {
  const sym = normalizeSymbol(symbol);
  if (sym.length === 0) return false;
  const cur = currency.trim().toUpperCase();
  if (cur.length > 0 && sym.includes(cur)) return true;
  for (const m of affectedMarkets) {
    const mm = normalizeSymbol(m);
    if (mm.length === 0) continue;
    if (sym === mm || sym.startsWith(mm) || mm.startsWith(sym)) return true;
  }
  return false;
}

// ── Calendar events → radar events (honesty gate) ────────────────────────────

/**
 * A raw economic-calendar event from a connected, REAL calendar provider. The
 * radar maps these onto the symbol; it does NOT carry forecast/actual numbers —
 * those are never surfaced by the radar.
 */
export interface RawCalendarEvent {
  id: string;
  title: string;
  currency: string;
  impact: "low" | "medium" | "high";
  eventTimeIso: string;
  affectedMarkets: string[];
}

/**
 * Build the radar's events from a calendar feed — HONESTY GATE.
 *
 * Events are surfaced ONLY when a real economic-calendar provider is connected
 * (`calendarConnected`). When it is not connected this returns `[]` regardless
 * of any `rawEvents` passed in: the radar NEVER fabricates a scheduled macro
 * event, and therefore can NEVER emit an actionable (Critical/High) alert from
 * synthetic/disconnected data. Synthetic instruments are immune to real-world
 * macro events and never map to one. Pure (caller passes `nowMs`).
 */
export function buildRadarEvents(input: {
  calendarConnected: boolean;
  rawEvents: readonly RawCalendarEvent[];
  symbol: string;
  synthetic: boolean;
  nowMs: number;
}): NewsRadarEvent[] {
  if (!input.calendarConnected) return [];
  const sym = normalizeSymbol(input.symbol);
  return input.rawEvents.map((e) => {
    const countdownSeconds = Math.round(
      (new Date(e.eventTimeIso).getTime() - input.nowMs) / 1000,
    );
    const state = eventState(countdownSeconds);
    const severity = classifyNewsSeverity(e.impact, state);
    const affectsSymbol = input.synthetic
      ? false
      : eventAffectsSymbol(sym, e.currency, e.affectedMarkets);
    return {
      id: e.id,
      title: e.title,
      currency: e.currency,
      severity,
      eventTimeIso: e.eventTimeIso,
      countdownSeconds,
      state,
      affectsSymbol,
      affectedSymbols: e.affectedMarkets,
    };
  });
}

// ── News behavior ────────────────────────────────────────────────────────────

/**
 * Decide how news should colour the read for the selected symbol. Honest:
 *   - no provider connected → technicals-only (NO_PROVIDER).
 *   - a high-impact event live in its window → NEWS_LIVE.
 *   - a high-impact event imminent/upcoming-soon → PRE_NEWS_CAUTION.
 *   - a high-impact event just passed → POST_NEWS.
 *   - otherwise → NORMAL.
 * Only events that AFFECT the symbol drive the mode.
 */
export function deriveNewsBehavior(
  providerConnected: boolean,
  events: readonly NewsRadarEvent[],
): SmartChartNewsBehavior {
  if (!providerConnected) {
    return {
      mode: "NO_PROVIDER",
      note:
        "No economic-calendar provider is connected, so no scheduled events are shown — the read below is technicals-only and does not include event timing or confirmed headlines.",
    };
  }

  const affecting = events.filter(
    (e) => e.affectsSymbol && (e.severity === "CRITICAL" || e.severity === "HIGH"),
  );
  if (affecting.length === 0) {
    return {
      mode: "NORMAL",
      note: "No high-impact economic events are affecting this symbol right now.",
    };
  }

  const live = affecting.find((e) => e.state === "LIVE");
  if (live) {
    return {
      mode: "NEWS_LIVE",
      note: `${live.title} is in its high-impact window now. Spreads and volatility can spike — treat any signal as lower-confidence until the move settles.`,
    };
  }
  const imminent = affecting.find(
    (e) => e.state === "IMMINENT" || e.state === "UPCOMING",
  );
  if (imminent) {
    const mins = Math.max(0, Math.round(imminent.countdownSeconds / 60));
    return {
      mode: "PRE_NEWS_CAUTION",
      note: `${imminent.title} lands in about ${mins} min and can move this symbol. Consider waiting — entries taken into the event carry extra risk.`,
    };
  }
  const recent = affecting.find((e) => e.state === "RECENT");
  if (recent) {
    const mins = Math.max(0, Math.round(Math.abs(recent.countdownSeconds) / 60));
    return {
      mode: "POST_NEWS",
      note: `${recent.title} was about ${mins} min ago. Early post-news moves can reverse — wait for the dust to settle before trusting direction.`,
    };
  }
  return {
    mode: "NORMAL",
    note: "No high-impact economic events are affecting this symbol right now.",
  };
}

// ── Signal → visual layers ───────────────────────────────────────────────────

interface PriceBand {
  from: number;
  to: number;
}

/** Narrow signal projection the layer builder needs (decoupled from the full signal). */
export interface SignalLayerInput {
  symbol: string;
  hasSufficientData: boolean;
  entryZone: PriceBand | null;
  watchZone: PriceBand | null;
  retestZone: PriceBand | null;
  doNotChaseZone: PriceBand | null;
  invalidationPrice: number | null;
  stopLoss: number | null;
  takeProfitZones: PriceBand[];
}

/** Narrow structure-level projection (from the chart-intelligence levels read). */
export interface StructureLevelInput {
  kind: "support" | "resistance";
  price: number;
  /** Optional personality label (already plain-English from the engine). */
  personality?: string | null;
}

function isFiniteNum(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function band(b: PriceBand | null): b is PriceBand {
  return !!b && isFiniteNum(b.from) && isFiniteNum(b.to);
}

/**
 * Build Ruby's signal geometry as visual layers. Layers are ONLY produced when
 * the signal was built for the SAME symbol the chart is showing — otherwise we
 * return [] and let the overlay handshake flag the mismatch (consistency). This
 * guarantees the drawn layers never contradict Ruby's text for another symbol.
 */
export function buildSignalLayers(
  signal: SignalLayerInput | null,
  structureLevels: readonly StructureLevelInput[],
  requestedSymbol: string,
): SmartChartLayer[] {
  const layers: SmartChartLayer[] = [];
  const want = normalizeSymbol(requestedSymbol);

  // Structure / SR layers are symbol-agnostic reads of the same chart.
  let li = 0;
  for (const lvl of structureLevels) {
    if (!isFiniteNum(lvl.price)) continue;
    const label = lvl.personality
      ? `${lvl.kind === "support" ? "Support" : "Resistance"} — ${lvl.personality}`
      : lvl.kind === "support"
        ? "Support"
        : "Resistance";
    layers.push({
      id: `structure-${lvl.kind}-${li++}`,
      group: "structure",
      kind: "line",
      price: lvl.price,
      label,
      severity: "neutral",
      source: "structure",
    });
  }

  if (!signal || normalizeSymbol(signal.symbol) !== want) {
    return layers;
  }

  if (band(signal.watchZone)) {
    layers.push({
      id: "signal-watch",
      group: "signal_zones",
      kind: "zone",
      priceFrom: signal.watchZone.from,
      priceTo: signal.watchZone.to,
      label: "Watch zone",
      severity: "info",
      source: "signal",
    });
  }
  if (band(signal.entryZone)) {
    layers.push({
      id: "signal-entry",
      group: "signal_zones",
      kind: "zone",
      priceFrom: signal.entryZone.from,
      priceTo: signal.entryZone.to,
      label: "Entry zone",
      severity: "success",
      source: "signal",
    });
  }
  if (band(signal.retestZone)) {
    layers.push({
      id: "signal-retest",
      group: "signal_zones",
      kind: "zone",
      priceFrom: signal.retestZone.from,
      priceTo: signal.retestZone.to,
      label: "Retest zone",
      severity: "info",
      source: "signal",
    });
  }
  if (band(signal.doNotChaseZone)) {
    layers.push({
      id: "signal-late",
      group: "signal_zones",
      kind: "zone",
      priceFrom: signal.doNotChaseZone.from,
      priceTo: signal.doNotChaseZone.to,
      label: "Late — do not chase",
      severity: "warning",
      source: "signal",
    });
  }
  if (isFiniteNum(signal.invalidationPrice)) {
    layers.push({
      id: "signal-invalidation",
      group: "signal_zones",
      kind: "line",
      price: signal.invalidationPrice,
      label: "Invalidation",
      severity: "danger",
      source: "signal",
    });
  }
  if (isFiniteNum(signal.stopLoss)) {
    layers.push({
      id: "signal-sl",
      group: "targets",
      kind: "line",
      price: signal.stopLoss,
      label: "Stop loss",
      severity: "danger",
      source: "signal",
    });
  }
  let ti = 1;
  for (const tp of signal.takeProfitZones) {
    if (!band(tp)) continue;
    const mid = (tp.from + tp.to) / 2;
    layers.push({
      id: `signal-tp-${ti}`,
      group: "targets",
      kind: "line",
      price: mid,
      label: `Take profit ${ti}`,
      severity: "success",
      source: "signal",
    });
    ti++;
  }

  return layers;
}

// ── Execution-cost overlay (Phase 3 break-even + expected-fill band) ──────────

/**
 * Inputs for the DRAWN execution-cost overlay, taken from the Phase 3 execution
 * preview (`estimateExecutionPreview`) for the signal's proposed trade. Every
 * value is a real broker-derived number or null — we never fabricate a cost.
 */
export interface ExecutionCostLayerInput {
  side: "BUY" | "SELL";
  /** Most-likely fill price (expectedFillRange.expected). */
  expectedFill: number | null;
  /** Best-case fill price (expectedFillRange.low). */
  fillLow: number | null;
  /** Worst-case fill price (expectedFillRange.high). */
  fillHigh: number | null;
  /** Break-even distance from the fill, in price POINTS (breakEven.points). */
  breakEvenPoints: number | null;
  /** Price size of one point (preview.pointSize). */
  pointSize: number | null;
}

/**
 * Build the execution-cost overlay as DRAWN layers: an expected-fill band (the
 * price range the order is likely to fill across) and a break-even price line
 * (where price must reach for the trade to cover entry cost). Each layer is
 * emitted ONLY when its underlying numbers are real, finite and positive — a
 * missing quote or a degraded estimate yields fewer layers, never a fabricated
 * one. These are non-reserved (live), so the chart draws them immediately.
 */
export function buildExecutionCostLayers(
  input: ExecutionCostLayerInput,
): SmartChartLayer[] {
  const layers: SmartChartLayer[] = [];

  // Expected-fill band (zone) — needs two finite, positive bounds.
  if (isFiniteNum(input.fillLow) && isFiniteNum(input.fillHigh)) {
    const from = Math.min(input.fillLow, input.fillHigh);
    const to = Math.max(input.fillLow, input.fillHigh);
    if (from > 0 && to > 0) {
      layers.push({
        id: "exec-cost-fill-band",
        group: "execution_cost",
        kind: "zone",
        priceFrom: from,
        priceTo: to,
        label: "Expected fill range",
        severity: "info",
        source: "execution",
      });
    }
  }

  // Break-even line — fill anchor moved by the break-even distance in the
  // recovery direction (a BUY must rise above the fill; a SELL must fall below).
  if (
    isFiniteNum(input.expectedFill) &&
    input.expectedFill > 0 &&
    isFiniteNum(input.breakEvenPoints) &&
    input.breakEvenPoints > 0 &&
    isFiniteNum(input.pointSize) &&
    input.pointSize > 0
  ) {
    const dist = input.breakEvenPoints * input.pointSize;
    const bePrice =
      input.side === "BUY" ? input.expectedFill + dist : input.expectedFill - dist;
    if (bePrice > 0) {
      layers.push({
        id: "exec-cost-break-even",
        group: "execution_cost",
        kind: "line",
        price: bePrice,
        label: "Break-even (after cost)",
        severity: "warning",
        source: "execution",
      });
    }
  }

  return layers;
}

// ── Reserved trade-health slot ───────────────────────────────────────────────

/** Minimal open-position projection for the reserved trade-health slot. */
export interface ReservedSlotPosition {
  ticket: string;
  symbol: string;
  entryPrice: number | null;
}

/**
 * Reserve the trade-health overlay slot for open positions on the selected
 * symbol. The slot is surfaced so it exists now; the trade-health scoring lands
 * in a later phase, so it is labeled honestly as not-yet-active and flagged
 * `reserved` (the chart does not draw a price line for it). We never draw a
 * fabricated health number. (Execution-cost is now drawn live — see
 * `buildExecutionCostLayers`.)
 */
export function buildTradeHealthSlots(
  positions: readonly ReservedSlotPosition[],
  requestedSymbol: string,
): SmartChartLayer[] {
  const want = normalizeSymbol(requestedSymbol);
  const layers: SmartChartLayer[] = [];
  for (const p of positions) {
    if (normalizeSymbol(p.symbol) !== want) continue;
    if (isFiniteNum(p.entryPrice)) {
      layers.push({
        id: `trade-health-${p.ticket}`,
        group: "trade_health",
        kind: "marker",
        price: p.entryPrice,
        label: "Trade health — monitoring lands in a later phase",
        severity: "neutral",
        source: "position",
        reserved: true,
      });
    }
  }
  return layers;
}

// ── Overlay handshake ────────────────────────────────────────────────────────

const FRESHNESS_WARN_MS = 90 * 1000; // overlays older than 90s → caution
const FRESHNESS_FAIL_MS = 5 * 60 * 1000; // older than 5 min → stale

export interface OverlayHandshakeInput {
  /** Whether the chart canvas has actually rendered (a frontend fact). */
  chartLoaded: boolean;
  /** Symbol the chart bus is currently showing (null when unknown). */
  chartSymbol: string | null;
  /** Symbol the signal/layers were built for (null when no signal). */
  signalSymbol: string | null;
  /** Whether a signal read exists for the symbol. */
  signalExists: boolean;
  /** Whether the signal had enough data (vs an honest blind read). */
  hasSufficientData: boolean;
  /** Count of structure levels drawn. */
  levelCount: number;
  /** Whether the news radar produced a (possibly-empty) mapping. */
  newsMapped: boolean;
  /** Age of the overlay data in ms (null when unknown). */
  overlayAgeMs: number | null;
}

/**
 * Compose the Smart Chart Overlay Handshake from the (frontend) chart state and
 * the (backend) data readiness. Advisory only — it never blocks rendering or
 * trading; it tells the user how much to trust what is drawn. Honest: when a
 * fact is unknown the check is NOT_AVAILABLE, never a fabricated PASS.
 */
export function buildOverlayHandshake(
  input: OverlayHandshakeInput,
): SmartChartOverlayHandshake {
  const checks: SmartChartOverlayCheck[] = [];

  checks.push({
    key: "chartLoaded",
    status: input.chartLoaded ? "PASS" : "FAIL",
    detail: input.chartLoaded
      ? "Chart is rendered."
      : "Chart has not finished loading.",
  });

  // Symbol match between the chart bus and the signal the layers came from.
  const cs = input.chartSymbol ? normalizeSymbol(input.chartSymbol) : null;
  const ss = input.signalSymbol ? normalizeSymbol(input.signalSymbol) : null;
  if (!cs || !ss) {
    checks.push({
      key: "symbolMatch",
      status: "NOT_AVAILABLE",
      detail: "Waiting for the chart and signal to report a symbol.",
    });
  } else if (cs === ss) {
    checks.push({
      key: "symbolMatch",
      status: "PASS",
      detail: `Layers match the symbol on the chart (${cs}).`,
    });
  } else {
    checks.push({
      key: "symbolMatch",
      status: "WARN",
      detail: `The chart shows ${cs} but these layers were built for ${ss} — they may not line up.`,
    });
  }

  if (!input.signalExists) {
    checks.push({
      key: "signalExists",
      status: "FAIL",
      detail: "No signal read is available for this symbol yet.",
    });
  } else if (!input.hasSufficientData) {
    checks.push({
      key: "signalExists",
      status: "WARN",
      detail: "Limited data — this is a technicals-only read with fewer drawn levels.",
    });
  } else {
    checks.push({
      key: "signalExists",
      status: "PASS",
      detail: "A current signal read is driving the layers.",
    });
  }

  checks.push({
    key: "levelsAvailable",
    status: input.levelCount > 0 ? "PASS" : "WARN",
    detail:
      input.levelCount > 0
        ? `${input.levelCount} structure level${input.levelCount === 1 ? "" : "s"} drawn.`
        : "No structure levels have formed yet on this timeframe.",
  });

  checks.push({
    key: "newsMapped",
    status: input.newsMapped ? "PASS" : "NOT_AVAILABLE",
    detail: input.newsMapped
      ? "Economic events are mapped to this symbol."
      : "News mapping is not available right now.",
  });

  if (input.overlayAgeMs == null) {
    checks.push({
      key: "freshness",
      status: "NOT_AVAILABLE",
      detail: "Overlay age is unknown.",
    });
  } else if (input.overlayAgeMs <= FRESHNESS_WARN_MS) {
    checks.push({
      key: "freshness",
      status: "PASS",
      detail: "Overlays are fresh.",
    });
  } else if (input.overlayAgeMs <= FRESHNESS_FAIL_MS) {
    checks.push({
      key: "freshness",
      status: "WARN",
      detail: "Overlays are a little old — refresh for the latest read.",
    });
  } else {
    checks.push({
      key: "freshness",
      status: "FAIL",
      detail: "Overlays are stale — refresh to redraw from a current read.",
    });
  }

  const overallStatus = rollUpOverall(checks);
  const warnings = checks
    .filter((c) => c.status === "WARN" || c.status === "FAIL")
    .map((c) => c.detail);

  return {
    overallStatus,
    checks,
    userFacingMessage: overlayMessage(overallStatus),
    warnings,
  };
}

/**
 * Roll the per-check statuses into an advisory overall status. A FAIL on a
 * fundamental check (chart not loaded / no signal) is the strongest signal that
 * the overlays cannot be trusted; any other WARN/FAIL degrades to WARN; all
 * PASS (with at least one PASS) is PASS; everything unknown is UNKNOWN.
 */
function rollUpOverall(
  checks: readonly SmartChartOverlayCheck[],
): HandshakeOverallStatus {
  const fundamentalFail = checks.some(
    (c) =>
      (c.key === "chartLoaded" || c.key === "signalExists") && c.status === "FAIL",
  );
  if (fundamentalFail) return "BLOCK";

  const anyDegraded = checks.some(
    (c) => c.status === "WARN" || c.status === "FAIL",
  );
  if (anyDegraded) return "WARN";

  const anyPass = checks.some((c) => c.status === "PASS");
  return anyPass ? "PASS" : "UNKNOWN";
}

function overlayMessage(status: HandshakeOverallStatus): string {
  switch (status) {
    case "PASS":
      return "Chart overlays match the live read and are safe to use as guidance.";
    case "WARN":
      return "Chart overlays are usable but some checks need attention — see the details.";
    case "BLOCK":
      return "Chart overlays are not ready yet — they may not reflect a current read.";
    case "UNKNOWN":
    default:
      return "Chart overlay readiness is still being determined.";
  }
}
