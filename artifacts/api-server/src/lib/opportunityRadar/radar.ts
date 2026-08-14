// Opportunity Radar — wraps the real LiveScanner into a ranked, labeled,
// per-user "what should I watch right now?" view.
//
// SAFETY:
// - READ-ONLY. Never opens, closes, or modifies trades.
// - Never imports placeOrder, dispatchToBroker, or runOrderGuards.
// - Real data only — when LiveScanner skips a (symbol, timeframe) for
//   missing candles, this engine emits a DATA_INSUFFICIENT opportunity
//   for that symbol. It NEVER fabricates a candidate.
// - Per-user scoped: all DB writes use the passed userId.

import { db } from "@workspace/db";
import {
  opportunityScansTable,
  watchlistSymbolPreferencesTable,
  watchlistsTable,
  watchlistItemsTable,
  usersTable,
  riskSettingsTable,
} from "@workspace/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { type LiveCandidate } from "../assistant/liveScanner.js";
import { type ScannerOpportunity } from "../marketScanner.js";
import { ARX_FOCUS_MARKETS, isApprovedArxMarket } from "@workspace/domain/market";
import { scanCoreOpportunities } from "../data/marketOverview.js";
import {
  scannerOpportunityToLiveCandidate,
  mapScannerDataStatusToDataQuality,
} from "../data/opportunityAdapters.js";
import { runActionGuards, type ActionGuardPrefetched } from "../tradeAction/guards.js";
import type { GuardChainResult } from "../tradeAction/types.js";
import { getStatus as getSafetyStatus } from "../safetyCore.js";
import { resolveRouting } from "../adminTrading/routingResolver.js";
import { getEnvelope } from "../adminTrading/safetyEnvelope.js";

export type RadarLabel =
  | "Strong opportunity"
  | "Watchlist opportunity"
  | "Wait for confirmation"
  | "Choppy / no clear edge"
  | "High risk"
  | "Avoid for now"
  | "Data insufficient";

export type SuggestedAction =
  | "WATCH"
  | "ASK_AI"
  | "SET_ALERT"
  | "REVIEW_DEMO_TRADE"
  | "REVIEW_LIVE_TRADE"
  | "WAIT_FOR_CONFIRMATION"
  | "AVOID"
  | "DATA_INSUFFICIENT"
  | "BLOCKED_BY_RULE";

export type DataQuality = "FRESH" | "STALE" | "PARTIAL" | "UNAVAILABLE";

/**
 * Phase OR2 — Risk Governor pre-check result attached to every opportunity.
 * Source-of-truth is `runActionGuards` (preview mode); radar never makes a
 * second, partial rule judgement.
 */
export type RuleStatus =
  | "CLEAR"
  | "WARNING_BY_RULE"
  | "BLOCKED_BY_RULE"
  | "DATA_INCOMPLETE"
  | "RULE_CHECK_SKIPPED"
  | "RULE_CHECK_FAILED";

export interface RuleCheck {
  status: RuleStatus;
  reason: string | null;
  failedCheckId: string | null;
  /** Names of all 14 guard checks (or fewer if a fail short-circuited). */
  checksRun: string[];
  /** OR2 P1 #1 — the mode this opportunity was evaluated against
   *  ("SIMULATED" | "DEMO" | "LIVE"). Surfaces "did we preview your real mode?" */
  evaluatedAgainstMode?: "SIMULATED" | "DEMO" | "LIVE";
  /** OR2 P1 #1 — soft warning surfaced even when guards pass (e.g. live locked,
   *  shared-master degraded, prop-firm caution). */
  warnings?: string[];
  /** Phase OR2 P2 (criterion #6) — structured detail surfaced to UI + AI so
   *  the user sees rule name, source, severity, current value, allowed limit,
   *  and what to fix. NEVER fabricated; only populated when status is
   *  BLOCKED_BY_RULE or WARNING_BY_RULE and the rule is registered. */
  ruleDetail?: RuleDetail | null;
}

/** Phase OR2 P2 — structured rule-violation surface (criterion #6 item 6). */
export interface RuleDetail {
  /** Human-readable rule name ("Emergency Kill Switch", "Risk Governor", etc). */
  ruleName: string;
  /** Where the rule lives: which subsystem failed. */
  source: "RISK_GOVERNOR" | "GUARD_CHAIN" | "SAFETY_CORE" | "ROUTING" | "USER_ACCOUNT";
  severity: "INFO" | "WARN" | "DANGER" | "CRITICAL";
  /** Parsed from the rejection text where possible (e.g. lot size submitted).
   *  Null when not numerically extractable — never fabricated. */
  currentValue: number | string | null;
  /** Parsed from the rejection text where possible (e.g. hard-cap lot value).
   *  Null when not numerically extractable — never fabricated. */
  allowedLimit: number | string | null;
  /** Single concrete next-step for the user. */
  fixHint: string;
}

