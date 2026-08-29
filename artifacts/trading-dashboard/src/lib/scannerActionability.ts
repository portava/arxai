// ── Scanner consolidated truth — public vocabulary + ONE action verdict ──────
//
// Task #600. The shared `resolveScannerTruth` resolver (Task #391) already speaks
// an internal vocabulary (candleStatus "live"|"delayed"|…, analysis.level
// "full"|"limited"|…). Several scanner surfaces — the header strip, the chart
// badge, the Ruby Chart Read panel, the opportunity / scalp cards, the trade
// ticket, and the Broad Scan summary — used to derive their OWN status words off
// the same query and so drifted (e.g. a "Ready now" card whose own copy said
// "wait for confirmation").
//
// This sibling module is the PURE, framework-free public contract layer. It
// defines the task's public enums, derives them from the already-resolved
// internal truth (NEVER from raw inputs — there is one authority), and exposes a
// single `resolveScannerActionability()` + `SCANNER_ACTIONABILITY_UI` map so a
// card's badge, copy, and button can never disagree: they all read one verdict.
//
// HONESTY: this layer never upgrades the backend's honest verdict and never
// invents a status. It only translates the resolved internal truth into the
// public vocabulary and folds an optional per-surface setup-readiness on top.

// ── Public status vocabulary (the task's required enums) ─────────────────────

export type PublicQuoteStatus =
  | "LIVE"
  | "STALE"
  | "UNAVAILABLE"
  | "FROZEN"
  | "MARKET_CLOSED";

export type PublicCandleStatus =
  | "CONFIRMED"
  | "SYNCING"
  | "STALE"
  | "UNCONFIRMED"
  | "UNAVAILABLE"
  | "LIMITED_HISTORY";

export type ChartIntelligenceStatus = "FULL" | "LIMITED" | "UNAVAILABLE";

export type RubyReadStatus = "FULL_READ" | "LIMITED_READ" | "NO_READ";

export type TradingStatus =
  | "ENABLED"
  | "DISABLED"
  | "BLOCKED"
  | "REVIEW_REQUIRED";

export type ScannerActionability =
  | "READY_NOW"
  | "WAIT_FOR_CONFIRMATION"
  | "TOO_LATE"
  | "NO_CLEAN_SETUP"
  | "MARKET_CLOSED"
  | "FEED_LIMITED"
  | "ANALYSIS_ONLY";

/**
 * A per-surface setup verdict, folded on top of the data cap. The CONTRACT's
 * stored actionability uses "UNKNOWN" (a pure data-only verdict). A card or the
 * header passes its own setup readiness (from the scalp engine / opportunity
 * bucket / composed verdict) to get the final action verdict for that surface.
 */
export type SetupReadiness =
  | "READY"
  | "WAIT"
  | "TOO_LATE"
  | "NO_CLEAN_SETUP"
  | "UNKNOWN";

/** A universe symbol the scan could not score, with a concrete reason. */
export interface SkippedSymbol {
  symbol: string;
  /** Plain-English reason (e.g. "No live feed", "Limited history"). */
  reason: string;
  /** Stable machine reason code (e.g. "MISSING_FEED"). */
  reasonCode: SkippedSymbolReasonCode;
}

export type SkippedSymbolReasonCode =
  | "MISSING_FEED"
  | "LIMITED_HISTORY"
  | "STALE_DATA"
  | "UNSUPPORTED_SYMBOL"
  | "PROVIDER_ERROR"
  | "EXCLUDED_BY_FILTER";

/**
 * The consolidated public truth block. Carried on `ScannerTruth.consolidated`
 * so every surface agrees on the selected symbol/timeframe, the feed/candle/
 * Ruby/trading status, the one action verdict, the candle provenance, and the
 * single user-facing message + stable internal reason code.
 */
export interface ConsolidatedTruth {
  selectedSymbol: string;
  selectedTimeframe: string;
  quoteStatus: PublicQuoteStatus;
  candleStatus: PublicCandleStatus;
  chartIntelligenceStatus: ChartIntelligenceStatus;
  rubyReadStatus: RubyReadStatus;
  tradingStatus: TradingStatus;
  /** The pure DATA-only action verdict (setup = UNKNOWN). Cards/header refine it. */
  scannerActionability: ScannerActionability;
  feedSource: string | null;
  candleSource: string | null;
  oldestCandleTime: string | null;
  newestCandleTime: string | null;
  candleCount: number;
  /** Scan-level skip list. Empty for a per-symbol resolve; populated by the scan. */
  skippedSymbols: SkippedSymbol[];
  /** ONE plain-English message explaining the governing data/action state. */
  userMessage: string;
  /** Stable machine code for the governing downgrade (or FEED_OK). */
  internalReasonCode: string;
  /** Stable ID for this read cycle — every surface for the same symbol/timeframe should carry the same readId. */
  readId: string;
  /** Unix ms timestamp when this consolidated truth was resolved. */
  readTimestamp: number;
}

