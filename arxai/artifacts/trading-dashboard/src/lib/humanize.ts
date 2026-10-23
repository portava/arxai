// Shared humanization helpers — turn raw backend codes into plain English
// for end-user surfaces. The raw code is preserved separately so power
// users / support can still see it as a small technical subtext.
//
// IMPORTANT: this file is presentation-only. It must never:
//  - change the meaning of a safety gate
//  - hide a refusal as a success
//  - relax any guard
// All server gates remain enforced. We only translate the label.

export interface HumanizedReason {
  /** Short, friendly headline shown as the primary label. */
  title: string;
  /** One-sentence plain-English explanation. */
  description: string;
  /** The original backend code, preserved verbatim for support / debugging. */
  technicalCode: string | null;
  /** Severity tier so callers can pick a color. */
  severity: "info" | "warning" | "blocked" | "error";
  /**
   * Which kind of gate produced this block. Drives the "Blocked by …"
   * framing and the owner/admin details section:
   *   BROKER     — broker/MT5 truth (lot, margin, retcode, symbol tradability)
   *   TECHNICAL  — connectivity/state (bridge down, stale quote, terminal off)
   *   GOVERNANCE — admin-configurable rule (SL required, max lot, allowlist)
   *   SECURITY   — auth / approval / isolation
   *   LEGACY     — hardcoded blocker that should move to Governance
   *   UNKNOWN    — could not be classified (still safe to show generic copy)
   * `changeableInGovernance` is true only for GOVERNANCE-class blocks, so the
   * UI can tell an owner "you can turn this off in Risk/Governance".
   */
  category: "BROKER" | "TECHNICAL" | "GOVERNANCE" | "SECURITY" | "LEGACY" | "UNKNOWN";
  changeableInGovernance: boolean;
}

