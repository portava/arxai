// ARX Fund Book — Capital movements & fee engine service (Task #132).
//
// SAFETY (inviolable):
// - This service NEVER touches any execution path, lot sizing, the 16-gate live
//   pipeline, kill switch, or any broker dispatch surface. It drives an
//   accounting workflow (deposit/withdrawal request → approval → settle) that
//   issues/redeems UNITS through the Fund Book NAV engine only.
// - The official NAV is NEVER discounted to fund a withdrawal. Every fee is a
//   transparent fund_book_fee_entries row.
// - Units issue ONLY on a settled deposit and redeem ONLY on an approved
//   withdrawal. Every mutation runs inside ONE db.transaction together with a
//   fail-closed admin_action_audit_log row.
// - Strict per-investor scoping: every per-user read is filtered by userId.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  adminActionAuditLogTable,
  strategyPoolsTable,
  strategyPoolNavTable,
  investorPoolHoldingsTable,
  investorStatementsTable,
  usersTable,
  fundCapitalSettingsTable,
  fundCapitalSpeedTiersTable,
  capitalMovementRequestsTable,
  fundBookFeeEntriesTable,
  investorDepositLocksTable,
  investorCapitalPreferencesTable,
  investorDisclosureAcknowledgmentsTable,
  DEFAULT_WITHDRAWAL_PRIORITY,
  type FundCapitalSettings,
  type FundCapitalSpeedTier,
  type CapitalMovementRequest,
  type CapitalMovementStatus,
  type InvestorCapitalPreferences,
  type FeeType,
  type DisclosureType,
} from "@workspace/db";
import {
  ensurePools,
  getPoolByKey,
  issueUnits,
  redeemUnits,
  getHolding,
  type Tx,
} from "./navEngine.js";
import {
  recomputeAndAdvanceTier,
  seedTiersForPool,
  ensureTierState,
  getPoolTierState,
} from "./tierEngine.js";
import { round2, round8 } from "./navMath.js";
import { resolveNavCycle } from "./navCutoff.js";
import {
  computeDepositFees,
  computeWithdrawalFees,
  computeManagementFee,
  computePerformanceFee,
  type SpeedTierFeeConfig,
} from "./feeEngine.js";
import {
  computeLockedVsWithdrawable,
  computeLockUntil,
  type DepositLockRow,
} from "./depositLock.js";
import { resolveWithdrawalPlan, type PoolAvailableValue } from "./withdrawalPriority.js";
import { assertTransition } from "./requestLifecycle.js";
import {
  assertActionAllowed,
  checkDepositCapacity,
  addToWaitlist,
  FundControlError,
} from "./fundControls.js";

export type Admin = { id: number; role: "ADMIN" | "OWNER" };

// Statuses in which a request still reserves capital (not yet terminal).
const OPEN_STATUSES = ["SUBMITTED", "PENDING_REVIEW", "APPROVED", "PROCESSING"] as const;
// June 19 2026 (Task #610): investor deposits are exclusively tier-priced into
// the BALANCED pool — every other target is refused with
// DEPOSIT_TARGET_NOT_ELIGIBLE at request creation. The default MUST therefore
// be BALANCED: the deposit route (`POST /api/me/capital/deposits`) accepts an
// omitted targetPoolKey, so any other default would make every default-target
// deposit request impossible.
const DEFAULT_DEPOSIT_TARGET = "BALANCED";

// ── Errors ──────────────────────────────────────────────────────────────────
export class CapitalError extends Error {
  constructor(
    public code: string,
    public httpStatus = 400,
  ) {
    super(code);
    this.name = "CapitalError";
  }
}

function tierFeeConfig(tier: FundCapitalSpeedTier): SpeedTierFeeConfig {
  return {
    feeMode: tier.feeMode as SpeedTierFeeConfig["feeMode"],
    flatFee: tier.flatFee,
    percentageFee: tier.percentageFee,
    minFee: tier.minFee,
    maxFee: tier.maxFee,
  };
}

async function auditInTx(
  tx: Tx,
  args: {
    admin: Admin;
    action: string;
    targetUserId: number | null;
    beforeState: Record<string, unknown>;
    afterState: Record<string, unknown>;
    reason?: string | null;
  },
): Promise<void> {
  await tx.insert(adminActionAuditLogTable).values({
    adminId: args.admin.id,
    adminRole: args.admin.role,
    action: args.action,
    targetUserId: args.targetUserId,
    beforeState: args.beforeState,
    afterState: args.afterState,
    reason: args.reason ?? null,
  });
}

// ── Config: settings + speed tiers ──────────────────────────────────────────

const DEFAULT_DEPOSIT_TIERS = [
  {
    tierKey: "STANDARD",
    label: "Standard",
    description: "Standard processing at the next NAV cutoff.",
    feeMode: "NONE" as const,
    flatFee: 0,
    percentageFee: 0,
    slaLabel: "2–3 business days",
    estimatedHours: 72,
    sortOrder: 0,
  },
  {
    tierKey: "FAST",
    label: "Fast",
    description: "Expedited processing for a small fee.",
    feeMode: "PERCENTAGE" as const,
    flatFee: 0,
    percentageFee: 1,
    slaLabel: "Same business day",
    estimatedHours: 8,
    sortOrder: 1,
  },
];

const DEFAULT_WITHDRAWAL_TIERS = [
  {
    tierKey: "STANDARD",
    label: "Standard",
    description: "Standard processing at the next NAV cutoff.",
    feeMode: "NONE" as const,
    flatFee: 0,
    percentageFee: 0,
    minFee: null as number | null,
    slaLabel: "3–5 business days",
    estimatedHours: 120,
    requiresDisclosure: false,
    disclosureType: null as string | null,
    sortOrder: 0,
  },
  {
    tierKey: "PRIORITY",
    label: "Priority",
    description: "Faster processing for a small fee.",
    feeMode: "PERCENTAGE" as const,
    flatFee: 0,
    percentageFee: 0.5,
    minFee: null as number | null,
    slaLabel: "1–2 business days",
    estimatedHours: 48,
    requiresDisclosure: false,
    disclosureType: null as string | null,
    sortOrder: 1,
  },
  {
    tierKey: "RUSH",
    label: "Rush",
    description: "Same-day processing for an expedited fee.",
    feeMode: "PERCENTAGE" as const,
    flatFee: 0,
    percentageFee: 1.5,
    minFee: 25 as number | null,
    slaLabel: "Same business day",
    estimatedHours: 8,
    requiresDisclosure: true,
    disclosureType: "RUSH_WITHDRAWAL" as string | null,
    sortOrder: 2,
  },
  {
    tierKey: "FULL_IMMEDIATE_EXIT",
    label: "Full immediate exit",
    description: "Redeem all units immediately; locks future allocation.",
    feeMode: "BOTH" as const,
    flatFee: 50,
    percentageFee: 1,
    minFee: null as number | null,
    slaLabel: "Same business day",
    estimatedHours: 8,
    requiresDisclosure: true,
    disclosureType: "FULL_EXIT" as string | null,
    sortOrder: 3,
  },
  {
    tierKey: "EMERGENCY",
    label: "Emergency",
    description: "Fastest possible processing for an emergency fee.",
    feeMode: "PERCENTAGE" as const,
    flatFee: 0,
    percentageFee: 3,
    minFee: 100 as number | null,
    slaLabel: "Within hours",
    estimatedHours: 4,
    requiresDisclosure: true,
    disclosureType: "RUSH_WITHDRAWAL" as string | null,
    sortOrder: 4,
  },
];

/**
 * Seed the singleton settings row + the default speed tiers if missing.
 * Idempotent — only inserts what is absent.
 */