// ── The single action verdict ────────────────────────────────────────────────

/** The slice of consolidated truth the action verdict depends on. */
export type ActionabilityDataInput = Pick<
  ConsolidatedTruth,
  "quoteStatus" | "candleStatus" | "chartIntelligenceStatus"
>;

/**
 * The DATA cap: when the feed/candle data cannot support a live entry, the data
 * verdict dominates the per-card setup. Returns null when data is fully clean
 * (CONFIRMED candles + FULL intelligence + a non-closed market) so the setup
 * readiness can decide.
 *
 * Priority (most severe first): MARKET_CLOSED > FEED_LIMITED > ANALYSIS_ONLY.
 */
export function resolveDataActionabilityCap(
  c: ActionabilityDataInput,
): ScannerActionability | null {
  if (c.quoteStatus === "MARKET_CLOSED") return "MARKET_CLOSED";
  if (
    c.candleStatus === "UNAVAILABLE" ||
    c.candleStatus === "STALE" ||
    c.candleStatus === "SYNCING" ||
    c.candleStatus === "LIMITED_HISTORY" ||
    c.candleStatus === "UNCONFIRMED" ||
    c.chartIntelligenceStatus === "UNAVAILABLE"
  ) {
    return "FEED_LIMITED";
  }
  if (c.chartIntelligenceStatus === "LIMITED") return "ANALYSIS_ONLY";
  return null;
}

/**
 * The ONE action verdict every card/strip derives badge + copy + button from.
 * The data cap dominates; only when the data is fully clean does the per-surface
 * setup readiness decide. With no setup (UNKNOWN) the honest verdict is
 * WAIT_FOR_CONFIRMATION: the data is fine but no confirmed setup has been
 * asserted, so nothing should render as act-ready. READY_NOW requires BOTH clean
 * data AND an actionable setup.
 */
// Chart-pattern child-impact (Task #617) is applied SERVER-SIDE (it folds into
// the scanner-truth caps + the Ruby structural read the frontend consumes), so
// the verdict this pure translator receives already reflects any pattern
// downgrade. There is deliberately NO frontend pattern parameter here: a second,
// independently-applied pattern fold would violate the module's single-verdict
// authority. The backend caps + the Phase B 23-gate pipeline remain the sole
// authority for pattern impact and execution.
export function resolveScannerActionability(
  c: ActionabilityDataInput,
  setup: SetupReadiness = "UNKNOWN",
  readinessCeiling?: { mayShowTradeButton: boolean },
): ScannerActionability {
  const cap = resolveDataActionabilityCap(c);
  if (cap) return cap;
  let verdict: ScannerActionability;
  switch (setup) {
    case "READY":
      verdict = "READY_NOW";
      break;
    case "TOO_LATE":
      verdict = "TOO_LATE";
      break;
    case "NO_CLEAN_SETUP":
      verdict = "NO_CLEAN_SETUP";
      break;
    case "WAIT":
      verdict = "WAIT_FOR_CONFIRMATION";
      break;
    case "UNKNOWN":
    default:
      verdict = "WAIT_FOR_CONFIRMATION";
      break;
  }
  // DOWNGRADE-ONLY readiness ceiling (optional). When the shared Trade-Health
  // verdict withholds the trade affordance for this symbol+timeframe (read not
  // live-confirmed, structure unclear, or setup invalidated → mayShowTradeButton
  // false), a positive setup may not read as "Ready now". This can only soften
  // READY_NOW → WAIT_FOR_CONFIRMATION; it NEVER upgrades a verdict and is not an
  // execution gate (canAct already drives whether buttons enable; canTrade and
  // the backend 23-gate pipeline remain the sole execution authority).
  if (
    verdict === "READY_NOW" &&
    readinessCeiling &&
    !readinessCeiling.mayShowTradeButton
  ) {
    verdict = "WAIT_FOR_CONFIRMATION";
  }
  return verdict;
}