// Classify a raw reason code into a gate category. Pure string mapping — no
// behavior change, only labelling for honest, specific block messages.
const CATEGORY_BY_CODE: Record<string, HumanizedReason["category"]> = {
  // ── BROKER / MT5 truth ───────────────────────────────────────────────
  LOT_EXCEEDS_MAX: "BROKER", VOLUME_ABOVE_MAX: "BROKER", VOLUME_BELOW_MIN: "BROKER",
  VOLUME_OFF_STEP: "BROKER", SYMBOL_NOT_TRADABLE: "BROKER", SYMBOL_NOT_LIVE_TRADABLE: "BROKER",
  STOP_LOSS_TOO_CLOSE: "BROKER", TAKE_PROFIT_TOO_CLOSE: "BROKER", STOP_INSIDE_FREEZE: "BROKER",
  DEVIATION_TOO_LARGE: "BROKER", SPREAD_TOO_WIDE: "BROKER", NO_PRICES: "BROKER",
  QUOTE_STALE: "BROKER", MARKET_CLOSED: "BROKER", INVALID_TICKET: "BROKER",
  EA_REJECTED_NO_DETAIL: "BROKER",
  // ── TECHNICAL / connectivity ─────────────────────────────────────────
  TERMINAL_NOT_CONNECTED: "TECHNICAL", HEARTBEAT_STALE: "TECHNICAL",
  EA_VERSION_TOO_OLD: "TECHNICAL", EA_LIVE_EXECUTION_DISABLED: "TECHNICAL",
  ALGO_TRADING_DISABLED: "TECHNICAL", NETWORK_ERROR: "TECHNICAL",
  BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED: "TECHNICAL",
  SYNTHETIC_FEED_NOT_LIVE_CONFIRMED: "TECHNICAL",
  SYMBOL_NOT_IN_ARX_FOCUS: "TECHNICAL",
  INSUFFICIENT_DATA_FOR_ENTRY: "TECHNICAL",
  // ── GOVERNANCE / admin-configurable ──────────────────────────────────
  STOP_LOSS_REQUIRED: "GOVERNANCE", SYMBOL_NOT_ALLOWED: "GOVERNANCE",
  DAILY_LOSS_CAP_HIT: "GOVERNANCE", EXPOSURE_CAP_EXCEEDED: "GOVERNANCE",
  SYMBOL_COOLDOWN_ACTIVE: "GOVERNANCE", LIVE_ONE_CLICK_DISABLED: "GOVERNANCE",
  USER_SUBMIT_RATE_LIMITED: "GOVERNANCE",
  // ── SECURITY / auth / approval / isolation ───────────────────────────
  AUTH_REQUIRED: "SECURITY", ACCOUNT_NOT_LIVE: "SECURITY",
  ADMIN_APPROVAL_REQUIRED: "SECURITY", USER_NOT_ARMED_FOR_LIVE: "SECURITY",
  MASTER_LIVE_USER_ACCESS_BLOCKED: "SECURITY", KILL_SWITCH_ENGAGED: "SECURITY",
  GLOBAL_LIVE_KILLED: "SECURITY", LIVE_BROKER_EXECUTION_DISABLED: "SECURITY",
  REJECTED_READ_ONLY_MODE_ACTIVE: "SECURITY", ALLOCATION_FROZEN: "SECURITY",
  DUPLICATE_LIVE_IDEMPOTENCY_KEY: "SECURITY",
  // ── Command integrity (AACI Security Phase 3) ────────────────────────
  INTEGRITY_PAYLOAD_MISSING: "SECURITY", INTEGRITY_PAYLOAD_MISMATCH: "SECURITY",
  INTEGRITY_SIGNATURE_MISSING: "SECURITY", INTEGRITY_SIGNATURE_MISMATCH: "SECURITY",
  INTEGRITY_ROUTE_NOT_ALLOWED: "SECURITY", INTEGRITY_DECISION_MISMATCH: "SECURITY",
  INTEGRITY_ACTOR_INVALID: "SECURITY", INTEGRITY_EXPIRED: "SECURITY",
  // ── Allocation (governance-adjacent but enforced) ────────────────────
  INSUFFICIENT_ALLOCATION: "GOVERNANCE", ALLOCATION_UNAVAILABLE: "TECHNICAL",
  // ── Shared master-pool pre-gate (runs before the 16 dispatch gates) ──
  // Transient bridge/snapshot/pool-reconciliation states are TECHNICAL (no
  // governance toggle changes them); per-user allocation shortfalls mirror
  // INSUFFICIENT_ALLOCATION as GOVERNANCE (operator adjusts the allocation).
  MASTER_BRIDGE_NOT_PINNED: "TECHNICAL", MASTER_SNAPSHOT_MISSING: "TECHNICAL",
  MASTER_SNAPSHOT_STALE: "TECHNICAL", SHARED_LIVE_PAUSED: "TECHNICAL",
  POOL_OVER_ALLOCATED: "TECHNICAL", USER_ALLOCATION_NOT_ASSIGNED: "GOVERNANCE",
  USER_ALLOCATION_EXHAUSTED: "GOVERNANCE",
  ALLOCATION_EXCEEDS_MASTER_AVAILABLE: "GOVERNANCE",
  // ── Live dispatch-gate codes (exact strings from livePhaseBDispatchGate) ──
  USER_NOT_LIVE_APPROVED: "SECURITY", GLOBAL_LIVE_DISABLED: "SECURITY",
  BRIDGE_NOT_LIVE_ACCOUNT: "SECURITY", DISCLOSURE_NOT_ACCEPTED: "SECURITY",
  EA_HEARTBEAT_STALE: "TECHNICAL", EA_ENABLE_LIVE_EXECUTION_FALSE: "TECHNICAL",
  EA_READ_ONLY_MODE_TRUE: "TECHNICAL", EA_TERMINAL_NOT_CONNECTED: "TECHNICAL",
  EA_ALGO_TRADING_NOT_ALLOWED: "TECHNICAL",
  // ── Shared-master live bridge gate (runs before the 16 gates) ─────────
  MASTER_BRIDGE_NOT_LIVE_CAPABLE: "TECHNICAL", MASTER_BRIDGE_HEARTBEAT_STALE: "TECHNICAL",
  MASTER_BRIDGE_REAL_HEARTBEAT_REQUIRED: "TECHNICAL", MASTER_LIVE_REQUIRES_REAL_BRIDGE: "TECHNICAL",
  MASTER_BRIDGE_EA_VERSION_TOO_OLD: "TECHNICAL", BRIDGE_BINDING_MISMATCH: "TECHNICAL",
  MASTER_BRIDGE_NOT_CONFIGURED: "GOVERNANCE", MASTER_BRIDGE_LIVE_NOT_ENABLED: "GOVERNANCE",
  SHARED_LIVE_TRADING_DISABLED: "GOVERNANCE", NO_BRIDGE_REGISTERED: "TECHNICAL",
  VOLUME_EXCEEDS_MAX_LIVE_LOT: "GOVERNANCE", VOLUME_EXCEEDS_USER_MAX_LOT: "GOVERNANCE",
  VOLUME_EXCEEDS_MARKET_MAX_LOT: "GOVERNANCE", DAILY_LOSS_LIMIT_REACHED: "GOVERNANCE",
  MISSING_STOP_LOSS: "GOVERNANCE", MISSING_TAKE_PROFIT: "GOVERNANCE",
  // ── Task #737 — additive live-execution activation gate + eligibility ──
  LIVE_EXECUTION_ACTIVATION_GATE: "SECURITY",
  BOT_AGENT_NOT_ALLOWED: "SECURITY", INVESTOR_NOT_ALLOWED: "SECURITY",
  // ── One-click LIVE enable master-live access gate (meOneClick.ts) ──────
  LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS: "SECURITY",
  RUBY_TRADING_REQUIRES_MASTER_LIVE_ACCESS: "SECURITY",
  MASTER_LIVE_USER_ACCESS_REQUIRED: "SECURITY",
};

export function categorizeReason(code: string | null | undefined): HumanizedReason["category"] {
  if (!code) return "UNKNOWN";
  // exact match first
  if (CATEGORY_BY_CODE[code]) return CATEGORY_BY_CODE[code]!;
  // strip a LIVE_BLOCKED: envelope and retry
  const m = code.match(/^LIVE_BLOCKED:([A-Z0-9_]+)/);
  if (m && CATEGORY_BY_CODE[m[1]!]) return CATEGORY_BY_CODE[m[1]!]!;
  // token scan
  for (const k of Object.keys(CATEGORY_BY_CODE)) if (code.includes(k)) return CATEGORY_BY_CODE[k]!;
  // broker retcodes look like MT5:<num> or contain 'retcode'
  if (/retcode|MT5:\d+|broker/i.test(code)) return "BROKER";
  return "UNKNOWN";
}

