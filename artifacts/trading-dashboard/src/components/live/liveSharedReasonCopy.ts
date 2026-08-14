// Clean user-facing copy mapper for the Live Shared trade ticket.
//
// Translates raw backend block codes — from THREE distinct envelope
// shapes — into a single user-safe sentence:
//
//   1. preflight refusal from createLiveDraft (200 OK):
//      { ok:false, stage:"preflight", reason: "<DRAFT_REFUSAL>" , detail }
//   2. 16-gate dispatch refusal from the Phase B evaluator:
//      { ok:false, primaryReason:"LIVE_BLOCKED:<GATE>", blockReasons:[...] }
//   3. shared-routing precondition refusal from requireSharedRouting
//      (HTTP 409): { error:"ROUTING_NOT_RESOLVED" |
//      "ROUTING_NOT_SHARED_MASTER" | "SHARED_ROUTING_MISSING_IDS", detail }
//      — and the input-validation 400s ({error:"SYMBOL_REQUIRED"} etc.).
//
// CONTRACT:
// - NEVER returns a raw gate code, flag name, route name, JSON blob, or
//   stack trace. The raw fields are still available to admins via the
//   "Developer details" drawer in the component; this mapper is only for
//   the prose surfaced to normal users.
// - Returns `null` when the input is a successful pre-flight pass (the
//   component renders its own success copy in that case).
// - Falls back to a neutral sentence on any unrecognised code so a
//   never-seen identifier cannot leak through verbatim.

export interface LiveSharedReasonInput {
  ok?: boolean;
  stage?: string | null;
  primaryReason?: string | null;
  reason?: string | null;
  // Routing precondition + input-validation envelopes use `error` (not
  // `reason`/`primaryReason`). Without this field a routing failure
  // would fall through to the generic sentence.
  error?: string | null;
  // Task #737 follow-up — the SPECIFIC execution-readiness blocker threaded by
  // the backend alongside the generic canonical reason. When present it gives
  // an EXACT-match distinct sentence (so "approved but Full Live Activation
  // missing" reads differently from "feed not confirmed").
  blockingReasonCode?: string | null;
}

// EXACT-match copy for the resolver's specific blockingReasonCode values.
// Mirrors the backend's USER_SAFE_BLOCK_COPY. Checked BEFORE the concatenated
// substring chain below because some codes are substrings of one another
// (e.g. SERVER_LIVE_EXECUTION_OFF ⊃ LIVE_EXECUTION_OFF) and would otherwise
// match the wrong branch.
const ACTIVATION_BLOCK_COPY: Record<string, string> = {
  INVESTOR_NOT_ALLOWED:
    "Investor accounts are view-only and cannot place or manage trades.",
  BOT_AGENT_NOT_ALLOWED:
    "Automated, agent, and system accounts are not eligible for live execution.",
  NOT_APPROVED_FOR_LIVE:
    "Your account isn't approved for live trading yet. Ask your operator to approve your account.",
  LIVE_BRIDGE_ASSIGNMENT_PENDING:
    "Your live shared-bridge allocation is still being set up. Contact your operator to finish onboarding.",
  KILL_SWITCH_ENGAGED:
    "The emergency kill switch is on. New live trades are blocked.",
  EMERGENCY_STOP_ACTIVE:
    "Live trading is paused platform-wide. Trades will resume once your operator re-enables it.",
  LIVE_CONFIRMATION_REQUIRED:
    "Your account is approved, but Full Live Activation isn't complete yet. Complete live confirmation, or ask your operator to enable it on your behalf.",
  LIVE_ARMING_PENDING:
    "Live trading isn't armed yet. Arm it from MT5 Setup to execute.",
  SERVER_LIVE_EXECUTION_OFF:
    "Live execution is currently paused for maintenance. It will resume automatically once re-enabled.",
  RISK_PROFILE_INCOMPLETE:
    "Your risk settings are incomplete. Complete them (max lot, daily loss limit, symbols) to continue.",
};