/**
 * The header's Action cell shows the SELECTED symbol's verdict. The selected-
 * symbol Focus scalp card computes the setup-aware verdict (it knows the engine
 * status, not just the feed) and lifts it to the page; the header consumes that
 * when present so the two can never disagree (e.g. card "Ready now" while the
 * header's own data-only verdict reads "Wait for confirmation"). When no card
 * has published a verdict for the symbol (other tabs, loading), the header falls
 * back to its own data-only consolidated verdict. This is the ONE precedence
 * rule: the setup-aware lifted verdict wins; the data-only verdict is the
 * fallback — never an independent third opinion.
 */
export function resolveSelectedSymbolActionability(
  lifted: ScannerActionability | null,
  dataOnlyFallback: ScannerActionability | null,
): ScannerActionability | null {
  return lifted ?? dataOnlyFallback;
}

// ── One UI map: badge label + tone + copy + whether buttons may enable ───────

export type ActionabilityTone =
  | "success"
  | "warning"
  | "danger"
  | "muted"
  | "info";

export interface ActionabilityUi {
  /** Badge label (e.g. "Ready now"). */
  label: string;
  /** Drives badge/dot colour. */
  tone: ActionabilityTone;
  /** The ONE guidance line — never mix this with a separate bestAction prose. */
  copy: string;
  /** Whether trade affordances (Plan Buy/Plan Sell) may enable for this verdict. */
  canAct: boolean;
}

export const SCANNER_ACTIONABILITY_UI: Record<
  ScannerActionability,
  ActionabilityUi
> = {
  READY_NOW: {
    label: "Ready now",
    tone: "success",
    copy: "Live data is confirmed and the setup is ready — you can act now.",
    canAct: true,
  },
  WAIT_FOR_CONFIRMATION: {
    label: "Wait for confirmation",
    tone: "warning",
    copy: "Live data is confirmed, but the setup still needs to confirm before acting.",
    canAct: false,
  },
  TOO_LATE: {
    label: "Too late",
    tone: "muted",
    copy: "The move has already played out — entering now would be chasing price.",
    canAct: false,
  },
  NO_CLEAN_SETUP: {
    label: "No clean setup",
    tone: "muted",
    copy: "No clean setup on this market right now — there's nothing to act on.",
    canAct: false,
  },
  MARKET_CLOSED: {
    label: "Market closed",
    tone: "muted",
    copy: "This market is closed — no live entry is possible right now.",
    canAct: false,
  },
  FEED_LIMITED: {
    label: "Feed limited",
    tone: "warning",
    copy: "The live feed isn't fully confirmed — treat this as context, not a live entry.",
    canAct: false,
  },
  ANALYSIS_ONLY: {
    label: "Analysis only",
    tone: "info",
    copy: "Historical context only — not fresh enough for a live entry.",
    canAct: false,
  },
};

/** Convenience: the UI descriptor for a verdict (badge + copy + button gate). */
export function actionabilityUi(a: ScannerActionability): ActionabilityUi {
  return SCANNER_ACTIONABILITY_UI[a];
}

// ── Cold-start pending DISPLAY state (display-only, shared layer) ────────────
//
// PENDING ("Checking…") exists for the window in which the scanner has NOT
// resolved the current symbol+timeframe at all: the truth read hasn't landed
// yet (mid-switch, first load, or a feed that never answers), so there is no
// verdict of any kind to show. The truth source is keyed by symbol+timeframe
// (no keepPreviousData): its consolidated data-only verdict is null exactly in
// that gap and, when present, is ALWAYS computed from the current key's real
// candles response. A present data-only verdict — including the setup-UNKNOWN
// WAIT_FOR_CONFIRMATION fallthrough ("live data confirmed, nothing has
// confirmed a setup yet") — is therefore a RESOLVED scanner verdict and must
// render immediately: the chart badge and the header Action cell derive from
// the same resolved read and may never disagree (chart resolved while the
// header still says "Checking…" was the desync bug this layer now locks out).
//
// PENDING / NO_CONFIRMATION / CHECK_FAILED are DISPLAY tokens only: they are
// deliberately NOT members of `ScannerActionability` (no verdict computation,
// gate, sufficiency, or `canAct` semantics change —
// resolveScannerActionability is untouched), and every surface inherits them
// from this shared layer rather than inventing per-component placeholders.

/**
 * What a card may PUBLISH (lift) into the selected-action store: a real
 * setup-aware verdict, or the honest failure marker when its setup check
 * errored. CHECK_FAILED is display-only vocabulary (never a member of
 * `ScannerActionability`, never an input to any gate or verdict computation) —
 * it exists so a failed read resolves the header immediately with an honest
 * reason instead of leaving the pending state to age out.
 */