const RULE_REGISTRY: Record<string, Omit<RuleDetail, "currentValue" | "allowedLimit">> = {
  ownership:              { ruleName: "Trade Ownership",          source: "GUARD_CHAIN",   severity: "DANGER",   fixHint: "Only the trade's owner can act on it." },
  kill_switch:            { ruleName: "Emergency Kill Switch",    source: "SAFETY_CORE",   severity: "CRITICAL", fixHint: "Reset the Emergency Stop in Trading Control before retrying." },
  platform_mode:          { ruleName: "Platform Trading Mode",    source: "SAFETY_CORE",   severity: "DANGER",   fixHint: "Ask your admin to enable the requested mode (DEMO or LIVE) in Trading Control." },
  user_active:            { ruleName: "Account Status",           source: "USER_ACCOUNT",  severity: "CRITICAL", fixHint: "Contact support — your account is currently suspended." },
  routing:                { ruleName: "Account Routing",          source: "ROUTING",       severity: "DANGER",   fixHint: "Connect or re-verify your MT5 bridge in Settings → MT5." },
  account_type:           { ruleName: "Account Type vs Mode",     source: "ROUTING",       severity: "DANGER",   fixHint: "Use a demo-typed account for DEMO, or a live-verified account for LIVE." },
  risk_limits:            { ruleName: "Max Lot Size",             source: "GUARD_CHAIN",   severity: "WARN",     fixHint: "Reduce the lot size to within your configured max." },
  risk_governor:          { ruleName: "Risk Governor",            source: "RISK_GOVERNOR", severity: "DANGER",   fixHint: "Review Risk Settings — a governor rule (daily loss cap, max open trades, close-only mode, allowed symbols, or shared-master allocation) is currently blocking new entries." },
  duplicate:              { ruleName: "Duplicate Action",         source: "GUARD_CHAIN",   severity: "WARN",     fixHint: "An identical action is already in flight. Wait for it to complete." },
  expiry:                 { ruleName: "Action Expiry",            source: "GUARD_CHAIN",   severity: "INFO",     fixHint: "This action draft expired — create a fresh one." },
  live_disclosure:        { ruleName: "Live Trading Disclosure",  source: "GUARD_CHAIN",   severity: "DANGER",   fixHint: "Open Risk Settings → Live Disclosure and accept it before live actions." },
  explicit_confirmation:  { ruleName: "Live Confirmation",        source: "GUARD_CHAIN",   severity: "INFO",     fixHint: "Click Confirm in the Live Trade dialog to acknowledge the live order." },
  queueable:              { ruleName: "MT5 Connection Required",  source: "ROUTING",       severity: "DANGER",   fixHint: "Connect MT5 in Settings → MT5 Bridge before sending real orders." },
};

const SOFT_WARNING_DETAIL: Omit<RuleDetail, "currentValue" | "allowedLimit"> = {
  ruleName: "Mode / Account Advisory",
  source: "SAFETY_CORE",
  severity: "WARN",
  fixHint: "Review the advisory and confirm you still want to take this setup.",
};

const DATA_INCOMPLETE_DETAIL: Omit<RuleDetail, "currentValue" | "allowedLimit"> = {
  ruleName: "Risk Governor Context Unavailable",
  source: "RISK_GOVERNOR",
  severity: "WARN",
  fixHint: "Your safety + risk context could not be loaded. Refresh, or check that risk settings are configured.",
};

/** Parse numeric "current vs limit" from rejection text — honest, no
 *  fabrication. Matches patterns like:
 *   "Lot size 6 exceeds hard cap 5.0"
 *   "Lot size 0.5 exceeds your max 0.1"
 *   "Max concurrent positions reached (3/3)"
 *   "Daily loss cap reached: -200 / -150" */
function parseCurrentAndLimit(reason: string | null): { currentValue: number | null; allowedLimit: number | null } {
  if (!reason) return { currentValue: null, allowedLimit: null };
  const slash = reason.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  if (slash) return { currentValue: Number(slash[1]), allowedLimit: Number(slash[2]) };
  const exceeds = reason.match(/(-?\d+(?:\.\d+)?)\s+exceeds\s+(?:hard\s+cap|your\s+max|max|limit\s+of)?\s*(-?\d+(?:\.\d+)?)/i);
  if (exceeds) return { currentValue: Number(exceeds[1]), allowedLimit: Number(exceeds[2]) };
  return { currentValue: null, allowedLimit: null };
}

/** Build a RuleDetail for a failed/warning RuleCheck. Returns null when
 *  status doesn't warrant one (CLEAR / RULE_CHECK_SKIPPED). */
function buildRuleDetail(rc: RuleCheck): RuleDetail | null {
  if (rc.status === "DATA_INCOMPLETE") {
    return { ...DATA_INCOMPLETE_DETAIL, currentValue: null, allowedLimit: null };
  }
  if (rc.status === "BLOCKED_BY_RULE" || rc.status === "RULE_CHECK_FAILED") {
    const base: Omit<RuleDetail, "currentValue" | "allowedLimit"> =
      (rc.failedCheckId && RULE_REGISTRY[rc.failedCheckId])
        ? RULE_REGISTRY[rc.failedCheckId]!
        : {
            ruleName: rc.failedCheckId ?? "Unknown rule",
            source: "GUARD_CHAIN",
            severity: "WARN",
            fixHint: "See rule reason for details.",
          };
    const { currentValue, allowedLimit } = parseCurrentAndLimit(rc.reason);
    return { ...base, currentValue, allowedLimit };
  }
  if (rc.status === "WARNING_BY_RULE") {
    // Soft-warning origin — failedCheckId is null because guards passed;
    // surface the advisory in the same shape.
    if (rc.failedCheckId && RULE_REGISTRY[rc.failedCheckId]) {
      const base = RULE_REGISTRY[rc.failedCheckId]!;
      const { currentValue, allowedLimit } = parseCurrentAndLimit(rc.reason);
      return { ...base, severity: "WARN", currentValue, allowedLimit };
    }
    return { ...SOFT_WARNING_DETAIL, currentValue: null, allowedLimit: null };
  }
  return null;
}

