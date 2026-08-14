// fundBookCapitalTest.ts — Automated proof (Task #132) of the ARX Fund Book
// capital movements & fee engine: the deposit/withdrawal request → approval →
// settle lifecycle that issues/redeems UNITS through the NAV engine at the
// official NAV, the configurable speed-tier + fee engine, the per-deposit lock,
// unit reservation, configurable withdrawal source priority, disclosure acks,
// and the post-full-exit allocation lock.
//
// IT PROVES:
//   PURE (no IO):
//     - Speed-fee math: NONE / FLAT / PERCENTAGE / BOTH with min/max clamps.
//     - Management fee prorates by days over a 365-day year.
//     - Performance fee is 0 at/below the high-water mark and positive only on
//       the gain ABOVE it (never on a loss).
//     - Liquidity fee on gross.
//     - Deposit / withdrawal fee breakdowns: net = gross − fees, floored at 0;
//       a full-exit BOTH tier = flat + percent.
//     - Locked-vs-withdrawable split honours future-dated LOCKED rows and caps
//       locked at the current value (withdrawable never negative).
//     - resolveWithdrawalPlan consumes pools in priority order, never exceeds a
//       pool's available value, and reports shortfall / fullyCovered.
//   INTEGRATION (REAL service + DB, no HTTP):
//     - A settled deposit issues units = net/NAV at the official NAV, writes the
//       transparent DEPOSIT_SPEED fee row, and creates a 30-day lock row.
//     - A withdrawal above the available (unlocked, unreserved) value is refused.
//     - With an unlocked deposit, a priority-tier withdrawal settles, redeems
//       units, and writes the WITHDRAWAL_SPEED fee row.
//     - A full exit redeems ALL units, produces a final statement, and locks
//       future allocation (a subsequent deposit is refused).
//     - Per-investor isolation: investor A's requests / fee entries / locks never
//       include investor B's rows; reading B's request as A returns null.
//     - Periodic management fee charges (and writes a MANAGEMENT row); a
//       performance fee below the high-water mark is an honest audited no-op.
//
// SAFETY / ISOLATION:
//   - Seeds isolated users (fixed TAG) and operates ONLY on their rows.
//   - Idempotent cleanup of every seeded row at the end, even on failure.
//   - Never places a trade / touches any execution / live / bridge surface; the
//     starting arx_live_commands count is asserted unchanged at the end.
//   - Operates on the shared BALANCED seed pool's per-user holdings/events for
//     its own seeded users (June 19 2026: investor deposits are BALANCED-only);
//     the shared pool NAV snapshot, tier state, price ladder, and the singleton
//     fund_capital_settings row are captured and restored exactly as found.
//   - Only DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:fundbook-capital

import { and, eq, inArray, or } from "drizzle-orm";
import {
  pool,
  db,
  usersTable,
  strategyPoolsTable,
  strategyPoolNavTable,
  investorPoolHoldingsTable,
  fundBookUnitEventsTable,
  investorStatementsTable,
  adminActionAuditLogTable,
  capitalMovementRequestsTable,
  fundBookFeeEntriesTable,
  investorDepositLocksTable,
  investorCapitalPreferencesTable,
  investorDisclosureAcknowledgmentsTable,
  fundCapitalSettingsTable,
  fundBookPoolTierStateTable,
  fundBookPoolTierEventsTable,
  fundBookSharePriceTiersTable,
  fundControlFreezesTable,
} from "@workspace/db";
import {
  computeSpeedFee,
  computeManagementFee,
  computePerformanceFee,
  computeLiquidityFee,
  computeDepositFees,
  computeWithdrawalFees,
} from "../../artifacts/api-server/src/lib/fundbook/feeEngine.js";
import {
  computeLockedVsWithdrawable,
  computeLockUntil,
} from "../../artifacts/api-server/src/lib/fundbook/depositLock.js";
import { resolveWithdrawalPlan } from "../../artifacts/api-server/src/lib/fundbook/withdrawalPriority.js";
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  isTerminal,
} from "../../artifacts/api-server/src/lib/fundbook/requestLifecycle.js";
import {
  ensureCapitalConfig,
  getInvestorValuation,
  createDepositRequest,
  createWithdrawalRequest,
  approveRequest,
  rejectRequest,
  cancelRequest,
  settleRequest,
  listInvestorRequests,
  getInvestorRequest,
  listInvestorFeeEntries,
  listInvestorLocks,
  chargePeriodicFee,
  getPreferences,
  CapitalError,
  type Admin,
} from "../../artifacts/api-server/src/lib/fundbook/capitalMovements.js";

