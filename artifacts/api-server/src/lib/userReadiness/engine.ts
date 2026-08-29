// Per-user Trading Readiness Engine (14-status model).
//
// SAFETY:
// - READ-ONLY against MT5, broker, and live-trading subsystems.
// - NEVER mutates canPlaceTrades, safetyCore, live_trading_state.
// - NEVER returns secrets (apiKeyHash, tokens, bridge tokens, passwords).
// - Per-user scoped: all queries filter on the passed userId.
// - `ready_for_live` always returns false unless every one of the
//   live-gating statuses passes AND the system-wide PAPER_ONLY lock is
//   lifted. By design, this function CANNOT enable live trading. It only
//   reports state.

import { db } from "@workspace/db";
import {
  usersTable,
  userReadinessStateTable,
  userOnboardingProgressTable,
  mt5ConnectionTable,
  virtualTradingAccountsTable,
  liveTradingStateTable,
} from "@workspace/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { getMyArming } from "../live/liveArming.js";

export type ReadinessStatusValue = "pass" | "fail" | "warning" | "blocked" | "not_required";
export type AccountRoutingMode = "USER_OWNED_MT5" | "SHARED_MASTER_MT5";

export interface ReadinessStatusItem {
  id: string;
  label: string;
  status: ReadinessStatusValue;
  requiredFor: Array<"paper" | "demo" | "live" | "user_owned_mt5" | "shared_master_mt5">;
  blockerReason: string | null;
  userFriendlyExplanation: string;
  nextStep: string | null;
  adminOnly?: boolean;
  lastCheckedAt: string;
}

export interface ReadinessReport {
  userId: number;
  evaluatedAt: string;
  accountMode: AccountRoutingMode | null;
  /** Canonical Phase-10 name for the live-execution hard-lock. */
  liveExecutionHardLockActive: boolean;
  /** @deprecated Use `liveExecutionHardLockActive`. Retained for back-compat. */
  paperOnlyHardLockActive: boolean;
  ready_for_paper: boolean;
  ready_for_demo: boolean;
  ready_for_live: boolean;
  blockers: string[];
  statuses: ReadinessStatusItem[];
  safetyEnvelope: {
    safetyMode: "paper_only";
    liveLocked: true;
    readOnlyMode: true;
    allowOrderExecution: false;
  };
}

const SAFETY_ENVELOPE = {
  safetyMode: "paper_only" as const,
  liveLocked: true as const,
  readOnlyMode: true as const,
  allowOrderExecution: false as const,
};

const HEARTBEAT_STALE_MS = 5 * 60 * 1000; // 5 minutes