const CATEGORY_LABEL: Record<HumanizedReason["category"], string> = {
  BROKER: "Blocked by Broker", TECHNICAL: "Blocked", GOVERNANCE: "Blocked by Governance",
  SECURITY: "Blocked", LEGACY: "Blocked", UNKNOWN: "Order was blocked by a safety gate",
};

// Friendly copy for the most common live-pipeline / safety / EA codes the
// user can encounter. Keep entries terse; the description is the actual
// sentence shown.
const REASON_MAP: Record<string, Omit<HumanizedReason, "technicalCode" | "category" | "changeableInGovernance">> = {
  // ── Live dispatch-gate codes (exact strings from livePhaseBDispatchGate) ──
  // Keep these in sync with the EA-result-code siblings below so the exact gate
  // that refused gets precise copy in humanizeReason() paths too (not just the
  // structuredRejection override used by RejectionDisplay).
  SYMBOL_NOT_IN_ARX_FOCUS: {
    title: "Market not in ARX focus list",
    description: "This market is outside the active ARX approved market universe, so a new live entry is refused. You can still close or modify an existing position on it.",
    severity: "blocked",
  },
  USER_NOT_LIVE_APPROVED: {
    title: "Waiting on admin approval",
    description: "Your account isn't approved for live trading yet. An admin needs to approve it before you can dispatch a live order.",
    severity: "blocked",
  },
  GLOBAL_LIVE_DISABLED: {
    title: "Global live trading is off",
    description: "Live trading has been globally turned off. All live orders are refused until it's turned back on.",
    severity: "blocked",
  },
  BRIDGE_NOT_LIVE_ACCOUNT: {
    title: "MT5 account is not a live account",
    description: "The connected MT5 account is a demo or contest account. Connect a real-money account to dispatch live orders.",
    severity: "blocked",
  },
  EA_HEARTBEAT_STALE: {
    title: "MT5 bridge is offline",
    description: "We haven't heard from your MT5 bridge in over 15 seconds. Make sure MetaTrader 5 is open and the EA is attached.",
    severity: "warning",
  },
  EA_ENABLE_LIVE_EXECUTION_FALSE: {
    title: "Live execution is off in MT5",
    description: "Open MT5 → EA inputs and set EnableLiveExecution = true.",
    severity: "warning",
  },
  EA_READ_ONLY_MODE_TRUE: {
    title: "MT5 EA is in read-only mode",
    description: "Open MT5 → EA inputs and set ReadOnlyMode = false to allow order dispatch.",
    severity: "warning",
  },
  EA_TERMINAL_NOT_CONNECTED: {
    title: "MT5 terminal is not connected to the broker",
    description: "MetaTrader 5 lost its broker connection. Check your internet and try reconnecting in MT5.",
    severity: "warning",
  },
  EA_ALGO_TRADING_NOT_ALLOWED: {
    title: "Algo trading is off in MT5",
    description: "Click the AutoTrading button in MetaTrader 5 to allow the EA to place orders.",
    severity: "warning",
  },
  VOLUME_EXCEEDS_MAX_LIVE_LOT: {
    title: "Lot size above your live limit",
    description: "This lot size exceeds your per-symbol live maximum. Reduce the lot, or ask an admin to raise the cap.",
    severity: "warning",
  },
  VOLUME_EXCEEDS_USER_MAX_LOT: {
    title: "Lot size above your armed maximum",
    description: "This lot size exceeds the maximum you confirmed when you armed live trading. Reduce the lot, or re-arm with a higher confirmed max in Live Trading Setup.",
    severity: "warning",
  },
  VOLUME_EXCEEDS_MARKET_MAX_LOT: {
    title: "Lot size above the market maximum",
    description: "This lot size exceeds the configured maximum for this market. Reduce the lot, or ask an admin to raise the cap.",
    severity: "warning",
  },
  DAILY_LOSS_LIMIT_REACHED: {
    title: "Daily loss limit reached",
    description: "Your realised and floating loss has hit the daily cap. Live orders are paused until it resets.",
    severity: "blocked",
  },
  MISSING_STOP_LOSS: {
    title: "Stop-loss required",
    description: "Live orders require a stop-loss. Set an SL price and resubmit.",
    severity: "warning",
  },
  MISSING_TAKE_PROFIT: {
    title: "Take-profit required",
    description: "A take-profit is required for live orders on your account. Set a TP price and resubmit.",
    severity: "warning",
  },
  DISCLOSURE_NOT_ACCEPTED: {
    title: "Risk disclosure not accepted",
    description: "Open Live Trading Setup and accept the live risk disclosure before placing a live order.",
    severity: "blocked",
  },
  // ── Task #737 — additive live-execution activation gate + eligibility ──
  LIVE_EXECUTION_ACTIVATION_GATE: {
    title: "Live execution not activated",
    description: "Live execution isn't activated for your account yet. Complete live confirmation, or ask your operator to enable Full Live Activation on your behalf.",
    severity: "blocked",
  },
  BOT_AGENT_NOT_ALLOWED: {
    title: "Account type not eligible for live",
    description: "Automated, agent, and system accounts are not eligible for live execution.",
    severity: "blocked",
  },
  INVESTOR_NOT_ALLOWED: {
    title: "Investor accounts are view-only",
    description: "Investor accounts can view performance but cannot place or manage trades.",
    severity: "blocked",
  },
  // ── Shared-master live bridge gate (runs before the 16 gates) ──
  MASTER_BRIDGE_NOT_LIVE_CAPABLE: {
    title: "Master bridge isn't live-ready",
    description: "The shared master MT5 bridge hasn't reported that its terminal is connected, AutoTrading is on, and live execution is enabled. Check the master terminal's EA inputs and AutoTrading button.",
    severity: "blocked",
  },
  MASTER_BRIDGE_HEARTBEAT_STALE: {
    title: "Master bridge is offline",
    description: "The shared master MT5 bridge hasn't sent a heartbeat recently. Make sure the master MetaTrader 5 terminal is open with the EA attached and running.",
    severity: "blocked",
  },
  MASTER_BRIDGE_REAL_HEARTBEAT_REQUIRED: {
    title: "Master bridge is offline",
    description: "The shared master MT5 bridge hasn't sent a recent live heartbeat. Make sure the master terminal is open and connected.",
    severity: "blocked",
  },
  MASTER_LIVE_REQUIRES_REAL_BRIDGE: {
    title: "Master account is not a live account",
    description: "The shared master MT5 bridge is bound to a demo/contest account. A real-money master account is required for shared-live trading.",
    severity: "blocked",
  },
  MASTER_BRIDGE_EA_VERSION_TOO_OLD: {
    title: "Master bridge EA needs updating",
    description: "The shared master MT5 bridge is running an EA older than v1.27. Update the master terminal's Expert Advisor.",
    severity: "blocked",
  },
  BRIDGE_BINDING_MISMATCH: {
    title: "Bridge binding mismatch",
    description: "The configured platform master bridge doesn't match the connected bridge. An admin needs to re-check the master bridge binding.",
    severity: "blocked",
  },
  MASTER_BRIDGE_NOT_CONFIGURED: {
    title: "No master bridge configured",
    description: "Shared-live trading has no platform master bridge configured yet. An admin needs to bind one before live orders can route.",
    severity: "blocked",
  },
  MASTER_BRIDGE_LIVE_NOT_ENABLED: {
    title: "Master bridge live is off",
    description: "Live execution on the shared master bridge is turned off. An admin needs to enable it before live orders can route.",
    severity: "blocked",
  },
  SHARED_LIVE_TRADING_DISABLED: {
    title: "Shared-live trading is off",
    description: "Shared-live trading is currently disabled platform-wide. An admin needs to enable it.",
    severity: "blocked",
  },
  NO_BRIDGE_REGISTERED: {
    title: "No MT5 bridge registered",
    description: "No MT5 bridge is registered for routing. Make sure the master terminal is connected with the EA attached.",
    severity: "blocked",
  },
  // Phase B — live broker dispatch gate (16 gates)
  LIVE_BROKER_EXECUTION_DISABLED: {
    title: "Live trading is paused",
    description: "Live broker dispatch is currently switched off on the server. Demo trading still works.",
    severity: "blocked",
  },
  BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED: {
    title: "Live trading is paused",
    description: "The live broker placement layer is intentionally locked in this build. No real-money order can be placed yet.",
    severity: "blocked",
  },
  USER_NOT_ARMED_FOR_LIVE: {
    title: "You haven't armed live trading yet",
    description: "Open Live Trading Setup and pass the readiness gate before sending a live order.",
    severity: "warning",
  },
  ADMIN_APPROVAL_REQUIRED: {
    title: "Waiting on admin approval",
    description: "Your account isn't approved for live trading yet. An admin needs to approve it before you can dispatch a live order.",
    severity: "blocked",
  },
  GLOBAL_LIVE_KILLED: {
    title: "Global live trading is off",
    description: "Live trading has been globally killed. All live orders are refused until it's turned back on.",
    severity: "blocked",
  },
  KILL_SWITCH_ENGAGED: {
    title: "Kill switch is engaged",
    description: "Your kill switch is on. Disengage it on the Live Trading page to send orders.",
    severity: "blocked",
  },
  ACCOUNT_NOT_LIVE: {
    title: "MT5 account is not a live account",
    description: "The connected MT5 account is a demo or contest account. Connect a real-money account to dispatch live orders.",
    severity: "blocked",
  },
  HEARTBEAT_STALE: {
    title: "MT5 bridge is offline",
    description: "We haven't heard from your MT5 bridge in over 15 seconds. Make sure MetaTrader 5 is open and the EA is attached.",
    severity: "warning",
  },
  EA_VERSION_TOO_OLD: {
    title: "MT5 EA needs updating",
    description: "Your MT5 Expert Advisor is on an older version. Install EA v1.27 or newer.",
    severity: "warning",
  },
  EA_LIVE_EXECUTION_DISABLED: {
    title: "Live execution is off in MT5",
    description: "Open MT5 → EA inputs and set EnableLiveExecution = true.",
    severity: "warning",
  },
  REJECTED_READ_ONLY_MODE_ACTIVE: {
    title: "MT5 EA is in read-only mode",
    description: "Open MT5 → EA inputs and set ReadOnlyMode = false to allow order dispatch.",
    severity: "warning",
  },
  TERMINAL_NOT_CONNECTED: {
    title: "MT5 terminal is not connected to the broker",
    description: "MetaTrader 5 lost its broker connection. Check your internet and try reconnecting in MT5.",
    severity: "warning",
  },
  ALGO_TRADING_DISABLED: {
    title: "Algo trading is off in MT5",
    description: "Click the AutoTrading button in MetaTrader 5 to allow the EA to place orders.",
    severity: "warning",
  },
  SYMBOL_NOT_ALLOWED: {
    title: "Symbol isn't on your allowlist",
    description: "Add this symbol to your live trading allowlist before sending an order on it.",
    severity: "blocked",
  },
  LOT_EXCEEDS_MAX: {
    title: "Lot size is too large",
    description: "The requested volume is above your per-symbol max lot. Reduce the lot size and try again.",
    severity: "warning",
  },
  DAILY_LOSS_CAP_HIT: {
    title: "Daily loss cap reached",
    description: "Your daily loss limit (realised + open floating) is at or above the cap. No more live orders today.",
    severity: "blocked",
  },
  STOP_LOSS_REQUIRED: {
    title: "Stop loss is required",
    description: "Set a stop loss on the order before sending it live.",
    severity: "warning",
  },

  // Pipeline-level
  DUPLICATE_LIVE_IDEMPOTENCY_KEY: {
    title: "Looks like a duplicate order",
    description: "An identical order was just submitted. Wait a minute or change one parameter before resending.",
    severity: "warning",
  },
  // ── Command integrity (AACI Security Phase 3) — tamper/replay/staleness ──
  // The block reason is intentionally generic to the user: it never names the
  // specific integrity check that tripped. EXPIRED is benign (re-submit);
  // every other integrity reason is a verification failure (blocked for safety).
  INTEGRITY_PAYLOAD_MISSING: {
    title: "Trade request couldn't be verified",
    description: "This trade request couldn't be verified and was blocked for your safety. Please review the trade and submit it again.",
    severity: "blocked",
  },
  INTEGRITY_PAYLOAD_MISMATCH: {
    title: "Trade request couldn't be verified",
    description: "This trade request couldn't be verified and was blocked for your safety. Please review the trade and submit it again.",
    severity: "blocked",
  },
  INTEGRITY_SIGNATURE_MISSING: {
    title: "Trade request couldn't be verified",
    description: "This trade request couldn't be verified and was blocked for your safety. Please review the trade and submit it again.",
    severity: "blocked",
  },
  INTEGRITY_SIGNATURE_MISMATCH: {
    title: "Trade request couldn't be verified",
    description: "This trade request couldn't be verified and was blocked for your safety. Please review the trade and submit it again.",
    severity: "blocked",
  },
  INTEGRITY_ROUTE_NOT_ALLOWED: {
    title: "Trade request couldn't be verified",
    description: "This trade request couldn't be verified and was blocked for your safety. Please review the trade and submit it again.",
    severity: "blocked",
  },
  INTEGRITY_DECISION_MISMATCH: {
    title: "Trade request couldn't be verified",
    description: "This trade request couldn't be verified and was blocked for your safety. Please review the trade and submit it again.",
    severity: "blocked",
  },
  INTEGRITY_ACTOR_INVALID: {
    title: "Trade request couldn't be verified",
    description: "This trade request couldn't be verified and was blocked for your safety. Please review the trade and submit it again.",
    severity: "blocked",
  },
  INTEGRITY_EXPIRED: {
    title: "Trade request expired",
    description: "This trade request has expired. Please review the trade and submit it again.",
    severity: "warning",
  },
  USER_SUBMIT_RATE_LIMITED: {
    title: "You're submitting too quickly",
    description: "Slow down a bit between live orders.",
    severity: "warning",
  },
  SYMBOL_COOLDOWN_ACTIVE: {
    title: "Symbol is in cooldown",
    description: "You've recently traded this symbol. Wait for the cooldown to end before sending another live order on it.",
    severity: "warning",
  },
  EXPOSURE_CAP_EXCEEDED: {
    title: "Exposure cap reached",
    description: "This order would push your open exposure above the cap. Close existing positions or reduce the size.",
    severity: "warning",
  },
  LIVE_ONE_CLICK_DISABLED: {
    title: "ARX Single Confirm (live) is off",
    description:
      "This is an ARX app setting — separate from your MT5 terminal's One Click Trading checkbox (which ARX cannot read and does not require). Turn on Single Confirm for LIVE in MT5 Setup → One-Click Trade to place live orders straight from the chart. Every safety gate still runs.",
    severity: "info",
  },
  MASTER_LIVE_USER_ACCESS_BLOCKED: {
    title: "Live trading access is restricted",
    description: "Your account doesn't currently have access to live trading. Contact an admin.",
    severity: "blocked",
  },
  // One-click LIVE enable gate (meOneClick.ts PUT 403). Turning on live
  // one-click first needs master-live access; the toggle never bypasses it.
  LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS: {
    title: "Live trading access required",
    description: "Live one-click needs live-trading access first. Ask an admin to approve live trading for your account, then turn this on.",
    severity: "blocked",
  },
  MASTER_LIVE_USER_ACCESS_REQUIRED: {
    title: "Live trading access required",
    description: "You need live-trading access before you can enable this. Ask an admin to approve live trading for your account.",
    severity: "blocked",
  },
  RUBY_TRADING_REQUIRES_MASTER_LIVE_ACCESS: {
    title: "Live trading access required",
    description: "Letting the assistant trade live needs live-trading access first. Ask an admin to approve live trading for your account.",
    severity: "blocked",
  },

  // Auth / network
  AUTH_REQUIRED: {
    title: "Please sign in",
    description: "You need to be signed in to do that.",
    severity: "info",
  },
  NETWORK_ERROR: {
    title: "Connection issue",
    description: "Couldn't reach the server. Check your connection and try again.",
    severity: "warning",
  },
  INVALID_TICKET: {
    title: "Order ticket couldn't be parsed",
    description: "Something in the order details was malformed. Double-check the symbol, lot size, and price levels.",
    severity: "error",
  },

  // Symbol tradability (ARX floor — synthetic / data-only markets)
  SYMBOL_NOT_LIVE_TRADABLE: {
    title: "This market can't be traded live here",
    description: "This is a data-only market for analysis. Live execution isn't available through the connected MT5 bridge, so no order was sent.",
    severity: "blocked",
  },

  // Synthetic per-symbol live confirmation (Task #542 live-entry floor) —
  // transient: the synthetic is tradable, but its feed isn't ticking right now.
  SYNTHETIC_FEED_NOT_LIVE_CONFIRMED: {
    title: "This synthetic isn't live-confirmed yet",
    description: "Its price feed isn't ticking right now, so a live entry would be based on a stale read. Wait for the live feed to resume and try again. No order was sent.",
    severity: "blocked",
  },

  // Data-sufficiency floor (Phase 2 live-entry) — not enough confirmed live
  // closed candles yet to open a NEW entry. Block-only; never grants.
  INSUFFICIENT_DATA_FOR_ENTRY: {
    title: "Not enough live market data yet",
    description: "There isn't enough confirmed live history for this symbol to open a new trade safely. Wait for the live feed to build a few more closed candles and try again. No order was sent.",
    severity: "blocked",
  },

  // EA / broker-side rejection (order reached MT5 but was refused)
  EA_REJECTED_NO_DETAIL: {
    title: "Your broker refused the order",
    description: "The order reached MT5 but the broker rejected it without a reason. This usually means the exact symbol isn't in your MT5 Market Watch, or the market is closed. Nothing was placed.",
    severity: "blocked",
  },

  // Broker pre-trade guard (real broker symbol rules)
  QUOTE_STALE: {
    title: "No fresh price from the broker",
    description: "The latest quote for this symbol is too old to trade on safely. Wait for prices to update and try again.",
    severity: "warning",
  },
  NO_PRICES: {
    title: "Broker isn't quoting this symbol",
    description: "The broker is returning no bid/ask for this market right now (often outside trading hours). No order was sent.",
    severity: "blocked",
  },
  SPREAD_TOO_WIDE: {
    title: "Spread is too wide right now",
    description: "The current spread on this symbol is above the safe limit. Wait for it to tighten before sending a live order.",
    severity: "warning",
  },
  MARKET_CLOSED: {
    title: "Market is closed",
    description: "The broker reports this market's session is closed, so the order can't be filled. Try again when it reopens.",
    severity: "blocked",
  },
  SYMBOL_NOT_TRADABLE: {
    title: "Broker has this symbol disabled",
    description: "The broker has trading on this symbol turned off (disabled, close-only, or not visible in Market Watch). No order was sent.",
    severity: "blocked",
  },
  DEVIATION_TOO_LARGE: {
    title: "Price moved too far",
    description: "The market moved past the allowed slippage before the order could go out. Try again at the current price.",
    severity: "warning",
  },
  VOLUME_BELOW_MIN: {
    title: "Lot size is below the broker minimum",
    description: "The requested volume is smaller than the broker's minimum lot for this symbol. Increase the lot size.",
    severity: "warning",
  },
  VOLUME_ABOVE_MAX: {
    title: "Lot size is above the broker maximum",
    description: "The requested volume is larger than the broker's maximum lot for this symbol. Reduce the lot size.",
    severity: "warning",
  },
  VOLUME_OFF_STEP: {
    title: "Lot size isn't a valid step",
    description: "The broker only accepts certain lot increments for this symbol. Round the volume to an allowed step (e.g. 0.01) and try again.",
    severity: "warning",
  },
  STOP_LOSS_TOO_CLOSE: {
    title: "Stop loss is too close to price",
    description: "The broker requires the stop loss to sit a minimum distance from the current price. Move it further away and try again.",
    severity: "warning",
  },
  TAKE_PROFIT_TOO_CLOSE: {
    title: "Take profit is too close to price",
    description: "The broker requires the take profit to sit a minimum distance from the current price. Move it further away and try again.",
    severity: "warning",
  },
  STOP_INSIDE_FREEZE: {
    title: "Stop is inside the broker's freeze zone",
    description: "Your stop loss or take profit is inside the broker's freeze distance from price, so it can't be set. Widen the levels and try again.",
    severity: "warning",
  },

  // Allocation / funding
  ALLOCATION_FROZEN: {
    title: "Your allocation is frozen",
    description: "Live trading on your allocation is currently frozen. No new orders can be opened until it's unfrozen.",
    severity: "blocked",
  },
  ALLOCATION_UNAVAILABLE: {
    title: "No live allocation available",
    description: "You don't have an active live allocation to trade against. Contact an admin to assign one.",
    severity: "blocked",
  },
  INSUFFICIENT_ALLOCATION: {
    title: "Not enough allocation for this order",
    description: "This order needs more margin than your available allocation. Reduce the lot size or free up allocation.",
    severity: "warning",
  },

  // ── Shared master-pool pre-gate (liveCommandPipeline.ts preflight) ───
  // These run before the 16 dispatch gates and previously fell through to
  // the generic "server safety check refused" message. Copy is honest about
  // the transient/operator nature and never implies the order went through.
  POOL_OVER_ALLOCATED: {
    title: "Live pool is being reconciled",
    description: "The shared live bridge allocation is temporarily unavailable while the master balance is being reconciled. No order was sent — try again shortly.",
    severity: "warning",
  },
  USER_ALLOCATION_NOT_ASSIGNED: {
    title: "No live allocation assigned",
    description: "No live allocation has been assigned to your account yet. An operator must assign allocation before you can place a live order.",
    severity: "blocked",
  },
  USER_ALLOCATION_EXHAUSTED: {
    title: "No live allocation available",
    description: "Your available live allocation is 0 — your assigned allocation is fully used by reserved risk and open floating loss. Contact your operator to add funds, or close open positions to free headroom.",
    severity: "blocked",
  },
  ALLOCATION_EXCEEDS_MASTER_AVAILABLE: {
    title: "Allocation exceeds master balance",
    description: "Your assigned live allocation is above the master account balance. Contact your operator — no order was sent.",
    severity: "blocked",
  },
  MASTER_BRIDGE_NOT_PINNED: {
    title: "Live bridge unavailable",
    description: "The shared live bridge isn't available right now, so no order was sent. Try again shortly.",
    severity: "warning",
  },
  MASTER_SNAPSHOT_MISSING: {
    title: "Live bridge data unavailable",
    description: "The shared live bridge hasn't reported account data yet, so no order was sent. Try again shortly.",
    severity: "warning",
  },
  MASTER_SNAPSHOT_STALE: {
    title: "Live bridge data is stale",
    description: "The shared live bridge account data is out of date. Wait for it to refresh, then try again — no order was sent.",
    severity: "warning",
  },
  SHARED_LIVE_PAUSED: {
    title: "Live trading is paused",
    description: "Shared live trading is temporarily paused for reconciliation. No order was sent — try again shortly.",
    severity: "warning",
  },
};