export interface Opportunity {
  symbol: string;
  brokerSymbol: string | null;
  timeframe: string;
  directionBias: "bullish" | "bearish" | "neutral" | "mixed" | "choppy";
  opportunityScore: number;
  setupQualityScore: number;
  confluenceScore: number;
  riskScore: number;
  strategyMatch: string | null;
  label: RadarLabel;
  reasonSummary: string;
  keyLevelToWatch: number | null;
  invalidationLevel: number | null;
  suggestedAction: SuggestedAction;
  toolsUsed: string[];
  dataQuality: DataQuality;
  dataSource: string | null;
  multiTimeframe?: {
    bias: string;
    alignmentScore: number;
    conflictWarning: string | null;
    bestTimeframeToWatch: string | null;
  };
  /**
   * Phase OR2 — full Risk Governor preview (runActionGuards) result for this
   * opportunity if it were opened as a DEMO trade right now. Same source of
   * truth that the live trade queue uses. May be RULE_CHECK_SKIPPED when
   * dataQuality is UNAVAILABLE (we don't block what we can't evaluate).
   */
  ruleCheck: RuleCheck;
  createdAt: string;
}

const SAFETY_ENVELOPE = {
  safetyMode: "paper_only" as const,
  liveLocked: true as const,
  readOnlyMode: true as const,
  allowOrderExecution: false as const,
};

// Task #558 — radar defaults DERIVE from the ARX Focus registry (approved-only,
// never a parallel hardcoded list): the tier-1 forex majors + metals.
const DEFAULT_SYMBOLS: readonly string[] = ARX_FOCUS_MARKETS
  .filter((m) => m.priorityTier === "tier_1" && (m.category === "forex_major" || m.category === "metal"))
  .map((m) => m.canonicalSymbol);

/** Timeframes the radar scans per symbol through the single scoring path. */
const RADAR_TIMEFRAMES = ["M15", "H1"] as const;

function labelAndAction(c: LiveCandidate): { label: RadarLabel; action: SuggestedAction; opportunityScore: number } {
  // Map LiveScanner opportunityLabel + statusBadge → radar label + suggested action.
  const score = Math.round(c.score);
  switch (c.opportunityLabel) {
    case "ELITE":
    case "STRONG":
      return { label: "Strong opportunity", action: "REVIEW_DEMO_TRADE", opportunityScore: score };
    case "ACCEPTABLE":
      return { label: "Watchlist opportunity", action: "WATCH", opportunityScore: score };
    case "WEAK":
      if (c.statusBadge === "CHOPPY_MARKET") {
        return { label: "Choppy / no clear edge", action: "WAIT_FOR_CONFIRMATION", opportunityScore: score };
      }
      if (c.riskScore >= 70) {
        return { label: "High risk", action: "WAIT_FOR_CONFIRMATION", opportunityScore: score };
      }
      return { label: "Wait for confirmation", action: "WAIT_FOR_CONFIRMATION", opportunityScore: score };
    case "REJECT":
    default:
      return { label: "Avoid for now", action: "AVOID", opportunityScore: score };
  }
}

const RULE_CHECK_SKIPPED: RuleCheck = {
  status: "RULE_CHECK_SKIPPED",
  reason: "Risk Governor cannot evaluate without market data.",
  failedCheckId: null,
  checksRun: [],
};

function dataInsufficient(symbol: string, dataSource: string | null): Opportunity {
  return {
    symbol,
    brokerSymbol: null,
    timeframe: "M15",
    directionBias: "neutral",
    opportunityScore: 0,
    setupQualityScore: 0,
    confluenceScore: 0,
    riskScore: 0,
    strategyMatch: null,
    label: "Data insufficient",
    reasonSummary:
      "Live market data with sufficient candle history is not connected for this symbol. No opportunity can be evaluated.",
    keyLevelToWatch: null,
    invalidationLevel: null,
    suggestedAction: "DATA_INSUFFICIENT",
    toolsUsed: ["marketProvider:check", "liveScanner:skipped_no_candles"],
    dataQuality: "UNAVAILABLE",
    dataSource,
    ruleCheck: RULE_CHECK_SKIPPED,
    createdAt: new Date().toISOString(),
  };
}

function biasToSide(bias: LiveCandidate["bias"]): string | null {
  if (bias === "bullish") return "BUY";
  if (bias === "bearish") return "SELL";
  return null;
}

