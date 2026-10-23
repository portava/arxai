// T033 Phase 8 — structured live-rejection detail.
//
// Builds ON TOP of humanize.ts (T030), which already gives a clean user-facing
// title/description + category + verbatim technicalCode. Phase 8 adds the two
// things admins need that humanize.ts doesn't carry:
//   1. rejectLayer — WHICH layer refused (frontend / backend-gate / governance /
//      symbol-resolver / EA-preflight / MT5-broker), so an admin instantly knows
//      where to look.
//   2. suggestedFix — the concrete next action, and WHO can take it.
//
// It also fills the user-copy gaps for the live reason codes that surface today
// (MASTER_SNAPSHOT_STALE, BROKER_RULE_SPREAD_TOO_WIDE, the EA/terminal gates,
// the symbol-resolver reasons) so none of them fall through to the generic
// "server safety check refused" message.
//
// SAFETY: pure presentation. No code here changes a gate decision, weakens
// execution, hides a broker reason, or fabricates success. It only maps a raw
// rejection into clearer text + structured admin fields. Unknown codes degrade
// to "No detailed reason reported" with the layer where the trail went cold —
// never to a fake success or a vague catch-all that hides distinct causes.

import { humanizeReason, type HumanizedReason } from "./humanize.js";

export type RejectLayer =
  | "frontend"
  | "backend-gate"
  | "governance"
  | "symbol-resolver"
  | "EA-preflight"
  | "MT5-broker"
  | "unknown";

export type FixableBy = "user" | "admin" | "ea-mt5" | "broker" | "market" | "none";

// MT5 trade-server return-code category. MIRRORS the server's source of truth
// in artifacts/api-server/src/lib/mt5/retcodeMap.ts (classifyRetcode). The
// frontend can't import the server package, so this is a deliberate mirror —
// keep the two in sync. Only the FAILURE categories carry user copy here;
// success codes (10008/10009/10010) never render a rejection.
export type RetcodeCategory =
  | "rejected_by_broker"
  | "invalid_symbol"
  | "invalid_lot_size"
  | "invalid_stops"
  | "insufficient_margin"
  | "market_closed"
  | "requote_price_changed"
  | "trade_disabled"
  | "timeout"
  | "expired_unclaimed"
  | "unknown_broker_response";

export interface StructuredRejection {
  /** Clean, one-line user-facing message (no jargon). */
  userMessage: string;
  /** Friendly headline (from humanize). */
  title: string;
  /** Verbatim raw code, preserved for support. */
  technicalCode: string | null;
  /** Raw reason string exactly as the backend/EA sent it (un-prettied). */
  rawReason: string | null;
  category: HumanizedReason["category"];
  severity: HumanizedReason["severity"];
  /** Which layer refused. */
  rejectLayer: RejectLayer;
  /** Who can fix it. */
  fixableBy: FixableBy;
  /** Concrete next step. */
  suggestedFix: string;
  changeableInGovernance: boolean;
  /**
   * MT5 broker return-code category (e.g. "invalid_stops") when the rejection
   * carried a real broker retcode. Null for pre-broker (gate/EA) rejections.
   */
  retcodeCategory: RetcodeCategory | null;
  /** Admin-facing "<retcode> · <category>" label, e.g. "10016 · invalid_stops". */
  retcodeLabel: string | null;
}

interface CodeMeta {
  userMessage: string;
  rejectLayer: RejectLayer;
  fixableBy: FixableBy;
  suggestedFix: string;
}