// June 19 2026: investor deposits are BALANCED-only. createDepositRequest
// refuses any other target with DEPOSIT_TARGET_NOT_ELIGIBLE, and the omitted-
// target default is BALANCED — this suite locks both.
const POOL_KEY = "BALANCED";
const TAG = `qaFundBookCapital_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

let passes = 0;
let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passes++;
    // eslint-disable-next-line no-console
    console.log(`  \u2713 ${label}`);
  } else {
    failures++;
    // eslint-disable-next-line no-console
    console.error(`  \u2717 ${label}`);
  }
}
function approx(a: number, b: number, eps = 0.01): boolean {
  return Math.abs(a - b) <= eps;
}
async function expectThrow(fn: () => Promise<unknown>, code: string, label: string): Promise<void> {
  try {
    await fn();
    assert(false, `${label} (expected ${code}, but it resolved)`);
  } catch (e) {
    const got = e instanceof CapitalError ? e.code : (e as Error).message;
    assert(got === code, `${label} (got ${got})`);
  }
}

async function auditCount(targetUserId: number, action: string): Promise<number> {
  const r = await pool.query(
    "SELECT COUNT(*)::int AS n FROM admin_action_audit_log WHERE target_user_id = $1 AND action = $2",
    [targetUserId, action],
  );
  return (r.rows[0] as { n: number }).n;
}
async function liveCommandsCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}
async function readPoolFeesAccrued(strategyPoolId: number): Promise<number> {
  const r = await pool.query(
    "SELECT fees_accrued AS f FROM strategy_pool_nav WHERE strategy_pool_id = $1",
    [strategyPoolId],
  );
  return Number((r.rows[0] as { f: number } | undefined)?.f ?? 0);
}

async function createUser(label: string, role: "INVESTOR" | "ADMIN"): Promise<number> {
  const [u] = await db
    .insert(usersTable)
    .values({ email: `${TAG}_${label}@arx.test`, name: `${TAG} ${label}`, role })
    .returning();
  return u!.id;
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("fundBookCapitalTest");
  // eslint-disable-next-line no-console
  console.log("===================\n");

  const startLive = await liveCommandsCount();

  // ── 1. PURE fee / lock / priority math ──────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log("1. Pure fee, lock, and priority math");

  // Speed-fee modes + clamps.
  assert(
    computeSpeedFee({ feeMode: "NONE", flatFee: 9, percentageFee: 9, minFee: null, maxFee: null }, 1000) === 0,
    "NONE tier ⇒ fee 0",
  );
  assert(
    computeSpeedFee({ feeMode: "FLAT", flatFee: 50, percentageFee: 0, minFee: null, maxFee: null }, 1000) === 50,
    "FLAT tier ⇒ flatFee",
  );
  assert(
    approx(computeSpeedFee({ feeMode: "PERCENTAGE", flatFee: 0, percentageFee: 1.5, minFee: null, maxFee: null }, 1000), 15),
    "PERCENTAGE tier ⇒ gross × pct (1.5% of 1000 = 15)",
  );
  assert(
    approx(computeSpeedFee({ feeMode: "BOTH", flatFee: 50, percentageFee: 1, minFee: null, maxFee: null }, 1000), 60),
    "BOTH tier ⇒ flat + gross × pct (50 + 1% of 1000 = 60)",
  );
  assert(
    computeSpeedFee({ feeMode: "PERCENTAGE", flatFee: 0, percentageFee: 0.5, minFee: 25, maxFee: null }, 1000) === 25,
    "minFee clamp raises a small percentage fee to the floor",
  );
  assert(
    computeSpeedFee({ feeMode: "PERCENTAGE", flatFee: 0, percentageFee: 10, minFee: null, maxFee: 40 }, 1000) === 40,
    "maxFee clamp caps a large percentage fee at the ceiling",
  );

  // Management fee prorates by days over 365.
  assert(approx(computeManagementFee(10000, 12, 365), 1200), "management fee 12%/yr over 365d = 1200");
  assert(approx(computeManagementFee(10000, 12, 30), (10000 * 0.12 * 30) / 365), "management fee prorates by 30 days");
  assert(computeManagementFee(10000, 0, 365) === 0, "0% management rate ⇒ 0");

  // Performance fee only above the high-water mark.
  assert(computePerformanceFee(900, 1000, 20) === 0, "performance fee = 0 BELOW high-water");
  assert(computePerformanceFee(1000, 1000, 20) === 0, "performance fee = 0 AT high-water");
  assert(approx(computePerformanceFee(1500, 1000, 20), 100), "performance fee = 20% of gain above HWM (500 ⇒ 100)");

  assert(approx(computeLiquidityFee(2000, 0.25), 5), "liquidity fee = amount × pct (0.25% of 2000 = 5)");

  // Deposit / withdrawal breakdowns.
  {
    const dep = computeDepositFees({
      grossAmount: 1000,
      tier: { feeMode: "PERCENTAGE", flatFee: 0, percentageFee: 1, minFee: null, maxFee: null },
    });
    assert(approx(dep.speedFee, 10) && approx(dep.netAmount, 990), "deposit: net invested = gross − fee (1000 − 10 = 990)");
  }
  {
    const wd = computeWithdrawalFees({
      grossAmount: 2000,
      tier: { feeMode: "BOTH", flatFee: 50, percentageFee: 1, minFee: null, maxFee: null },
      liquidityFeePct: 0,
      performanceFeePct: 20,
      performanceGainAboveHighWater: 500,
    });
    // speed = 50 + 1% of 2000 = 70; perf = 20% of 500 = 100; net = 2000 − 170.
    assert(approx(wd.speedFee, 70), "full-exit BOTH tier speed fee = flat + percent (70)");
    assert(approx(wd.performanceFee, 100), "withdrawal performance fee only on supplied gain above HWM (100)");
    assert(approx(wd.netAmount, 1830), "withdrawal net payout = gross − all fees (2000 − 170 = 1830)");
  }
  {
    const wd = computeWithdrawalFees({
      grossAmount: 1000,
      tier: { feeMode: "BOTH", flatFee: 0, percentageFee: 0, minFee: null, maxFee: null },
      performanceGainAboveHighWater: -50, // a loss must never produce a perf fee
      performanceFeePct: 20,
    });
    assert(wd.performanceFee === 0, "a loss (negative gain) never produces a performance fee");
  }

  // Locked-vs-withdrawable split.
  {
    const now = new Date("2026-01-15T00:00:00Z");
    const future = new Date("2026-02-14T00:00:00Z");
    const past = new Date("2026-01-01T00:00:00Z");
    const split = computeLockedVsWithdrawable(
      1000,
      [
        { principalAmount: 600, lockUntil: future, status: "LOCKED" },
        { principalAmount: 300, lockUntil: past, status: "LOCKED" }, // already releasable
        { principalAmount: 100, lockUntil: future, status: "RELEASED" }, // released ⇒ ignored
      ],
      now,
    );
    assert(approx(split.lockedPrincipal, 600), "only future-dated LOCKED rows count as locked (600)");
    assert(approx(split.withdrawableValue, 400), "withdrawable = value − locked (1000 − 600 = 400)");
    assert(split.nextReleaseAt?.getTime() === future.getTime(), "nextReleaseAt is the earliest future lock");
    const capped = computeLockedVsWithdrawable(500, [{ principalAmount: 900, lockUntil: future, status: "LOCKED" }], now);
    assert(capped.lockedPrincipal === 500 && capped.withdrawableValue === 0, "locked principal is capped at current value");
  }
  {
    const at = new Date("2026-03-01T00:00:00Z");
    assert(computeLockUntil(at, 30).getTime() === new Date("2026-03-31T00:00:00Z").getTime(), "lockUntil = lockedAt + 30 days");
  }

  // Withdrawal priority planning.
  {
    const plan = resolveWithdrawalPlan(
      1200,
      ["CASH_RESERVE", "CONSERVATIVE", "BALANCED", "AGGRESSIVE"],
      [
        { poolKey: "AGGRESSIVE", strategyPoolId: 4, availableValue: 1000 },
        { poolKey: "CASH_RESERVE", strategyPoolId: 1, availableValue: 500 },
        { poolKey: "CONSERVATIVE", strategyPoolId: 2, availableValue: 1000 },
      ],
      // priority order, not input order
    );
    assert(plan.fullyCovered && approx(plan.plannedAmount, 1200), "priority plan fully covers 1200");
    assert(plan.legs[0]?.poolKey === "CASH_RESERVE" && approx(plan.legs[0]?.amount ?? 0, 500), "first leg drains CASH_RESERVE (500)");
    assert(plan.legs[1]?.poolKey === "CONSERVATIVE" && approx(plan.legs[1]?.amount ?? 0, 700), "second leg takes 700 from CONSERVATIVE");
    const short = resolveWithdrawalPlan(
      2000,
      ["CASH_RESERVE"],
      [{ poolKey: "CASH_RESERVE", strategyPoolId: 1, availableValue: 500 }],
    );
    assert(!short.fullyCovered && approx(short.shortfall, 1500), "an under-funded plan reports the shortfall (1500)");
  }

  // Request lifecycle state machine (pure).
  {
    // Happy-path forward hops are allowed.
    assert(canTransition("DRAFT", "SUBMITTED"), "lifecycle: DRAFT → SUBMITTED");
    assert(canTransition("SUBMITTED", "PENDING_REVIEW"), "lifecycle: SUBMITTED → PENDING_REVIEW");
    assert(canTransition("PENDING_REVIEW", "APPROVED"), "lifecycle: PENDING_REVIEW → APPROVED");
    assert(canTransition("APPROVED", "PROCESSING"), "lifecycle: APPROVED → PROCESSING");
    assert(canTransition("PROCESSING", "SETTLED"), "lifecycle: PROCESSING → SETTLED");
    assert(canTransition("SETTLED", "COMPLETED"), "lifecycle: SETTLED → COMPLETED");
    // Phase-skipping is refused.
    assert(!canTransition("APPROVED", "COMPLETED"), "lifecycle: APPROVED ↛ COMPLETED (skips settlement)");
    assert(!canTransition("PENDING_REVIEW", "SETTLED"), "lifecycle: PENDING_REVIEW ↛ SETTLED");
    assert(!canTransition("SUBMITTED", "APPROVED"), "lifecycle: SUBMITTED ↛ APPROVED (skips review)");
    // Terminal states never move.
    assert(!canTransition("CANCELLED", "REJECTED"), "lifecycle: CANCELLED ↛ REJECTED");
    assert(!canTransition("COMPLETED", "PROCESSING"), "lifecycle: COMPLETED ↛ PROCESSING");
    assert(!canTransition("REJECTED", "APPROVED"), "lifecycle: REJECTED ↛ APPROVED");
    assert(
      isTerminal("COMPLETED") && isTerminal("REJECTED") && isTerminal("FAILED") && isTerminal("CANCELLED"),
      "lifecycle: COMPLETED/REJECTED/FAILED/CANCELLED are terminal",
    );
    assert(
      ALLOWED_TRANSITIONS.COMPLETED.length === 0 && ALLOWED_TRANSITIONS.CANCELLED.length === 0,
      "lifecycle: terminal states have no outgoing transitions",
    );
    // Mid-settlement requests cannot be cancelled or rejected.
    assert(!canTransition("PROCESSING", "CANCELLED"), "lifecycle: PROCESSING ↛ CANCELLED");
    assert(!canTransition("PROCESSING", "REJECTED"), "lifecycle: PROCESSING ↛ REJECTED");
  }

  // ── Integration setup ───────────────────────────────────────────────────────
  await ensureCapitalConfig();

  let investorA: number | null = null;
  let investorB: number | null = null;
  let adminId: number | null = null;
  let poolId: number | null = null;
  let navBaseline: typeof strategyPoolNavTable.$inferSelect | null = null;
  let settingsBaseline: typeof fundCapitalSettingsTable.$inferSelect | null = null;
  let origTierState: typeof fundBookPoolTierStateTable.$inferSelect | null = null;
  let origTierLadderCount = 0;
  let tierEventBaselineIds: number[] = [];
  let tierCaptured = false;
  let suspendedFreezeIds: number[] = [];

  try {
    investorA = await createUser("investorA", "INVESTOR");
    investorB = await createUser("investorB", "INVESTOR");
    adminId = await createUser("admin", "ADMIN");
    const admin: Admin = { id: adminId, role: "ADMIN" };

    const poolRow = (
      await db.select().from(strategyPoolsTable).where(eq(strategyPoolsTable.poolKey, POOL_KEY)).limit(1)
    )[0];
    assert(poolRow != null, "BALANCED seed pool exists");
    poolId = poolRow!.id;
    navBaseline = (
      await db.select().from(strategyPoolNavTable).where(eq(strategyPoolNavTable.strategyPoolId, poolId)).limit(1)
    )[0]!;
    settingsBaseline = (
      await db.select().from(fundCapitalSettingsTable).where(eq(fundCapitalSettingsTable.scope, "GLOBAL")).limit(1)
    )[0]!;

    // ── Deterministic tier isolation (capture → reset → restore) ─────────────
    // BALANCED deposit settlement prices units through the tier engine. Capture
    // the EXACT pre-existing tier_state + price-ladder + tier-event rows so
    // cleanup restores them byte-for-byte, then DELETE tier_state so this run
    // starts from a guaranteed-clean T1 ($1.00 buy-in) baseline regardless of
    // accumulated dev-DB drift — the unit-math asserts below depend on it.
    origTierState =
      (
        await db
          .select()
          .from(fundBookPoolTierStateTable)
          .where(eq(fundBookPoolTierStateTable.strategyPoolId, poolId))
          .limit(1)
      )[0] ?? null;
    origTierLadderCount = (
      await db
        .select()
        .from(fundBookSharePriceTiersTable)
        .where(eq(fundBookSharePriceTiersTable.strategyPoolId, poolId))
    ).length;
    tierEventBaselineIds = (
      await db
        .select()
        .from(fundBookPoolTierEventsTable)
        .where(eq(fundBookPoolTierEventsTable.strategyPoolId, poolId))
    ).map((r) => r.id);
    await db.delete(fundBookPoolTierStateTable).where(eq(fundBookPoolTierStateTable.strategyPoolId, poolId));
    tierCaptured = true;

    // ── Deterministic freeze isolation (suspend → restore) ───────────────────
    // Pre-existing ACTIVE control freezes (e.g. an old AUTO_CRITICAL global
    // lock left by a past reconciliation run in the dev DB) would make every
    // deposit/withdrawal here fail with ACTION_FROZEN — unrelated dev-DB state,
    // not the behavior under test. Suspend EXACTLY the pre-existing rows that
    // gate this suite's scopes (captured by id) and restore active=true in the
    // finally block. Rows are never deleted — the freeze evidence is preserved
    // byte-for-byte, and freezes created DURING the run are never touched.
    const blockingFreezes = await db
      .select({ id: fundControlFreezesTable.id })
      .from(fundControlFreezesTable)
      .where(
        and(
          eq(fundControlFreezesTable.active, true),
          or(
            inArray(fundControlFreezesTable.freezeScope, ["DEPOSITS", "WITHDRAWALS", "ISSUANCE", "STATEMENTS"]),
            and(
              eq(fundControlFreezesTable.freezeScope, "POOL"),
              inArray(fundControlFreezesTable.scopeKey, ["GLOBAL", POOL_KEY]),
            ),
            and(
              eq(fundControlFreezesTable.freezeScope, "INVESTOR"),
              eq(fundControlFreezesTable.scopeKey, "GLOBAL"),
            ),
          ),
        ),
      );
    suspendedFreezeIds = blockingFreezes.map((f) => f.id);
    if (suspendedFreezeIds.length > 0) {
      await db
        .update(fundControlFreezesTable)
        .set({ active: false })
        .where(inArray(fundControlFreezesTable.id, suspendedFreezeIds));
    }

    // Clean, deterministic NAV ($1.00, zero units) for the seeded math below.
    await db
      .update(strategyPoolNavTable)
      .set({
        navPerUnit: 1,
        totalUnitsOutstanding: 0,
        totalPoolValue: poolRow!.startingCapital,
        realizedPl: 0,
        unrealizedPl: 0,
        feesAccrued: 0,
        depositsAllocated: 0,
        withdrawalsRedeemed: 0,
        approvedAdjustments: 0,
        highWaterValue: poolRow!.startingCapital,
        currentDrawdownPercent: 0,
        navStatus: "OK",
      })
      .where(eq(strategyPoolNavTable.strategyPoolId, poolId));

    // Deterministic fee settings: 30-day lock, no liquidity/management fee.
    await db
      .update(fundCapitalSettingsTable)
      .set({
        depositLockDays: 30,
        liquidityFeePct: 0,
        performanceFeePct: 10,
        managementFeeAnnualPct: 0,
        minDepositAmount: 0,
        minWithdrawalAmount: 0,
      })
      .where(eq(fundCapitalSettingsTable.scope, "GLOBAL"));

    // ── 2. Deposit lifecycle: issue units + write fee row + create lock ───────
    // eslint-disable-next-line no-console
    console.log("\n2. Deposit request → approve → settle (units issued, fee row, 30-day lock)");
    // June-19 gate: a deposit explicitly targeting any non-BALANCED pool is
    // refused at request creation.
    await expectThrow(
      () => createDepositRequest({ userId: investorA!, grossAmount: 1000, speedTierKey: "FAST", targetPoolKey: "CASH_RESERVE" }),
      "DEPOSIT_TARGET_NOT_ELIGIBLE",
      "a deposit targeting CASH_RESERVE is refused (BALANCED-only)",
    );
    // dep1 deliberately OMITS targetPoolKey — exactly what the FE sends — to
    // lock the BALANCED default (an ineligible default would refuse ALL
    // investor deposits, the June-19 prod bug this suite now pins).
    const dep1 = await createDepositRequest({ userId: investorA, grossAmount: 1000, speedTierKey: "FAST" });
    assert(dep1.status === "PENDING_REVIEW", `deposit request opens PENDING_REVIEW (got ${dep1.status})`);
    assert(approx(dep1.speedFeeAmount, 10) && approx(dep1.netAmount, 990), "FAST tier: fee 10, net invested 990");

    await expectThrow(
      () => settleRequest(admin, dep1.id, "qa settle before approve"),
      "REQUEST_NOT_APPROVED",
      "settling a non-approved request is refused",
    );

    const dep1Approved = await approveRequest(admin, dep1.id, "qa approve deposit A1");
    assert(dep1Approved.status === "APPROVED" && dep1Approved.navCycleTiming != null, "approval resolves the NAV cutoff cycle");

    const settleBefore = await auditCount(investorA, "FUNDBOOK_CAPITAL_DEPOSIT_SETTLE");
    const feesAccruedBefore = await readPoolFeesAccrued(poolId);
    const dep1Settled = await settleRequest(admin, dep1.id, "qa settle deposit A1");
    assert(dep1Settled.status === "COMPLETED", "deposit settles to COMPLETED");
    assert(approx(dep1Settled.settledNavPerUnit ?? 0, 1), "units issued at the official NAV $1.00");
    assert(approx(dep1Settled.settledUnits ?? 0, 990), "units issued = net / NAV (990)");
    assert(
      (await auditCount(investorA, "FUNDBOOK_CAPITAL_DEPOSIT_SETTLE")) === settleBefore + 1,
      "exactly one deposit-settle audit row written",
    );
    // The settle phases are recorded as their own audited admin actions.
    assert(
      (await auditCount(investorA, "FUNDBOOK_CAPITAL_DEPOSIT_PROCESSING")) >= 1,
      "settlement writes a PROCESSING phase audit row",
    );
    assert(
      (await auditCount(investorA, "FUNDBOOK_CAPITAL_DEPOSIT_SETTLED")) >= 1,
      "settlement writes a SETTLED phase audit row",
    );
    // Lifecycle is enforced: a COMPLETED request cannot move backward.
    await expectThrow(
      () => rejectRequest(admin, dep1.id, "qa reject completed"),
      "INVALID_STATUS_TRANSITION:COMPLETED->REJECTED",
      "a COMPLETED request cannot be rejected",
    );
    await expectThrow(
      () => cancelRequest(investorA!, dep1.id),
      "INVALID_STATUS_TRANSITION:COMPLETED->CANCELLED",
      "a COMPLETED request cannot be cancelled",
    );
    await expectThrow(
      () => settleRequest(admin, dep1.id, "qa double settle"),
      "REQUEST_NOT_APPROVED",
      "a COMPLETED request cannot be settled again",
    );

    // INVARIANT: the deposit speed fee is a transparent ledger row only — it must
    // NEVER flow into the pool's feesAccrued, which would discount the official
    // NAV. Pin the exact bug class: feesAccrued is unchanged by the deposit.
    assert(
      approx(await readPoolFeesAccrued(poolId), feesAccruedBefore),
      "deposit speed fee does NOT touch pool feesAccrued (official NAV not discounted)",
    );

    const feesA1 = await listInvestorFeeEntries(investorA);
    const depFee = feesA1.find((f) => f.feeType === "DEPOSIT_SPEED");
    assert(depFee != null && approx(depFee.feeAmount, 10), "a transparent DEPOSIT_SPEED fee row (10) was written");
    assert(
      depFee != null && approx(depFee.feeBasisAmount, 1000) && depFee.capitalMovementRequestId === dep1.id,
      "DEPOSIT_SPEED fee row discloses the gross basis (1000) and links to its request",
    );

    const locksA1 = await listInvestorLocks(investorA);
    assert(locksA1.length === 1, "one deposit lock row created");
    assert(approx(locksA1[0]?.principalAmount ?? 0, 990) && locksA1[0]?.status === "LOCKED", "lock holds the net principal (990), status LOCKED");
    assert((locksA1[0]?.lockUntil.getTime() ?? 0) > Date.now(), "lock is future-dated (30-day window)");

    const valA1 = await getInvestorValuation(investorA);
    assert(approx(valA1.totalValue, 990), "valuation total = 990");
    assert(approx(valA1.lockedPrincipal, 990) && approx(valA1.withdrawableValue, 0), "all principal locked, nothing withdrawable yet");

    // ── 3. Withdrawal above available value is refused ────────────────────────
    // eslint-disable-next-line no-console
    console.log("\n3. Withdrawal above the available (locked) value is refused");
    await expectThrow(
      () => createWithdrawalRequest({ userId: investorA!, grossAmount: 100, speedTierKey: "STANDARD" }),
      "WITHDRAWAL_EXCEEDS_AVAILABLE",
      "withdrawing locked principal is refused",
    );

    // ── 4. Unlock (lock days 0) → priority-tier withdrawal settles ────────────
    // eslint-disable-next-line no-console
    console.log("\n4. Priority-tier withdrawal settles, redeems units, writes a fee row");
    await db
      .update(fundCapitalSettingsTable)
      .set({ depositLockDays: 0 })
      .where(eq(fundCapitalSettingsTable.scope, "GLOBAL"));

    const dep2 = await createDepositRequest({ userId: investorA, grossAmount: 1000, speedTierKey: "FAST" });
    await approveRequest(admin, dep2.id, "qa approve deposit A2");
    await settleRequest(admin, dep2.id, "qa settle deposit A2");

    const valBeforeWd = await getInvestorValuation(investorA);
    assert(approx(valBeforeWd.totalValue, 1980), "after a 2nd deposit total = 1980");
    assert(approx(valBeforeWd.withdrawableValue, 990), "the unlocked deposit (990) is now withdrawable");

    const wd = await createWithdrawalRequest({ userId: investorA, grossAmount: 500, speedTierKey: "PRIORITY" });
    assert(wd.status === "PENDING_REVIEW" && (wd.reservedUnits ?? 0) > 0, "withdrawal reserves units on creation");
    assert(approx(wd.speedFeeAmount, 2.5), "PRIORITY tier speed fee = 0.5% of 500 = 2.5");

    await approveRequest(admin, wd.id, "qa approve withdrawal");
    const wdSettled = await settleRequest(admin, wd.id, "qa settle withdrawal");
    assert(wdSettled.status === "COMPLETED", "withdrawal settles to COMPLETED");
    assert(approx(wdSettled.grossAmount, 500) && (wdSettled.settledUnits ?? 0) > 0, "withdrawal redeemed 500 of gross value");
    assert(approx(wdSettled.netAmount, 497.5), "net payout = gross − speed fee (497.5)");

    const feesAfterWd = await listInvestorFeeEntries(investorA);
    const wdFee = feesAfterWd.find((f) => f.feeType === "WITHDRAWAL_SPEED");
    assert(wdFee != null && approx(wdFee.feeAmount, 2.5), "a transparent WITHDRAWAL_SPEED fee row (2.5) was written");

    const valAfterWd = await getInvestorValuation(investorA);
    assert(approx(valAfterWd.totalValue, 1480), "total reduced to 1480 after redeeming 500");

    // ── 5. Full exit redeems all + final statement + allocation lock ──────────
    // eslint-disable-next-line no-console
    console.log("\n5. Full exit redeems all units, writes a final statement, locks allocation");
    const exit = await createWithdrawalRequest({
      userId: investorA,
      grossAmount: 0,
      speedTierKey: "FULL_IMMEDIATE_EXIT",
      isFullExit: true,
      acknowledgeDisclosures: true,
    });
    assert(exit.isFullExit && approx(exit.grossAmount, 1480), "full exit gross = entire current value (1480)");
    await approveRequest(admin, exit.id, "qa approve full exit");
    const exitSettled = await settleRequest(admin, exit.id, "qa settle full exit");
    assert(exitSettled.status === "COMPLETED", "full exit settles to COMPLETED");
    assert(exitSettled.finalStatementId != null, "a final statement is produced on full exit");
    assert(approx(exitSettled.speedFeeAmount, 50 + 0.01 * 1480), "FULL_IMMEDIATE_EXIT BOTH tier fee = flat 50 + 1% (64.8)");

    const valAfterExit = await getInvestorValuation(investorA);
    assert(approx(valAfterExit.totalValue, 0), "no holdings remain after a full exit");

    const stmts = await db
      .select()
      .from(investorStatementsTable)
      .where(eq(investorStatementsTable.userId, investorA));
    assert(stmts.some((s) => s.id === exitSettled.finalStatementId), "the final statement row belongs to investor A");

    const prefsA = await getPreferences(investorA);
    assert(prefsA.allocationLocked === true, "allocation is locked after a full exit");
    await expectThrow(
      () => createDepositRequest({ userId: investorA!, grossAmount: 100, speedTierKey: "STANDARD" }),
      "ALLOCATION_LOCKED",
      "a new deposit is refused while allocation is locked",
    );

    // ── 6. Per-investor isolation ─────────────────────────────────────────────
    // eslint-disable-next-line no-console
    console.log("\n6. Per-investor isolation");
    const depB = await createDepositRequest({ userId: investorB, grossAmount: 1000, speedTierKey: "FAST" });
    await approveRequest(admin, depB.id, "qa approve deposit B");
    await settleRequest(admin, depB.id, "qa settle deposit B");

    const reqsA = await listInvestorRequests(investorA);
    assert(reqsA.length > 0 && reqsA.every((r) => r.userId === investorA), "investor A's request list contains ONLY A's rows");
    const feesAonly = await listInvestorFeeEntries(investorA);
    assert(feesAonly.every((f) => f.userId === investorA), "investor A's fee entries contain ONLY A's rows");
    const locksAonly = await listInvestorLocks(investorA);
    assert(locksAonly.every((l) => l.userId === investorA), "investor A's locks contain ONLY A's rows");
    assert((await getInvestorRequest(investorA, depB.id)) === null, "investor A cannot read investor B's request");

    // ── 7. Periodic fees: management charge + below-HWM performance no-op ──────
    // eslint-disable-next-line no-console
    console.log("\n7. Periodic management fee charges; performance fee below high-water is a no-op");
    const mgmt = await chargePeriodicFee(admin, {
      userId: investorB,
      poolKey: POOL_KEY,
      feeType: "MANAGEMENT",
      annualPct: 12,
      periodDays: 365,
      reason: "qa annual management fee",
    });
    assert(approx(mgmt.feeAmount, 990 * 0.12) && mgmt.unitsRedeemed > 0, "management fee = 12% of value over a full year (118.8)");
    const feesB = await listInvestorFeeEntries(investorB);
    const mgmtFee = feesB.find((f) => f.feeType === "MANAGEMENT");
    assert(mgmtFee != null && mgmtFee.periodDays === 365, "a MANAGEMENT fee row was written covering 365 days");

    // Force the holding's high-water above its current value, then a perf fee must no-op.
    await db
      .update(investorPoolHoldingsTable)
      .set({ highWaterValue: 1_000_000 })
      .where(and(eq(investorPoolHoldingsTable.userId, investorB), eq(investorPoolHoldingsTable.strategyPoolId, poolId)));
    const noopBefore = await auditCount(investorB, "FUNDBOOK_CAPITAL_PERIODIC_FEE_NOOP");
    const perf = await chargePeriodicFee(admin, {
      userId: investorB,
      poolKey: POOL_KEY,
      feeType: "PERFORMANCE",
      performancePct: 20,
      reason: "qa performance fee below high-water",
    });
    assert(perf.feeAmount === 0 && perf.unitsRedeemed === 0, "performance fee below high-water charges nothing");
    assert(
      (await auditCount(investorB, "FUNDBOOK_CAPITAL_PERIODIC_FEE_NOOP")) === noopBefore + 1,
      "the below-high-water no-op is still audited",
    );
    assert(
      (await listInvestorFeeEntries(investorB)).filter((f) => f.feeType === "PERFORMANCE").length === 0,
      "no PERFORMANCE fee row is written below the high-water mark",
    );
  } catch (e) {
    assert(false, `unexpected error: ${(e as Error).message}`);
  } finally {
    const ids = [investorA, investorB, adminId].filter((x): x is number => typeof x === "number");
    try {
      if (ids.length > 0) {
        await db.delete(investorDisclosureAcknowledgmentsTable).where(inArray(investorDisclosureAcknowledgmentsTable.userId, ids));
        await db.delete(fundBookFeeEntriesTable).where(inArray(fundBookFeeEntriesTable.userId, ids));
        await db.delete(investorDepositLocksTable).where(inArray(investorDepositLocksTable.userId, ids));
        await db.delete(capitalMovementRequestsTable).where(inArray(capitalMovementRequestsTable.userId, ids));
        await db.delete(investorCapitalPreferencesTable).where(inArray(investorCapitalPreferencesTable.userId, ids));
        await db.delete(investorStatementsTable).where(inArray(investorStatementsTable.userId, ids));
        await db.delete(fundBookUnitEventsTable).where(inArray(fundBookUnitEventsTable.userId, ids));
        await db.delete(investorPoolHoldingsTable).where(inArray(investorPoolHoldingsTable.userId, ids));
        await db.delete(adminActionAuditLogTable).where(inArray(adminActionAuditLogTable.targetUserId, ids));
        await db.delete(usersTable).where(inArray(usersTable.id, ids));
      }
      // Re-activate the exact pre-existing freezes suspended above, then
      // SENTINEL-verify the restore actually landed: if this suite is ever
      // killed mid-run (no finally) or the restore silently fails, the next
      // run — and this one's output — must make the altered safety posture
      // loudly visible instead of leaving the dev DB quietly unprotected.
      if (suspendedFreezeIds.length > 0) {
        await db
          .update(fundControlFreezesTable)
          .set({ active: true })
          .where(inArray(fundControlFreezesTable.id, suspendedFreezeIds));
        const restored = await db
          .select({ id: fundControlFreezesTable.id })
          .from(fundControlFreezesTable)
          .where(
            and(
              inArray(fundControlFreezesTable.id, suspendedFreezeIds),
              eq(fundControlFreezesTable.active, true),
            ),
          );
        assert(
          restored.length === suspendedFreezeIds.length,
          `sentinel: all ${suspendedFreezeIds.length} suspended freeze(s) re-activated (got ${restored.length})`,
        );
      }
      // Restore tier state EXACTLY as captured: delete whatever this run
      // created, then re-insert the original row if one existed. Remove the
      // tier events + price ladder this run appended/seeded (only if the pool
      // had no ladder before — seedTiersForPool never mutates existing rows).
      if (poolId != null && tierCaptured) {
        await db.delete(fundBookPoolTierStateTable).where(eq(fundBookPoolTierStateTable.strategyPoolId, poolId));
        if (origTierState) await db.insert(fundBookPoolTierStateTable).values(origTierState);
        const eventsNow = await db
          .select()
          .from(fundBookPoolTierEventsTable)
          .where(eq(fundBookPoolTierEventsTable.strategyPoolId, poolId));
        const baseline = new Set(tierEventBaselineIds);
        const appended = eventsNow.map((r) => r.id).filter((id) => !baseline.has(id));
        if (appended.length > 0) {
          await db.delete(fundBookPoolTierEventsTable).where(inArray(fundBookPoolTierEventsTable.id, appended));
        }
        if (origTierLadderCount === 0) {
          await db.delete(fundBookSharePriceTiersTable).where(eq(fundBookSharePriceTiersTable.strategyPoolId, poolId));
        }
      }
      // Restore the shared BALANCED NAV snapshot exactly as found.
      if (poolId != null && navBaseline != null) {
        await db
          .update(strategyPoolNavTable)
          .set({
            navPerUnit: navBaseline.navPerUnit,
            totalUnitsOutstanding: navBaseline.totalUnitsOutstanding,
            totalPoolValue: navBaseline.totalPoolValue,
            realizedPl: navBaseline.realizedPl,
            unrealizedPl: navBaseline.unrealizedPl,
            feesAccrued: navBaseline.feesAccrued,
            depositsAllocated: navBaseline.depositsAllocated,
            withdrawalsRedeemed: navBaseline.withdrawalsRedeemed,
            approvedAdjustments: navBaseline.approvedAdjustments,
            highWaterValue: navBaseline.highWaterValue,
            currentDrawdownPercent: navBaseline.currentDrawdownPercent,
            navStatus: navBaseline.navStatus,
          })
          .where(eq(strategyPoolNavTable.strategyPoolId, poolId));
      }
      // Restore the singleton settings row exactly as found.
      if (settingsBaseline != null) {
        await db
          .update(fundCapitalSettingsTable)
          .set({
            depositLockDays: settingsBaseline.depositLockDays,
            liquidityFeePct: settingsBaseline.liquidityFeePct,
            performanceFeePct: settingsBaseline.performanceFeePct,
            managementFeeAnnualPct: settingsBaseline.managementFeeAnnualPct,
            minDepositAmount: settingsBaseline.minDepositAmount,
            minWithdrawalAmount: settingsBaseline.minWithdrawalAmount,
            withdrawalPriority: settingsBaseline.withdrawalPriority,
            navCutoffHour: settingsBaseline.navCutoffHour,
            navCutoffMinute: settingsBaseline.navCutoffMinute,
            navCutoffTimezone: settingsBaseline.navCutoffTimezone,
            disclosureVersion: settingsBaseline.disclosureVersion,
          })
          .where(eq(fundCapitalSettingsTable.scope, "GLOBAL"));
      }
    } catch (e) {
      assert(false, `cleanup failed: ${(e as Error).message}`);
    }
  }

  const endLive = await liveCommandsCount();
  assert(endLive === startLive, `no live command created (start=${startLive} end=${endLive})`);

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  await pool.end().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error("[fundBookCapitalTest] FAILED:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