function summarizeGuardResult(guard: GuardChainResult | null): RuleCheck {
  if (!guard) {
    return {
      status: "RULE_CHECK_FAILED",
      reason: "Risk Governor preview did not return a result.",
      failedCheckId: null,
      checksRun: [],
    };
  }
  const checksRun = guard.checks.map((c) => c.id);
  if (guard.passed) {
    return { status: "CLEAR", reason: null, failedCheckId: null, checksRun };
  }
  return {
    status: "BLOCKED_BY_RULE",
    reason: guard.rejectionReason,
    failedCheckId: guard.failedCheckId,
    checksRun,
  };
}

async function runRulePreviewForOpportunity(
  userId: number,
  op: Opportunity,
  scanCtx: ScanContext,
): Promise<RuleCheck> {
  if (op.dataQuality === "UNAVAILABLE") return RULE_CHECK_SKIPPED;
  if (scanCtx.contextStatus === "DATA_INCOMPLETE") {
    const rc: RuleCheck = {
      status: "DATA_INCOMPLETE",
      reason: scanCtx.contextError ?? "Per-scan safety context could not be loaded; cannot evaluate Risk Governor.",
      failedCheckId: null,
      checksRun: [],
      evaluatedAgainstMode: scanCtx.effectivePreviewMode,
    };
    rc.ruleDetail = buildRuleDetail(rc);
    return rc;
  }
  try {
    // OR2 P1 #1 — preview against the user's ACTUAL most-permissive mode.
    // OR2 P1 #2 — pass the shared scan context so we don't re-query per opportunity.
    const guard = await runActionGuards({
      userId,
      actionId: -1,                    // sentinel: never collides with a real action row
      actionType: "OPEN",
      requestedMode: scanCtx.effectivePreviewMode,
      symbol: op.symbol,
      side: biasToSide(op.directionBias === "bullish" ? "bullish"
                       : op.directionBias === "bearish" ? "bearish" : "neutral"),
      lotSize: null,                   // radar has no lot size yet
      tradeKey: null,                  // no real trade — OPEN draft
      confirmedByUser: scanCtx.effectivePreviewMode === "LIVE", // satisfies "explicit confirm" check at preview time; UI/queue still requires real user confirm
      expiresAt: null,
      previewMode: true,
      prefetched: scanCtx.prefetched,
    });
    const summary = summarizeGuardResult(guard);
    summary.evaluatedAgainstMode = scanCtx.effectivePreviewMode;
    // Surface soft warnings even when guards pass.
    if (summary.status === "CLEAR" && scanCtx.softWarnings.length > 0) {
      summary.status = "WARNING_BY_RULE";
      summary.warnings = scanCtx.softWarnings;
      summary.reason = scanCtx.softWarnings[0] ?? null;
    } else if (scanCtx.softWarnings.length > 0) {
      summary.warnings = scanCtx.softWarnings;
    }
    summary.ruleDetail = buildRuleDetail(summary);
    return summary;
  } catch (e) {
    const rc: RuleCheck = {
      status: "RULE_CHECK_FAILED",
      reason: `Risk Governor preview errored: ${(e as Error).message.slice(0, 160)}`,
      failedCheckId: null,
      checksRun: [],
      evaluatedAgainstMode: scanCtx.effectivePreviewMode,
    };
    rc.ruleDetail = buildRuleDetail(rc);
    return rc;
  }
}

// ── OR2 P1 #1 + #2 — Per-scan, per-user safety + mode context ─────────────
// Built ONCE per evaluateOpportunitiesForUser call. Lives only on the stack.
// Never global, never cached across users, never reused across requests.
interface ScanContext {
  /** "FRESH" when all shared state loaded cleanly; "DATA_INCOMPLETE" when a
   *  required read failed and we should label opportunities accordingly. */
  contextStatus: "FRESH" | "DATA_INCOMPLETE";
  contextError: string | null;
  /** When the scan context was assembled — surfaced to the client so it can
   *  show "Evaluated at HH:MM:SS UTC against your <mode> mode". */
  cachedAt: string;
  /** Effective preview mode = the most permissive mode the user could ACTUALLY
   *  use right now. Drives both the guard preview AND the suggestedAction cap. */
  effectivePreviewMode: "SIMULATED" | "DEMO" | "LIVE";
  /** True when the platform is OFF or kill switch is engaged — no queueing,
   *  analyze-only. */
  tradingDisabled: boolean;
  /** True when account is in close-only mode (admin daily-loss cap, etc).
   *  OPENs are blocked; only CLOSE/PARTIAL_CLOSE/MODIFY allowed. */
  closeOnlyMode: boolean;
  /** True when user is routed through a shared master account. */
  isSharedMaster: boolean;
  /** Mode summary surfaced in the radar response envelope. */
  modeSummary: {
    platformMode: string;
    tradingMode: string;
    bannerLabel: string;
    accountRoutingMode: string;
    userLiveApproved: boolean;
    liveLocked: boolean;
    emergencyKillSwitch: boolean;
    canSuggestLive: boolean;
    canSuggestDemo: boolean;
    closeOnlyMode: boolean;
  };
  /** Soft (non-blocking) warnings to attach to every opportunity. */
  softWarnings: string[];
  /** Cached state forwarded into runActionGuards. */
  prefetched: ActionGuardPrefetched;
}