// Phase 8 code table — the live reasons that surface today + the brief's set.
// userMessage here OVERRIDES the generic humanize description when present, so
// each distinct cause gets distinct copy (requirement 7: never collapse causes).
const CODE_META: Record<string, CodeMeta> = {
  SYMBOL_NOT_IN_ARX_FOCUS: {
    userMessage: "This market is outside the active ARX approved market universe.",
    rejectLayer: "backend-gate", fixableBy: "market",
    suggestedFix: "ARX is focused on its approved market universe. Pick one of the approved markets to place a new trade. Existing positions on any symbol can still be closed or modified.",
  },
  INSUFFICIENT_DATA_FOR_ENTRY: {
    userMessage: "There isn't enough confirmed live market data for this symbol yet to open a new trade.",
    rejectLayer: "backend-gate", fixableBy: "market",
    suggestedFix: "Wait for the live feed to build a few more closed candles for this symbol, then try again. Existing positions can still be closed or modified.",
  },
  MASTER_SNAPSHOT_STALE: {
    userMessage: "MT5 account data is stale. Wait for the bridge to refresh, then try again.",
    rejectLayer: "backend-gate", fixableBy: "ea-mt5",
    suggestedFix: "The master MT5 snapshot is out of date — usually because the terminal is disconnected. Reconnect MT5 to the broker so the bridge can refresh, then retry.",
  },
  BROKER_RULE_SPREAD_TOO_WIDE: {
    userMessage: "Spread is too wide right now. The broker price is moving too much for this trade.",
    rejectLayer: "MT5-broker", fixableBy: "market",
    suggestedFix: "The broker rejected the order because the current spread exceeds the allowed limit. Wait for the spread to tighten (often around news or session open) and retry.",
  },
  SPREAD_TOO_WIDE: {
    userMessage: "Spread is too wide right now. The broker price is moving too much for this trade.",
    rejectLayer: "MT5-broker", fixableBy: "market",
    suggestedFix: "Wait for the spread to tighten and retry.",
  },
  TERMINAL_DISCONNECTED: {
    userMessage: "MT5 is not connected to the broker.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "The MetaTrader 5 terminal has lost its broker connection. Check the terminal's connection status (bottom-right) and your network on the machine/VPS running MT5.",
  },
  TERMINAL_NOT_CONNECTED: {
    userMessage: "MT5 is not connected to the broker.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "Reconnect the MetaTrader 5 terminal to the broker.",
  },
  ALGO_DISABLED: {
    userMessage: "Algo Trading is off in MT5.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "Turn on the 'Algo Trading' (AutoTrading) button in the MetaTrader 5 toolbar so the EA is allowed to place orders.",
  },
  ALGO_TRADING_DISABLED: {
    userMessage: "Algo Trading is off in MT5.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "Enable AutoTrading in the MetaTrader 5 toolbar.",
  },
  ENABLE_LIVE_FALSE: {
    userMessage: "Live execution is disabled in the EA settings.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "On the EA's inputs, set EnableLiveExecution = true (and confirm ReadOnlyMode = false). Re-attach the EA if needed.",
  },
  EA_LIVE_EXECUTION_DISABLED: {
    userMessage: "Live execution is disabled in the EA settings.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "Set EnableLiveExecution = true on the EA inputs.",
  },
  READ_ONLY_MODE: {
    userMessage: "The EA is in read-only mode.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "On the EA's inputs, set ReadOnlyMode = false so it can act on commands. Leave it true for monitoring-only.",
  },
  REJECTED_READ_ONLY_MODE_ACTIVE: {
    userMessage: "The EA is in read-only mode.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "Set ReadOnlyMode = false on the EA inputs.",
  },
  SYMBOL_NOT_FOUND: {
    userMessage: "This symbol was not found in the MT5 symbol directory.",
    rejectLayer: "symbol-resolver", fixableBy: "user",
    suggestedFix: "Pick the symbol from the list, or run symbol sync (ENUMERATE_SYMBOLS) so the broker's exact name is available. Don't type a shorthand the broker doesn't use.",
  },
  SYMBOL_AMBIGUOUS: {
    userMessage: "Multiple matching symbols found. Choose the exact broker symbol.",
    rejectLayer: "symbol-resolver", fixableBy: "user",
    suggestedFix: "Your input matched more than one market (e.g. the standard and the (1s) variant). Select the exact instrument from the candidate list.",
  },
  MISSING_BROKER_SYMBOL: {
    userMessage: "This symbol has no exact broker name on your account yet.",
    rejectLayer: "symbol-resolver", fixableBy: "ea-mt5",
    suggestedFix: "The symbol is known but the broker hasn't reported a tradable name. Run symbol sync (ENUMERATE_SYMBOLS) on the connected terminal.",
  },
  NO_BROKER_SYMBOL: {
    userMessage: "This symbol has no exact broker name on your account yet.",
    rejectLayer: "symbol-resolver", fixableBy: "ea-mt5",
    suggestedFix: "Run symbol sync on the connected terminal.",
  },
  INVALID_VOLUME: {
    userMessage: "That lot size isn't valid for this symbol.",
    rejectLayer: "MT5-broker", fixableBy: "user",
    suggestedFix: "The volume is below the minimum, above the maximum, or off the lot step for this symbol. Adjust it to a valid size (check the symbol's min / max / step).",
  },
  MARKET_CLOSED: {
    userMessage: "The market for this symbol is closed right now.",
    rejectLayer: "MT5-broker", fixableBy: "market",
    suggestedFix: "Trading hours are closed for this instrument. Wait for the market to reopen.",
  },
  INSUFFICIENT_MARGIN: {
    userMessage: "Not enough free margin for this trade.",
    rejectLayer: "MT5-broker", fixableBy: "user",
    suggestedFix: "The account doesn't have enough free margin for this lot size. Reduce the volume or free up margin by closing other positions.",
  },
  TRADE_DISABLED: {
    userMessage: "Trading is disabled for this symbol.",
    rejectLayer: "MT5-broker", fixableBy: "broker",
    suggestedFix: "The broker has trading disabled for this instrument (or it's view-only on this account). Pick a tradable symbol or contact the broker.",
  },
  ORDER_EXPIRED: {
    userMessage: "This order expired before it could be placed.",
    rejectLayer: "backend-gate", fixableBy: "user",
    suggestedFix: "The command's time-to-live elapsed (often after a reconnect). Re-submit the trade so a fresh command is created.",
  },
  DUPLICATE_COMMAND: {
    userMessage: "This looks like a duplicate of an order already sent.",
    rejectLayer: "backend-gate", fixableBy: "user",
    suggestedFix: "An identical command was already submitted (idempotency guard). Check open positions/commands before re-sending.",
  },
  DUPLICATE_LIVE_IDEMPOTENCY_KEY: {
    userMessage: "This looks like a duplicate of an order already sent.",
    rejectLayer: "backend-gate", fixableBy: "user",
    suggestedFix: "Check open positions/commands before re-sending.",
  },
  // ── Command integrity (AACI Security Phase 3) ────────────────────────
  // Verification runs as a pre-gate before the 16-gate Phase B evaluator. The
  // user message never names which integrity check tripped. Everything except
  // EXPIRED is a verification failure (re-submit a fresh request); EXPIRED is
  // benign staleness.
  INTEGRITY_PAYLOAD_MISSING: {
    userMessage: "This trade request couldn't be verified and was blocked for your safety.",
    rejectLayer: "backend-gate", fixableBy: "user",
    suggestedFix: "Start a fresh trade request and submit it again. If this keeps happening, contact support.",
  },
  INTEGRITY_PAYLOAD_MISMATCH: {
    userMessage: "This trade request couldn't be verified and was blocked for your safety.",
    rejectLayer: "backend-gate", fixableBy: "user",
    suggestedFix: "Start a fresh trade request and submit it again. If this keeps happening, contact support.",
  },
  INTEGRITY_SIGNATURE_MISSING: {
    userMessage: "This trade request couldn't be verified and was blocked for your safety.",
    rejectLayer: "backend-gate", fixableBy: "user",
    suggestedFix: "Start a fresh trade request and submit it again. If this keeps happening, contact support.",
  },
  INTEGRITY_SIGNATURE_MISMATCH: {
    userMessage: "This trade request couldn't be verified and was blocked for your safety.",
    rejectLayer: "backend-gate", fixableBy: "user",
    suggestedFix: "Start a fresh trade request and submit it again. If this keeps happening, contact support.",
  },
  INTEGRITY_ROUTE_NOT_ALLOWED: {
    userMessage: "This trade request couldn't be verified and was blocked for your safety.",
    rejectLayer: "backend-gate", fixableBy: "user",
    suggestedFix: "Start a fresh trade request and submit it again. If this keeps happening, contact support.",
  },
  INTEGRITY_DECISION_MISMATCH: {
    userMessage: "This trade request couldn't be verified and was blocked for your safety.",
    rejectLayer: "backend-gate", fixableBy: "user",
    suggestedFix: "Start a fresh trade request and submit it again. If this keeps happening, contact support.",
  },
  INTEGRITY_ACTOR_INVALID: {
    userMessage: "This trade request couldn't be verified and was blocked for your safety.",
    rejectLayer: "backend-gate", fixableBy: "user",
    suggestedFix: "Start a fresh trade request and submit it again. If this keeps happening, contact support.",
  },
  INTEGRITY_EXPIRED: {
    userMessage: "This trade request has expired. Please review and submit it again.",
    rejectLayer: "backend-gate", fixableBy: "user",
    suggestedFix: "Live approvals are only valid for a short window. Review the trade and submit a fresh request.",
  },
  ACCOUNT_MISMATCH: {
    userMessage: "This trade was routed to the wrong MT5 account.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "The command's target account doesn't match the bound master/bridge account. An admin should verify the bridge binding for this allocation.",
  },
  NETWORK_ERROR: {
    userMessage: "Couldn't reach ARX. Check your connection and try again.",
    rejectLayer: "frontend", fixableBy: "user",
    suggestedFix: "The request to the ARX server failed before a response came back (network/transport error). This is a connection problem between your device and ARX — not the broker. Check your internet and retry. The order was not placed.",
  },
  // ── Shared-master live bridge gate (runs before the 16 dispatch gates) ──
  // Surfaces for LIVE_SHARED routing when the platform master bridge isn't
  // reporting a live-ready terminal. These are observability classifications
  // only — they change no gate decision.
  MASTER_BRIDGE_NOT_LIVE_CAPABLE: {
    userMessage: "The shared master MT5 bridge isn't reporting that it's ready for live trading.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "The master MT5 terminal hasn't reported terminal-connected + AutoTrading-on + live-execution-enabled. On the master terminal, turn on the 'Algo Trading' (AutoTrading) button and set the EA inputs ReadOnlyMode = false and EnableLiveExecution = true, then wait for the next heartbeat.",
  },
  MASTER_BRIDGE_HEARTBEAT_STALE: {
    userMessage: "The shared master MT5 bridge is offline.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "No recent heartbeat from the master MT5 bridge. Make sure the master MetaTrader 5 terminal is open with the EA attached and running, then retry.",
  },
  MASTER_BRIDGE_REAL_HEARTBEAT_REQUIRED: {
    userMessage: "The shared master MT5 bridge hasn't sent a recent live heartbeat.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "The master bridge needs a fresh live heartbeat. Confirm the master terminal is open and connected to the broker.",
  },
  MASTER_LIVE_REQUIRES_REAL_BRIDGE: {
    userMessage: "The shared master MT5 account isn't a live account.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "The master bridge is bound to a demo or contest account. A real-money master account is required for shared-live trading.",
  },
  MASTER_BRIDGE_EA_VERSION_TOO_OLD: {
    userMessage: "The shared master MT5 bridge EA needs updating.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "Install EA v1.27 or newer on the master MT5 terminal.",
  },
  BRIDGE_BINDING_MISMATCH: {
    userMessage: "The platform master bridge binding doesn't match the connected bridge.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "An admin should re-verify the platform master bridge binding so the configured connection matches the live one.",
  },
  MASTER_BRIDGE_NOT_CONFIGURED: {
    userMessage: "No platform master bridge is configured for shared-live trading.",
    rejectLayer: "governance", fixableBy: "admin",
    suggestedFix: "An admin needs to bind a platform master bridge before shared-live orders can route.",
  },
  MASTER_BRIDGE_LIVE_NOT_ENABLED: {
    userMessage: "Live execution on the shared master bridge is turned off.",
    rejectLayer: "governance", fixableBy: "admin",
    suggestedFix: "An admin needs to enable live execution on the platform master bridge.",
  },
  SHARED_LIVE_TRADING_DISABLED: {
    userMessage: "Shared-live trading is turned off platform-wide.",
    rejectLayer: "governance", fixableBy: "admin",
    suggestedFix: "An admin needs to enable shared-live trading before live orders can route.",
  },
  NO_BRIDGE_REGISTERED: {
    userMessage: "No MT5 bridge is registered for routing.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "Make sure the master MT5 terminal is connected with the EA attached so a bridge is registered.",
  },
  // ── Shared master-pool pre-gate (liveCommandPipeline.ts preflight) ──────
  // Runs before the 16 dispatch gates. Pure presentation — changes no gate.
  MASTER_BRIDGE_NOT_PINNED: {
    userMessage: "The shared live bridge isn't available right now.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "No platform master bridge is currently pinned for shared-live routing. An operator needs to bind/pin the master bridge. No order was sent.",
  },
  MASTER_SNAPSHOT_MISSING: {
    userMessage: "The shared live bridge hasn't reported account data yet.",
    rejectLayer: "backend-gate", fixableBy: "ea-mt5",
    suggestedFix: "The master MT5 terminal hasn't sent an account snapshot yet. Confirm the master terminal is open and connected, then retry shortly.",
  },
  SHARED_LIVE_PAUSED: {
    userMessage: "Shared live trading is temporarily paused for reconciliation.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "An operator has paused shared-live trading while balances reconcile. It will resume automatically or when the operator unpauses. No order was sent.",
  },
  POOL_OVER_ALLOCATED: {
    userMessage: "The shared live pool is being reconciled — allocation is temporarily unavailable.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "The pool's total allocation currently exceeds the master account balance (Strict Real-Balance Mode), so new entries are paused. This clears once the master balance/positions reconcile; an operator can review allocations if it persists. No order was sent.",
  },
  USER_ALLOCATION_NOT_ASSIGNED: {
    userMessage: "No live allocation has been assigned to you yet.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "You don't have any live allocation assigned. An operator needs to assign allocation to your account before you can place a live order. No order was sent.",
  },
  USER_ALLOCATION_EXHAUSTED: {
    userMessage: "Your available live allocation is 0.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "Your assigned allocation is fully used by reserved risk and open floating loss. Contact your operator to add allocation, or close open positions to free headroom. No order was sent.",
  },
  ALLOCATION_EXCEEDS_MASTER_AVAILABLE: {
    userMessage: "Your assigned allocation is above the master account balance.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "Your assigned live allocation has drifted above the conservative master balance cap. An operator needs to re-balance your allocation. No order was sent.",
  },
  ALLOCATION_FROZEN: {
    userMessage: "Your live allocation is frozen by the operator.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "An operator has frozen your allocation, so no new live orders can open. Contact your operator to unfreeze it. No order was sent.",
  },
  // ── Live dispatch-gate codes (exact strings from livePhaseBDispatchGate) ──
  // These mirror the EA-result-code siblings above so the precise gate that
  // refused gets precise copy instead of the generic humanize fallback.
  LIVE_BROKER_EXECUTION_DISABLED: {
    userMessage: "Live trading is paused on the server right now.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "Live broker dispatch is switched off server-side. An admin must enable it. Demo trading still works.",
  },
  USER_NOT_ARMED_FOR_LIVE: {
    userMessage: "You haven't armed live trading yet.",
    rejectLayer: "backend-gate", fixableBy: "user",
    suggestedFix: "Open Live Trading Setup and pass the readiness gate before sending a live order.",
  },
  USER_NOT_LIVE_APPROVED: {
    userMessage: "Your account isn't approved for live trading yet.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "An admin needs to approve your account for live trading before you can dispatch a live order.",
  },
  GLOBAL_LIVE_DISABLED: {
    userMessage: "Live trading is globally turned off.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "Live trading is disabled globally. All live orders are refused until an admin re-enables it.",
  },
  KILL_SWITCH_ENGAGED: {
    userMessage: "The kill switch is engaged.",
    rejectLayer: "backend-gate", fixableBy: "user",
    suggestedFix: "Disengage the kill switch on the Live Trading page to send orders.",
  },
  BRIDGE_NOT_LIVE_ACCOUNT: {
    userMessage: "The connected MT5 account isn't a live account.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "The bound MT5 account is demo or contest. Connect a real-money account to dispatch live orders.",
  },
  EA_HEARTBEAT_STALE: {
    userMessage: "The MT5 bridge is offline.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "We haven't heard from your MT5 bridge in over 15 seconds. Make sure MetaTrader 5 is open and the EA is attached and running.",
  },
  EA_VERSION_TOO_OLD: {
    userMessage: "Your MT5 EA needs updating.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "Install EA v1.27 or newer on the connected terminal.",
  },
  EA_ENABLE_LIVE_EXECUTION_FALSE: {
    userMessage: "Live execution is disabled in the EA settings.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "On the EA's inputs, set EnableLiveExecution = true (and confirm ReadOnlyMode = false). Re-attach the EA if needed.",
  },
  EA_READ_ONLY_MODE_TRUE: {
    userMessage: "The EA is in read-only mode.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "On the EA's inputs, set ReadOnlyMode = false so it can act on commands. Leave it true for monitoring-only.",
  },
  EA_TERMINAL_NOT_CONNECTED: {
    userMessage: "MT5 is not connected to the broker.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "The MetaTrader 5 terminal has lost its broker connection. Check the terminal's connection status (bottom-right) and your network.",
  },
  EA_ALGO_TRADING_NOT_ALLOWED: {
    userMessage: "Algo Trading is off in MT5.",
    rejectLayer: "EA-preflight", fixableBy: "ea-mt5",
    suggestedFix: "Turn on the 'Algo Trading' (AutoTrading) button in the MetaTrader 5 toolbar so the EA is allowed to place orders.",
  },
  SYMBOL_NOT_ALLOWED: {
    userMessage: "This symbol isn't on your live allowlist.",
    rejectLayer: "governance", fixableBy: "admin",
    suggestedFix: "Live trading for this symbol isn't permitted on your account. An admin can add it to your allowlist.",
  },
  VOLUME_EXCEEDS_MAX_LIVE_LOT: {
    userMessage: "That lot size is above your live limit for this symbol.",
    rejectLayer: "governance", fixableBy: "user",
    suggestedFix: "Reduce the lot size to within your per-symbol live maximum, or ask an admin to raise the cap.",
  },
  VOLUME_EXCEEDS_USER_MAX_LOT: {
    userMessage: "That lot size is above the maximum you confirmed when you armed live trading.",
    rejectLayer: "governance", fixableBy: "user",
    suggestedFix: "Reduce the lot size to within your armed maximum, or re-arm live trading in Live Trading Setup with a higher confirmed max lot.",
  },
  VOLUME_EXCEEDS_MARKET_MAX_LOT: {
    userMessage: "That lot size is above the configured maximum for this market.",
    rejectLayer: "governance", fixableBy: "user",
    suggestedFix: "Reduce the lot size to within the per-market maximum, or ask an admin to raise the governance lot cap.",
  },
  DAILY_LOSS_LIMIT_REACHED: {
    userMessage: "You've hit your daily loss limit.",
    rejectLayer: "governance", fixableBy: "user",
    suggestedFix: "Your realised and floating loss has reached the daily cap. Live orders are paused until the cap resets or an admin adjusts it.",
  },
  MISSING_STOP_LOSS: {
    userMessage: "This live order needs a stop-loss.",
    rejectLayer: "governance", fixableBy: "user",
    suggestedFix: "Live orders require a stop-loss. Set an SL price and resubmit.",
  },
  MISSING_TAKE_PROFIT: {
    userMessage: "This live order needs a take-profit.",
    rejectLayer: "governance", fixableBy: "user",
    suggestedFix: "A take-profit is required for live orders on your account. Set a TP price and resubmit.",
  },
  DISCLOSURE_NOT_ACCEPTED: {
    userMessage: "You haven't accepted the live risk disclosure.",
    rejectLayer: "backend-gate", fixableBy: "user",
    suggestedFix: "Open Live Trading Setup and accept the live risk disclosure before placing a live order.",
  },
  // ── Task #737 — additive live-execution activation gate + eligibility ──
  LIVE_EXECUTION_ACTIVATION_GATE: {
    userMessage: "Live execution isn't activated for your account yet.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "Complete live confirmation, or ask your operator to enable Full Live Activation on your behalf. Every order still re-checks all live safety gates.",
  },
  // Task #737 follow-up — the SPECIFIC execution-readiness blockers the shared
  // resolver (buildApprovedTraderLiveState) can report. Mirror the backend's
  // USER_SAFE_BLOCK_COPY so the order ticket shows exactly what to fix instead
  // of the generic activation-gate sentence. Surfaced via `overrideCode`.
  NOT_APPROVED_FOR_LIVE: {
    userMessage: "Your account isn't approved for live trading yet.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "Admin approval is required before you can trade live. Ask your operator to approve your account.",
  },
  LIVE_BRIDGE_ASSIGNMENT_PENDING: {
    userMessage: "Your live shared-bridge allocation is still being set up.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "Contact your operator to finish shared-bridge onboarding. Once your allocation is assigned you can place live orders.",
  },
  EMERGENCY_STOP_ACTIVE: {
    userMessage: "Live trading is paused platform-wide.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "Trades will resume once your operator re-enables live trading. Existing positions can still be closed or modified.",
  },
  LIVE_CONFIRMATION_REQUIRED: {
    userMessage: "Your account is approved, but Full Live Activation isn't complete yet.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "Complete live confirmation to start placing live orders, or ask your operator to enable Full Live Activation on your behalf.",
  },
  LIVE_ARMING_PENDING: {
    userMessage: "Live trading isn't armed yet.",
    rejectLayer: "backend-gate", fixableBy: "user",
    suggestedFix: "Arm live trading to execute. Every dispatch still re-checks all live safety gates.",
  },
  SERVER_LIVE_EXECUTION_OFF: {
    userMessage: "Live execution is currently paused for maintenance.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "It will resume automatically once re-enabled. No action is needed on your side.",
  },
  RISK_PROFILE_INCOMPLETE: {
    userMessage: "Your risk settings are incomplete.",
    rejectLayer: "backend-gate", fixableBy: "user",
    suggestedFix: "Complete your risk settings (max lot, daily loss limit, symbols) to continue.",
  },
  BOT_AGENT_NOT_ALLOWED: {
    userMessage: "Automated, agent, and system accounts can't execute live.",
    rejectLayer: "backend-gate", fixableBy: "none",
    suggestedFix: "Live execution is only available to eligible human trader accounts.",
  },
  INVESTOR_NOT_ALLOWED: {
    userMessage: "Investor accounts are view-only.",
    rejectLayer: "backend-gate", fixableBy: "none",
    suggestedFix: "Investor accounts can view performance but cannot place or manage trades.",
  },
  BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED: {
    userMessage: "Live trading is locked in this build.",
    rejectLayer: "backend-gate", fixableBy: "admin",
    suggestedFix: "The live broker placement layer is intentionally locked server-side (master switch off). No real-money order can be placed until an operator enables it. Demo trading still works.",
  },
};