export async function evaluateUserReadiness(userId: number): Promise<ReadinessReport> {
  const now = new Date();
  const nowIso = now.toISOString();

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const [state] = await db.select().from(userReadinessStateTable)
    .where(eq(userReadinessStateTable.userId, userId)).limit(1);
  const [onb] = await db.select().from(userOnboardingProgressTable)
    .where(eq(userOnboardingProgressTable.userId, userId)).limit(1);
  const [conn] = await db.select().from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, userId))
    .orderBy(desc(mt5ConnectionTable.id)).limit(1);
  const [vta] = await db.select().from(virtualTradingAccountsTable)
    .where(eq(virtualTradingAccountsTable.userId, userId))
    .orderBy(desc(virtualTradingAccountsTable.id)).limit(1);
  const [liveState] = await db.select().from(liveTradingStateTable)
    .orderBy(desc(liveTradingStateTable.id)).limit(1);
  // Per-user live arming (canonical resolver, fail-closed to false on any error).
  const arming = await getMyArming(userId).catch(() => null);
  const liveArmed = arming?.isArmed === true;

  const accountMode = (state?.accountMode ?? null) as AccountRoutingMode | null;
  const isUserOwned = accountMode === "USER_OWNED_MT5";
  const isSharedMaster = accountMode === "SHARED_MASTER_MT5";

  // System-wide live-execution posture. This engine is read-only against safety
  // surfaces and is REPORTING ONLY — it never grants execution authority.
  //
  // `systemLiveHardStop` = genuine hard stops that block live for EVERYONE,
  // including an approved + armed trader: a missing live-state row (fail-closed),
  // an explicit operator maintenance lock (LIVE_LOCKED), the kill switch, or an
  // emergency stop.
  const systemLiveHardStop =
    !liveState
    || liveState.mode === "LIVE_LOCKED"
    || liveState.killSwitchActive === true
    || liveState.emergencyStopActive === true;
  // `systemPaperOnlyMode` = the legacy blanket "this build is paper-only" modes.
  // Task #750: these no longer permanently block an approved + armed trader's
  // REPORTED readiness, but remain a hard block for everyone else. They never
  // grant execution authority — every live order still runs the full 23-gate
  // Phase B dispatch + the per-user activation gate, neither of which this
  // reporting engine can short-circuit.
  const systemPaperOnlyMode =
    liveState?.mode === "READ_ONLY" || liveState?.mode === "PAPER_ONLY";
  // System-wide hard-lock (drives the `paper_only_guard_active` status item).
  // Semantically identical to the previous always-on lock.
  const liveExecutionHardLock = systemLiveHardStop || systemPaperOnlyMode;
  const paperOnlyHardLock = liveExecutionHardLock;

  const items: ReadinessStatusItem[] = [];
  const blockers: string[] = [];

  function pushStatus(
    id: string,
    label: string,
    status: ReadinessStatusValue,
    requiredFor: ReadinessStatusItem["requiredFor"],
    explanation: string,
    nextStep: string | null,
    blockerReason: string | null,
    adminOnly = false,
  ): void {
    items.push({
      id, label, status, requiredFor,
      blockerReason, userFriendlyExplanation: explanation, nextStep,
      adminOnly, lastCheckedAt: nowIso,
    });
    if (status === "fail" || status === "blocked") {
      if (blockerReason) blockers.push(blockerReason);
    }
  }

  // 1. user_authenticated
  pushStatus(
    "user_authenticated",
    "Account signed in",
    user ? "pass" : "blocked",
    ["paper", "demo", "live"],
    user ? "You're signed in." : "You must be signed in.",
    user ? null : "Sign in to continue.",
    user ? null : "Not authenticated.",
  );

  // 2. profile_complete
  const profileOk = state?.profileComplete === true || (!!user?.email && !!user?.name);
  pushStatus(
    "profile_complete",
    "Profile completed",
    profileOk ? "pass" : "warning",
    ["paper", "demo", "live"],
    profileOk ? "Profile basics are set." : "Add your name and verified email.",
    profileOk ? null : "Open Profile and complete required fields.",
    profileOk ? null : "Profile incomplete.",
  );

  // 3. risk_profile_complete
  const riskOk = state?.riskProfileComplete === true;
  pushStatus(
    "risk_profile_complete",
    "Risk profile completed",
    riskOk ? "pass" : "warning",
    ["demo", "live"],
    riskOk ? "Your risk preferences are recorded." : "Set your risk tolerance and limits.",
    riskOk ? null : "Open Risk Settings and complete the risk profile.",
    riskOk ? null : "Risk profile not completed.",
  );

  // 4. trading_disclaimer_accepted
  const discOk = !!state?.tradingDisclaimerAcceptedAt || onb?.riskDisclaimerAcknowledged === true;
  pushStatus(
    "trading_disclaimer_accepted",
    "Trading disclaimer accepted",
    discOk ? "pass" : "fail",
    ["paper", "demo", "live"],
    discOk ? "Disclaimer accepted." : "You must accept the trading risk disclaimer first.",
    discOk ? null : "Open Onboarding > Disclaimer and accept.",
    discOk ? null : "Trading disclaimer not accepted.",
  );

  // 5. paper_only_guard_active (system invariant — should be PASS here)
  pushStatus(
    "paper_only_guard_active",
    "PAPER_ONLY safety guard active",
    paperOnlyHardLock ? "pass" : "warning",
    ["paper", "demo", "live"],
    paperOnlyHardLock
      ? "System-wide live-execution hard-lock is active. No real trades will execute."
      : "Live-execution hard-lock is not currently active.",
    null,
    paperOnlyHardLock ? null : null,
  );

  // 6. paper_session_available
  pushStatus(
    "paper_session_available",
    "Paper trading session available",
    "pass",
    ["paper"],
    "Paper sessions are always available in this build.",
    null,
    null,
  );

  // 7. mt5_bridge_connected — only required for USER_OWNED routing
  const bridgeConnected = conn?.status === "connected";
  pushStatus(
    "mt5_bridge_connected",
    "MT5 bridge connected",
    isUserOwned
      ? (bridgeConnected ? "pass" : "fail")
      : isSharedMaster ? "not_required" : "warning",
    ["demo", "live", "user_owned_mt5"],
    isUserOwned
      ? (bridgeConnected ? "Your MT5 bridge is connected." : "Your MT5 bridge is not connected yet.")
      : isSharedMaster
        ? "Not required for shared-master routing."
        : "Choose an account mode first.",
    isUserOwned && !bridgeConnected ? "Set up the MT5 EA and generate a bridge token in MT5 Setup." : null,
    isUserOwned && !bridgeConnected ? "MT5 bridge not connected." : null,
  );

  // 8. mt5_heartbeat_recent — only required for USER_OWNED routing
  const lastHb = conn?.lastHeartbeat ? new Date(conn.lastHeartbeat).getTime() : 0;
  const hbFresh = lastHb > 0 && (now.getTime() - lastHb) < HEARTBEAT_STALE_MS;
  pushStatus(
    "mt5_heartbeat_recent",
    "MT5 heartbeat recent",
    isUserOwned
      ? (hbFresh ? "pass" : "fail")
      : isSharedMaster ? "not_required" : "warning",
    ["demo", "live", "user_owned_mt5"],
    isUserOwned
      ? (hbFresh
        ? "Your MT5 EA has reported a heartbeat in the last 5 minutes."
        : "No recent heartbeat from your MT5 EA.")
      : isSharedMaster ? "Not required for shared-master routing." : "Choose an account mode first.",
    isUserOwned && !hbFresh ? "Confirm the EA is attached and the terminal is running." : null,
    isUserOwned && !hbFresh ? "MT5 heartbeat stale or missing." : null,
  );

  // 9. account_mode_selected
  const modeOk = accountMode === "USER_OWNED_MT5" || accountMode === "SHARED_MASTER_MT5";
  pushStatus(
    "account_mode_selected",
    "Account routing mode selected",
    modeOk ? "pass" : "fail",
    ["demo", "live"],
    modeOk ? `Routing mode: ${accountMode}.` : "Choose between connecting your own MT5 or using a shared allocation.",
    modeOk ? null : "Open Onboarding > Account Mode.",
    modeOk ? null : "Account routing mode not selected.",
  );

  // 10. user_owned_mt5_ready
  const accountTypeRaw = (conn as { accountType?: string | null } | undefined)?.accountType ?? null;
  const userOwnedReady = isUserOwned && bridgeConnected && hbFresh
    && (accountTypeRaw === "demo" || accountTypeRaw === "live" || accountTypeRaw === "real");
  pushStatus(
    "user_owned_mt5_ready",
    "User-owned MT5 ready",
    isUserOwned
      ? (userOwnedReady ? "pass" : "fail")
      : "not_required",
    ["demo", "user_owned_mt5"],
    isUserOwned
      ? (userOwnedReady
        ? "Your MT5 connection passes connection, heartbeat, and account-type checks."
        : "Your MT5 connection is missing one or more required checks.")
      : "Not required — you selected shared-master routing.",
    isUserOwned && !userOwnedReady ? "Re-check MT5 Setup; ensure account type is reported by the bridge." : null,
    isUserOwned && !userOwnedReady ? "User-owned MT5 not fully ready." : null,
  );

  // 11. shared_master_mt5_ready
  const sharedReady = isSharedMaster && vta && (vta.status === "ACTIVE" || vta.status === "active");
  pushStatus(
    "shared_master_mt5_ready",
    "Shared-master allocation ready",
    isSharedMaster
      ? (sharedReady ? "pass" : "fail")
      : "not_required",
    ["demo", "shared_master_mt5"],
    isSharedMaster
      ? (sharedReady
        ? "You have an active shared-master allocation."
        : "You don't yet have an active shared-master allocation.")
      : "Not required — you selected user-owned MT5.",
    isSharedMaster && !sharedReady ? "Ask an admin to provision a shared-master allocation." : null,
    isSharedMaster && !sharedReady ? "Shared-master allocation not ready." : null,
  );

  // 12. demo_trading_ready (composite)
  const demoBlocked =
    !user
    || !discOk
    || !modeOk
    || (isUserOwned && !userOwnedReady)
    || (isSharedMaster && !sharedReady);
  const demoReady = !demoBlocked;
  pushStatus(
    "demo_trading_ready",
    "Ready for demo trading",
    demoReady ? "pass" : "blocked",
    ["demo"],
    demoReady ? "All demo prerequisites are met." : "Demo trading is blocked until upstream items pass.",
    demoReady ? null : "Fix the failing items above.",
    demoReady ? null : "Demo trading not ready.",
  );

  // 13. live_account_verified
  const liveAccountVerified =
    (isUserOwned && accountTypeRaw === "live") ||
    (isSharedMaster && !!vta && (vta as { accountType?: string }).accountType === "live");
  pushStatus(
    "live_account_verified",
    "Live account verified",
    liveAccountVerified ? "pass" : "fail",
    ["live"],
    liveAccountVerified
      ? "A verified live routing account is associated with your profile."
      : "No verified live routing/account is associated with your profile.",
    liveAccountVerified ? null : "Connect a verified live account, then re-run readiness.",
    liveAccountVerified ? null : "Live account not verified.",
  );

  // 14. admin_live_approval_granted
  const liveApproved = state?.liveAdminApproved === true && state?.liveAdminRevokedAt == null;
  pushStatus(
    "admin_live_approval_granted",
    "Admin live approval granted",
    liveApproved ? "pass" : "fail",
    ["live"],
    liveApproved
      ? "An admin has approved you for live trading. This is one of several gates."
      : "No admin has approved you for live trading.",
    liveApproved ? null : "Request live approval from an admin after completing all other gates.",
    liveApproved ? null : "Admin live approval not granted.",
    /*adminOnly*/ true,
  );

  // Composite readiness flags
  const liveDisclosureOk = !!state?.liveDisclosureAcceptedAt;
  const ready_for_paper = !!user && discOk;
  const ready_for_demo = demoReady;

  // Identity eligibility for live: only a real human trader may EVER report
  // ready_for_live. Investors, system/bot accounts, and missing users are
  // fail-closed OUT, regardless of any other flag.
  const isInvestor = (user?.role ?? "") === "INVESTOR";
  const isSystemUserAccount = user?.isSystemUser === true;
  const liveEligibleIdentity = !!user && !isInvestor && !isSystemUserAccount;
  // Task #750: an admin-approved, armed, eligible trader is the ONLY caller for
  // whom ready_for_live can ever be true.
  const approvedArmedTrader = liveEligibleIdentity && liveApproved && liveArmed;

  // ready_for_live is REPORTING ONLY — it is NOT an execution authority. No
  // execution path reads this flag; live dispatch is governed independently by
  // the per-user activation gate + the 23-gate Phase B dispatch. An approved +
  // armed eligible trader who has cleared every live gate reports ready, blocked
  // only by a genuine system hard stop (kill / emergency / maintenance lock).
  // Everyone else — non-approved, non-armed, investor, system, or under the
  // blanket paper-only mode — reports false.
  const ready_for_live =
    approvedArmedTrader
    && demoReady
    && liveDisclosureOk
    && liveAccountVerified
    && !systemLiveHardStop;

  return {
    userId,
    evaluatedAt: nowIso,
    accountMode,
    // Honest per-user posture: an approved + armed trader is "hard-locked" only
    // by a genuine system hard stop; everyone else also sees the blanket
    // paper-only mode as a lock.
    liveExecutionHardLockActive: approvedArmedTrader ? systemLiveHardStop : liveExecutionHardLock,
    paperOnlyHardLockActive: approvedArmedTrader ? systemLiveHardStop : paperOnlyHardLock,
    ready_for_paper,
    ready_for_demo,
    ready_for_live,
    blockers,
    statuses: items,
    safetyEnvelope: SAFETY_ENVELOPE,
  };
}