export async function ensureCapitalConfig(): Promise<{
  settings: FundCapitalSettings;
  tiers: FundCapitalSpeedTier[];
}> {
  await ensurePools();

  const existing = await db
    .select()
    .from(fundCapitalSettingsTable)
    .where(eq(fundCapitalSettingsTable.scope, "GLOBAL"))
    .limit(1);
  let settings = existing[0];
  if (!settings) {
    const ins = await db
      .insert(fundCapitalSettingsTable)
      .values({ scope: "GLOBAL" })
      .onConflictDoNothing({ target: fundCapitalSettingsTable.scope })
      .returning();
    settings =
      ins[0] ??
      (
        await db
          .select()
          .from(fundCapitalSettingsTable)
          .where(eq(fundCapitalSettingsTable.scope, "GLOBAL"))
          .limit(1)
      )[0]!;
  }

  const tiers = await db.select().from(fundCapitalSpeedTiersTable);
  const have = new Set(tiers.map((t) => `${t.movementType}:${t.tierKey}`));
  const toInsert: (typeof fundCapitalSpeedTiersTable.$inferInsert)[] = [];
  for (const t of DEFAULT_DEPOSIT_TIERS) {
    if (!have.has(`DEPOSIT:${t.tierKey}`)) {
      toInsert.push({ movementType: "DEPOSIT", ...t });
    }
  }
  for (const t of DEFAULT_WITHDRAWAL_TIERS) {
    if (!have.has(`WITHDRAWAL:${t.tierKey}`)) {
      toInsert.push({ movementType: "WITHDRAWAL", ...t });
    }
  }
  if (toInsert.length > 0) {
    await db
      .insert(fundCapitalSpeedTiersTable)
      .values(toInsert)
      .onConflictDoNothing();
  }

  const allTiers = await db
    .select()
    .from(fundCapitalSpeedTiersTable)
    .orderBy(fundCapitalSpeedTiersTable.movementType, fundCapitalSpeedTiersTable.sortOrder);
  return { settings, tiers: allTiers };
}

export async function getCapitalSettings(): Promise<FundCapitalSettings> {
  const { settings } = await ensureCapitalConfig();
  return settings;
}

export async function listSpeedTiers(
  movementType?: "DEPOSIT" | "WITHDRAWAL",
): Promise<FundCapitalSpeedTier[]> {
  const { tiers } = await ensureCapitalConfig();
  const active = tiers.filter((t) => t.active);
  return movementType ? active.filter((t) => t.movementType === movementType) : active;
}

async function getSpeedTierOrThrow(
  movementType: "DEPOSIT" | "WITHDRAWAL",
  tierKey: string,
): Promise<FundCapitalSpeedTier> {
  const tiers = await listSpeedTiers(movementType);
  const tier = tiers.find((t) => t.tierKey === tierKey);
  if (!tier) throw new CapitalError("SPEED_TIER_NOT_FOUND", 404);
  return tier;
}

export async function updateCapitalSettings(
  admin: Admin,
  patch: Partial<{
    navCutoffHour: number;
    navCutoffMinute: number;
    navCutoffTimezone: string;
    depositLockDays: number;
    withdrawalPriority: string[];
    managementFeeAnnualPct: number;
    performanceFeePct: number;
    liquidityFeePct: number;
    minDepositAmount: number;
    minWithdrawalAmount: number;
    disclosureVersion: string;
  }>,
  reason: string,
): Promise<FundCapitalSettings> {
  const before = await getCapitalSettings();
  return db.transaction(async (tx) => {
    const upd = await tx
      .update(fundCapitalSettingsTable)
      .set({ ...patch, updatedByAdminId: admin.id })
      .where(eq(fundCapitalSettingsTable.scope, "GLOBAL"))
      .returning();
    await auditInTx(tx, {
      admin,
      action: "FUNDBOOK_CAPITAL_SETTINGS_UPDATE",
      targetUserId: null,
      beforeState: { ...before },
      afterState: { ...patch },
      reason,
    });
    return upd[0]!;
  });
}

export async function upsertSpeedTier(
  admin: Admin,
  data: typeof fundCapitalSpeedTiersTable.$inferInsert,
  reason: string,
): Promise<FundCapitalSpeedTier> {
  return db.transaction(async (tx) => {
    const upd = await tx
      .insert(fundCapitalSpeedTiersTable)
      .values(data)
      .onConflictDoUpdate({
        target: [fundCapitalSpeedTiersTable.movementType, fundCapitalSpeedTiersTable.tierKey],
        set: {
          label: data.label,
          description: data.description,
          feeMode: data.feeMode,
          flatFee: data.flatFee,
          percentageFee: data.percentageFee,
          minFee: data.minFee,
          maxFee: data.maxFee,
          slaLabel: data.slaLabel,
          estimatedHours: data.estimatedHours,
          requiresDisclosure: data.requiresDisclosure,
          disclosureType: data.disclosureType,
          sortOrder: data.sortOrder,
          active: data.active,
        },
      })
      .returning();
    await auditInTx(tx, {
      admin,
      action: "FUNDBOOK_CAPITAL_SPEED_TIER_UPSERT",
      targetUserId: null,
      beforeState: {},
      afterState: { movementType: data.movementType, tierKey: data.tierKey },
      reason,
    });
    return upd[0]!;
  });
}

// ── Valuation / available balance ───────────────────────────────────────────

export interface PoolValuation {
  poolKey: string;
  strategyPoolId: number;
  unitsOwned: number;
  navPerUnit: number;
  value: number;
  /** Locked principal attributed to this pool (future-dated locks). */
  lockedPrincipal: number;
  /** value − lockedPrincipal, floored at 0. */
  availableValue: number;
}

export interface InvestorValuation {
  totalValue: number;
  lockedPrincipal: number;
  withdrawableValue: number;
  /** Value reserved by other open withdrawal requests. */
  reservedValue: number;
  /** withdrawableValue − reservedValue, floored at 0. */
  availableForWithdrawal: number;
  nextLockReleaseAt: Date | null;
  pools: PoolValuation[];
}

async function loadValuation(
  runner: Tx | typeof db,
  userId: number,
  now: Date,
  opts: { excludeRequestId?: number } = {},
): Promise<InvestorValuation> {
  const [pools, navRows, holdings, locks, openWithdrawals] = await Promise.all([
    runner.select().from(strategyPoolsTable),
    runner.select().from(strategyPoolNavTable),
    runner
      .select()
      .from(investorPoolHoldingsTable)
      .where(eq(investorPoolHoldingsTable.userId, userId)),
    runner
      .select()
      .from(investorDepositLocksTable)
      .where(eq(investorDepositLocksTable.userId, userId)),
    runner
      .select()
      .from(capitalMovementRequestsTable)
      .where(
        and(
          eq(capitalMovementRequestsTable.userId, userId),
          eq(capitalMovementRequestsTable.movementType, "WITHDRAWAL"),
          inArray(capitalMovementRequestsTable.status, [...OPEN_STATUSES]),
        ),
      ),
  ]);

  const navByPool = new Map(navRows.map((n) => [n.strategyPoolId, n]));
  const poolById = new Map(pools.map((p) => [p.id, p]));

  // Per-pool locked principal from future-dated LOCKED rows.
  const lockedByPool = new Map<number, number>();
  const lockRows: DepositLockRow[] = [];
  for (const l of locks) {
    lockRows.push({
      principalAmount: l.principalAmount,
      lockUntil: l.lockUntil,
      status: l.status,
    });
    if (l.status === "LOCKED" && l.lockUntil.getTime() > now.getTime() && l.strategyPoolId) {
      lockedByPool.set(
        l.strategyPoolId,
        round2((lockedByPool.get(l.strategyPoolId) ?? 0) + Math.max(0, l.principalAmount)),
      );
    }
  }

  const poolValuations: PoolValuation[] = [];
  let totalValue = 0;
  for (const h of holdings) {
    if (h.unitsOwned <= 0) continue;
    const nav = navByPool.get(h.strategyPoolId);
    const pool = poolById.get(h.strategyPoolId);
    if (!nav || !pool) continue;
    const value = round2(h.unitsOwned * nav.navPerUnit);
    totalValue = round2(totalValue + value);
    const lockedPrincipal = round2(Math.min(lockedByPool.get(h.strategyPoolId) ?? 0, value));
    poolValuations.push({
      poolKey: pool.poolKey,
      strategyPoolId: h.strategyPoolId,
      unitsOwned: round8(h.unitsOwned),
      navPerUnit: nav.navPerUnit,
      value,
      lockedPrincipal,
      availableValue: round2(Math.max(0, value - lockedPrincipal)),
    });
  }

  const split = computeLockedVsWithdrawable(totalValue, lockRows, now);
  const reservedValue = round2(
    openWithdrawals
      .filter((r) => r.id !== opts.excludeRequestId)
      .reduce((s, r) => s + Math.max(0, r.grossAmount), 0),
  );
  const availableForWithdrawal = round2(Math.max(0, split.withdrawableValue - reservedValue));

  return {
    totalValue,
    lockedPrincipal: split.lockedPrincipal,
    withdrawableValue: split.withdrawableValue,
    reservedValue,
    availableForWithdrawal,
    nextLockReleaseAt: split.nextReleaseAt,
    pools: poolValuations,
  };
}