// Map a humanize category → who can typically fix it, when the code isn't in
// CODE_META (best-effort default; CODE_META always wins when present).
const CATEGORY_FIXABLE: Record<HumanizedReason["category"], FixableBy> = {
  BROKER: "broker", TECHNICAL: "ea-mt5", GOVERNANCE: "admin",
  SECURITY: "admin", LEGACY: "admin", UNKNOWN: "none",
};
const CATEGORY_LAYER: Record<HumanizedReason["category"], RejectLayer> = {
  BROKER: "MT5-broker", TECHNICAL: "EA-preflight", GOVERNANCE: "governance",
  SECURITY: "backend-gate", LEGACY: "backend-gate", UNKNOWN: "unknown",
};

// Raw MT5 retcode → category. Mirrors the FAILURE rows of the server's
// RETCODE_MAP (retcodeMap.ts). Success codes are intentionally absent — a
// success never renders a rejection. Unmapped present codes resolve to
// "unknown_broker_response" (honest, never faked as success).
const RETCODE_CATEGORY: Record<number, RetcodeCategory> = {
  10004: "requote_price_changed",
  10006: "rejected_by_broker",
  10007: "rejected_by_broker",
  10011: "rejected_by_broker",
  10012: "timeout",
  10013: "rejected_by_broker",
  10014: "invalid_lot_size",
  10015: "requote_price_changed",
  10016: "invalid_stops",
  10017: "trade_disabled",
  10018: "market_closed",
  10019: "insufficient_margin",
  10020: "requote_price_changed",
  10021: "requote_price_changed",
  10022: "invalid_stops",
  10024: "rejected_by_broker",
  10026: "trade_disabled",
  10027: "trade_disabled",
  10028: "rejected_by_broker",
  10029: "rejected_by_broker",
  10030: "invalid_lot_size",
  10031: "timeout",
  10033: "invalid_lot_size",
  10034: "invalid_lot_size",
  10036: "rejected_by_broker",
};