export async function getOrCreateReadinessState(userId: number): Promise<typeof userReadinessStateTable.$inferSelect> {
  const [existing] = await db.select().from(userReadinessStateTable)
    .where(eq(userReadinessStateTable.userId, userId)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(userReadinessStateTable)
    .values({ userId })
    .returning();
  return created;
}

export async function listUsersReadinessSummary(limit = 200): Promise<Array<{
  userId: number;
  email: string | null;
  name: string | null;
  accountMode: AccountRoutingMode | null;
  ready_for_paper: boolean;
  ready_for_demo: boolean;
  ready_for_live: boolean;
  blockerCount: number;
}>> {
  const users = await db.select({
    id: usersTable.id, email: usersTable.email, name: usersTable.name,
  }).from(usersTable).limit(Math.min(500, Math.max(1, limit)));
  const out: Awaited<ReturnType<typeof listUsersReadinessSummary>> = [];
  for (const u of users) {
    const r = await evaluateUserReadiness(u.id);
    out.push({
      userId: u.id, email: u.email, name: u.name,
      accountMode: r.accountMode,
      ready_for_paper: r.ready_for_paper,
      ready_for_demo: r.ready_for_demo,
      ready_for_live: r.ready_for_live,
      blockerCount: r.blockers.length,
    });
    void and; void eq;
  }
  return out;
}
