// Smart Chart Layers & News Radar — TYPES (Task #197).
//
// Pure, self-contained contract for the Smart Chart visual overlay model and the
// Market Impact Radar. The Smart Chart (ScannerChartPanel) draws Ruby's reads as
// visual layers that stay CONSISTENT with Ruby's text, surfaces a news radar
// mapping economic events to symbols/currencies, and reports an overlay
// handshake describing how trustworthy the drawn overlays are.
//
// SAFETY (inviolable):
// - Pure types only. No IO, DB, HTTP, Date.now, or randomness in this module.
// - ADVISORY / VISUAL ONLY. Nothing here gates, slows, or places a trade. The
//   16-gate live pipeline + kill switch remain the only things that stop a trade.
// - HONEST. News is real or honestly absent — never fabricated. When a news
//   provider is unavailable the behavior degrades to a technicals-only read and
//   SAYS SO. We never claim a confirmed economic result we do not have.
// - No internal enum tokens (UPPER_SNAKE) in any user-facing string (labels,
//   notes, messages, summaries).

import type { HandshakeOverallStatus } from "../handshake/handshake.types";

// ── Visual layer model ───────────────────────────────────────────────────────

/** Which conceptual family a drawn layer belongs to (drives toggles + styling). */
export type SmartChartLayerGroup =
  | "structure" // support / resistance / structure levels
  | "signal_zones" // watch / entry / retest / late (do-not-chase) / invalidation
  | "targets" // take-profit zones / stop-loss
  | "execution_cost" // Phase-3 break-even / expected-fill band (reserved slot)
  | "trade_health" // Phase-5 placeholder slot
  | "news"; // economic-event markers

export type SmartChartLayerKind = "line" | "zone" | "marker";

/** Visual severity (mirrors the chart-overlay palette, advisory only). */
export type SmartChartSeverity =
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "neutral";

/** Honest provenance of a layer. */
export type SmartChartLayerSource =
  | "signal"
  | "ruby"
  | "structure"
  | "execution"
  | "news"
  | "position"
  | "plan";

export interface SmartChartLayer {
  id: string;
  group: SmartChartLayerGroup;
  kind: SmartChartLayerKind;
  /** Price for a `line` or `marker` layer. */
  price?: number;
  /** Lower bound for a `zone` layer. */
  priceFrom?: number;
  /** Upper bound for a `zone` layer. */
  priceTo?: number;
  /** Plain-English label — never an internal enum token. */
  label: string;
  severity: SmartChartSeverity;
  source: SmartChartLayerSource;
  /**
   * True when this is a reserved/placeholder slot — drawn so the surface exists,
   * but the underlying live logic lands in a later phase. Always labeled
   * honestly so the user is never misled.
   */
  reserved?: boolean;
}

// ── Market Impact Radar ──────────────────────────────────────────────────────

export type NewsRadarSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/** Where the event sits relative to "now". */
export type NewsRadarState = "UPCOMING" | "IMMINENT" | "LIVE" | "RECENT";

export interface NewsRadarEvent {
  id: string;
  title: string;
  currency: string;
  severity: NewsRadarSeverity;
  eventTimeIso: string;
  /** Signed seconds: > 0 = upcoming, < 0 = time since the event. */
  countdownSeconds: number;
  state: NewsRadarState;
  /** True when this event maps onto the selected symbol. */
  affectsSymbol: boolean;
  /** Markets/symbols the event historically moves (schedule-based mapping). */
  affectedSymbols: string[];
}

/** Honest provenance of the radar feed itself. */
export interface NewsRadarProvider {
  /** True only when a real headline/news provider is connected. */
  connected: boolean;
  /** Operator-facing provider name (no secrets). */
  name: string;
  /** Plain-English note describing what is / is not live. */
  note: string;
}

export interface MarketImpactRadar {
  symbol: string;
  provider: NewsRadarProvider;
  events: NewsRadarEvent[];
  /** Highest severity among events that affect the selected symbol. */
  topSeverity: NewsRadarSeverity | null;
  /** True when a high-impact window is currently live/imminent for the symbol. */
  highImpactWindowActive: boolean;
  /** Plain-English one-line summary. */
  summary: string;
}

// ── News behavior (how news alters the read) ─────────────────────────────────

export type NewsBehaviorMode =
  | "NORMAL" // no notable news window
  | "PRE_NEWS_CAUTION" // high-impact event approaching
  | "NEWS_LIVE" // high-impact event currently in its window
  | "POST_NEWS" // just after a high-impact event (volatility settling)
  | "NO_PROVIDER"; // no live news provider — technicals-only

export interface SmartChartNewsBehavior {
  mode: NewsBehaviorMode;
  /** Plain-English explanation — never an internal enum token. */
  note: string;
}

// ── Smart Chart Overlay Handshake ────────────────────────────────────────────

export type SmartChartCheckStatus = "PASS" | "WARN" | "FAIL" | "NOT_AVAILABLE";

export type SmartChartCheckKey =
  | "chartLoaded"
  | "symbolMatch"
  | "signalExists"
  | "levelsAvailable"
  | "newsMapped"
  | "freshness";

export interface SmartChartOverlayCheck {
  key: SmartChartCheckKey;
  status: SmartChartCheckStatus;
  /** Plain-English detail — never an internal enum token. */
  detail: string;
}

export interface SmartChartOverlayHandshake {
  overallStatus: HandshakeOverallStatus;
  checks: SmartChartOverlayCheck[];
  /** Plain-English summary for the chart badge. */
  userFacingMessage: string;
  warnings: string[];
}