async function buildScanContext(userId: number, dataSource: string | null): Promise<ScanContext> {
  const cachedAt = new Date().toISOString();
  const softWarnings: string[] = [];
  try {
    // One round-trip; each call is independent and safe to parallelize.
    // IMPORTANT — distinguish "row not found" (null) from "lookup errored"
    // (undefined). Guards treat `undefined` as "not prefetched → live re-read",
    // and `null` as "confirmed no row". Coalescing errors to `null` would mask
    // transient failures as hard guard rejections.
    const [envelope, safety, user, riskSettingsRow] = await Promise.all([
      getEnvelope(userId),
      getSafetyStatus(),
      db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1)
        .then(r => (r[0] ?? null) as { id: number; suspendedAt?: Date | null } | null)
        .catch(() => undefined),
      db.select().from(riskSettingsTable)
        .where(eq(riskSettingsTable.userId, userId)).limit(1)
        .then(r => r[0] ?? null)
        .catch(() => undefined),
    ]);

    const allowed = safety.allowedModes ?? [];
    const liveDisclosureAck = (riskSettingsRow as { liveDisclosureAcknowledgedAt?: Date | null } | null)?.liveDisclosureAcknowledgedAt ?? null;
    const liveOk =
      envelope.tradingMode === "LIVE"
      && envelope.globalLiveEnabled === true
      && envelope.userLiveApproved === true
      && envelope.liveLocked === false
      && envelope.emergencyKillSwitch === false
      && allowed.includes("LIVE_TRADING")
      && !!liveDisclosureAck;
    const demoOk =
      !envelope.emergencyKillSwitch
      && (allowed.includes("PAPER_TRADING") || allowed.includes("LIVE_TRADING"))
      && envelope.tradingMode !== "DISABLED";

    const tradingDisabled = envelope.tradingMode === "DISABLED" || envelope.emergencyKillSwitch;
    const isSharedMaster = envelope.accountRoutingMode === "SHARED_MASTER_MT5";

    // Determine effective preview mode.
    const effectivePreviewMode: "SIMULATED" | "DEMO" | "LIVE" =
      liveOk ? "LIVE" : demoOk ? "DEMO" : "SIMULATED";

    // Pre-resolve routing for the chosen preview mode (radar emits one).
    const routing = await resolveRouting({ userId, mode: effectivePreviewMode }).catch(() => null);

    // Compose soft warnings.
    if (envelope.liveLocked && envelope.tradingMode !== "LIVE") {
      softWarnings.push("Live trading is locked by platform safety — preview suggestions are demo-only.");
    }
    if (envelope.tradingMode === "DEMO" || envelope.tradingMode === "SIMULATED") {
      softWarnings.push(`Platform is in ${envelope.tradingMode} mode — any suggestion is a paper/demo review only.`);
    }
    if (isSharedMaster) {
      if (routing && !routing.ok) {
        softWarnings.push(`Shared-master routing unavailable: ${routing.blockReason ?? "no shared master resolved"}.`);
      } else {
        softWarnings.push(`Routed through shared master MT5 (virtual account #${routing?.virtualAccountId ?? "—"}). Allocation limits apply.`);
      }
    }
    if (envelope.bannerLabel === "Live Trading Pending Approval") {
      softWarnings.push("Live trading is pending admin approval.");
    }

    const closeOnlyMode = false; // Risk Governor evaluates this per-opportunity; surfaced via BLOCKED_BY_RULE("rg_close_only") downstream.

    return {
      contextStatus: "FRESH",
      contextError: null,
      cachedAt,
      effectivePreviewMode,
      tradingDisabled,
      closeOnlyMode,
      isSharedMaster,
      modeSummary: {
        platformMode: envelope.tradingMode,
        tradingMode: envelope.tradingMode,
        bannerLabel: envelope.bannerLabel,
        accountRoutingMode: envelope.accountRoutingMode,
        userLiveApproved: envelope.userLiveApproved,
        liveLocked: envelope.liveLocked,
        emergencyKillSwitch: envelope.emergencyKillSwitch,
        canSuggestLive: liveOk,
        canSuggestDemo: demoOk,
        closeOnlyMode,
      },
      softWarnings,
      prefetched: {
        safety,
        routing: routing && routing.ok ? routing : undefined,
        // `user` / `riskSettings` are passed through preserving the
        // null-vs-undefined distinction. `undefined` ⇒ guards live-fallback;
        // `null` ⇒ guards treat as "no row" (fails user_active for users).
        user: user === undefined
          ? undefined
          : user === null
            ? null
            : { id: user.id, suspendedAt: user.suspendedAt ?? null },
        riskSettings: riskSettingsRow as ActionGuardPrefetched["riskSettings"],
        cachedAt,
        cacheSource: "radar-scan",
      },
    };
  } catch (err) {
    return {
      contextStatus: "DATA_INCOMPLETE",
      contextError: `Per-scan safety context failed: ${(err as Error).message.slice(0, 200)}`,
      cachedAt,
      effectivePreviewMode: "SIMULATED",
      tradingDisabled: true,
      closeOnlyMode: false,
      isSharedMaster: false,
      modeSummary: {
        platformMode: "UNKNOWN",
        tradingMode: "UNKNOWN",
        bannerLabel: "Unknown",
        accountRoutingMode: "USER_OWNED_MT5",
        userLiveApproved: false,
        liveLocked: true,
        emergencyKillSwitch: true,
        canSuggestLive: false,
        canSuggestDemo: false,
        closeOnlyMode: false,
      },
      softWarnings: ["Per-scan safety context unavailable; opportunities are advisory only."],
      prefetched: { cachedAt, cacheSource: "radar-scan" },
    };
  }
  void dataSource;
}

