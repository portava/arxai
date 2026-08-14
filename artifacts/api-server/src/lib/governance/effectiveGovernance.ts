// ── T019 — getEffectiveTradingGovernance: single source of truth ────────────
//
// One resolver that both the backend live dispatch AND the frontend payload
// routes read, so the UI and the server can never disagree about what is
// required or allowed for a given user.
//
// Posture:
//   - Owner/admin (privileged) with Owner Live Control Mode ON  → every
//     app-added restriction is OFF unless explicitly turned ON in
//     owner_governance_settings. This is the "no training wheels" default the
//     owner approved in T019.
//   - Normal (non-approved) users → today's protective defaults are retained
//     from user_master_live_access / arx_live_user_settings.
//
// This resolver NEVER relaxes a permanent technical/security/broker-truth
// check. Those (16-gate evaluator, master switch, kill switch, bridge
// heartbeat, EA flags, account type, manual confirmation, ledger, ownership,
// master-account privacy, broker symbol/lot/price truth) are enforced
// elsewhere and are reported here only as `brokerEnforced`/`SECURITY`/
// `TECHNICAL` metadata, never toggled.

import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  userMasterLiveAccessTable,
  arxLiveUserSettingsTable,
  ownerGovernanceSettingsTable,
  type OwnerGovernanceSettingsRow,
} from "@workspace/db";
import { getUserRiskProfile } from "../live/userRiskProfile.js";

export type GovernanceCategory = "BROKER" | "TECHNICAL" | "GOVERNANCE" | "SECURITY";
export type GovernanceSource = "GOVERNANCE" | "OWNER_DEFAULT" | "USER_DEFAULT";
export type GovernanceAudience = "owner" | "admin" | "user" | "all";

export interface GovernancePolicy {
  key: string;
  label: string;
  category: GovernanceCategory;
  enabled: boolean; // is this restriction active for this user right now?
  value: boolean | number | string[] | null;
  source: GovernanceSource;
  appliesTo: GovernanceAudience;
  blocksTrading: boolean;
  changeableInGovernance: boolean;
  brokerEnforced: boolean;
}

export interface EffectiveTradingGovernance {
  userId: number;
  role: string;
  accountMode: string;
  isPrivileged: boolean;
  ownerLiveControlMode: boolean;

  // Flat effective values consumed by dispatch + frontend.
  requireStopLoss: boolean;
  requireTakeProfit: boolean;
  requireSecondConfirm: boolean;
  maxLotPerTrade: number | null;
  maxOpenPositions: number | null;
  maxDailyLossUsd: number | null;
  allowedSymbols: string[] | null; // null = unrestricted
  blockedSymbols: string[];
  enforceSymbolAllowlist: boolean;
  enforceAllocationLimit: boolean;
  enforceMarketHoursAppCheck: boolean;
  requireSpreadLimit: boolean;
  spreadLimitPoints: number | null;
  requireScannerSignal: boolean;
  requireRubyExplanation: boolean;
  requireBacktest: boolean;
  requireNewsCheck: boolean;
  requireRiskReward: boolean;
  allowMarketOrders: boolean;
  allowPendingOrders: boolean;
  allowChartTrading: boolean;
  allowReverse: boolean;
  allowPartialClose: boolean;
  allowBreakEven: boolean;
  allowOneClick: boolean;

  // Detailed policy list for the Admin Governance UI + categorized blocks.
  policies: GovernancePolicy[];
}

/** In-memory defaults matching owner_governance_settings column defaults. */
function governanceDefaults(): Omit<OwnerGovernanceSettingsRow, "id" | "userId" | "updatedBy" | "updatedAt" | "createdAt"> {
  return {
    ownerLiveControlMode: true,
    requireStopLoss: false,
    requireTakeProfit: false,
    requireSecondConfirm: false,
    maxLotPerTrade: null,
    maxOpenPositions: null,
    maxDailyLossUsd: null,
    allowedSymbols: null,
    blockedSymbols: [],
    requireSpreadLimit: false,
    spreadLimitPoints: null,
    requireScannerSignal: false,
    requireRubyExplanation: false,
    requireBacktest: false,
    requireNewsCheck: false,
    requireRiskReward: false,
    allowMarketOrders: true,
    allowPendingOrders: true,
    allowChartTrading: true,
    allowReverse: true,
    allowPartialClose: true,
    allowBreakEven: true,
    allowOneClick: true,
    enforceAllocationLimit: false,
    enforceMarketHoursAppCheck: false,
    enforceSymbolAllowlist: false,
  };
}

