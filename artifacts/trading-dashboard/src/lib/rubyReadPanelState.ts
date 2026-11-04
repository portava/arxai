// ── Ruby Chart Read — one derived panel state (Task #506) ────────────────────
//
// The Scanner's Ruby Chart Read panel has three sub-surfaces that USED to each
// read a different verdict off the SAME underlying query and so could render
// mutually contradictory claims at once:
//
//   - badge  → raw feedStatus (socket-level "clean bars are arriving")
//   - banner → resolved scanner-truth level (stricter than raw feed quality)
//   - body   → the server read-chart `basis`/`gated` verdict
//
// Because all three describe the same chart from a different angle, the
// screenshot bug was: badge "Clean · AI" + banner "Feed not confirmed" + body
// "cannot verify chart data" — all true simultaneously, and the banner header
// ("not confirmed") even sat next to a positive reason ("valid for a live read")
// because the level downgrade and the reason text described different things.
//
// This pure resolver folds the shared `useScannerTruth` resolution together with
// the server read-chart response into ONE verdict. Every sub-surface derives
// from this single object, so the contradiction is structurally impossible. It
// is deliberately framework-free so the contradiction matrix can be tested
// exhaustively without rendering.

import type { ReadLevel } from "./scannerTruth";
import type { RubyReadStatus, ScannerActionabilityDisplay } from "./scannerActionability";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";
import type {
  TradeDataFreshnessBand,
  TradeHealthReadinessVerdict,
} from "@workspace/domain/market";

export type RubyReadVerdict =
  | "confirmed"
  | "structural_only"
  | "not_confirmed"
  | "unknown";

/** Display-only read tier (Task #602) — never an execution input. */
export type RubyReadLayer = "FULL" | "STRUCTURAL_ONLY" | "INSUFFICIENT";

/** The slice of the server read-chart response this panel reads. */
export interface RubyReadServerState {
  gated?: boolean;
  dataQuality?: "ok" | "insufficient";
  basis?: string;
  headline?: string;
  blockedReason?: string;
  /**
   * Display-only read layer (Task #602). `STRUCTURAL_ONLY` means a directional
   * structural read is available but the exact entry/stop/target are withheld
   * because the live feed isn't confirmed — a DOWNGRADE for the badge/header cap,
   * never a "feed not confirmed" hard block.
   */
  readLayer?: RubyReadLayer;
  /** The exact live trade setup is withheld (true on a STRUCTURAL_ONLY read). */
  liveSetupWithheld?: boolean;
  /** Enough closed history to read structure (transparency boolean). */
  canReadStructure?: boolean;
  /** The exact live trade setup may be shown (false on STRUCTURAL_ONLY). */
  canShowLiveTradeSetup?: boolean;
  /**
   * The server's Trade-Health contract verdict for THIS read (same contract the
   * Scanner composes): freshness band, display label and trust line. Used only
   * to cap the header's Trade Health chip DOWN to what the read actually had.
   */
  tradeHealthFreshness?: string;
  tradeHealthLabel?: string;
  tradeHealthTrustLine?: string;
  /**
   * Data time of the read: the latest CLOSED candle's close boundary (ISO), or
   * null when the server did not know it. A read is a one-shot snapshot, so this
   * is what "as of" means — never the time the read was requested.
   */
  observedAt?: string | null;
  /** Gate that withheld the exact setup on a structural read (display-only). */
  withheldBy?: string | null;
}

/**
 * When a non-gated chart read stops describing the current chart: its newest
 * closed candle + ONE timeframe interval, i.e. the moment the next candle
 * closes. That is the shared trailing-interval rule (@workspace/domain/market
 * candleFreshnessRule) and the bound the server's evidence matching applies;
 * the old 1.2–1.5× `candleMaxAgeMs` budget kept a read "current" for up to
 * half an interval after a newer candle had closed. Returns `null` for a gated
 * read (nothing directional to expire) and `NaN` when the read carries no valid
 * `observedAt` or the interval is unknown — the caller treats NaN as already
 * expired (fail-closed).
 */