export type PublishedScannerAction = ScannerActionability | "CHECK_FAILED";

/** Display-layer verdict: a real verdict, or one of the display-only states. */
export type ScannerActionabilityDisplay =
  | ScannerActionability
  | "PENDING"
  | "NO_CONFIRMATION"
  | "CHECK_FAILED";

/**
 * Hard ceiling on how long the neutral PENDING ("Checking…") display state may
 * show for one symbol+timeframe key. When it elapses without ANY verdict
 * arriving (no lifted card verdict AND no data-only truth verdict for the
 * key), the display resolver converts the gap to the FINAL "No confirmation"
 * state — PENDING is a bounded transition, never a terminal state. Expiry
 * never overrides a resolved verdict. 10s comfortably covers a healthy truth
 * read (~1–3s) without leaving the user staring at a spinner state.
 */
export const PENDING_RESOLVE_TIMEOUT_MS = 10_000;

/** Neutral pending descriptor — muted, non-actionable, no setup language. */
export const ACTIONABILITY_PENDING_UI: ActionabilityUi = {
  label: "Checking…",
  tone: "muted",
  copy: "Reading this market — the verdict will show once the check completes.",
  canAct: false,
};

/** FINAL no-confirmation descriptor — honest reason, non-actionable. */
export const ACTIONABILITY_NO_CONFIRMATION_UI: ActionabilityUi = {
  label: "No confirmation",
  tone: "warning",
  copy: "No setup confirmation arrived for this market and timeframe — nothing has confirmed a trade here.",
  canAct: false,
};

/** FINAL check-failed descriptor — honest failure reason, non-actionable. */
export const ACTIONABILITY_CHECK_FAILED_UI: ActionabilityUi = {
  label: "Check failed",
  tone: "danger",
  copy: "The setup check couldn't complete for this market — refresh the signal card to retry. Live data is unaffected.",
  canAct: false,
};

/**
 * The DISPLAY form of the selected-symbol precedence rule — a FINITE state
 * resolution. Same precedence as `resolveSelectedSymbolActionability` (lifted
 * setup-aware verdict wins, the data-only verdict is the fallback), with
 * display-only refinements that guarantee the Action cell always reaches a
 * final state AND always mirrors an already-resolved scanner verdict:
 *
 *   1. A lifted CHECK_FAILED (the card's setup read errored) renders the FINAL
 *      "Check failed" state with its honest reason.
 *   2. ANY resolved verdict — lifted OR data-only — renders as-is,
 *      IMMEDIATELY. The data-only verdict is computed by resolveScannerTruth
 *      from the CURRENT symbol+timeframe's real candles response (the truth
 *      source is keyed; it is null mid-switch, never stale), so when it is
 *      present the scanner HAS resolved this market and the header must show
 *      that verdict — including WAIT_FOR_CONFIRMATION ("live data confirmed,
 *      no setup has confirmed yet"), which is exactly the state the chart's
 *      own badge shows as WAIT FOR ENTRY. The header may never sit on
 *      "Checking…" while the chart already displays a resolved verdict.
 *   3. PENDING ("Checking…") is reserved for the ONLY genuinely-unresolved
 *      case: no lifted verdict AND no data-only verdict (the truth read for
 *      the current symbol+timeframe hasn't landed — mid-switch, first load,
 *      or a dead feed). It is TIME-BOUNDED: once the caller's
 *      PENDING_RESOLVE_TIMEOUT_MS deadline elapses (`pendingExpired` true) it
 *      converts to the FINAL "No confirmation" state — PENDING can never
 *      persist indefinitely.
 *   4. Expiry NEVER overrides a resolved verdict: `pendingExpired` is only
 *      consulted when no verdict exists at all.
 */
export function resolveSelectedSymbolActionabilityDisplay(
  lifted: PublishedScannerAction | null,
  dataOnlyFallback: ScannerActionability | null,
  pendingExpired = false,
): ScannerActionabilityDisplay {
  if (lifted === "CHECK_FAILED") return "CHECK_FAILED";
  const resolved = resolveSelectedSymbolActionability(lifted, dataOnlyFallback);
  if (resolved !== null) return resolved;
  return pendingExpired ? "NO_CONFIRMATION" : "PENDING";
}

/** UI descriptor for a display verdict (pending/final-display-state aware). */
export function actionabilityDisplayUi(
  a: ScannerActionabilityDisplay,
): ActionabilityUi {
  if (a === "PENDING") return ACTIONABILITY_PENDING_UI;
  if (a === "NO_CONFIRMATION") return ACTIONABILITY_NO_CONFIRMATION_UI;
  if (a === "CHECK_FAILED") return ACTIONABILITY_CHECK_FAILED_UI;
  return SCANNER_ACTIONABILITY_UI[a];
}