// Clean, plain-English copy per retcode category. A real broker retcode is the
// most specific truth for the broker layer, so this OVERRIDES the generic
// humanize/CODE_META copy when a retcode is present (e.g. 10016 → "your stop
// loss is too close" instead of a vague "order refused"). No jargon, no code
// names, mobile-readable. Never implies the order went on.
const RETCODE_USER_COPY: Record<RetcodeCategory, CodeMeta> = {
  invalid_stops: {
    userMessage: "The broker rejected this — your stop loss is too close to the current price.",
    rejectLayer: "MT5-broker", fixableBy: "user",
    suggestedFix: "Move the stop loss (and take profit) further from the entry price. The broker enforces a minimum distance for this symbol — widen the stop and try again.",
  },
  invalid_lot_size: {
    userMessage: "The broker rejected the trade size for this symbol.",
    rejectLayer: "MT5-broker", fixableBy: "user",
    suggestedFix: "The lot size is below the minimum, above the maximum, or off the lot step for this symbol. Adjust it to a valid size and try again.",
  },
  insufficient_margin: {
    userMessage: "Not enough free margin for this trade.",
    rejectLayer: "MT5-broker", fixableBy: "user",
    suggestedFix: "The account doesn't have enough free margin for this lot size. Reduce the volume or close other positions to free up margin.",
  },
  market_closed: {
    userMessage: "The market for this symbol is closed right now.",
    rejectLayer: "MT5-broker", fixableBy: "market",
    suggestedFix: "Trading hours are closed for this instrument. Wait for the market to reopen and try again.",
  },
  requote_price_changed: {
    userMessage: "The price moved before the order could be placed.",
    rejectLayer: "MT5-broker", fixableBy: "market",
    suggestedFix: "The broker requoted because the price changed (common in fast or thin markets). Try again — if it keeps happening, wait for calmer conditions.",
  },
  trade_disabled: {
    userMessage: "Trading is turned off for this order.",
    rejectLayer: "MT5-broker", fixableBy: "ea-mt5",
    suggestedFix: "Either AutoTrading is switched off in the MT5 terminal, or the broker has this instrument disabled. If it's your terminal, turn the 'Algo Trading' (AutoTrading) button on; otherwise pick a tradable symbol or contact the broker.",
  },
  timeout: {
    userMessage: "The broker timed out before placing the order.",
    rejectLayer: "MT5-broker", fixableBy: "market",
    suggestedFix: "The trade server didn't respond in time (often a connection issue). Check the MT5 terminal's connection and try again. The order was not placed.",
  },
  rejected_by_broker: {
    userMessage: "The broker rejected this order.",
    rejectLayer: "MT5-broker", fixableBy: "broker",
    suggestedFix: "The broker declined the order without a more specific reason. Check the broker message below, then try again — if it persists, contact the broker.",
  },
  invalid_symbol: {
    userMessage: "The broker didn't recognise this symbol.",
    rejectLayer: "MT5-broker", fixableBy: "user",
    suggestedFix: "The broker doesn't accept this symbol name. Pick the exact instrument from the list and try again.",
  },
  expired_unclaimed: {
    userMessage: "This order expired before the broker placed it.",
    rejectLayer: "EA-preflight", fixableBy: "user",
    suggestedFix: "The command's time-to-live elapsed before MT5 acted on it. Re-submit so a fresh order is created.",
  },
  unknown_broker_response: {
    userMessage: "The broker rejected this trade.",
    rejectLayer: "MT5-broker", fixableBy: "broker",
    suggestedFix: "The broker returned a code ARX doesn't have specific copy for. See the broker message and code below, then try again or contact the broker.",
  },
};