export async function getInvestorValuation(userId: number): Promise<InvestorValuation> {
  await ensureCapitalConfig();
  return loadValuation(db, userId, new Date());
}

// ── Previews ────────────────────────────────────────────────────────────────

export async function previewDeposit(input: {
  grossAmount: number;
  speedTierKey: string;
}): Promise<{
  grossAmount: number;
  speedFee: number;
  totalFee: number;
  netAmount: number;
  tier: FundCapitalSpeedTier;
}> {
  const settings = await getCapitalSettings();
  if (input.grossAmount <= 0) throw new CapitalError("AMOUNT_NOT_POSITIVE");
  if (input.grossAmount < settings.minDepositAmount) {
    throw new CapitalError("BELOW_MIN_DEPOSIT");
  }
  const tier = await getSpeedTierOrThrow("DEPOSIT", input.speedTierKey);
  const breakdown = computeDepositFees({
    grossAmount: input.grossAmount,
    tier: tierFeeConfig(tier),
  });
  return {
    grossAmount: breakdown.grossAmount,
    speedFee: breakdown.speedFee,
    totalFee: breakdown.totalFee,
    netAmount: breakdown.netAmount,
    tier,
  };
}

export async function previewWithdrawal(input: {
  userId: number;
  grossAmount: number;
  speedTierKey: string;
  isFullExit?: boolean;
}): Promise<{
  grossAmount: number;
  speedFee: number;
  liquidityFee: number;
  performanceFee: number;
  totalFee: number;
  netAmount: number;
  availableForWithdrawal: number;
  fullyCovered: boolean;
  tier: FundCapitalSpeedTier;
}> {
  const settings = await getCapitalSettings();
  const tier = await getSpeedTierOrThrow("WITHDRAWAL", input.speedTierKey);
  const valuation = await getInvestorValuation(input.userId);

  const grossAmount = input.isFullExit ? valuation.totalValue : round2(input.grossAmount);
  if (grossAmount <= 0) throw new CapitalError("AMOUNT_NOT_POSITIVE");
  if (!input.isFullExit && grossAmount < settings.minWithdrawalAmount) {
    throw new CapitalError("BELOW_MIN_WITHDRAWAL");
  }

  // Realized-gain proxy for the performance fee: gain above cost (only positive).
  const fullyCovered = input.isFullExit
    ? true
    : grossAmount <= valuation.availableForWithdrawal + 1e-6;

  const breakdown = computeWithdrawalFees({
    grossAmount,
    tier: tierFeeConfig(tier),
    liquidityFeePct: settings.liquidityFeePct,
    performanceFeePct: settings.performanceFeePct,
    performanceGainAboveHighWater: 0,
  });

  return {
    grossAmount,
    speedFee: breakdown.speedFee,
    liquidityFee: breakdown.liquidityFee,
    performanceFee: breakdown.performanceFee,
    totalFee: breakdown.totalFee,
    netAmount: breakdown.netAmount,
    availableForWithdrawal: valuation.availableForWithdrawal,
    fullyCovered,
    tier,
  };
}

// ── Disclosure enforcement helper ───────────────────────────────────────────

async function ensureDisclosure(
  tx: Tx,
  userId: number,
  disclosureType: DisclosureType,
  version: string,
  requestId: number | null,
  acknowledge: boolean,
): Promise<void> {
  const existing = await tx
    .select({ id: investorDisclosureAcknowledgmentsTable.id })
    .from(investorDisclosureAcknowledgmentsTable)
    .where(
      and(
        eq(investorDisclosureAcknowledgmentsTable.userId, userId),
        eq(investorDisclosureAcknowledgmentsTable.disclosureType, disclosureType),
        eq(investorDisclosureAcknowledgmentsTable.version, version),
      ),
    )
    .limit(1);
  if (existing[0]) return;
  if (!acknowledge) throw new CapitalError(`DISCLOSURE_REQUIRED:${disclosureType}`, 409);
  await tx.insert(investorDisclosureAcknowledgmentsTable).values({
    userId,
    disclosureType,
    version,
    capitalMovementRequestId: requestId,
  });
}

// ── Create requests ─────────────────────────────────────────────────────────

export async function createDepositRequest(input: {
  userId: number;
  grossAmount: number;
  speedTierKey: string;
  targetPoolKey?: string | null;
  requestNote?: string | null;
  acknowledgeDisclosures?: boolean;
}): Promise<CapitalMovementRequest> {
  const settings = await getCapitalSettings();
  const preview = await previewDeposit({
    grossAmount: input.grossAmount,
    speedTierKey: input.speedTierKey,
  });

  const targetPoolKey = (input.targetPoolKey ?? DEFAULT_DEPOSIT_TARGET).toUpperCase();
  const pool = await getPoolByKey(targetPoolKey);
  if (!pool) throw new CapitalError("TARGET_POOL_NOT_FOUND", 404);
  // Tier-based pricing is exclusive to the BALANCED pool; investor deposits
  // to any other pool are refused at request-creation time.
  if (pool.poolKey !== "BALANCED") throw new CapitalError("DEPOSIT_TARGET_NOT_ELIGIBLE", 400);
  if (pool.frozen) throw new CapitalError("TARGET_POOL_FROZEN", 409);

  // Fund-control freezes (Task #133): refuse new deposits while the DEPOSITS
  // scope, this investor, or the target pool is frozen for verification.
  await assertActionAllowed(["DEPOSITS"]);
  await assertActionAllowed(["INVESTOR"], { scopeKey: String(input.userId) });
  await assertActionAllowed(["POOL"], { scopeKey: targetPoolKey });

  // Capacity routing (Task #133): if the target pool is at/over capacity (or an
  // admin paused/closed it), refuse the direct deposit and — when a waitlist or
  // cash-reserve route applies — record the routing row with a clean message.
  const [navForCap, fundValueRow, investorValuation] = await Promise.all([
    db
      .select({ v: strategyPoolNavTable.totalPoolValue })
      .from(strategyPoolNavTable)
      .where(eq(strategyPoolNavTable.strategyPoolId, pool.id))
      .limit(1)
      .then((r) => r[0]),
    db
      .select({
        v: sql<number>`coalesce(sum(${strategyPoolNavTable.totalPoolValue}), 0)`,
      })
      .from(strategyPoolNavTable)
      .then((r) => r[0]),
    loadValuation(db, input.userId, new Date()),
  ]);
  const capacity = await checkDepositCapacity({
    poolKey: targetPoolKey,
    currentValue: navForCap?.v ?? 0,
    depositAmount: preview.netAmount,
    fundCurrentValue: Number(fundValueRow?.v ?? 0),
    investorCurrentValue: investorValuation.totalValue,
  });
  if (!capacity.allowed) {
    if (capacity.routedTo === "WAITLIST" || capacity.routedTo === "CASH_RESERVE") {
      await addToWaitlist({
        userId: input.userId,
        strategyPoolId: pool.id,
        poolKey: targetPoolKey,
        requestedAmount: preview.netAmount,
        status: capacity.routedTo === "WAITLIST" ? "WAITLISTED" : "ROUTED_CASH_RESERVE",
        investorMessage: capacity.investorMessage,
        reason: `Capacity routing: pool ${capacity.status}.`,
      });
    }
    throw new FundControlError("POOL_AT_CAPACITY", 409, capacity.investorMessage);
  }

  return db.transaction(async (tx) => {
    // Refuse new deposits while allocation is locked by a prior full exit.
    const prefs = await tx
      .select({ allocationLocked: investorCapitalPreferencesTable.allocationLocked })
      .from(investorCapitalPreferencesTable)
      .where(eq(investorCapitalPreferencesTable.userId, input.userId))
      .limit(1);
    if (prefs[0]?.allocationLocked) throw new CapitalError("ALLOCATION_LOCKED", 409);

    if (preview.tier.requiresDisclosure && preview.tier.disclosureType) {
      await ensureDisclosure(
        tx,
        input.userId,
        preview.tier.disclosureType as DisclosureType,
        settings.disclosureVersion,
        null,
        input.acknowledgeDisclosures ?? false,
      );
    }

    const ins = await tx
      .insert(capitalMovementRequestsTable)
      .values({
        userId: input.userId,
        movementType: "DEPOSIT",
        status: "SUBMITTED",
        grossAmount: preview.grossAmount,
        speedTierKey: preview.tier.tierKey,
        speedFeeAmount: preview.speedFee,
        otherFeesAmount: 0,
        totalFeeAmount: preview.totalFee,
        netAmount: preview.netAmount,
        targetPoolKey,
        requestNote: input.requestNote ?? null,
        feeBreakdown: {
          kind: "DEPOSIT",
          grossAmount: preview.grossAmount,
          speedFee: preview.speedFee,
          totalFee: preview.totalFee,
          netAmount: preview.netAmount,
          tierKey: preview.tier.tierKey,
        },
      })
      .returning();
    return advanceToPendingReview(tx, ins[0]!);
  });
}