const GENERIC_BLOCKED: Omit<HumanizedReason, "technicalCode" | "category" | "changeableInGovernance"> = {
  title: "Order was blocked by a safety gate",
  description: "A server safety check refused this order. See the technical code below or try again with adjusted settings.",
  severity: "blocked",
};

const GENERIC_UNKNOWN: Omit<HumanizedReason, "technicalCode" | "category" | "changeableInGovernance"> = {
  title: "Something didn't work",
  description: "Please try again. If it keeps happening, contact support with the technical code below.",
  severity: "error",
};

/**
 * Convert a raw backend code (e.g. `LIVE_BLOCKED:USER_NOT_ARMED_FOR_LIVE`)
 * or a free-form server message into a friendly headline + description.
 * The original code is preserved so the UI can render it as a small
 * "Technical: …" subtext for power users / support.
 */
type PartialReason = Omit<HumanizedReason, "category" | "changeableInGovernance">;

function humanizeReasonBase(input: unknown): PartialReason {
  if (input == null) {
    return { ...GENERIC_UNKNOWN, technicalCode: null };
  }
  const raw =
    input instanceof Error ? input.message :
    typeof input === "string" ? input :
    typeof input === "object" && input !== null && "message" in input ? String((input as { message: unknown }).message) :
    String(input);

  if (!raw.trim()) return { ...GENERIC_UNKNOWN, technicalCode: null };

  // Symbol-tradability floor carries the symbol inline, e.g.
  // `SYMBOL_NOT_LIVE_TRADABLE:V75_is_deriv_data_only` (optionally wrapped
  // in a LIVE_BLOCKED: envelope). Name the symbol so the user knows exactly
  // which market was refused, without leaking any internal detail.
  const notTradable = raw.match(/SYMBOL_NOT_LIVE_TRADABLE:([A-Za-z0-9 ()._-]+?)_is_[a-z]+_data_only/);
  if (notTradable) {
    const sym = notTradable[1]!.trim();
    return {
      title: `${sym} can't be traded live here`,
      description: `${sym} is a data-only market for analysis. Live execution isn't available through the connected MT5 bridge, so no order was sent.`,
      technicalCode: raw,
      severity: "blocked",
    };
  }

  // Synthetic per-symbol live-confirmation floor carries the symbol inline,
  // e.g. `SYNTHETIC_FEED_NOT_LIVE_CONFIRMED:V75_no_live_tick`. Name the symbol
  // so the user knows exactly which synthetic isn't ticking, without leaking
  // any internal detail. Transient (awaiting/stale feed), not a permanent block.
  const notLiveConfirmed = raw.match(/SYNTHETIC_FEED_NOT_LIVE_CONFIRMED:([A-Za-z0-9 ()._-]+?)_no_live_tick/);
  if (notLiveConfirmed) {
    const sym = notLiveConfirmed[1]!.trim();
    return {
      title: `${sym} isn't live-confirmed yet`,
      description: `${sym}'s price feed isn't ticking right now, so a live entry would be based on a stale read. Wait for the live feed to resume and try again. No order was sent.`,
      technicalCode: raw,
      severity: "blocked",
    };
  }

  // LIVE_BLOCKED:<GATE> envelope from Phase B pipeline.
  const liveBlocked = raw.match(/^LIVE_BLOCKED:([A-Z0-9_]+)/);
  if (liveBlocked) {
    const gate = liveBlocked[1]!;
    const mapped = REASON_MAP[gate];
    if (mapped) return { ...mapped, technicalCode: raw };
    return { ...GENERIC_BLOCKED, technicalCode: raw };
  }

  // Direct code match (e.g. handlers that return the bare reason).
  const direct = REASON_MAP[raw];
  if (direct) return { ...direct, technicalCode: raw };

  // Token-by-token scan — handler error envelopes sometimes embed a
  // known code inside a longer English message.
  for (const code of Object.keys(REASON_MAP)) {
    if (raw.includes(code)) {
      return { ...REASON_MAP[code]!, technicalCode: code };
    }
  }

  // Network / auth heuristics.
  if (/401|Unauthorized|AUTH_REQUIRED/i.test(raw)) {
    return { ...REASON_MAP.AUTH_REQUIRED!, technicalCode: raw };
  }
  if (/Failed to fetch|NetworkError|TypeError: fetch/i.test(raw)) {
    return { ...REASON_MAP.NETWORK_ERROR!, technicalCode: raw };
  }

  // Looks like a raw stack trace / HTML — never show that to a user.
  if (/<!DOCTYPE|<html|stack|at \w+ \(|node_modules|\/home\/runner/i.test(raw)) {
    return { ...GENERIC_UNKNOWN, technicalCode: "RAW_TRACE_HIDDEN" };
  }

  // Unknown short server message. We deliberately do NOT surface the raw
  // text as the user-facing description (defence-in-depth — backend could
  // change and start emitting something sensitive). Instead, show generic
  // copy and preserve the raw string as a technical subtext for support.
  // Strings that look like tokens / hex / bearer values are extra-redacted.
  if (raw.length <= 180) {
    const looksTokenish = /[A-Fa-f0-9]{32,}|Bearer\s+\S+|sk-[A-Za-z0-9]{16,}/.test(raw);
    return {
      title: "Order refused",
      description: "A server safety check refused this order. See the technical code below if you need to contact support.",
      technicalCode: looksTokenish ? "RAW_TOKENISH_REDACTED" : raw,
      severity: "warning",
    };
  }

  return { ...GENERIC_UNKNOWN, technicalCode: "RAW_TRACE_HIDDEN" };
}

/**
 * Public entry point. Runs the base humanizer, then classifies the block into
 * a gate category (BROKER / TECHNICAL / GOVERNANCE / SECURITY / LEGACY) so the
 * UI can show an exact "Blocked by …" label instead of generic copy, and so an
 * owner/admin can be told whether the block is changeable in Risk/Governance.
 * No behavior change — pure labelling on top of the existing mapping.
 */
export function humanizeReason(input: unknown): HumanizedReason {
  const base = humanizeReasonBase(input);
  const category = categorizeReason(base.technicalCode);
  const changeableInGovernance = category === "GOVERNANCE";
  // If the base fell back to the generic "safety gate" title but we DID manage
  // to classify the category, upgrade the headline to the exact category label
  // so the user no longer sees an unspecific "server safety check refused".
  let title = base.title;
  if (
    category !== "UNKNOWN" &&
    (base.title === "Order was blocked by a safety gate" || base.title === "Order refused")
  ) {
    title = CATEGORY_LABEL[category];
  }
  return { ...base, title, category, changeableInGovernance };
}

/** Convenience — just the friendly description text. */
export function humanize(input: unknown): string {
  return humanizeReason(input).description;
}