/** Read (without creating) the owner governance row for a user. */
export async function loadOwnerGovernanceRow(userId: number): Promise<OwnerGovernanceSettingsRow | null> {
  const rows = await db.select().from(ownerGovernanceSettingsTable)
    .where(eq(ownerGovernanceSettingsTable.userId, userId)).limit(1);
  return rows[0] ?? null;
}

/**
 * The single source of truth. Resolves the effective governance for a user in
 * a given account mode. Privileged (owner/admin) users are governed by
 * owner_governance_settings (defaults = unrestricted); everyone else keeps the
 * protective per-user defaults.
 */
export async function getEffectiveTradingGovernance(
  userId: number,
  accountMode: string,
  role?: string | null,
): Promise<EffectiveTradingGovernance> {
  const [userRow] = role
    ? [{ role }]
    : await db.select({ role: usersTable.role }).from(usersTable)
        .where(eq(usersTable.id, userId)).limit(1);
  const resolvedRole = (userRow?.role ?? "USER").toString();

  const [riskProfile, govRow, accessRows, settingsRows] = await Promise.all([
    getUserRiskProfile(userId),
    loadOwnerGovernanceRow(userId),
    db.select().from(userMasterLiveAccessTable)
      .where(eq(userMasterLiveAccessTable.userId, userId)).limit(1),
    db.select().from(arxLiveUserSettingsTable)
      .where(eq(arxLiveUserSettingsTable.userId, userId)).limit(1),
  ]);

  const access = accessRows[0] ?? null;
  const settings = settingsRows[0] ?? null;
  const isOwnerRoleLike = resolvedRole === "OWNER" || resolvedRole === "ADMIN";
  const isPrivileged = isOwnerRoleLike || riskProfile.isOwnerUnrestricted;

  // ── PRIVILEGED PATH — governance-driven, default OFF ───────────────────────
  if (isPrivileged) {
    const g = govRow ?? { ...governanceDefaults() } as OwnerGovernanceSettingsRow;
    const ownerLiveControlMode = govRow ? g.ownerLiveControlMode : true;
    const audience: GovernanceAudience = resolvedRole === "ADMIN" ? "admin" : "owner";
    const src: GovernanceSource = govRow ? "GOVERNANCE" : "OWNER_DEFAULT";

    // When Owner Live Control Mode is OFF, the privileged user falls back to
    // the protective per-user defaults (treated like a normal approved user).
    if (!ownerLiveControlMode) {
      // T019 — keep isPrivileged=true here (role IS owner/admin) so the Admin
      // Governance panel stays visible and the operator can turn Owner Live
      // Control Mode back ON. ownerLiveControlMode=false in the protective
      // return means every "governance currently active" decision
      // (useGovernance = isPrivileged && ownerLiveControlMode) still collapses
      // to protective, so dispatch/payloads behave exactly like a normal user.
      return buildProtective(userId, resolvedRole, accountMode, access, settings, true);
    }

    const allowedSymbols = g.enforceSymbolAllowlist ? (g.allowedSymbols ?? null) : null;

    const policies: GovernancePolicy[] = [
      gov("requireStopLoss", "Require Stop Loss", g.requireStopLoss, g.requireStopLoss, src, audience),
      gov("requireTakeProfit", "Require Take Profit", g.requireTakeProfit, g.requireTakeProfit, src, audience),
      gov("requireSecondConfirm", "Require Second Confirmation", g.requireSecondConfirm, g.requireSecondConfirm, src, audience),
      gov("maxLotPerTrade", "Max Lot Per Trade", g.maxLotPerTrade != null, g.maxLotPerTrade, src, audience),
      gov("maxOpenPositions", "Max Open Positions", g.maxOpenPositions != null, g.maxOpenPositions, src, audience),
      gov("maxDailyLossUsd", "Max Daily Loss (USD)", g.maxDailyLossUsd != null, g.maxDailyLossUsd, src, audience),
      gov("enforceSymbolAllowlist", "Symbol Allowlist", g.enforceSymbolAllowlist, g.allowedSymbols, src, audience),
      gov("blockedSymbols", "Symbol Blocklist", (g.blockedSymbols ?? []).length > 0, g.blockedSymbols ?? [], src, audience),
      gov("enforceAllocationLimit", "Enforce Allocation Limit", g.enforceAllocationLimit, g.enforceAllocationLimit, src, audience),
      gov("enforceMarketHoursAppCheck", "App Market-Hours Check", g.enforceMarketHoursAppCheck, g.enforceMarketHoursAppCheck, src, audience),
      gov("requireSpreadLimit", "Spread Limit", g.requireSpreadLimit, g.spreadLimitPoints, src, audience),
      gov("requireScannerSignal", "Require Scanner Signal", g.requireScannerSignal, g.requireScannerSignal, src, audience),
      gov("requireRubyExplanation", "Require Ruby Explanation", g.requireRubyExplanation, g.requireRubyExplanation, src, audience),
      gov("requireBacktest", "Require Backtest", g.requireBacktest, g.requireBacktest, src, audience),
      gov("requireNewsCheck", "Require News Check", g.requireNewsCheck, g.requireNewsCheck, src, audience),
      gov("requireRiskReward", "Require Risk/Reward", g.requireRiskReward, g.requireRiskReward, src, audience),
      // Allowed-action toggles: enabled (restriction active) when the action is DISALLOWED.
      gov("allowMarketOrders", "Allow Market Orders", !g.allowMarketOrders, g.allowMarketOrders, src, audience),
      gov("allowPendingOrders", "Allow Pending Orders", !g.allowPendingOrders, g.allowPendingOrders, src, audience),
      gov("allowChartTrading", "Allow Chart Trading", !g.allowChartTrading, g.allowChartTrading, src, audience),
      gov("allowReverse", "Allow Reverse", !g.allowReverse, g.allowReverse, src, audience),
      gov("allowPartialClose", "Allow Partial Close", !g.allowPartialClose, g.allowPartialClose, src, audience),
      gov("allowBreakEven", "Allow Break-Even", !g.allowBreakEven, g.allowBreakEven, src, audience),
      gov("allowOneClick", "Allow One-Click / Single Confirm", !g.allowOneClick, g.allowOneClick, src, audience),
    ];

    return {
      userId,
      role: resolvedRole,
      accountMode,
      isPrivileged: true,
      ownerLiveControlMode,
      requireStopLoss: g.requireStopLoss,
      requireTakeProfit: g.requireTakeProfit,
      requireSecondConfirm: g.requireSecondConfirm,
      maxLotPerTrade: g.maxLotPerTrade,
      maxOpenPositions: g.maxOpenPositions,
      maxDailyLossUsd: g.maxDailyLossUsd,
      allowedSymbols,
      blockedSymbols: g.blockedSymbols ?? [],
      enforceSymbolAllowlist: g.enforceSymbolAllowlist,
      enforceAllocationLimit: g.enforceAllocationLimit,
      enforceMarketHoursAppCheck: g.enforceMarketHoursAppCheck,
      requireSpreadLimit: g.requireSpreadLimit,
      spreadLimitPoints: g.spreadLimitPoints,
      requireScannerSignal: g.requireScannerSignal,
      requireRubyExplanation: g.requireRubyExplanation,
      requireBacktest: g.requireBacktest,
      requireNewsCheck: g.requireNewsCheck,
      requireRiskReward: g.requireRiskReward,
      allowMarketOrders: g.allowMarketOrders,
      allowPendingOrders: g.allowPendingOrders,
      allowChartTrading: g.allowChartTrading,
      allowReverse: g.allowReverse,
      allowPartialClose: g.allowPartialClose,
      allowBreakEven: g.allowBreakEven,
      allowOneClick: g.allowOneClick,
      policies,
    };
  }

  // ── NORMAL USER PATH — protective defaults retained ────────────────────────
  return buildProtective(userId, resolvedRole, accountMode, access, settings, false);
}