export async function createWithdrawalRequest(input: {
  userId: number;
  grossAmount: number;
  speedTierKey: string;
  isFullExit?: boolean;
  requestNote?: string | null;
  acknowledgeDisclosures?: boolean;
}): Promise<CapitalMovementRequest> {
  const settings = await getCapitalSettings();
  const isFullExit = input.isFullExit ?? false;

  return db.transaction(async (tx) => {
    const now = new Date();
    const tier = (await listSpeedTiers("WITHDRAWAL")).find(
      (t) => t.tierKey === input.speedTierKey,
    );
    if (!tier) throw new CapitalError("SPEED_TIER_NOT_FOUND", 404);

    // Fund-control freezes (Task #133): refuse new withdrawals while the
    // WITHDRAWALS scope or this investor is frozen for verification.
    await assertActionAllowed(["WITHDRAWALS"], { reader: tx });
    await assertActionAllowed(["INVESTOR"], { scopeKey: String(input.userId), reader: tx });

    const valuation = await loadValuation(tx, input.userId, now);
    if (valuation.totalValue <= 0) throw new CapitalError("NO_HOLDINGS", 409);

    const grossAmount = isFullExit ? valuation.totalValue : round2(input.grossAmount);
    if (grossAmount <= 0) throw new CapitalError("AMOUNT_NOT_POSITIVE");
    if (!isFullExit && grossAmount < settings.minWithdrawalAmount) {
      throw new CapitalError("BELOW_MIN_WITHDRAWAL");
    }

    // Reservation gate: cannot withdraw more than is available right now.
    if (!isFullExit && grossAmount > valuation.availableForWithdrawal + 1e-6) {
      throw new CapitalError("WITHDRAWAL_EXCEEDS_AVAILABLE", 409);
    }
    // A full exit while principal is locked requires an immediate-exit tier.
    if (isFullExit && valuation.lockedPrincipal > 0 && !tier.requiresDisclosure) {
      throw new CapitalError("FULL_EXIT_REQUIRES_IMMEDIATE_TIER", 409);
    }

    // Disclosures: tier-required + an explicit FULL_EXIT ack for full exits.
    if (tier.requiresDisclosure && tier.disclosureType) {
      await ensureDisclosure(
        tx,
        input.userId,
        tier.disclosureType as DisclosureType,
        settings.disclosureVersion,
        null,
        input.acknowledgeDisclosures ?? false,
      );
    }
    if (isFullExit) {
      await ensureDisclosure(
        tx,
        input.userId,
        "FULL_EXIT",
        settings.disclosureVersion,
        null,
        input.acknowledgeDisclosures ?? false,
      );
    }

    const breakdown = computeWithdrawalFees({
      grossAmount,
      tier: tierFeeConfig(tier),
      liquidityFeePct: settings.liquidityFeePct,
      performanceFeePct: settings.performanceFeePct,
      performanceGainAboveHighWater: 0,
    });

    // Reserve units (approximate, for display) from the plan legs.
    const plan = resolveWithdrawalPlan(
      grossAmount,
      settings.withdrawalPriority ?? [...DEFAULT_WITHDRAWAL_PRIORITY],
      valuation.pools.map<PoolAvailableValue>((p) => ({
        poolKey: p.poolKey,
        strategyPoolId: p.strategyPoolId,
        availableValue: isFullExit ? p.value : p.availableValue,
      })),
    );
    let reservedUnits = 0;
    for (const leg of plan.legs) {
      const pv = valuation.pools.find((p) => p.strategyPoolId === leg.strategyPoolId);
      if (pv && pv.navPerUnit > 0) reservedUnits = round8(reservedUnits + leg.amount / pv.navPerUnit);
    }

    const ins = await tx
      .insert(capitalMovementRequestsTable)
      .values({
        userId: input.userId,
        movementType: "WITHDRAWAL",
        status: "SUBMITTED",
        grossAmount,
        speedTierKey: tier.tierKey,
        speedFeeAmount: breakdown.speedFee,
        otherFeesAmount: round2(breakdown.liquidityFee + breakdown.performanceFee),
        totalFeeAmount: breakdown.totalFee,
        netAmount: breakdown.netAmount,
        isFullExit,
        reservedUnits,
        requestNote: input.requestNote ?? null,
        feeBreakdown: {
          kind: "WITHDRAWAL",
          grossAmount,
          speedFee: breakdown.speedFee,
          liquidityFee: breakdown.liquidityFee,
          performanceFee: breakdown.performanceFee,
          totalFee: breakdown.totalFee,
          netAmount: breakdown.netAmount,
          tierKey: tier.tierKey,
          isFullExit,
        },
      })
      .returning();
    return advanceToPendingReview(tx, ins[0]!);
  });
}

// ── Investor reads ──────────────────────────────────────────────────────────

export async function listInvestorRequests(
  userId: number,
  filter?: { movementType?: "DEPOSIT" | "WITHDRAWAL"; status?: string },
): Promise<CapitalMovementRequest[]> {
  const conds = [eq(capitalMovementRequestsTable.userId, userId)];
  if (filter?.movementType) {
    conds.push(eq(capitalMovementRequestsTable.movementType, filter.movementType));
  }
  if (filter?.status) conds.push(eq(capitalMovementRequestsTable.status, filter.status));
  return db
    .select()
    .from(capitalMovementRequestsTable)
    .where(and(...conds))
    .orderBy(desc(capitalMovementRequestsTable.createdAt));
}