/**
 * Classify a raw MT5 retcode into a category + an admin label "<code> · <cat>".
 * Accepts a number or numeric string. Returns {null,null,false} for anything
 * that is NOT a real positive-integer retcode (missing, blank/whitespace, 0,
 * negative, decimal, non-numeric) — those are the pre-broker reject cases, and
 * the caller must leave the existing copy untouched (never coerce "" → 0).
 * `mapped` is true only when the code is in our table; an in-range-but-unmapped
 * code resolves to "unknown_broker_response" (honest, never faked as success)
 * but with `mapped:false` so callers don't overwrite a more specific reason.
 * Mirrors the server's classifyRetcode (retcodeMap.ts) — keep in sync.
 */
export function classifyRetcode(
  retcode: number | string | null | undefined,
): { category: RetcodeCategory | null; label: string | null; mapped: boolean } {
  let n: number;
  if (typeof retcode === "number") n = retcode;
  else if (typeof retcode === "string") {
    const t = retcode.trim();
    if (t === "") return { category: null, label: null, mapped: false };
    n = Number(t);
  } else return { category: null, label: null, mapped: false };
  if (!Number.isInteger(n) || n <= 0) return { category: null, label: null, mapped: false };
  const mapped = RETCODE_CATEGORY[n];
  if (mapped) return { category: mapped, label: `${n} · ${mapped}`, mapped: true };
  return { category: "unknown_broker_response", label: `${n} · unknown_broker_response`, mapped: false };
}