/**
 * OR2 P1 #1 — Map raw suggestedAction onto what the user's current mode
 * actually permits. Never emit REVIEW_LIVE_TRADE when live is unavailable.
 */
function applyModeCapToSuggestion(
  baseAction: SuggestedAction,
  rc: RuleCheck,
  ctx: ScanContext,
): SuggestedAction {
  if (rc.status === "DATA_INCOMPLETE") return "DATA_INSUFFICIENT";
  if (rc.status === "BLOCKED_BY_RULE") return "BLOCKED_BY_RULE";
  if (rc.status === "RULE_CHECK_FAILED") return "WAIT_FOR_CONFIRMATION";
  if (ctx.tradingDisabled) {
    // OFF / kill switch — analyze only.
    if (baseAction === "REVIEW_LIVE_TRADE" || baseAction === "REVIEW_DEMO_TRADE") return "WATCH";
    return baseAction;
  }
  if (baseAction === "REVIEW_LIVE_TRADE" && !ctx.modeSummary.canSuggestLive) {
    return ctx.modeSummary.canSuggestDemo ? "REVIEW_DEMO_TRADE" : "WATCH";
  }
  if (baseAction === "REVIEW_DEMO_TRADE" && !ctx.modeSummary.canSuggestDemo) {
    return "WATCH";
  }
  return baseAction;
}

function fromLiveCandidate(c: LiveCandidate, dataSource: string | null): Opportunity {
  const { label, action, opportunityScore } = labelAndAction(c);
  const bias: Opportunity["directionBias"] =
    c.bias === "bullish" || c.bias === "bearish" || c.bias === "neutral" || c.bias === "choppy"
      ? c.bias
      : "neutral";
  return {
    symbol: c.symbol,
    brokerSymbol: null,
    timeframe: c.timeframe,
    directionBias: bias,
    opportunityScore,
    setupQualityScore: Math.round(c.confidenceScore),
    confluenceScore: Math.round(c.confidenceScore),
    riskScore: Math.round(c.riskScore),
    strategyMatch: c.setupType,
    label,
    reasonSummary: c.reasonForTrade || c.reasonToAvoid || "Scanner-evaluated setup.",
    keyLevelToWatch: c.entry || null,
    invalidationLevel: c.stopLoss || null,
    suggestedAction: action,
    toolsUsed: ["liveScanner", "confluenceScoring", `marketProvider:${dataSource ?? "unknown"}`],
    dataQuality: "FRESH",
    dataSource,
    ruleCheck: RULE_CHECK_SKIPPED, // overwritten by per-scan rule preview loop
    createdAt: c.generatedAt,
  };
}

function combineMultiTimeframe(perTf: LiveCandidate[]): Opportunity["multiTimeframe"] {
  if (perTf.length === 0) return undefined;
  const biases = perTf.map((c) => c.bias);
  const allAgree = biases.every((b) => b === biases[0]);
  const anyOpposite = biases.some((b) => b === "bullish") && biases.some((b) => b === "bearish");
  const alignment = allAgree ? 100 : anyOpposite ? 0 : 50;
  const best = [...perTf].sort((a, b) => b.score - a.score)[0];
  return {
    bias: allAgree ? biases[0]! : anyOpposite ? "mixed" : "neutral",
    alignmentScore: alignment,
    conflictWarning: anyOpposite ? "Conflicting bias across timeframes — wait for alignment" : null,
    bestTimeframeToWatch: best?.timeframe ?? null,
  };
}

async function resolveUserWatchSymbols(userId: number, fallback: readonly string[] = DEFAULT_SYMBOLS): Promise<string[]> {
  // Task #558 — any user-stored watch symbol that is no longer an approved ARX
  // Focus market is dropped here so unapproved symbols never resurface on the
  // radar. The approved defaults are the floor when nothing approved remains.
  // 1. Explicit preferences (pinned first, muted excluded)
  const prefs = await db.select().from(watchlistSymbolPreferencesTable)
    .where(eq(watchlistSymbolPreferencesTable.userId, userId));
  if (prefs.length > 0) {
    const approved = prefs
      .filter((p) => !p.muted && isApprovedArxMarket(p.symbol))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned))
      .map((p) => p.symbol);
    if (approved.length > 0) return approved;
  }
  // 2. Items from the user's watchlists
  const lists = await db.select().from(watchlistsTable).where(eq(watchlistsTable.userId, userId));
  if (lists.length > 0) {
    const items = await db.select().from(watchlistItemsTable)
      .where(inArray(watchlistItemsTable.watchlistId, lists.map((l) => l.id)));
    const approved = Array.from(new Set(items.map((i) => i.symbol))).filter(isApprovedArxMarket);
    if (approved.length > 0) return approved;
  }
  // 3. Defaults
  return [...fallback];
}