export function chartReadExpiresAtMs(
  read: RubyReadServerState | null | undefined,
  candleIntervalMs: number,
): number | null {
  if (!read || read.gated === true) return null;
  const t = typeof read.observedAt === "string" ? Date.parse(read.observedAt) : Number.NaN;
  if (!Number.isFinite(t) || !(candleIntervalMs > 0)) return Number.NaN;
  return t + candleIntervalMs;
}

/** "HH:MM UTC" for a read's observedAt, or null when unknown. */
export function chartReadAsOfLabel(read: RubyReadServerState | null | undefined): string | null {
  const t = typeof read?.observedAt === "string" ? Date.parse(read.observedAt) : Number.NaN;
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/**
 * True when a server read is a STRUCTURAL_ONLY read — direction from closed
 * candles, exact entry/stop/target withheld.
 *
 * Primary signal: `readLayer === "STRUCTURAL_ONLY"`. Belt-and-braces: the
 * transparency booleans (`liveSetupWithheld`, `canShowLiveTradeSetup`) travel
 * beside it and survive the server's user-copy scrubber, which once blanked
 * `readLayer` to "" (owner screenshot 2026-10-27: "Full read" + "Live read on
 * V75 1m." beside "Exact entry, stop, and target levels withheld"). A non-gated
 * read that says its live setup is withheld is therefore treated as structural
 * even when `readLayer` is missing, empty or contradicts it. DOWNGRADE-ONLY: this
 * can only lower the panel/header verdict, never raise it. A gated read is the
 * stricter "not confirmed" state and is left to that path.
 */
export function isStructuralOnlyRead(read: RubyReadServerState | null | undefined): boolean {
  if (!read) return false;
  if (read.readLayer === "STRUCTURAL_ONLY") return true;
  // Gated / insufficient reads also carry liveSetupWithheld but are the harder
  // "not confirmed" block, so they are left to that path.
  if (read.gated === true || read.dataQuality === "insufficient" || read.readLayer === "INSUFFICIENT") {
    return false;
  }
  return (
    read.canReadStructure !== false &&
    (read.liveSetupWithheld === true || read.canShowLiveTradeSetup === false)
  );
}

const FRESHNESS_RANK: Record<TradeDataFreshnessBand, number> = {
  LIVE_CONFIRMED: 4,
  LIVE_DELAYED: 3,
  HISTORICAL_ONLY: 2,
  AWAITING: 1,
  UNKNOWN: 0,
};

const FALLBACK_FRESHNESS_LABEL: Record<TradeDataFreshnessBand, string> = {
  LIVE_CONFIRMED: "Live-confirmed",
  LIVE_DELAYED: "Delayed feed",
  HISTORICAL_ONLY: "Historical read only",
  AWAITING: "Awaiting live feed",
  UNKNOWN: "Unconfirmed",
};

function isFreshnessBand(v: unknown): v is TradeDataFreshnessBand {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(FRESHNESS_RANK, v);
}

/**
 * Cap the header's Trade Health readiness DISPLAY by the same-key server read.
 *
 * The header chip is composed client-side from the scanner's own candle verdict;
 * the Ruby read for the same symbol+timeframe carries the server's contract
 * verdict (`tradeHealthFreshness` / label / trust line). When the server read is
 * strictly LESS fresh (LIVE_CONFIRMED > LIVE_DELAYED > HISTORICAL_ONLY >
 * AWAITING > UNKNOWN) the chip adopts the server's label and trust line and every
 * affordance flag drops to false, so the board can never say "Live-confirmed 1m
 * read with enough recent closed candles" next to a read whose exact levels are
 * withheld because the feed is delayed. Never upgrades: an equal or fresher
 * server band, a missing/unknown band, or no read returns `readiness` unchanged.
 * DISPLAY-ONLY — no execution path reads this.
 */
export function capReadinessByServerRead(
  readiness: TradeHealthReadinessVerdict,
  read: RubyReadServerState | null | undefined,
): TradeHealthReadinessVerdict {
  const band = read?.tradeHealthFreshness;
  if (!read || !isFreshnessBand(band)) return readiness;
  if (FRESHNESS_RANK[band] >= FRESHNESS_RANK[readiness.dataFreshness]) return readiness;
  const label = typeof read.tradeHealthLabel === "string" ? read.tradeHealthLabel.trim() : "";
  const trust = typeof read.tradeHealthTrustLine === "string" ? read.tradeHealthTrustLine.trim() : "";
  return {
    ...readiness,
    dataFreshness: band,
    displayLabel: label || FALLBACK_FRESHNESS_LABEL[band],
    userFacingTrustLine: trust || read.blockedReason || "",
    mayDescribeSetup: false,
    mayShowTradeButton: false,
    mayShowOneClickButton: false,
    mayOfferLiveExecutionRequest: false,
  };
}

/**
 * The full server read-chart response. Extends the honesty slice
 * (`RubyReadServerState`) with the directional read fields the panel body
 * renders. Lives here (not in the component) so the page-level shared read store
 * and the header cap can both type the lifted read without importing a
 * component module.
 */
export interface ChartRead extends RubyReadServerState {
  bias?: string;
  confidence?: string;
  why?: string;
  supportZone?: string;
  resistanceZone?: string;
  buyCondition?: string;
  sellCondition?: string;
  invalidation?: string;
  riskNote?: string;
  /** Higher-timeframe bias; null/absent ⇒ the HTF was NOT read. */
  htfBias?: string | null;
  /** Canonical code of the timeframe htfBias came from (server-supplied). */
  htfTimeframe?: string | null;
  /**
   * Bars the server's chart-structure read ran over (a moving-average trend /
   * location read — a different classifier and window from the scanner's swing
   * structure). Display-only; absent on older payloads ⇒ no window is named.
   */
  structureWindow?: number | null;
  /**
   * DISPLAY-ONLY child inputs from the server's pattern / trendline detectors on
   * the same closed-candle window. `*Detection` says whether the detector found
   * something, looked and found nothing ("none"), or had too few bars
   * ("insufficient"). Absent ⇒ the read did not assess it (unavailable).
   */
  patternRead?: {
    patternNote?: string;
    patternStatus?: string;
    patternConditional?: boolean;
    patternContextOnly?: boolean;
    patternDetection?: string;
  } | null;
  trendlineRead?: {
    trendlineNote?: string;
    trendlineStatus?: string;
    trendlineConditional?: boolean;
    trendlineContextOnly?: boolean;
    trendlineDetection?: string;
  } | null;
  cautions?: string[];
  disclaimer?: string;
  /** Server-measured momentum sentence (separate from the structure `confidence`). */
  momentumNote?: string;
}

const READ_LAYER_RANK: Record<RubyReadLayer, number> = {
  INSUFFICIENT: 0,
  STRUCTURAL_ONLY: 1,
  FULL: 2,
};
function asReadLayer(v: unknown): RubyReadLayer | null {
  return v === "FULL" || v === "STRUCTURAL_ONLY" || v === "INSUFFICIENT" ? v : null;
}

/**
 * Fold the route's top-level `readLayer` (the read-chart service's own layer,
 * returned beside `chartRead`) into the read — DOWNGRADE-ONLY. A missing or
 * blank `chartRead.readLayer` takes the route layer only when that layer is
 * STRUCTURAL_ONLY / INSUFFICIENT; a route "FULL" never promotes a blank layer,
 * and a lower route layer always wins over a higher payload layer.
 */
export function withRouteReadLayer<T extends RubyReadServerState>(
  read: T | null | undefined,
  routeLayer: unknown,
): T | null {
  if (!read || typeof read !== "object") return read ?? null;
  const route = asReadLayer(routeLayer);
  if (!route) return read;
  const own = asReadLayer(read.readLayer);
  if (own == null) return route === "FULL" ? read : { ...read, readLayer: route };
  return READ_LAYER_RANK[route] < READ_LAYER_RANK[own] ? { ...read, readLayer: route } : read;
}

/**
 * The server's higher-timeframe read, resolved for display. `bias` is null when
 * the HTF was not read — including the legacy "No clear edge" sentinel older
 * servers sent when they never fetched HTF candles (quickTrend never yields it
 * once it has bars). `label` is the server's htfTimeframe as a chart-pill label
 * ("M15" → "15m"); the client never derives which timeframe is "higher".
 */
export function resolveHtfRead(read: Pick<ChartRead, "htfBias" | "htfTimeframe"> | null | undefined): {
  bias: string | null;
  label: string | null;
} {
  const raw = (read?.htfBias ?? "").trim();
  const bias = raw && raw.toLowerCase() !== "no clear edge" ? raw : null;
  const code = (read?.htfTimeframe ?? "").trim().toUpperCase();
  const m = /^(MN|[MHDW])(\d+)$/.exec(code);
  let label: string | null = null;
  if (m) {
    const unit = m[1] === "MN" ? "mo" : m[1] === "M" ? "m" : m[1] === "H" ? "h" : m[1] === "D" ? "D" : "W";
    label = `${m[2]}${unit}`;
  }
  return { bias, label };
}

/**
 * True when the page's ONE action verdict for this symbol+timeframe is itself a
 * FEED/DATA limitation ("Feed limited" / "Analysis only"). Only those two: a
 * CHECK_FAILED is a setup-check error whose own copy says live data is
 * unaffected, and PENDING / NO_CONFIRMATION only occur with no truth at all
 * (where the read is already NO_READ). DISPLAY-ONLY — used to cap the Eleanor
 * cell/panel DOWN so they can never say "Full read" / Clean·AI beside an Action
 * cell that says the live feed isn't fully confirmed.
 */
export function isFeedLimitedAction(
  action: ScannerActionabilityDisplay | null | undefined,
): boolean {
  return action === "FEED_LIMITED" || action === "ANALYSIS_ONLY";
}

/** Shared downgrade copy for a feed-limited Eleanor read (header + panel). */
export function feedLimitedReadReason(assistantName: string = DEFAULT_ASSISTANT_NAME): string {
  return `The live feed isn't fully confirmed — ${assistantName} reads with caution.`;
}

/** The Ruby read status capped against the server read + an optional override. */
export interface CappedRubyRead {
  status: RubyReadStatus;
  /** The reason for any downgrade (server-supplied when available). */
  reason: string | null;
}

/**
 * Reconcile the header's Ruby cell with the Ruby Chart Read panel (Task #600).
 *
 * The contract's `consolidated.rubyReadStatus` is the BASE read capability
 * derived from the shared truth (no server read folded in). Once the panel runs
 * a server read — or a parent supplies an `aiUsable` override — the result can
 * only LOWER the read, never raise it. Both the header cell and the panel call
 * this with the SAME (base, read, override) so they can never disagree.
 *
 * Monotonic / downgrade-only:
 *   - NO_READ      → stays NO_READ (no readable data at all).
 *   - FULL_READ    → LIMITED_READ when the server marks the read
 *                    gated/insufficient OR the override says the feed isn't
 *                    usable; otherwise stays FULL_READ.
 *   - LIMITED_READ → stays LIMITED_READ (surfaces the server reason if any).
 */
export function resolveCappedRubyReadStatus(
  base: RubyReadStatus,
  read: RubyReadServerState | null,
  aiUsableOverride?: boolean,
  assistantName: string = DEFAULT_ASSISTANT_NAME,
  /**
   * The page's action verdict is a feed/data limitation (`isFeedLimitedAction`).
   * Downgrade-only: caps FULL_READ to LIMITED_READ exactly like a blocking
   * override; never raises anything.
   */
  actionFeedLimited = false,
): CappedRubyRead {
  if (base === "NO_READ") return { status: "NO_READ", reason: null };

  const overrideBlocks = aiUsableOverride === false || actionFeedLimited;
  // A STRUCTURAL_ONLY read is a DOWNGRADE (direction readable, exact setup
  // withheld) — it caps a FULL_READ to LIMITED_READ exactly like a gated /
  // insufficient read, even though `gated` is false and dataQuality is "ok".
  const readDowngraded =
    !!read &&
    (read.gated === true ||
      read.dataQuality === "insufficient" ||
      isStructuralOnlyRead(read));
  const serverReason = readDowngraded
    ? read?.blockedReason ?? read?.headline ?? null
    : null;

  if (base === "FULL_READ") {
    if (overrideBlocks || readDowngraded) {
      return {
        status: "LIMITED_READ",
        reason: serverReason ?? feedLimitedReadReason(assistantName),
      };
    }
    return { status: "FULL_READ", reason: null };
  }

  // base === "LIMITED_READ"
  return { status: "LIMITED_READ", reason: serverReason };
}

export interface RubyReadPanelInputs {
  /**
   * Resolved shared-truth analysis level (from `useScannerTruth`); `null` while
   * the truth is still unresolved/loading.
   */
  truthLevel: ReadLevel | null;
  /**
   * Shared-truth downgrade reason. Only honest about a NON-full feed — at level
   * "full" it reads "Live data — valid for a live read", so it must never be
   * surfaced under a "not confirmed" header.
   */
  truthReason: string | null;
  /**
   * Optional parent override of the feed verdict (e.g. an ARXNativeChart
   * `onChartContextChange`). `undefined` means no override.
   */
  aiUsableProp: boolean | undefined;
  /** The server read-chart response once a read has run; `null` before. */
  read: RubyReadServerState | null;
  /**
   * The read's data is older than the timeframe's candle budget (or its time is
   * unknown). Downgrade-only: the badge can no longer claim clean/AI.
   */
  readExpired?: boolean;
  /**
   * The page's canonical action verdict is a feed/data limitation
   * (`isFeedLimitedAction`). Display-only downgrade: the badge can never claim
   * Clean/AI and the panel says the feed isn't confirmed. It is NOT forwarded to
   * the read-chart endpoint (`reportedAiUsable` is unchanged), so it never
   * alters what the server reads.
   */
  actionFeedLimited?: boolean;
  /** Assistant display name for the shared downgrade copy. */
  assistantName?: string;
}

export interface RubyReadPanelState {
  /** The single panel verdict every sub-surface derives from. */
  verdict: RubyReadVerdict;
  /** The banner renders iff true (verdict === "not_confirmed"). */
  feedNotConfirmed: boolean;
  /**
   * Reason appended to the banner — describes the SAME dimension that drove the
   * downgrade, so the header and reason can never contradict each other.
   */
  reason: string | null;
  /**
   * What the badge may claim: `true` → clean/AI allowed, `false` → never
   * clean/AI, `null` → unknown (verdict not yet resolved).
   */
  badgeAiUsable: boolean | null;
  /**
   * Value forwarded to the read-chart endpoint. `undefined` means "unknown" →
   * the server falls back to its own gate.
   */
  reportedAiUsable: boolean | undefined;
  /** The shown read no longer describes the current chart (see input). */
  readExpired: boolean;
}

export function resolveRubyReadPanelState(
  input: RubyReadPanelInputs,
): RubyReadPanelState {
  const { truthLevel, truthReason, aiUsableProp, read } = input;
  const actionFeedLimited = input.actionFeedLimited === true;

  const truthKnown = truthLevel != null;
  // The read is "usable" only when the shared truth is fully actionable. Any
  // downgrade (limited / historical_only / blocked) means feed-not-confirmed.
  const truthActionable = truthLevel === "full";

  // A parent override wins; otherwise use the resolved shared truth. We only
  // know a verdict once the truth is resolved (or a parent supplies one).
  const effectiveAiUsable: boolean | null =
    aiUsableProp != null ? aiUsableProp : truthKnown ? truthActionable : null;

  // Once a read has run, the server marks unconfirmed/gated reads insufficient —
  // this is authoritative for the body, so it must also drive the badge/banner.
  const readInsufficient =
    !!read && (read.gated === true || read.dataQuality === "insufficient");
  // A STRUCTURAL_ONLY read (Task #602) is its OWN verdict: a directional read IS
  // available, but the exact live setup is withheld. It takes precedence over a
  // generic "not confirmed" (it's the more specific, more honest state) and over
  // "confirmed" (the badge must never claim clean/AI while the setup is withheld).
  const structuralOnlyRead = isStructuralOnlyRead(read);
  // CURRENT truth outranks a STORED structural tier when the truth has since
  // degraded below what the read was produced on: the read's own freshness
  // band (server `tradeHealthFreshness`) is fresher than the current shared
  // truth for the same key, or the truth now has no data at all (blocked). The
  // read's reason then describes a past state ("Live feed is delayed…") while
  // the header says historical / no data — so the panel takes the current
  // not-confirmed verdict and the truth's current reason. Downgrade-only: an
  // unknown read band (older / scrubbed wire) keeps the structural verdict.
  const readBand = read?.tradeHealthFreshness;
  const truthBandRank: number | null =
    truthLevel === "full"
      ? FRESHNESS_RANK.LIVE_CONFIRMED
      : truthLevel === "limited"
        ? FRESHNESS_RANK.LIVE_DELAYED
        : truthLevel === "historical_only"
          ? FRESHNESS_RANK.HISTORICAL_ONLY
          : truthLevel === "blocked"
            ? FRESHNESS_RANK.AWAITING
            : null;
  const truthDegradedSinceRead =
    structuralOnlyRead &&
    truthBandRank != null &&
    (truthLevel === "blocked" ||
      (isFreshnessBand(readBand) && FRESHNESS_RANK[readBand] > truthBandRank));
  const structuralOnly = structuralOnlyRead && !truthDegradedSinceRead;

  let verdict: RubyReadVerdict;
  if (structuralOnly) {
    verdict = "structural_only";
  } else if (
    truthDegradedSinceRead ||
    readInsufficient ||
    effectiveAiUsable === false ||
    actionFeedLimited
  ) {
    verdict = "not_confirmed";
  } else if (effectiveAiUsable === true) {
    verdict = "confirmed";
  } else {
    verdict = "unknown";
  }

  const feedNotConfirmed = verdict === "not_confirmed";

  // The reason MUST describe the same dimension that drove the downgrade so the
  // banner is never self-contradictory ("not confirmed" + "valid for a live
  // read"). Truth's reason is only honest about a non-full feed, so use it ONLY
  // when the truth itself is downgraded; when the truth is full/unknown but the
  // server couldn't verify, the server's own reason is the real driver.
  let reason: string | null = null;
  if (verdict === "structural_only") {
    // The withheld-setup reason the server supplied is the authoritative driver.
    reason = read?.blockedReason ?? read?.headline ?? null;
  } else if (feedNotConfirmed) {
    if (truthKnown && !truthActionable) {
      reason = truthReason;
    } else if (readInsufficient) {
      reason = read?.blockedReason ?? read?.headline ?? null;
    } else if (actionFeedLimited) {
      reason = feedLimitedReadReason(input.assistantName);
    }
  }

  // What we tell the endpoint: prefer an explicit override, else the resolved
  // verdict. This is read-independent (sent before any read has run).
  const reportedAiUsable: boolean | undefined =
    aiUsableProp != null ? aiUsableProp : truthKnown ? truthActionable : undefined;

  // The badge may claim clean/AI only on a fully-confirmed read. A
  // structural-only read is a downgrade → never clean/AI.
  // An expired read (older than its timeframe's candle budget, or of unknown
  // time) can never back a clean/AI claim either.
  const readExpired = !!read && read.gated !== true && input.readExpired === true;
  const badgeAiUsable: boolean | null =
    verdict === "confirmed" && !readExpired
      ? true
      : verdict === "not_confirmed" || verdict === "structural_only" || readExpired
        ? false
        : null;

  return { verdict, feedNotConfirmed, reason, badgeAiUsable, reportedAiUsable, readExpired };
}

/**
 * The badge verdict for a feed-confidence chip on a NON-read surface — the
 * live-chart header and the trade-decision panels (Trade Command Room, "Trade
 * from chart") — which only have the shared `useScannerTruth` level for the
 * active symbol/timeframe: no server read-chart response and no parent override.
 *
 * It is exactly what RubyChartRead passes as `aiUsableResolved` before any read
 * has run (full ⇒ true, downgraded ⇒ false, unresolved ⇒ null), so these chips
 * can never claim Clean/AI when the resolved truth is downgraded or still
 * unresolved — without each surface re-deriving the cap.
 */
export function resolveFeedBadgeVerdict(
  truthLevel: ReadLevel | null,
): boolean | null {
  return resolveRubyReadPanelState({
    truthLevel,
    truthReason: null,
    aiUsableProp: undefined,
    read: null,
  }).badgeAiUsable;
}