export async function getInvestorRequest(
  userId: number,
  requestId: number,
): Promise<CapitalMovementRequest | null> {
  const rows = await db
    .select()
    .from(capitalMovementRequestsTable)
    .where(
      and(
        eq(capitalMovementRequestsTable.id, requestId),
        eq(capitalMovementRequestsTable.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listInvestorFeeEntries(userId: number) {
  return db
    .select()
    .from(fundBookFeeEntriesTable)
    .where(eq(fundBookFeeEntriesTable.userId, userId))
    .orderBy(desc(fundBookFeeEntriesTable.createdAt));
}

export async function listInvestorLocks(userId: number) {
  return db
    .select()
    .from(investorDepositLocksTable)
    .where(eq(investorDepositLocksTable.userId, userId))
    .orderBy(desc(investorDepositLocksTable.lockUntil));
}

/** Investor cancels their own non-terminal request. Releases the reservation. */
export async function cancelRequest(
  userId: number,
  requestId: number,
): Promise<CapitalMovementRequest> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(capitalMovementRequestsTable)
      .where(
        and(
          eq(capitalMovementRequestsTable.id, requestId),
          eq(capitalMovementRequestsTable.userId, userId),
        ),
      )
      .for("update")
      .limit(1);
    const reqRow = rows[0];
    if (!reqRow) throw new CapitalError("REQUEST_NOT_FOUND", 404);
    ensureTransition(reqRow.status, "CANCELLED");
    const upd = await tx
      .update(capitalMovementRequestsTable)
      .set({ status: "CANCELLED", reservedUnits: 0 })
      .where(eq(capitalMovementRequestsTable.id, requestId))
      .returning();
    return upd[0]!;
  });
}

// ── Admin lifecycle ─────────────────────────────────────────────────────────

export async function listAllRequests(filter?: {
  movementType?: "DEPOSIT" | "WITHDRAWAL";
  status?: string;
  userId?: number;
}): Promise<CapitalMovementRequest[]> {
  const conds = [];
  if (filter?.movementType) {
    conds.push(eq(capitalMovementRequestsTable.movementType, filter.movementType));
  }
  if (filter?.status) conds.push(eq(capitalMovementRequestsTable.status, filter.status));
  if (filter?.userId) conds.push(eq(capitalMovementRequestsTable.userId, filter.userId));
  const q = db.select().from(capitalMovementRequestsTable);
  const rows = conds.length ? await q.where(and(...conds)) : await q;
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

async function lockRequest(tx: Tx, requestId: number): Promise<CapitalMovementRequest> {
  const rows = await tx
    .select()
    .from(capitalMovementRequestsTable)
    .where(eq(capitalMovementRequestsTable.id, requestId))
    .for("update")
    .limit(1);
  const reqRow = rows[0];
  if (!reqRow) throw new CapitalError("REQUEST_NOT_FOUND", 404);
  return reqRow;
}

/**
 * Enforce the request lifecycle state machine. Translates the pure module's
 * generic error into a domain CapitalError so callers get a 409 rather than an
 * unhandled 500. Every status mutation in this service routes through here.
 */
function ensureTransition(from: string, to: CapitalMovementStatus): void {
  try {
    assertTransition(from as CapitalMovementStatus, to);
  } catch {
    throw new CapitalError(`INVALID_STATUS_TRANSITION:${from}->${to}`, 409);
  }
}

/**
 * On submission a request moves SUBMITTED → PENDING_REVIEW so it lands in the
 * admin review queue. Both hops are validated by the state machine.
 */
async function advanceToPendingReview(
  tx: Tx,
  created: CapitalMovementRequest,
): Promise<CapitalMovementRequest> {
  ensureTransition(created.status, "PENDING_REVIEW");
  const upd = await tx
    .update(capitalMovementRequestsTable)
    .set({ status: "PENDING_REVIEW" })
    .where(eq(capitalMovementRequestsTable.id, created.id))
    .returning();
  return upd[0]!;
}

/** Approve a request: resolves the NAV cutoff cycle and marks it APPROVED. */
export async function approveRequest(
  admin: Admin,
  requestId: number,
  reason: string,
  reviewNote?: string | null,
): Promise<CapitalMovementRequest> {
  const settings = await getCapitalSettings();
  return db.transaction(async (tx) => {
    const reqRow = await lockRequest(tx, requestId);
    ensureTransition(reqRow.status, "APPROVED");
    const approvalAt = new Date();
    const cycle = resolveNavCycle(approvalAt, {
      cutoffHour: settings.navCutoffHour,
      cutoffMinute: settings.navCutoffMinute,
      timeZone: settings.navCutoffTimezone,
    });
    const upd = await tx
      .update(capitalMovementRequestsTable)
      .set({
        status: "APPROVED",
        navCycleTiming: cycle.timing,
        navCutAt: cycle.navCutAt,
        reviewedByAdminId: admin.id,
        reviewedAt: approvalAt,
        reviewNote: reviewNote ?? null,
      })
      .where(eq(capitalMovementRequestsTable.id, requestId))
      .returning();
    await auditInTx(tx, {
      admin,
      action: "FUNDBOOK_CAPITAL_REQUEST_APPROVE",
      targetUserId: reqRow.userId,
      beforeState: { status: reqRow.status },
      afterState: { status: "APPROVED", navCycleTiming: cycle.timing },
      reason,
    });
    return upd[0]!;
  });
}

export async function rejectRequest(
  admin: Admin,
  requestId: number,
  reason: string,
  reviewNote?: string | null,
): Promise<CapitalMovementRequest> {
  return db.transaction(async (tx) => {
    const reqRow = await lockRequest(tx, requestId);
    ensureTransition(reqRow.status, "REJECTED");
    const upd = await tx
      .update(capitalMovementRequestsTable)
      .set({
        status: "REJECTED",
        reservedUnits: 0,
        reviewedByAdminId: admin.id,
        reviewedAt: new Date(),
        reviewNote: reviewNote ?? null,
      })
      .where(eq(capitalMovementRequestsTable.id, requestId))
      .returning();
    await auditInTx(tx, {
      admin,
      action: "FUNDBOOK_CAPITAL_REQUEST_REJECT",
      targetUserId: reqRow.userId,
      beforeState: { status: reqRow.status },
      afterState: { status: "REJECTED" },
      reason,
    });
    return upd[0]!;
  });
}

async function writeFeeEntry(
  tx: Tx,
  args: {
    userId: number;
    requestId: number | null;
    strategyPoolId: number | null;
    feeType: FeeType;
    basisAmount: number;
    amount: number;
    reason: string;
    adminId: number;
    highWaterValueAtCharge?: number | null;
    periodStart?: Date | null;
    periodEnd?: Date | null;
    periodDays?: number | null;
  },
): Promise<void> {
  if (!(args.amount > 0)) return;
  await tx.insert(fundBookFeeEntriesTable).values({
    userId: args.userId,
    capitalMovementRequestId: args.requestId,
    strategyPoolId: args.strategyPoolId,
    feeType: args.feeType,
    feeBasisAmount: round2(args.basisAmount),
    feeAmount: round2(args.amount),
    highWaterValueAtCharge: args.highWaterValueAtCharge ?? null,
    periodStart: args.periodStart ?? null,
    periodEnd: args.periodEnd ?? null,
    periodDays: args.periodDays ?? null,
    reason: args.reason,
    createdByAdminId: args.adminId,
  });
}

/**
 * Settle an APPROVED request. Deposit ⇒ issue units at the official NAV + create
 * the 30-day lock. Withdrawal ⇒ redeem units across the priority order, write
 * every fee entry, and (full exit) produce a final statement + lock allocation.
 */
export async function settleRequest(
  admin: Admin,
  requestId: number,
  reason: string,
): Promise<CapitalMovementRequest> {
  const settings = await getCapitalSettings();
  await ensurePools();
  // Task #612: every finalized-NAV mutation path (deposit AND withdrawal) now
  // recomputes the tier and emits any tier event INSIDE this transaction, so
  // tier-event causality is aligned to the mutation rather than deferred to a
  // post-commit best-effort pass or the next tier read. There is no
  // post-settlement recompute outside the transaction anymore.
  return db.transaction(async (tx) => {
    const reqRow = await lockRequest(tx, requestId);
    if (reqRow.status !== "APPROVED") throw new CapitalError("REQUEST_NOT_APPROVED", 409);
    const settledAt = new Date();

    // Lifecycle: APPROVED → PROCESSING → SETTLED → COMPLETED. Each hop is
    // validated by the state machine and recorded as a distinct audited admin
    // action so the settlement phases are visible in the audit trail.
    ensureTransition(reqRow.status, "PROCESSING");
    await tx
      .update(capitalMovementRequestsTable)
      .set({ status: "PROCESSING", settledByAdminId: admin.id })
      .where(eq(capitalMovementRequestsTable.id, requestId));
    await auditInTx(tx, {
      admin,
      action:
        reqRow.movementType === "DEPOSIT"
          ? "FUNDBOOK_CAPITAL_DEPOSIT_PROCESSING"
          : "FUNDBOOK_CAPITAL_WITHDRAWAL_PROCESSING",
      targetUserId: reqRow.userId,
      beforeState: { status: reqRow.status },
      afterState: { status: "PROCESSING" },
      reason,
    });

    if (reqRow.movementType === "DEPOSIT") {
      const poolKey = (reqRow.targetPoolKey ?? DEFAULT_DEPOSIT_TARGET).toUpperCase();
      const pool = await getPoolByKey(poolKey);
      if (!pool) throw new CapitalError("TARGET_POOL_NOT_FOUND", 404);
      // Defense-in-depth: tier pricing only applies to BALANCED; any legacy or
      // admin-created request targeting another pool is refused at settlement.
      if (pool.poolKey !== "BALANCED") throw new CapitalError("DEPOSIT_TARGET_NOT_ELIGIBLE", 409);
      if (pool.frozen) throw new CapitalError("TARGET_POOL_FROZEN", 409);

      // Fund-control freezes (Task #133): refuse unit issuance while the
      // ISSUANCE scope or the target pool is frozen for verification.
      await assertActionAllowed(["ISSUANCE"], { reader: tx });
      await assertActionAllowed(["POOL"], { scopeKey: poolKey, reader: tx });

      // Issue units on the NET contribution only. The speed fee is recorded as
      // a transparent fund_book_fee_entries row below — it must NOT flow into
      // the pool's feesAccrued, or it would discount the official NAV (the fee
      // was skimmed from the gross before any capital entered the pool, so it
      // was never pool value to begin with).

      // Task #610: Tier-aware share issuance (fail-closed).
      //
      // Recompute the pool's tier state immediately before issuing units so the
      // effective share price reflects the current finalized NAV and active
      // buy-in tier. This uses the PRE-DEPOSIT finalized NAV (correct for
      // pricing — the deposit itself cannot inflate the tier threshold it is
      // settling against).
      //
      // FAIL-CLOSED: if tier state cannot be computed, the settlement is
      // aborted (error propagates). An investor must never be issued units at
      // an indeterminate price. The tier engine errors here propagate as
      // CapitalError or plain Error and roll back the whole transaction.
      await seedTiersForPool(pool.id, tx);
      await ensureTierState(pool.id, tx);
      const _tierResult = await recomputeAndAdvanceTier(pool.id, {
        adminId: admin.id,
        reason: `deposit_settlement:${requestId}`,
        runner: tx,
      });
      const { fundBookPoolTierStateTable } = await import("@workspace/db");
      const tierStateRows = await tx
        .select()
        .from(fundBookPoolTierStateTable)
        .where(eq(fundBookPoolTierStateTable.strategyPoolId, pool.id))
        .limit(1);
      const tierState = tierStateRows[0];
      if (!tierState) {
        // Tier state row must exist after seedTiersForPool + ensureTierState.
        // If it doesn't, abort rather than silently issue at wrong pricing.
        throw new CapitalError("TIER_STATE_UNAVAILABLE", 500);
      }
      const tierCtx: Parameters<typeof issueUnits>[1]["tierContext"] = {
        activeTier: {
          tierNum: tierState.activeTierNum,
          label: tierState.activeTierLabel,
          navMin: 0,
          navMax: null,
          sharePrice: tierState.activePricingMode === "FIXED" ? tierState.activeBuyInPrice : null,
          pricingMode: tierState.activePricingMode as "FIXED" | "DYNAMIC",
        },
        activeBuyInPrice: tierState.activeBuyInPrice,
        finalizedNavPerUnit: tierState.finalizedNavPerUnit,
        finalizedTotalNav: tierState.finalizedTotalNav,
        dynamicGrowthMultiplier: tierState.dynamicGrowthMultiplier,
        dynamicGrowthStepSize: tierState.dynamicGrowthStepSize,
      };

      const issued = await issueUnits(tx, {
        userId: reqRow.userId,
        poolId: pool.id,
        grossAmount: reqRow.netAmount,
        feeAmount: 0,
        reason,
        adminId: admin.id,
        relatedLedgerEntryId: reqRow.id,
        tierContext: tierCtx,
      });

      // Task #610: Second in-tx tier recompute AFTER unit issuance.
      // The pre-issue recompute (above) priced the units correctly using the
      // pre-deposit finalized NAV. This pass runs after units are issued so any
      // tier threshold crossing driven by the newly committed capital is recorded
      // in the tier-event ledger within the SAME transaction. Fail-closed: an
      // error here rolls back the entire settlement — no silent tier-event gaps.
      await recomputeAndAdvanceTier(pool.id, {
        adminId: admin.id,
        reason: `deposit_post_issue:${requestId}`,
        runner: tx,
      });

      await writeFeeEntry(tx, {
        userId: reqRow.userId,
        requestId: reqRow.id,
        strategyPoolId: pool.id,
        feeType: "DEPOSIT_SPEED",
        basisAmount: reqRow.grossAmount,
        amount: reqRow.speedFeeAmount,
        reason,
        adminId: admin.id,
      });

      await tx.insert(investorDepositLocksTable).values({
        userId: reqRow.userId,
        capitalMovementRequestId: reqRow.id,
        strategyPoolId: pool.id,
        principalAmount: issued.netAmount,
        unitsIssued: issued.unitsIssued,
        lockedAt: settledAt,
        lockUntil: computeLockUntil(settledAt, settings.depositLockDays),
      });

      // PROCESSING → SETTLED: units are now issued and the lock is recorded.
      ensureTransition("PROCESSING", "SETTLED");
      await tx
        .update(capitalMovementRequestsTable)
        .set({
          status: "SETTLED",
          settledNavPerUnit: issued.navPerUnit,
          settledUnits: issued.unitsIssued,
          netAmount: issued.netAmount,
          settledByAdminId: admin.id,
          settledAt,
        })
        .where(eq(capitalMovementRequestsTable.id, requestId));
      await auditInTx(tx, {
        admin,
        action: "FUNDBOOK_CAPITAL_DEPOSIT_SETTLED",
        targetUserId: reqRow.userId,
        beforeState: { status: "PROCESSING" },
        afterState: {
          status: "SETTLED",
          poolKey,
          unitsIssued: issued.unitsIssued,
          netAmount: issued.netAmount,
        },
        reason,
      });

      // SETTLED → COMPLETED: the request is fully closed out.
      ensureTransition("SETTLED", "COMPLETED");
      const upd = await tx
        .update(capitalMovementRequestsTable)
        .set({ status: "COMPLETED" })
        .where(eq(capitalMovementRequestsTable.id, requestId))
        .returning();

      await auditInTx(tx, {
        admin,
        action: "FUNDBOOK_CAPITAL_DEPOSIT_SETTLE",
        targetUserId: reqRow.userId,
        beforeState: { status: "SETTLED" },
        afterState: {
          status: "COMPLETED",
          poolKey,
          unitsIssued: issued.unitsIssued,
          netAmount: issued.netAmount,
        },
        reason,
      });
      return upd[0]!;
    }

    // ── WITHDRAWAL ──
    // Fund-control freeze (Task #133): refuse withdrawal settlement while the
    // WITHDRAWALS scope is frozen for verification.
    await assertActionAllowed(["WITHDRAWALS"], { reader: tx });

    const valuation = await loadValuation(tx, reqRow.userId, settledAt, {
      excludeRequestId: reqRow.id,
    });
    if (valuation.totalValue <= 0) throw new CapitalError("NO_HOLDINGS", 409);

    const isFullExit = reqRow.isFullExit;
    let grossRedeemed = 0;
    let unitsRedeemed = 0;
    let realizedGain = 0;
    // Task #612: collect every pool whose finalized NAV changes via redemption
    // here, so we can recompute its tier + emit any tier event in this same
    // transaction (see the recompute loop after the redemptions below).
    const touchedPoolIds = new Set<number>();

    if (isFullExit) {
      for (const pv of valuation.pools) {
        if (pv.unitsOwned <= 0) continue;
        const r = await redeemUnits(tx, {
          userId: reqRow.userId,
          poolId: pv.strategyPoolId,
          units: pv.unitsOwned,
          reason,
          adminId: admin.id,
          relatedLedgerEntryId: reqRow.id,
          useFinalized: true,
        });
        touchedPoolIds.add(pv.strategyPoolId);
        grossRedeemed = round2(grossRedeemed + r.grossValue);
        unitsRedeemed = round8(unitsRedeemed + r.unitsRedeemed);
        realizedGain = round2(realizedGain + r.realizedDelta);
      }
    } else {
      const plan = resolveWithdrawalPlan(
        reqRow.grossAmount,
        settings.withdrawalPriority ?? [...DEFAULT_WITHDRAWAL_PRIORITY],
        valuation.pools.map<PoolAvailableValue>((p) => ({
          poolKey: p.poolKey,
          strategyPoolId: p.strategyPoolId,
          availableValue: p.availableValue,
        })),
      );
      if (!plan.fullyCovered) throw new CapitalError("WITHDRAWAL_EXCEEDS_AVAILABLE", 409);
      for (const leg of plan.legs) {
        const r = await redeemUnits(tx, {
          userId: reqRow.userId,
          poolId: leg.strategyPoolId,
          grossAmount: leg.amount,
          reason,
          adminId: admin.id,
          relatedLedgerEntryId: reqRow.id,
          useFinalized: true,
        });
        touchedPoolIds.add(leg.strategyPoolId);
        grossRedeemed = round2(grossRedeemed + r.grossValue);
        unitsRedeemed = round8(unitsRedeemed + r.unitsRedeemed);
        realizedGain = round2(realizedGain + r.realizedDelta);
      }
    }

    // Task #610 / #612: recompute the share-price tier for every pool whose
    // finalized NAV just changed via redemption, INSIDE this transaction. This
    // keeps tier-event causality aligned to the withdrawal (deterministic audit
    // trail) instead of deferring to a post-commit pass or the next read.
    //
    // Scoped to pools that already carry tier state (BALANCED under Task #610);
    // pools without tier state are left untouched so this never widens tier
    // pricing beyond BALANCED. Fail-closed: a recompute error rolls back the
    // whole withdrawal settlement, exactly like the deposit path — the tier
    // engine is accounting-only and never touches any execution surface.
    for (const touchedPoolId of touchedPoolIds) {
      const existingTierState = await getPoolTierState(touchedPoolId, tx);
      if (!existingTierState) continue;
      await recomputeAndAdvanceTier(touchedPoolId, {
        adminId: admin.id,
        reason: `withdrawal_settlement:${requestId}`,
        runner: tx,
      });
    }

    // Fees on the actually-redeemed gross. Performance fee only on positive
    // realized gain (above the cost-basis high-water), never on a loss.
    const gainAboveHighWater = Math.max(0, realizedGain);
    const fees = computeWithdrawalFees({
      grossAmount: grossRedeemed,
      tier: tierFeeConfig(await getSpeedTierOrThrow("WITHDRAWAL", reqRow.speedTierKey)),
      liquidityFeePct: settings.liquidityFeePct,
      performanceFeePct: settings.performanceFeePct,
      performanceGainAboveHighWater: gainAboveHighWater,
    });

    await writeFeeEntry(tx, {
      userId: reqRow.userId,
      requestId: reqRow.id,
      strategyPoolId: null,
      feeType: "WITHDRAWAL_SPEED",
      basisAmount: grossRedeemed,
      amount: fees.speedFee,
      reason,
      adminId: admin.id,
    });
    await writeFeeEntry(tx, {
      userId: reqRow.userId,
      requestId: reqRow.id,
      strategyPoolId: null,
      feeType: "LIQUIDITY",
      basisAmount: grossRedeemed,
      amount: fees.liquidityFee,
      reason,
      adminId: admin.id,
    });
    await writeFeeEntry(tx, {
      userId: reqRow.userId,
      requestId: reqRow.id,
      strategyPoolId: null,
      feeType: "PERFORMANCE",
      basisAmount: gainAboveHighWater,
      amount: fees.performanceFee,
      reason,
      adminId: admin.id,
      highWaterValueAtCharge: round2(grossRedeemed - gainAboveHighWater),
    });

    let finalStatementId: number | null = null;
    if (isFullExit) {
      // Fund-control freeze (Task #133): refuse final-statement issuance while
      // the STATEMENTS scope is frozen for verification.
      await assertActionAllowed(["STATEMENTS"], { reader: tx });
      const stmt = await tx
        .insert(investorStatementsTable)
        .values({
          userId: reqRow.userId,
          title: "Final withdrawal statement",
          statementType: "STATEMENT",
          summary: `Full exit settled. Units redeemed: ${unitsRedeemed}. Gross value: ${grossRedeemed}. Fees: ${fees.totalFee}. Net payout: ${fees.netAmount}.`,
          status: "ACTIVE",
          createdByAdminId: admin.id,
        })
        .returning();
      finalStatementId = stmt[0]!.id;

      // Lock future allocation until an admin clears it.
      await tx
        .insert(investorCapitalPreferencesTable)
        .values({ userId: reqRow.userId, allocationLocked: true })
        .onConflictDoUpdate({
          target: investorCapitalPreferencesTable.userId,
          set: { allocationLocked: true },
        });
    }

    // PROCESSING → SETTLED: units redeemed, fees posted, payout computed.
    ensureTransition("PROCESSING", "SETTLED");
    await tx
      .update(capitalMovementRequestsTable)
      .set({
        status: "SETTLED",
        grossAmount: grossRedeemed,
        speedFeeAmount: fees.speedFee,
        otherFeesAmount: round2(fees.liquidityFee + fees.performanceFee),
        totalFeeAmount: fees.totalFee,
        netAmount: fees.netAmount,
        settledUnits: unitsRedeemed,
        reservedUnits: 0,
        finalStatementId,
        settledByAdminId: admin.id,
        settledAt,
        feeBreakdown: {
          kind: "WITHDRAWAL",
          grossAmount: grossRedeemed,
          speedFee: fees.speedFee,
          liquidityFee: fees.liquidityFee,
          performanceFee: fees.performanceFee,
          totalFee: fees.totalFee,
          netAmount: fees.netAmount,
          unitsRedeemed,
          realizedGain,
          isFullExit,
        },
      })
      .where(eq(capitalMovementRequestsTable.id, requestId));
    await auditInTx(tx, {
      admin,
      action: "FUNDBOOK_CAPITAL_WITHDRAWAL_SETTLED",
      targetUserId: reqRow.userId,
      beforeState: { status: "PROCESSING" },
      afterState: {
        status: "SETTLED",
        grossRedeemed,
        unitsRedeemed,
        totalFee: fees.totalFee,
        netPayout: fees.netAmount,
        isFullExit,
        finalStatementId,
      },
      reason,
    });

    // SETTLED → COMPLETED: the request is fully closed out.
    ensureTransition("SETTLED", "COMPLETED");
    const upd = await tx
      .update(capitalMovementRequestsTable)
      .set({ status: "COMPLETED" })
      .where(eq(capitalMovementRequestsTable.id, requestId))
      .returning();

    await auditInTx(tx, {
      admin,
      action: "FUNDBOOK_CAPITAL_WITHDRAWAL_SETTLE",
      targetUserId: reqRow.userId,
      beforeState: { status: "SETTLED" },
      afterState: {
        status: "COMPLETED",
        grossRedeemed,
        unitsRedeemed,
        totalFee: fees.totalFee,
        netPayout: fees.netAmount,
        isFullExit,
        finalStatementId,
      },
      reason,
    });
    return upd[0]!;
  });
}

// ── Periodic fees (management / performance) ────────────────────────────────

/**
 * Charge a periodic management or performance fee to an investor in a pool by
 * redeeming units worth the fee at the official NAV and writing a transparent
 * fee-ledger row. Performance fees apply ONLY above the holding's high-water
 * mark (which is advanced after the charge). Fail-closed audited.
 */
export async function chargePeriodicFee(
  admin: Admin,
  input: {
    userId: number;
    poolKey: string;
    feeType: "MANAGEMENT" | "PERFORMANCE";
    annualPct?: number;
    periodDays?: number;
    performancePct?: number;
    reason: string;
  },
): Promise<{ feeAmount: number; unitsRedeemed: number }> {
  await ensurePools();
  return db.transaction(async (tx) => {
    const pool = await getPoolByKey(input.poolKey.toUpperCase());
    if (!pool) throw new CapitalError("POOL_NOT_FOUND", 404);
    const holding = await getHolding(input.userId, pool.id, tx);
    if (!holding || holding.unitsOwned <= 0) throw new CapitalError("NO_HOLDING", 404);
    const navRows = await tx
      .select()
      .from(strategyPoolNavTable)
      .where(eq(strategyPoolNavTable.strategyPoolId, pool.id))
      .limit(1);
    const nav = navRows[0];
    if (!nav || nav.navPerUnit <= 0) throw new CapitalError("NAV_UNAVAILABLE", 409);
    const currentValue = round2(holding.unitsOwned * nav.navPerUnit);

    let feeAmount = 0;
    let basisAmount = 0;
    let highWaterAtCharge: number | null = null;
    const now = new Date();
    let periodStart: Date | null = null;

    if (input.feeType === "MANAGEMENT") {
      const days = input.periodDays ?? 0;
      feeAmount = computeManagementFee(currentValue, input.annualPct ?? 0, days);
      basisAmount = currentValue;
      periodStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    } else {
      const hwm = holding.highWaterValue ?? 0;
      feeAmount = computePerformanceFee(currentValue, hwm, input.performancePct ?? 0);
      basisAmount = Math.max(0, currentValue - hwm);
      highWaterAtCharge = hwm;
    }

    if (!(feeAmount > 0)) {
      // Nothing to charge (e.g. below high-water). Honest no-op, still audited.
      await auditInTx(tx, {
        admin,
        action: "FUNDBOOK_CAPITAL_PERIODIC_FEE_NOOP",
        targetUserId: input.userId,
        beforeState: { poolKey: pool.poolKey, feeType: input.feeType },
        afterState: { feeAmount: 0 },
        reason: input.reason,
      });
      return { feeAmount: 0, unitsRedeemed: 0 };
    }

    const r = await redeemUnits(tx, {
      userId: input.userId,
      poolId: pool.id,
      grossAmount: feeAmount,
      reason: input.reason,
      adminId: admin.id,
    });

    await writeFeeEntry(tx, {
      userId: input.userId,
      requestId: null,
      strategyPoolId: pool.id,
      feeType: input.feeType,
      basisAmount,
      amount: feeAmount,
      reason: input.reason,
      adminId: admin.id,
      highWaterValueAtCharge: highWaterAtCharge,
      periodStart,
      periodEnd: input.feeType === "MANAGEMENT" ? now : null,
      periodDays: input.feeType === "MANAGEMENT" ? (input.periodDays ?? null) : null,
    });

    // Advance the holding's high-water mark after a performance charge.
    if (input.feeType === "PERFORMANCE") {
      const after = round2(currentValue - r.grossValue);
      await tx
        .update(investorPoolHoldingsTable)
        .set({ highWaterValue: round2(Math.max(holding.highWaterValue ?? 0, after)) })
        .where(eq(investorPoolHoldingsTable.id, holding.id));
    }

    // Task #612: a periodic-fee charge redeems units (and accrues a fee),
    // changing the pool's finalized NAV. Recompute the tier + emit any tier
    // event in this SAME transaction so the audit trail stays deterministic.
    // Scoped to a pool that already carries tier state (BALANCED under Task
    // #610); other pools are left untouched. Fail-closed, consistent with the
    // deposit and withdrawal settlement paths.
    const feeTierState = await getPoolTierState(pool.id, tx);
    if (feeTierState) {
      await recomputeAndAdvanceTier(pool.id, {
        adminId: admin.id,
        reason: `periodic_fee:${input.feeType}`,
        runner: tx,
      });
    }

    await auditInTx(tx, {
      admin,
      action: "FUNDBOOK_CAPITAL_PERIODIC_FEE_CHARGE",
      targetUserId: input.userId,
      beforeState: { poolKey: pool.poolKey, feeType: input.feeType, currentValue },
      afterState: { feeAmount, unitsRedeemed: r.unitsRedeemed },
      reason: input.reason,
    });
    return { feeAmount, unitsRedeemed: r.unitsRedeemed };
  });
}

export async function listFeeEntries(filter?: {
  userId?: number;
  feeType?: FeeType;
}) {
  const conds = [];
  if (filter?.userId) conds.push(eq(fundBookFeeEntriesTable.userId, filter.userId));
  if (filter?.feeType) conds.push(eq(fundBookFeeEntriesTable.feeType, filter.feeType));
  const q = db.select().from(fundBookFeeEntriesTable);
  const rows = conds.length ? await q.where(and(...conds)) : await q;
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

// ── Preferences + disclosures ───────────────────────────────────────────────

export async function getPreferences(userId: number): Promise<InvestorCapitalPreferences> {
  const rows = await db
    .select()
    .from(investorCapitalPreferencesTable)
    .where(eq(investorCapitalPreferencesTable.userId, userId))
    .limit(1);
  if (rows[0]) return rows[0];
  const ins = await db
    .insert(investorCapitalPreferencesTable)
    .values({ userId })
    .onConflictDoNothing({ target: investorCapitalPreferencesTable.userId })
    .returning();
  return (
    ins[0] ??
    (
      await db
        .select()
        .from(investorCapitalPreferencesTable)
        .where(eq(investorCapitalPreferencesTable.userId, userId))
        .limit(1)
    )[0]!
  );
}

export async function setPreferences(
  userId: number,
  patch: Partial<{
    profitHandling: "REINVEST" | "PAYOUT" | "SPLIT";
    profitPayoutPct: number;
    lossControl: "NONE" | "SOFT_ALERT" | "PAUSE_ON_DRAWDOWN";
    maxDrawdownPct: number;
    note: string | null;
  }>,
): Promise<InvestorCapitalPreferences> {
  // Fund-control freezes (Task #133): refuse allocation/preference changes while
  // the ALLOCATION scope or this investor is frozen for verification.
  await assertActionAllowed(["ALLOCATION"]);
  await assertActionAllowed(["INVESTOR"], { scopeKey: String(userId) });
  await getPreferences(userId); // ensure row exists
  const upd = await db
    .update(investorCapitalPreferencesTable)
    .set(patch)
    .where(eq(investorCapitalPreferencesTable.userId, userId))
    .returning();
  return upd[0]!;
}

/** Admin clears the post-full-exit allocation lock. Fail-closed audited. */
export async function setAllocationLock(
  admin: Admin,
  userId: number,
  locked: boolean,
  reason: string,
): Promise<InvestorCapitalPreferences> {
  return db.transaction(async (tx) => {
    await tx
      .insert(investorCapitalPreferencesTable)
      .values({ userId, allocationLocked: locked })
      .onConflictDoUpdate({
        target: investorCapitalPreferencesTable.userId,
        set: { allocationLocked: locked },
      });
    const rows = await tx
      .select()
      .from(investorCapitalPreferencesTable)
      .where(eq(investorCapitalPreferencesTable.userId, userId))
      .limit(1);
    await auditInTx(tx, {
      admin,
      action: "FUNDBOOK_CAPITAL_ALLOCATION_LOCK_SET",
      targetUserId: userId,
      beforeState: {},
      afterState: { allocationLocked: locked },
      reason,
    });
    return rows[0]!;
  });
}

export async function recordDisclosureAck(
  userId: number,
  disclosureType: DisclosureType,
  version: string,
  requestId?: number | null,
): Promise<void> {
  await db.insert(investorDisclosureAcknowledgmentsTable).values({
    userId,
    disclosureType,
    version,
    capitalMovementRequestId: requestId ?? null,
  });
}

export async function listDisclosureAcks(userId: number) {
  return db
    .select()
    .from(investorDisclosureAcknowledgmentsTable)
    .where(eq(investorDisclosureAcknowledgmentsTable.userId, userId))
    .orderBy(desc(investorDisclosureAcknowledgmentsTable.acknowledgedAt));
}

// Re-export for callers that need the user existence check.
export async function userExists(userId: number): Promise<boolean> {
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return Boolean(rows[0]);
}