export interface RankedOpportunitiesResult {
  evaluatedAt: string;
  liveDataConnected: boolean;
  dataSource: string | null;
  symbolsRequested: number;
  symbolsWithData: number;
  symbolsInsufficient: number;
  /** OR2 P1 #1 — surface the live mode context so UI/AI can render
   *  "previewed against your DEMO mode", "live locked", "shared master", etc.
   *  without re-querying. */
  modeContext: {
    platformMode: string;
    bannerLabel: string;
    accountRoutingMode: string;
    canSuggestLive: boolean;
    canSuggestDemo: boolean;
    tradingDisabled: boolean;
    effectivePreviewMode: "SIMULATED" | "DEMO" | "LIVE";
    scanCachedAt: string;
    warnings: string[];
    contextStatus: "FRESH" | "DATA_INCOMPLETE";
  };
  sections: {
    bestOpportunities: Opportunity[];
    watchClosely: Opportunity[];
    waitForConfirmation: Opportunity[];
    highRiskOrAvoid: Opportunity[];
    dataInsufficient: Opportunity[];
  };
  opportunities: Opportunity[];
  safetyEnvelope: typeof SAFETY_ENVELOPE;
}

function section(label: RadarLabel | "best", o: Opportunity): "best" | "watch" | "wait" | "avoid" | "data" {
  if (o.label === "Data insufficient") return "data";
  if (o.label === "Strong opportunity") return "best";
  if (o.label === "Watchlist opportunity") return "watch";
  if (o.label === "Wait for confirmation" || o.label === "Choppy / no clear edge") return "wait";
  return "avoid";
}