function gov(
  key: string,
  label: string,
  enabled: boolean,
  value: boolean | number | string[] | null,
  source: GovernanceSource,
  appliesTo: GovernanceAudience,
): GovernancePolicy {
  return {
    key,
    label,
    category: "GOVERNANCE",
    enabled,
    value,
    source,
    appliesTo,
    blocksTrading: enabled,
    changeableInGovernance: true,
    brokerEnforced: false,
  };
}

function buildProtective(
  userId: number,
  role: string,
  accountMode: string,
  access: typeof userMasterLiveAccessTable.$inferSelect | null,
  settings: typeof arxLiveUserSettingsTable.$inferSelect | null,
  isPrivileged: boolean,
): EffectiveTradingGovernance {
  const requireStopLoss = access?.requireStopLoss ?? settings?.requireStopLoss ?? true;
  const requireTakeProfit = access?.requireTakeProfit ?? true;
  const allowedSymbols = (access?.allowedSymbols ?? []) as string[];
  const maxLotPerTrade = access?.maxLot ?? null;
  const maxOpenPositions = access?.maxOpenPositions ?? null;
  const maxDailyLossUsd = access?.dailyLossLimitUsd ?? null;
  const src: GovernanceSource = "USER_DEFAULT";

  const policies: GovernancePolicy[] = [
    gov("requireStopLoss", "Require Stop Loss", requireStopLoss, requireStopLoss, src, "user"),
    gov("requireTakeProfit", "Require Take Profit", requireTakeProfit, requireTakeProfit, src, "user"),
    gov("maxLotPerTrade", "Max Lot Per Trade", maxLotPerTrade != null, maxLotPerTrade, src, "user"),
    gov("maxOpenPositions", "Max Open Positions", maxOpenPositions != null, maxOpenPositions, src, "user"),
    gov("maxDailyLossUsd", "Max Daily Loss (USD)", maxDailyLossUsd != null, maxDailyLossUsd, src, "user"),
    gov("enforceSymbolAllowlist", "Symbol Allowlist", allowedSymbols.length > 0, allowedSymbols, src, "user"),
  ].map((p) => ({ ...p, changeableInGovernance: false }));

  return {
    userId,
    role,
    accountMode,
    isPrivileged,
    ownerLiveControlMode: false,
    requireStopLoss,
    requireTakeProfit,
    requireSecondConfirm: false,
    maxLotPerTrade,
    maxOpenPositions,
    maxDailyLossUsd,
    allowedSymbols: allowedSymbols.length > 0 ? allowedSymbols : null,
    blockedSymbols: [],
    enforceSymbolAllowlist: allowedSymbols.length > 0,
    enforceAllocationLimit: true,
    enforceMarketHoursAppCheck: true,
    requireSpreadLimit: false,
    spreadLimitPoints: null,
    requireScannerSignal: false,
    requireRubyExplanation: false,
    requireBacktest: false,
    requireNewsCheck: false,
    requireRiskReward: false,
    allowMarketOrders: true,
    allowPendingOrders: true,
    allowChartTrading: true,
    allowReverse: true,
    allowPartialClose: true,
    allowBreakEven: true,
    allowOneClick: true,
    policies,
  };
}