/** Strip a LIVE_BLOCKED: envelope to find the inner code, mirroring humanize. */
function innerCode(code: string | null): string | null {
  if (!code) return null;
  const m = code.match(/^LIVE_BLOCKED:([A-Z0-9_]+)/);
  return m ? m[1]! : code;
}

function lookupMeta(code: string | null): CodeMeta | null {
  if (!code) return null;
  if (CODE_META[code]) return CODE_META[code]!;
  const inner = innerCode(code);
  if (inner && CODE_META[inner]) return CODE_META[inner]!;
  // token scan so e.g. "BROKER_RULE_SPREAD_TOO_WIDE_0.01" still matches
  for (const k of Object.keys(CODE_META)) if (code.includes(k)) return CODE_META[k]!;
  return null;
}

/**
 * Build a full StructuredRejection from a raw backend/EA rejection. Accepts the
 * common shapes: a bare code string, or an object with
 * {error|reason|primaryReason|code, detail, ...}. Composes humanize.ts for the
 * clean copy/category, then layers on rejectLayer + suggestedFix + fixableBy.
 *
 * If no usable code is found, returns the explicit "No detailed reason reported"
 * state (requirement 8) — never a fake success, never a vague catch-all.
 */
export function structureRejection(
  input: unknown,
  opts?: { mt5Retcode?: number | string | null; overrideCode?: string | null },
): StructuredRejection {
  // Extract a raw code + raw reason string from whatever shape we got.
  let rawReason: string | null = null;
  let codeForLookup: string | null = null;
  if (typeof input === "string") {
    rawReason = input; codeForLookup = input;
  } else if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const pick = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);
    codeForLookup = pick("primaryReason") ?? pick("error") ?? pick("reason") ?? pick("code");
    rawReason = pick("reason") ?? pick("primaryReason") ?? pick("error") ?? pick("code");
  }

  const h = humanizeReason(codeForLookup);
  const meta = lookupMeta(codeForLookup);

  // Task #737 follow-up — when the backend threads a SPECIFIC execution-readiness
  // blocker (`blockingReasonCode`, e.g. LIVE_CONFIRMATION_REQUIRED) alongside the
  // generic canonical reason (LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE), use it
  // to drive the user-facing copy while keeping the canonical code in the admin
  // trail (technicalCode/rawReason stay the raw envelope code). This lets the UI
  // tell "approved but Full Live Activation missing" apart from "feed not
  // confirmed" without weakening or renaming any gate.
  const overrideMeta = opts?.overrideCode ? lookupMeta(opts.overrideCode) : null;

  // A real broker retcode is the most specific truth for the broker layer.
  //   • A MAPPED failure (rc.mapped) drives the user copy (e.g. 10016 → "your
  //     stop loss is too close") — the broker verdict wins.
  //   • An in-range-but-UNMAPPED code (rc.category === unknown, mapped:false)
  //     must NOT overwrite a more specific gate/EA reason; we only surface its
  //     label for admins and fall back to its honest broker copy when there is
  //     no other reason at all.
  //   • Absent/invalid (rc.category === null) → no retcode influence, so every
  //     pre-broker (gate/EA) rejection keeps its existing copy (backward compat).
  const rc = classifyRetcode(opts?.mt5Retcode);
  const retMeta = rc.category ? RETCODE_USER_COPY[rc.category] : null;

  // No gate/EA code at all.
  if (!codeForLookup) {
    // …but if the broker still returned a retcode (mapped OR unmapped), THAT is
    // the only reason we have — use its honest broker copy, not "no reason".
    if (rc.category && retMeta) {
      return {
        userMessage: retMeta.userMessage,
        title: "Broker rejected the order",
        technicalCode: null,
        rawReason,
        category: "BROKER",
        severity: "error",
        rejectLayer: retMeta.rejectLayer,
        fixableBy: retMeta.fixableBy,
        suggestedFix: retMeta.suggestedFix,
        changeableInGovernance: false,
        retcodeCategory: rc.category,
        retcodeLabel: rc.label,
      };
    }
    // Explicit missing-reason state, naming where it went cold.
    return {
      userMessage: "The trade was refused, but no detailed reason was reported.",
      title: "No detailed reason reported",
      technicalCode: null,
      rawReason,
      category: "UNKNOWN",
      severity: "error",
      rejectLayer: "unknown",
      fixableBy: "none",
      suggestedFix: "The rejecting layer did not return a reason code. Check the server audit log and the EA Experts log for the failed command to see where the trail went cold.",
      changeableInGovernance: false,
      retcodeCategory: null,
      retcodeLabel: null,
    };
  }

  // Have a code AND a MAPPED broker retcode → the broker verdict wins for copy,
  // but we keep the raw code/category from humanize for the admin trail.
  if (rc.mapped && retMeta) {
    return {
      userMessage: retMeta.userMessage,
      title: h.title,
      technicalCode: h.technicalCode ?? codeForLookup,
      rawReason,
      category: "BROKER",
      severity: h.severity,
      rejectLayer: retMeta.rejectLayer,
      fixableBy: retMeta.fixableBy,
      suggestedFix: retMeta.suggestedFix,
      changeableInGovernance: h.changeableInGovernance,
      retcodeCategory: rc.category,
      retcodeLabel: rc.label,
    };
  }

  // Have a code with NO retcode, or an in-range-but-UNMAPPED retcode: keep the
  // existing (often more specific) code-derived copy, but still surface the raw
  // retcode label for admins when one was present.
  return {
    userMessage: overrideMeta?.userMessage ?? meta?.userMessage ?? h.description,
    title: h.title,
    technicalCode: h.technicalCode ?? codeForLookup,
    rawReason,
    category: h.category,
    severity: h.severity,
    rejectLayer: overrideMeta?.rejectLayer ?? meta?.rejectLayer ?? CATEGORY_LAYER[h.category],
    fixableBy: overrideMeta?.fixableBy ?? meta?.fixableBy ?? CATEGORY_FIXABLE[h.category],
    suggestedFix: overrideMeta?.suggestedFix
      ?? meta?.suggestedFix
      ?? (h.changeableInGovernance
        ? "This is an admin-configurable rule. An owner/admin can adjust it in Risk / Governance."
        : "See the technical code below and the server/EA logs for the failed command."),
    changeableInGovernance: h.changeableInGovernance,
    retcodeCategory: rc.category,
    retcodeLabel: rc.label,
  };
}

const LAYER_LABEL: Record<RejectLayer, string> = {
  "frontend": "App (frontend)",
  "backend-gate": "Server gate",
  "governance": "Governance rule",
  "symbol-resolver": "Symbol resolver",
  "EA-preflight": "EA / MT5 preflight",
  "MT5-broker": "MT5 / broker",
  "unknown": "Unknown layer",
};
export function rejectLayerLabel(l: RejectLayer): string { return LAYER_LABEL[l]; }

const FIXABLE_LABEL: Record<FixableBy, string> = {
  "user": "You can fix this",
  "admin": "An admin can change this",
  "ea-mt5": "Fix on the MT5 terminal / EA",
  "broker": "Broker-side condition",
  "market": "Market condition — wait and retry",
  "none": "No action available",
};
export function fixableByLabel(f: FixableBy): string { return FIXABLE_LABEL[f]; }