export async function evaluateOpportunitiesForUser(
  userId: number,
  options: { symbols?: readonly string[]; limit?: number; persist?: boolean } = {},
): Promise<RankedOpportunitiesResult> {
  const requested = options.symbols && options.symbols.length > 0
    ? Array.from(new Set(options.symbols)).slice(0, 50)
    : await resolveUserWatchSymbols(userId);
  const limit = Math.min(50, Math.max(1, options.limit ?? 25));

  // Unified scoring path: scan the user's watch symbols through the SINGLE
  // scoring path (scanSymbolTimeframe via scanCoreOpportunities), live-only.
  // limit = pairsAttempted so the top-N slice keeps every live row.
  const scan = await scanCoreOpportunities(
    requested,
    RADAR_TIMEFRAMES,
    requested.length * RADAR_TIMEFRAMES.length,
  );
  const liveDataConnected = scan.symbolsWithLiveData > 0;
  const dataSource = "ROUTER";

  // Group the live-only scanner rows by symbol. Keep the raw ScannerOpportunity
  // so each opportunity carries its OWN honest dataStatus → dataQuality and
  // resolved feed provider, instead of one blanket source/quality for the scan.
  const bySymbol = new Map<string, ScannerOpportunity[]>();
  for (const row of scan.opportunities) {
    const arr = bySymbol.get(row.symbol) ?? [];
    arr.push(row);
    bySymbol.set(row.symbol, arr);
  }

  const ops: Opportunity[] = [];
  let symbolsWithData = 0;
  let symbolsInsufficient = 0;

  for (const sym of requested) {
    const rows = bySymbol.get(sym);
    if (!rows || rows.length === 0) {
      // No live row for this symbol — honest "no source produced data" (null),
      // not a blanket scan source.
      ops.push(dataInsufficient(sym, null));
      symbolsInsufficient++;
      continue;
    }
    symbolsWithData++;
    // Adapt every row for this symbol to a LiveCandidate for the multi-tf view.
    const cands = rows.map(scannerOpportunityToLiveCandidate);
    // Pick the best-scored timeframe as the primary candidate, keeping the raw
    // row index aligned so the opportunity carries its OWN provenance + freshness.
    let primaryIdx = 0;
    for (let i = 1; i < cands.length; i++) {
      if (cands[i]!.score > cands[primaryIdx]!.score) primaryIdx = i;
    }
    const primaryRow = rows[primaryIdx]!;
    const op = fromLiveCandidate(cands[primaryIdx]!, primaryRow.feedProvider ?? primaryRow.dataSource);
    // Honest per-row freshness — derived from the scanner row's dataStatus, not
    // hardcoded FRESH. (Live-only input ⇒ FRESH today, but derived for correctness.)
    op.dataQuality = mapScannerDataStatusToDataQuality(primaryRow.dataStatus);
    op.multiTimeframe = combineMultiTimeframe(cands);
    ops.push(op);
  }

  // ── Phase OR2 — Risk Governor preview for every opportunity ───────────────
  // OR2 P1 #2: build per-scan context ONCE (envelope + safety + user +
  // riskSettings + routing) and pass it through. Each opportunity reuses the
  // cached shared state but still gets its own symbol/side/risk evaluation.
  // OR2 P1 #1: preview against the user's actual most-permissive mode, not
  // a hardcoded "DEMO" — so OFF / LIVE / shared-master / close-only all
  // surface the truthful BLOCKED_BY_RULE or WARNING_BY_RULE state.
  const scanCtx = await buildScanContext(userId, dataSource);
  const ruleChecks = await Promise.all(ops.map((op) => runRulePreviewForOpportunity(userId, op, scanCtx)));
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const rc = ruleChecks[i]!;
    op.ruleCheck = rc;
    // Mode-aware suggestion cap: never advertise an action the mode can't do.
    op.suggestedAction = applyModeCapToSuggestion(op.suggestedAction, rc, scanCtx);
    if (rc.status === "BLOCKED_BY_RULE") {
      op.toolsUsed = [...op.toolsUsed, `riskGovernor:${rc.failedCheckId ?? "blocked"}`];
    } else if (rc.status === "CLEAR") {
      op.toolsUsed = [...op.toolsUsed, "riskGovernor:clear", `mode:${scanCtx.effectivePreviewMode}`];
    } else if (rc.status === "WARNING_BY_RULE") {
      op.toolsUsed = [...op.toolsUsed, "riskGovernor:warning", `mode:${scanCtx.effectivePreviewMode}`];
    } else if (rc.status === "DATA_INCOMPLETE") {
      op.toolsUsed = [...op.toolsUsed, "riskGovernor:data_incomplete"];
    }
  }

  // Ranking: data-insufficient ALWAYS sinks to the bottom (per spec #5 of test list).
  ops.sort((a, b) => {
    const aBad = a.label === "Data insufficient" ? 1 : 0;
    const bBad = b.label === "Data insufficient" ? 1 : 0;
    if (aBad !== bBad) return aBad - bBad;
    return b.opportunityScore - a.opportunityScore;
  });
  const ranked = ops.slice(0, limit);

  const sections = {
    bestOpportunities: [] as Opportunity[],
    watchClosely: [] as Opportunity[],
    waitForConfirmation: [] as Opportunity[],
    highRiskOrAvoid: [] as Opportunity[],
    dataInsufficient: [] as Opportunity[],
  };
  for (const o of ranked) {
    switch (section(o.label, o)) {
      case "best": sections.bestOpportunities.push(o); break;
      case "watch": sections.watchClosely.push(o); break;
      case "wait": sections.waitForConfirmation.push(o); break;
      case "avoid": sections.highRiskOrAvoid.push(o); break;
      case "data": sections.dataInsufficient.push(o); break;
    }
  }

  if (options.persist !== false && ranked.length > 0) {
    try {
      await db.insert(opportunityScansTable).values(ranked.map((o) => ({
        userId,
        symbol: o.symbol,
        brokerSymbol: o.brokerSymbol,
        timeframe: o.timeframe,
        directionBias: o.directionBias,
        opportunityScore: o.opportunityScore,
        setupQualityScore: o.setupQualityScore,
        confluenceScore: o.confluenceScore,
        riskScore: o.riskScore,
        label: o.label,
        reasonSummary: o.reasonSummary,
        keyLevelToWatch: o.keyLevelToWatch ?? undefined,
        invalidationLevel: o.invalidationLevel ?? undefined,
        suggestedAction: o.suggestedAction,
        toolsUsed: o.toolsUsed,
        dataQuality: o.dataQuality,
        dataSource: o.dataSource,
      })));
    } catch {
      // non-fatal — persistence failure shouldn't block the response
    }
  }

  return {
    evaluatedAt: new Date().toISOString(),
    liveDataConnected,
    dataSource,
    symbolsRequested: requested.length,
    symbolsWithData,
    symbolsInsufficient,
    modeContext: {
      platformMode: scanCtx.modeSummary.platformMode,
      bannerLabel: scanCtx.modeSummary.bannerLabel,
      accountRoutingMode: scanCtx.modeSummary.accountRoutingMode,
      canSuggestLive: scanCtx.modeSummary.canSuggestLive,
      canSuggestDemo: scanCtx.modeSummary.canSuggestDemo,
      tradingDisabled: scanCtx.tradingDisabled,
      effectivePreviewMode: scanCtx.effectivePreviewMode,
      scanCachedAt: scanCtx.cachedAt,
      warnings: scanCtx.softWarnings,
      contextStatus: scanCtx.contextStatus,
    },
    sections,
    opportunities: ranked,
    safetyEnvelope: SAFETY_ENVELOPE,
  };
}

export async function getRecentOpportunitiesForUser(userId: number, limit = 25): Promise<{
  count: number;
  recent: Array<typeof opportunityScansTable.$inferSelect>;
  safetyEnvelope: typeof SAFETY_ENVELOPE;
}> {
  const rows = await db.select().from(opportunityScansTable)
    .where(eq(opportunityScansTable.userId, userId))
    .orderBy(desc(opportunityScansTable.createdAt))
    .limit(Math.min(100, Math.max(1, limit)));
  return { count: rows.length, recent: rows, safetyEnvelope: SAFETY_ENVELOPE };
}

void and;