// ── T019 — block categorization ────────────────────────────────────────────
// Every live refusal reason is classified so the UI can explain *why* a trade
// was blocked and whether the owner can change it in Admin Risk/Governance, or
// whether it is broker/technical/security truth that can never be toggled.

export interface CategorizedBlock {
  reason: string;
  category: GovernanceCategory;
  userReason: string;
  adminReason: string;
  changeableInGovernance: boolean;
  brokerEnforced: boolean;
}

const BLOCK_CATEGORY_MAP: Record<string, Omit<CategorizedBlock, "reason">> = {
  // ── GOVERNANCE (app-added policy; owner can change) ───────────────────────
  MISSING_STOP_LOSS: { category: "GOVERNANCE", userReason: "A stop loss is required.", adminReason: "requireStopLoss is ON in governance.", changeableInGovernance: true, brokerEnforced: false },
  MISSING_TAKE_PROFIT: { category: "GOVERNANCE", userReason: "A take profit is required.", adminReason: "requireTakeProfit is ON in governance.", changeableInGovernance: true, brokerEnforced: false },
  SYMBOL_NOT_ALLOWED: { category: "GOVERNANCE", userReason: "This symbol is not on your allowlist.", adminReason: "Governance symbol allowlist/blocklist.", changeableInGovernance: true, brokerEnforced: false },
  VOLUME_EXCEEDS_MARKET_MAX_LOT: { category: "GOVERNANCE", userReason: "Lot size exceeds the configured maximum.", adminReason: "Governance per-trade lot cap.", changeableInGovernance: true, brokerEnforced: false },
  VOLUME_EXCEEDS_USER_MAX_LOT: { category: "GOVERNANCE", userReason: "Lot size exceeds your armed maximum.", adminReason: "Per-user armed max lot.", changeableInGovernance: true, brokerEnforced: false },
  "LIVE_BLOCKED:DAILY_LOSS_LIMIT_REACHED": { category: "GOVERNANCE", userReason: "Daily loss limit reached.", adminReason: "Governance daily-loss cap.", changeableInGovernance: true, brokerEnforced: false },
  DAILY_LOSS_LIMIT_REACHED: { category: "GOVERNANCE", userReason: "Daily loss limit reached.", adminReason: "Governance daily-loss cap.", changeableInGovernance: true, brokerEnforced: false },
  MAX_OPEN_POSITIONS_REACHED: { category: "GOVERNANCE", userReason: "Maximum open positions reached.", adminReason: "Governance max-open-positions cap.", changeableInGovernance: true, brokerEnforced: false },
  MAX_EXPOSURE_PER_SYMBOL_REACHED: { category: "GOVERNANCE", userReason: "Per-symbol exposure cap reached.", adminReason: "Per-symbol exposure cap.", changeableInGovernance: true, brokerEnforced: false },
  "LIVE_BLOCKED:USER_ALLOCATION_NOT_ASSIGNED": { category: "GOVERNANCE", userReason: "No live allocation assigned to you yet.", adminReason: "No allocation row / assigned 0 — operator must assign.", changeableInGovernance: true, brokerEnforced: false },
  USER_ALLOCATION_NOT_ASSIGNED: { category: "GOVERNANCE", userReason: "No live allocation assigned to you yet.", adminReason: "No allocation row / assigned 0 — operator must assign.", changeableInGovernance: true, brokerEnforced: false },
  "LIVE_BLOCKED:USER_ALLOCATION_EXHAUSTED": { category: "GOVERNANCE", userReason: "Your allocation is exhausted.", adminReason: "Allocation headroom / margin proxy.", changeableInGovernance: true, brokerEnforced: false },
  USER_NOT_ARMED_FOR_LIVE: { category: "GOVERNANCE", userReason: "Live trading is not armed.", adminReason: "User has not armed live.", changeableInGovernance: true, brokerEnforced: false },
  KILL_SWITCH_ENGAGED: { category: "GOVERNANCE", userReason: "Kill switch is engaged.", adminReason: "Kill switch engaged.", changeableInGovernance: true, brokerEnforced: false },

  // ── PHYSICS / broker truth (never app-bypassable) ─────────────────────────
  STOP_LOSS_WRONG_SIDE: { category: "BROKER", userReason: "Your stop loss is on the wrong side of price.", adminReason: "SL sanity (physics) — applies to all profiles.", changeableInGovernance: false, brokerEnforced: true },
  STOP_LOSS_UNREASONABLE: { category: "BROKER", userReason: "Your stop loss looks like a price typo.", adminReason: "SL distance sanity (physics).", changeableInGovernance: false, brokerEnforced: true },
  SYMBOL_NOT_LIVE_TRADABLE: { category: "BROKER", userReason: "This market is data-only and cannot be traded live.", adminReason: "Deriv-synthetic/data-only hard floor.", changeableInGovernance: false, brokerEnforced: true },
  SYNTHETIC_FEED_NOT_LIVE_CONFIRMED: { category: "TECHNICAL", userReason: "This synthetic isn't live-confirmed right now — no fresh tick. Wait for the live feed and try again.", adminReason: "Deriv per-symbol live-tick not confirmed (Task #542 live-entry floor) — transient feed state, not a permanent block.", changeableInGovernance: false, brokerEnforced: false },

  // ── TECHNICAL (bridge / EA / pool readiness) ──────────────────────────────
  "LIVE_BLOCKED:MASTER_BRIDGE_NOT_PINNED": { category: "TECHNICAL", userReason: "Live bridge unavailable. Try again shortly.", adminReason: "Master bridge not pinned.", changeableInGovernance: false, brokerEnforced: false },
  "LIVE_BLOCKED:MASTER_SNAPSHOT_MISSING": { category: "TECHNICAL", userReason: "Live bridge unavailable. Try again shortly.", adminReason: "Master snapshot missing.", changeableInGovernance: false, brokerEnforced: false },
  "LIVE_BLOCKED:MASTER_SNAPSHOT_STALE": { category: "TECHNICAL", userReason: "Live bridge syncing. Try again shortly.", adminReason: "Master snapshot stale.", changeableInGovernance: false, brokerEnforced: false },
  "LIVE_BLOCKED:SHARED_LIVE_PAUSED": { category: "TECHNICAL", userReason: "Live trading is paused for reconciliation.", adminReason: "sharedLivePaused.", changeableInGovernance: false, brokerEnforced: false },
  "LIVE_BLOCKED:ALLOCATION_FROZEN": { category: "TECHNICAL", userReason: "Your allocation is frozen. Contact your operator.", adminReason: "Allocation frozen.", changeableInGovernance: false, brokerEnforced: false },
  EA_HEARTBEAT_STALE: { category: "TECHNICAL", userReason: "Trading bridge is offline.", adminReason: "EA heartbeat > 15s.", changeableInGovernance: false, brokerEnforced: false },
  EA_VERSION_TOO_OLD: { category: "TECHNICAL", userReason: "Trading bridge needs updating.", adminReason: "EA version < 1.27.", changeableInGovernance: false, brokerEnforced: false },
  EA_TERMINAL_NOT_CONNECTED: { category: "TECHNICAL", userReason: "Trading terminal is not connected.", adminReason: "terminalConnected=false.", changeableInGovernance: false, brokerEnforced: false },

  // ── BROKER (EA inputs / account truth) ────────────────────────────────────
  BRIDGE_NOT_LIVE_ACCOUNT: { category: "BROKER", userReason: "The connected account is not a live account.", adminReason: "accountType not live/real.", changeableInGovernance: false, brokerEnforced: true },
  EA_ENABLE_LIVE_EXECUTION_FALSE: { category: "BROKER", userReason: "Live execution is disabled on the bridge.", adminReason: "EA EnableLiveExecution=false.", changeableInGovernance: false, brokerEnforced: true },
  EA_READ_ONLY_MODE_TRUE: { category: "BROKER", userReason: "The bridge is in read-only mode.", adminReason: "EA ReadOnlyMode=true.", changeableInGovernance: false, brokerEnforced: true },
  EA_ALGO_TRADING_NOT_ALLOWED: { category: "BROKER", userReason: "Algo trading is disabled in MT5.", adminReason: "algoTradingAllowed=false.", changeableInGovernance: false, brokerEnforced: true },

  // ── SECURITY (identity / approval) ────────────────────────────────────────
  USER_NOT_LIVE_APPROVED: { category: "SECURITY", userReason: "Your account is not approved for live trading.", adminReason: "Not admin-approved for master live.", changeableInGovernance: false, brokerEnforced: false },
  DISCLOSURE_NOT_ACCEPTED: { category: "SECURITY", userReason: "You must accept the live risk disclosure.", adminReason: "Risk disclosure not accepted.", changeableInGovernance: false, brokerEnforced: false },
  LIVE_BROKER_EXECUTION_DISABLED: { category: "SECURITY", userReason: "Live execution is disabled system-wide.", adminReason: "Server master switch / DB arm flag off.", changeableInGovernance: false, brokerEnforced: false },
  GLOBAL_LIVE_DISABLED: { category: "SECURITY", userReason: "Live execution is disabled system-wide.", adminReason: "Global live disabled.", changeableInGovernance: false, brokerEnforced: false },
};

export function categorizeLiveBlock(reason: string | null | undefined): CategorizedBlock {
  const key = String(reason ?? "").trim();
  const bare = key.startsWith("LIVE_BLOCKED:") ? key.slice("LIVE_BLOCKED:".length) : key;
  const hit = BLOCK_CATEGORY_MAP[key] ?? BLOCK_CATEGORY_MAP[bare];
  if (hit) return { reason: key, ...hit };
  // Unknown reason → default to broker/technical truth (never falsely
  // advertise it as changeable in governance).
  return {
    reason: key,
    category: "BROKER",
    userReason: "Your broker or the trading bridge rejected this order.",
    adminReason: key || "Unclassified live block.",
    changeableInGovernance: false,
    brokerEnforced: true,
  };
}