// ── Direction-aware visible ACTION label (display-only) ──────────────────────
//
// The action badge shows the ONE action verdict's label. For the two verdicts
// that presuppose clean, confirmed data — READY_NOW and WAIT_FOR_CONFIRMATION —
// the generic label ("Wait for confirmation") HIDES the directional decision the
// rest of the surface already states (the header's bias chip, the card's
// direction badge). A user looking at a Conditional BUY then sees only "Wait for
// confirmation" with no side. This pure helper folds the symbol's ONE canonical
// directional read into ONLY those two verdicts, so the badge reads "Conditional
// Buy" / "Conditional Sell" (wait) and "Buy now" / "Sell now" (ready). Every
// other display state — the feed-degraded / market-closed / no-setup /
// display-only ones (TOO_LATE, NO_CLEAN_SETUP, MARKET_CLOSED, FEED_LIMITED,
// ANALYSIS_ONLY, PENDING, NO_CONFIRMATION, CHECK_FAILED) — keeps its neutral
// base label so a direction can NEVER leak onto an unconfirmed / no-setup feed.
//
// DISPLAY-ONLY: this renames a label. It changes NO verdict, tone, canAct, gate,
// sufficiency, or execution path (resolveScannerActionability, the data caps, the
// Phase B 23-gate pipeline, and canTrade remain the sole authorities).

/** A resolved trade side for the action label, or null for no clear direction. */
export type ActionDirection = "BUY" | "SELL" | null;

/**
 * Map a directional read — the composed snapshot `TruthVerdictBias`
 * (BULLISH/BEARISH/NEUTRAL/CONFLICT/UNKNOWN) or a raw "BUY"/"SELL"/"LONG"/"SHORT"
 * side — to the action direction, or null when there is no single clear
 * direction (NEUTRAL / CONFLICT / UNKNOWN / missing). A true no-direction read
 * therefore keeps the neutral label; only a clear bullish/bearish read shows a
 * side.
 */
export function biasToActionDirection(
  bias: string | null | undefined,
): ActionDirection {
  if (bias === "BULLISH" || bias === "BUY" || bias === "LONG") return "BUY";
  if (bias === "BEARISH" || bias === "SELL" || bias === "SHORT") return "SELL";
  return null;
}

/**
 * The visible ACTION label: the base UI label with the directional decision
 * folded in for READY_NOW / WAIT_FOR_CONFIRMATION only. Precedence — a present
 * direction on one of those two directional verdicts WINS over the generic
 * wording (so a stale/generic "Wait for confirmation" can never mask a newer
 * directional Conditional Buy/Sell); the absence of a direction, or any other
 * verdict/display-state, preserves the neutral base label (so no direction can
 * leak onto a degraded / no-setup / unresolved read). Pure and shared, so every
 * surface that renders the action label produces identical text for the same
 * (verdict, direction).
 */
export function resolveVisibleActionLabel(
  a: ScannerActionabilityDisplay,
  direction: ActionDirection,
): string {
  const base = actionabilityDisplayUi(a).label;
  if (direction !== "BUY" && direction !== "SELL") return base;
  const side = direction === "BUY" ? "Buy" : "Sell";
  if (a === "WAIT_FOR_CONFIRMATION") return `Conditional ${side}`;
  if (a === "READY_NOW") return `${side} now`;
  return base;
}

/**
 * The visible ACTION BUTTON label for the "Prepare Trade" button — directional
 * for WAIT_FOR_CONFIRMATION ("Prepare Conditional Buy/Sell") and READY_NOW
 * ("Prepare Buy/Sell") only. All other verdicts keep the neutral "Prepare Trade".
 * Pure and shared: every surface calls this for the button label so they can never
 * produce different wording for the same (verdict, direction). Parallel to
 * `resolveVisibleActionLabel` but for CTA buttons rather than badge copy.
 */
export function resolveVisibleActionButtonLabel(
  a: ScannerActionabilityDisplay,
  direction: ActionDirection,
): string {
  if (direction === "BUY" || direction === "SELL") {
    const side = direction === "BUY" ? "Buy" : "Sell";
    if (a === "WAIT_FOR_CONFIRMATION") return `Prepare Conditional ${side}`;
    if (a === "READY_NOW") return `Prepare ${side}`;
  }
  return "Prepare Trade";
}