export function mapValidationToUserCopy(v: LiveSharedReasonInput | null | undefined): string | null {
  if (!v) return null;
  if (v.ok === true && v.stage === "preflight_passed") return null;

  // Task #737 follow-up — a SPECIFIC execution-readiness blocker wins with its
  // exact distinct sentence over the generic activation-gate copy below.
  if (v.blockingReasonCode && ACTIVATION_BLOCK_COPY[v.blockingReasonCode])
    return ACTIVATION_BLOCK_COPY[v.blockingReasonCode]!;

  // Concatenate every code-bearing field so a single .includes() pass
  // covers all three envelope shapes. Upper-cased for stable matching.
  const reason = [v.primaryReason, v.reason, v.error]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .join("|")
    .toUpperCase();

  // ── 16-gate dispatch refusals ─────────────────────────────────────────
  if (reason.includes("LIVE_BROKER_EXECUTION_DISABLED") || reason.includes("MASTER_SWITCH"))
    return "Live trading is not armed on the server yet. Contact your operator.";
  if (reason.includes("USER_NOT_ARMED") || reason.includes("NOT_ARMED"))
    return "Your account is not armed for live trading. Arm it from MT5 Setup.";
  if (reason.includes("KILL_SWITCH"))
    return "The emergency kill switch is on. New live trades are blocked.";
  if (reason.includes("HEARTBEAT") || reason.includes("BRIDGE_STALE"))
    return "The MT5 bridge isn't reporting fresh data. Reattach the EA on a chart and try again.";
  if (reason.includes("EA_VERSION"))
    return "The MT5 EA is below the required version. Update the EA to v1.27 or newer.";
  if (reason.includes("READ_ONLY"))
    return "The MT5 EA is in read-only mode. In MT5 → EA → Inputs, set ReadOnlyMode=false.";
  if (reason.includes("ENABLE_LIVE_EXECUTION") || reason.includes("LIVE_EXECUTION_OFF"))
    return "Live execution is turned off on the EA. In MT5 → EA → Inputs, set EnableLiveExecution=true.";
  if (reason.includes("TERMINAL_NOT_CONNECTED") || reason.includes("TERMINAL_DISCONNECTED"))
    return "MT5 terminal isn't connected to the broker. Reconnect MT5 and try again.";
  if (reason.includes("ALGO_TRADING"))
    return "Algorithmic trading is disabled in MT5. Enable AutoTrading and try again.";
  if (reason.includes("ACCOUNT_TYPE") || reason.includes("NOT_LIVE_ACCOUNT"))
    return "The connected MT5 account isn't a live account. Connect a live account first.";

  // ── createLiveDraft preflight refusals ────────────────────────────────
  // SYNTHETIC_FEED_NOT_LIVE_CONFIRMED first (transient feed state) — it must
  // not be mistaken for the permanent data-only floor below. (Distinct token:
  // "NOT_LIVE_CONFIRMED" never contains "NOT_LIVE_TRADABLE".)
  if (reason.includes("SYNTHETIC_FEED_NOT_LIVE_CONFIRMED") || reason.includes("NOT_LIVE_CONFIRMED"))
    return "This synthetic isn't live-confirmed yet — its price feed isn't ticking right now. Wait for the live feed to resume and try again.";
  // Data-sufficiency floor (Phase 2 live-entry) — not enough confirmed live
  // history yet to open a NEW entry. Distinct token from the synthetic feed
  // refusal above; NEW entry only (close/modify of a position is unaffected).
  if (reason.includes("INSUFFICIENT_DATA_FOR_ENTRY"))
    return "There isn't enough confirmed live market data for this symbol yet to open a new trade. Wait for the live feed to build a little more history and try again.";
  // SYMBOL_NOT_LIVE_TRADABLE next — it contains SYMBOL but NOT ALLOW, so
  // the looser "SYMBOL && ALLOW" branch below would never match it.
  if (reason.includes("SYMBOL_NOT_LIVE_TRADABLE") || reason.includes("NOT_LIVE_TRADABLE"))
    return "This symbol can't be traded live — its price feed isn't routable to the broker. Pick a different symbol.";
  if ((reason.includes("SYMBOL") && reason.includes("ALLOW")) || reason.includes("SYMBOL_NOT_ALLOWED"))
    return "This symbol isn't on your allowed list. Ask your operator to add it.";
  if (reason.includes("MAX_LOT") || reason.includes("VOLUME_EXCEEDS") || reason.includes("VOLUME_OVER"))
    return "The requested lot size exceeds your per-symbol limit. Reduce the volume.";
  if (reason.includes("DAILY_LOSS"))
    return "Your daily loss cap has been reached. New live trades are blocked for today.";
  if (reason.includes("MISSING_STOP_LOSS") || reason.includes("STOP_LOSS_REQUIRED") || reason.includes("SL_REQUIRED"))
    return "Stop loss required for this account. Set one and try again.";
  if (reason.includes("STOP_LOSS_WRONG_SIDE"))
    return "Stop loss is on the wrong side of price. For a BUY, place SL below entry; for a SELL, place SL above entry.";
  if (reason.includes("STOP_LOSS_UNREASONABLE"))
    return "Stop loss looks like a pip/price typo — it's far enough from price that it would either fire instantly or never. Re-check the SL value.";
  if (reason.includes("MISSING_TAKE_PROFIT") || reason.includes("TAKE_PROFIT_REQUIRED") || reason.includes("TP_REQUIRED"))
    return "Take profit required for this account. Set one and try again.";
  if (reason.includes("MISSING_RISK_TEMPLATE") || reason.includes("RISK_TEMPLATE"))
    return "Risk settings required. Ask your operator to assign a risk template.";
  if (reason.includes("NO_ACTIVE_BRIDGE") || reason.includes("BRIDGE_NOT_CONNECTED"))
    return "Live bridge is not connected. Attach the MT5 EA on a chart and try again.";

  // ── Shared-routing precondition refusals (HTTP 409) ───────────────────
  if (
    reason.includes("ROUTING_NOT_RESOLVED")
    || reason.includes("ROUTING_NOT_SHARED_MASTER")
    || reason.includes("SHARED_ROUTING_MISSING_IDS")
    || reason.includes("ROUTING_RESOLUTION_FAILED")
    || reason.includes("VIRTUAL_ACCOUNT")
    || reason.includes("SHARED_ROUTING")
    || reason.includes("ROUTING")
  )
    return "Your account isn't set up for the shared live route yet. Contact your operator to complete account allocation.";

  // ── Allocation freeze (Phase ALLOC) ───────────────────────────────────
  if (reason.includes("FROZEN") || reason.includes("ALLOCATION_FROZEN") || reason.includes("TRADING_FROZEN"))
    return "Your account is frozen. New live trades are blocked. Contact your operator.";
  if (reason.includes("ALLOCATION") || reason.includes("USER_SLOT"))
    return "Account allocation required. Contact your operator to allocate a live slot.";

  // ── Input validation (HTTP 400) ───────────────────────────────────────
  if (reason.includes("SYMBOL_REQUIRED"))
    return "Pick a symbol before validating.";
  if (reason.includes("VOLUME_REQUIRED"))
    return "Set a trade volume (lots) before validating.";
  if (reason.includes("INVALID_COMMAND_TYPE") || reason.includes("INVALID_SIDE"))
    return "The trade ticket is missing a required field. Refresh the page and try again.";

  // ── Idempotency, confirmation, auth, generic safety ───────────────────
  if (reason.includes("DUPLICATE_LIVE_IDEMPOTENCY"))
    return "An identical trade was just submitted. Wait a moment before trying again.";
  if (reason.includes("CONFIRMATION_INTENT_MISMATCH"))
    return "Confirmation didn't match. Try the trade again.";
  if (reason.includes("AUTH_REQUIRED") || reason.includes("UNAUTHORIZED"))
    return "Your session expired. Sign in again and reopen the trade ticket.";
  if (reason.includes("PREVIEW") || reason.includes("PREVIEWING_AS_USER"))
    return "Preview mode only — exit user preview to validate trades.";

  // ── Task #737 — additive live-execution activation gate + eligibility ──
  if (reason.includes("BOT_AGENT_NOT_ALLOWED"))
    return "Automated, agent, and system accounts are not eligible for live execution.";
  if (reason.includes("INVESTOR_NOT_ALLOWED"))
    return "Investor accounts are view-only and cannot place or manage trades.";
  if (reason.includes("LIVE_EXECUTION_ACTIVATION_GATE"))
    return "Live execution isn't activated for your account yet. Complete live confirmation, or ask your operator to enable Full Live Activation.";

  // ── Final fallback: surface the exact failing gate name in plain
  // English so the operator knows what to fix instead of seeing the
  // generic "Trade blocked by safety checks" dead-end. We humanise the
  // gate key (UPPER_SNAKE → lower words) — no raw envelope tokens,
  // no JSON, no route names, no flag identifiers leak through.
  const gateMatch = reason.match(/LIVE_BLOCKED:([A-Z][A-Z0-9_]*)/);
  if (gateMatch) {
    const human = gateMatch[1].toLowerCase().replace(/_/g, " ");
    return `Trade blocked by safety check: ${human}. Adjust the trade or contact your operator.`;
  }
  return "Trade blocked by safety checks. Adjust the trade or contact your operator.";
}

// Forbidden token list — raw internals that must NEVER appear in any
// user-facing sentence produced by the mapper. Exported so regression
// tests can assert the mapper output is clean for every known gate code.
export const FORBIDDEN_USER_COPY_TOKENS: readonly string[] = [
  "primaryReason",
  "blockReasons",
  "defaultDeny",
  "liveExecutionDefaultDeny",
  "liveBrokerExecutionEnabled",
  "VIRTUAL_ACCOUNT_ACTIVE",
  "LIVE_BLOCKED",
  "Stage",
  "masterSwitch",
  "/api/",
  "evaluateLivePhaseBDispatchGate",
  "phase_b_live_runtime_gated",
];
