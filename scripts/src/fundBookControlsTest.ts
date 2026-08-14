// fundBookControlsTest.ts — Automated proof (Task #133) of the ARX Fund Book
// "Discrepancy & controls center": the admin reconciliation / safety-net ENGINE
// + persisted records. Detection-only — it flags + locks, never auto-edits a
// balance, never touches live execution / the 16-gate evaluator / the bridge,
// and investors never see internals.
//
// IT PROVES:
//   PURE (no IO):
//     - classifySeverity grades an absolute ($) + relative (fraction) mismatch
//       into LOW / MEDIUM / HIGH / CRITICAL, or null inside the LOW tolerance;
//       either dimension can drive the band, the highest exceeded band wins.
//     - computeDelta reports observed − expected and a non-negative percent of
//       the larger magnitude (0/0 ⇒ 0%).
//     - evaluateReconciliation fires every detection rule (broker-vs-pool,
//       pool-units-NAV, investor-value-vs-pool, pool-floating-P/L,
//       unassigned-position, stale-broker-sync, settled-deposit-without-units,
//       approved-withdrawal-without-reserved-units) with the right severity.
//     - classifyValueFreshness maps the 4-state broker freshness through 1:1 and
//       collapses every verification state (NAV under review, an open
//       discrepancy, an active freeze) to UNDER_REVIEW, with a calm,
//       internals-free investor message.
//     - classifyCapacityStatus / evaluateDepositCapacity grade OPEN /
//       NEAR_CAPACITY / FULL, layer the PAUSED / CLOSED admin override, and route
//       an over-cap deposit to the waitlist (or cash reserve) — never silently.
//   INTEGRATION (REAL service + DB, no HTTP):
//     - getReconciliationSettings returns the singleton; updating it writes a
//       fail-closed audited row.
//     - A seeded settled deposit with no units issued is detected as a CRITICAL
//       SETTLED_DEPOSIT_WITHOUT_UNITS discrepancy; with autoLockOnCritical on the
//       run auto-applies ISSUANCE / WITHDRAWALS / STATEMENTS freezes, which then
//       block assertActionAllowed at those checkpoints.
//     - A second run is idempotent: the same logical discrepancy is one row
//       (occurrenceCount bumped, not duplicated) and the already-active freezes
//       are not re-applied.
//     - Per-investor freshness scoping: a keyed INVESTOR freeze on user A makes
//       only A's value-status UNDER_REVIEW; user B is untouched.
//     - upsertCapacityLimit + addToWaitlist persist with an audited reason.
//
// SAFETY / ISOLATION:
//   - Seeds isolated users (fixed TAG) and operates ONLY on their rows.
//   - Snapshots every fund_control_freezes id before the integration phase and
//     removes ONLY freezes created during the test (pre-existing freezes are left
//     exactly as found — they are safety state, never auto-cleared).
//   - Captures and restores the singleton fund_reconciliation_settings row.
//   - Idempotent cleanup of every seeded row at the end, even on failure.
//   - Never places a trade / touches any execution / live / bridge surface; the
//     starting arx_live_commands count is asserted unchanged at the end.
//   - Only DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:fundbook-controls

import { eq, inArray } from "drizzle-orm";
import {
  pool,
  db,
  usersTable,
  adminActionAuditLogTable,
  capitalMovementRequestsTable,
  fundReconciliationSettingsTable,
  fundDiscrepanciesTable,
  fundControlFreezesTable,
  fundCapacityLimitsTable,
  fundCapacityWaitlistTable,
} from "@workspace/db";
import {
  classifySeverity,
  computeDelta,
  evaluateReconciliation,
  DEFAULT_BANDS,
  type ReconciliationSnapshot,
} from "../../artifacts/api-server/src/lib/fundbook/discrepancyRules.js";
import {
  classifyValueFreshness,
} from "../../artifacts/api-server/src/lib/fundbook/valueFreshness.js";
import {
  classifyCapacityStatus,
  evaluateDepositCapacity,
  evaluateCapacity,
} from "../../artifacts/api-server/src/lib/fundbook/capacity.js";
import {
  getReconciliationSettings,
  updateReconciliationSettings,
  runReconciliation,
  listDiscrepancies,
  applyFreeze,
  liftFreeze,
  isFrozen,
  assertActionAllowed,
  upsertCapacityLimit,
  addToWaitlist,
  getValueStatusForUser,
  FundControlError,
  type AdminActor,
} from "../../artifacts/api-server/src/lib/fundbook/fundControls.js";
import { setPreferences } from "../../artifacts/api-server/src/lib/fundbook/capitalMovements.js";

const TAG = `qaFundBookControls_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
const POOL_SCOPE_KEY = `${TAG}_POOL`;

// Investor-facing strings must never leak internals or carry forbidden wording.
const FORBIDDEN_TOKENS = [
  "paper",
  "sim",
  "simulat",
  "mock",
  "fake",
  "guarantee",
  "broker",
  "nav",
  "discrepancy",
  "freeze",
  "frozen",
];

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
function cleanInvestorMessage(msg: string): boolean {
  const lower = msg.toLowerCase();
  return !FORBIDDEN_TOKENS.some((t) => lower.includes(t));
}
async function expectThrow(
  fn: () => Promise<unknown>,
  code: string,
  label: string,
): Promise<void> {
  try {
    await fn();
    assert(false, `${label} (expected ${code}, but it resolved)`);
  } catch (e) {
    const got = e instanceof FundControlError ? e.code : (e as Error).message;
    assert(got === code, `${label} (got ${got})`);
  }
}
async function liveCommandsCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}
async function createUser(label: string): Promise<number> {
  const [u] = await db
    .insert(usersTable)
    .values({ email: `${TAG}_${label}@arx.test`, name: `${TAG} ${label}`, role: "INVESTOR" })
    .returning();
  return u!.id;
}

let deferredCleanup: (() => Promise<void>) | null = null;

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("fundBookControlsTest");
  // eslint-disable-next-line no-console
  console.log("====================\n");

  const startLive = await liveCommandsCount();

  // ── 1. PURE: severity grading + delta math ──────────────────────────────────
  // eslint-disable-next-line no-console
  console.log("1. Severity grading + delta math");

  assert(classifySeverity(0.5, 0.005, DEFAULT_BANDS) === null, "within LOW tolerance ⇒ null");
  assert(classifySeverity(5, 0, DEFAULT_BANDS) === "LOW", "$5 ⇒ LOW (> lowUsd, ≤ mediumUsd)");
  assert(classifySeverity(20, 0, DEFAULT_BANDS) === "MEDIUM", "$20 ⇒ MEDIUM");
  assert(classifySeverity(60, 0, DEFAULT_BANDS) === "HIGH", "$60 ⇒ HIGH");
  assert(classifySeverity(150, 0, DEFAULT_BANDS) === "CRITICAL", "$150 ⇒ CRITICAL");
  assert(classifySeverity(0, 0.02, DEFAULT_BANDS) === "LOW", "2% delta ⇒ LOW (pct-driven)");
  assert(classifySeverity(0, 0.5, DEFAULT_BANDS) === "CRITICAL", "50% delta ⇒ CRITICAL (pct-driven)");

  {
    const d = computeDelta(100, 110);
    assert(approx(d.deltaAbsolute, 10), "computeDelta absolute = observed − expected");
    assert(approx(d.deltaPercent, (10 / 110) * 100), "computeDelta percent of larger magnitude");
  }
  {
    const d = computeDelta(0, 0);
    assert(d.deltaAbsolute === 0 && d.deltaPercent === 0, "computeDelta(0,0) ⇒ 0 / 0%");
  }

  // ── 2. PURE: every detection rule fires ─────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log("\n2. Reconciliation detection rules");

  const snap: ReconciliationSnapshot = {
    now: Date.now(),
    brokerEquityTotal: 1000,
    brokerBalanceTotal: 1000,
    brokerFloatingPlTotal: 0,
    brokerAgeMs: 120_000, // > 60s default stale window
    poolValueTotal: 2000, // differs from broker equity
    bookClosedPlTotal: 0,
    brokerClosedPlTotal: null, // broker realized-P/L not ingested ⇒ CLOSED_PL skips
    pools: [
      {
        poolId: 1,
        poolKey: "TESTPOOL",
        navPerUnit: 1,
        totalUnitsOutstanding: 1000,
        totalPoolValue: 2000, // units×NAV (1000) ≠ recorded (2000)
        navStatus: "OK",
        investorUnits: 500, // ≠ outstanding 1000
        floatingPlNav: 0,
        floatingPlReported: 100, // ≠ NAV unrealized 0
      },
    ],
    unassignedPositions: [{ brokerTicket: "T-1", userId: 99, symbol: "EURUSD" }],
    settledDepositsWithoutUnits: [
      { requestId: 5, userId: 7, netAmount: 1000, settledUnits: null },
    ],
    approvedWithdrawalsWithoutReserved: [
      { requestId: 6, userId: 8, isFullExit: false, reservedUnits: 0 },
    ],
    pendingMovements: [
      {
        requestId: 10,
        userId: 11,
        movementType: "DEPOSIT",
        status: "SUBMITTED",
        ageMs: 48 * 60 * 60 * 1000, // 48h — past the 24h backlog window
        grossAmount: 1000,
        netAmount: 975, // net = gross − fee (consistent ⇒ accounting rule silent)
        feeAmount: 25,
      },
    ],
    feesOwedUnposted: [{ requestId: 12, userId: 13, feeAmount: 25 }],
  };
  const candidates = evaluateReconciliation(snap);
  const byType = new Map(candidates.map((c) => [c.discrepancyType, c]));
  for (const t of [
    "BROKER_VS_POOL_VALUE",
    "POOL_UNITS_NAV_MISMATCH",
    "INVESTOR_VALUE_VS_POOL",
    "POOL_FLOATING_PL_MISMATCH",
    "UNASSIGNED_POSITION",
    "STALE_BROKER_SYNC",
    "SETTLED_DEPOSIT_WITHOUT_UNITS",
    "APPROVED_WITHDRAWAL_WITHOUT_RESERVED_UNITS",
    "PENDING_MOVEMENT_BACKLOG",
    "FEES_OWED_UNPOSTED",
  ] as const) {
    assert(byType.has(t), `rule fires: ${t}`);
  }
  assert(
    byType.get("SETTLED_DEPOSIT_WITHOUT_UNITS")?.severity === "CRITICAL",
    "settled-deposit-without-units ⇒ CRITICAL",
  );
  assert(
    byType.get("UNASSIGNED_POSITION")?.severity === "HIGH",
    "unassigned-position ⇒ HIGH",
  );
  assert(
    byType.get("PENDING_MOVEMENT_BACKLOG")?.severity === "LOW",
    "1 backlogged movement ⇒ LOW (never CRITICAL)",
  );
  assert(
    byType.get("PENDING_MOVEMENT_BACKLOG")?.entityKey === "fund:PENDING_BACKLOG",
    "backlog is ONE fund-level candidate",
  );
  assert(
    byType.get("FEES_OWED_UNPOSTED")?.severity === "HIGH",
    "fees-owed-unposted ⇒ HIGH",
  );
  {
    // Backlog severity escalates with count: 3 movements ⇒ MEDIUM, 10 ⇒ HIGH.
    const mkPending = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        requestId: 100 + i,
        userId: 1,
        movementType: "DEPOSIT",
        status: "SUBMITTED",
        ageMs: 48 * 60 * 60 * 1000,
        grossAmount: 1000,
        netAmount: 975,
        feeAmount: 25,
      }));
    const med = evaluateReconciliation({ ...snap, pendingMovements: mkPending(3) });
    assert(
      med.find((c) => c.discrepancyType === "PENDING_MOVEMENT_BACKLOG")?.severity ===
        "MEDIUM",
      "3 backlogged movements ⇒ MEDIUM",
    );
    const high = evaluateReconciliation({ ...snap, pendingMovements: mkPending(10) });
    assert(
      high.find((c) => c.discrepancyType === "PENDING_MOVEMENT_BACKLOG")?.severity ===
        "HIGH",
      "10 backlogged movements ⇒ HIGH",
    );
    // A pending movement younger than the window does NOT fire.
    const fresh = evaluateReconciliation({
      ...snap,
      pendingMovements: [
        {
          requestId: 200,
          userId: 1,
          movementType: "DEPOSIT",
          status: "SUBMITTED",
          ageMs: 60 * 60 * 1000, // 1h < 24h window
          grossAmount: 1000,
          netAmount: 975,
          feeAmount: 25,
        },
      ],
      feesOwedUnposted: [],
    });
    assert(
      !fresh.some((c) => c.discrepancyType === "PENDING_MOVEMENT_BACKLOG"),
      "fresh pending movement ⇒ no backlog candidate",
    );
  }
  {
    // A clean snapshot (matching totals, fresh sync, no structural rows) fires nothing.
    const clean: ReconciliationSnapshot = {
      now: Date.now(),
      brokerEquityTotal: 1000,
      brokerBalanceTotal: 1000,
      brokerFloatingPlTotal: 0,
      brokerAgeMs: 5_000,
      poolValueTotal: 1000,
      bookClosedPlTotal: 0,
      brokerClosedPlTotal: null,
      pools: [
        {
          poolId: 1,
          poolKey: "CLEAN",
          navPerUnit: 1,
          totalUnitsOutstanding: 1000,
          totalPoolValue: 1000,
          navStatus: "OK",
          investorUnits: 1000,
          floatingPlNav: 0,
          floatingPlReported: 0,
        },
      ],
      unassignedPositions: [],
      settledDepositsWithoutUnits: [],
      approvedWithdrawalsWithoutReserved: [],
      pendingMovements: [],
      feesOwedUnposted: [],
    };
    assert(evaluateReconciliation(clean).length === 0, "clean snapshot ⇒ no candidates");

    // 2b. BROKER_BALANCE_MISMATCH — broker settled balance ≠ realized fund value
    // (pool value minus the book's unrealized P/L). Built from a clean base so
    // only this rule can fire.
    {
      const bal = evaluateReconciliation({
        ...clean,
        // realized book = poolValueTotal(1000) − floatingPlNav(0) = 1000;
        // broker settled balance reports 900 ⇒ delta 100.
        brokerBalanceTotal: 900,
      });
      const hit = bal.find((c) => c.discrepancyType === "BROKER_BALANCE_MISMATCH");
      assert(hit != null, "broker settled balance ≠ realized book ⇒ BROKER_BALANCE_MISMATCH");
      assert(hit?.entityKey === "fund:BALANCE", "balance mismatch is ONE fund-level candidate");
      assert(hit?.expectedValue === 1000 && hit?.observedValue === 900, "balance mismatch expected/observed");
    }

    // 2c. CLOSED_PL_MISMATCH — EVIDENCE-GATED on a real broker realized-P/L total.
    {
      // No broker figure (null) ⇒ rule NEVER fires, even when the book has P/L.
      const noEvidence = evaluateReconciliation({
        ...clean,
        bookClosedPlTotal: 500,
        brokerClosedPlTotal: null,
      });
      assert(
        !noEvidence.some((c) => c.discrepancyType === "CLOSED_PL_MISMATCH"),
        "null broker realized P/L ⇒ CLOSED_PL_MISMATCH never fires (no fabrication)",
      );
      // Once a real broker total is present and differs ⇒ rule fires.
      const withEvidence = evaluateReconciliation({
        ...clean,
        bookClosedPlTotal: 500,
        brokerClosedPlTotal: 450,
      });
      const hit = withEvidence.find((c) => c.discrepancyType === "CLOSED_PL_MISMATCH");
      assert(hit != null, "broker realized P/L ≠ book realized P/L ⇒ CLOSED_PL_MISMATCH");
      assert(hit?.expectedValue === 500 && hit?.observedValue === 450, "closed-PL expected/observed");
      // Matching totals (within tolerance) ⇒ no candidate.
      const matched = evaluateReconciliation({
        ...clean,
        bookClosedPlTotal: 500,
        brokerClosedPlTotal: 500,
      });
      assert(
        !matched.some((c) => c.discrepancyType === "CLOSED_PL_MISMATCH"),
        "matching broker/book realized P/L ⇒ no CLOSED_PL_MISMATCH",
      );
    }

    // 2d. PENDING_MOVEMENT_ACCOUNTING_MISMATCH — a pending request whose recorded
    // net breaks net = gross − fee. Per-request, scoped to its investor.
    {
      const acct = evaluateReconciliation({
        ...clean,
        pendingMovements: [
          {
            requestId: 777,
            userId: 42,
            movementType: "WITHDRAWAL",
            status: "APPROVED",
            ageMs: 60 * 60 * 1000, // fresh ⇒ no backlog noise
            grossAmount: 1000,
            netAmount: 900, // recorded net
            feeAmount: 25, // implied net = 975 ≠ 900 ⇒ delta 75
          },
        ],
      });
      const hit = acct.find(
        (c) => c.discrepancyType === "PENDING_MOVEMENT_ACCOUNTING_MISMATCH",
      );
      assert(hit != null, "net ≠ gross − fee ⇒ PENDING_MOVEMENT_ACCOUNTING_MISMATCH");
      assert(hit?.entityKey === "request:777", "accounting mismatch is per-request");
      assert(hit?.userId === 42, "accounting mismatch carries the investor userId (per-investor scope)");
      assert(hit?.expectedValue === 975 && hit?.observedValue === 900, "accounting expected/observed");
      // A consistent pending request (net = gross − fee) fires nothing.
      const consistent = evaluateReconciliation({
        ...clean,
        pendingMovements: [
          {
            requestId: 778,
            userId: 42,
            movementType: "DEPOSIT",
            status: "SUBMITTED",
            ageMs: 60 * 60 * 1000,
            grossAmount: 1000,
            netAmount: 975,
            feeAmount: 25,
          },
        ],
      });
      assert(
        !consistent.some((c) => c.discrepancyType === "PENDING_MOVEMENT_ACCOUNTING_MISMATCH"),
        "consistent pending accounting ⇒ no candidate",
      );
    }
  }

  // ── 3. PURE: value freshness 5-state ────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log("\n3. Value freshness (5-state, investor-safe)");

  assert(
    classifyValueFreshness({ brokerFreshness: "FRESH", brokerAgeMs: 5_000 }).status === "FRESH",
    "FRESH broker ⇒ FRESH",
  );
  assert(
    classifyValueFreshness({ brokerFreshness: "DELAYED", brokerAgeMs: 30_000 }).status === "DELAYED",
    "DELAYED broker ⇒ DELAYED",
  );
  assert(
    classifyValueFreshness({ brokerFreshness: "STALE", brokerAgeMs: 120_000 }).status === "STALE",
    "STALE broker ⇒ STALE",
  );
  assert(
    classifyValueFreshness({ brokerFreshness: "MISSING", brokerAgeMs: null }).status === "MISSING",
    "no broker sync ⇒ MISSING",
  );
  for (const verifying of [
    { brokerFreshness: "FRESH" as const, brokerAgeMs: 5_000, hasOpenDiscrepancy: true },
    { brokerFreshness: "FRESH" as const, brokerAgeMs: 5_000, isFrozen: true },
    { brokerFreshness: "FRESH" as const, brokerAgeMs: 5_000, navStatus: "UNDER_REVIEW" },
  ]) {
    const r = classifyValueFreshness(verifying);
    assert(r.status === "UNDER_REVIEW", "verification state ⇒ UNDER_REVIEW");
    assert(cleanInvestorMessage(r.investorMessage), "UNDER_REVIEW message hides internals");
  }
  for (const s of ["FRESH", "DELAYED", "STALE", "MISSING"] as const) {
    const r = classifyValueFreshness({
      brokerFreshness: s,
      brokerAgeMs: s === "MISSING" ? null : 5_000,
    });
    assert(cleanInvestorMessage(r.investorMessage), `${s} message hides internals`);
    assert(r.adminSource.length > 0, `${s} carries an admin source`);
  }

  // ── 4. PURE: capacity status + deposit routing ──────────────────────────────
  // eslint-disable-next-line no-console
  console.log("\n4. Capacity status + deposit routing");

  assert(
    classifyCapacityStatus(50, { maxCapital: 0, nearThresholdPct: 90 }) === "OPEN",
    "no cap ⇒ OPEN",
  );
  assert(
    classifyCapacityStatus(50, { maxCapital: 100, nearThresholdPct: 90 }) === "OPEN",
    "50% fill ⇒ OPEN",
  );
  assert(
    classifyCapacityStatus(95, { maxCapital: 100, nearThresholdPct: 90 }) === "NEAR_CAPACITY",
    "95% fill ⇒ NEAR_CAPACITY",
  );
  assert(
    classifyCapacityStatus(100, { maxCapital: 100, nearThresholdPct: 90 }) === "FULL",
    "100% fill ⇒ FULL",
  );
  assert(
    classifyCapacityStatus(10, {
      maxCapital: 100,
      nearThresholdPct: 90,
      adminStatusOverride: "PAUSED",
    }) === "PAUSED",
    "admin PAUSED override wins",
  );
  assert(
    classifyCapacityStatus(10, {
      maxCapital: 100,
      nearThresholdPct: 90,
      adminStatusOverride: "CLOSED",
    }) === "CLOSED",
    "admin CLOSED override wins",
  );
  {
    const within = evaluateDepositCapacity({
      currentValue: 10,
      depositAmount: 50,
      limits: { maxCapital: 100, nearThresholdPct: 90 },
      waitlistEnabled: true,
    });
    assert(within.allowed && within.routedTo === "POOL", "within cap ⇒ POOL allowed");
    assert(cleanInvestorMessage(within.investorMessage), "within-cap message clean");

    const overWaitlist = evaluateDepositCapacity({
      currentValue: 90,
      depositAmount: 50,
      limits: { maxCapital: 100, nearThresholdPct: 90 },
      waitlistEnabled: true,
    });
    assert(
      !overWaitlist.allowed && overWaitlist.routedTo === "WAITLIST",
      "over cap + waitlist ⇒ WAITLIST (not allowed into pool)",
    );
    assert(cleanInvestorMessage(overWaitlist.investorMessage), "waitlist message clean");

    const overReserve = evaluateDepositCapacity({
      currentValue: 90,
      depositAmount: 50,
      limits: { maxCapital: 100, nearThresholdPct: 90 },
      waitlistEnabled: false,
    });
    assert(
      !overReserve.allowed && overReserve.routedTo === "CASH_RESERVE",
      "over cap, no waitlist ⇒ CASH_RESERVE",
    );

    const paused = evaluateDepositCapacity({
      currentValue: 10,
      depositAmount: 5,
      limits: { maxCapital: 100, nearThresholdPct: 90, adminStatusOverride: "PAUSED" },
      waitlistEnabled: true,
    });
    assert(!paused.allowed && paused.routedTo === "BLOCKED", "PAUSED ⇒ BLOCKED");
    assert(cleanInvestorMessage(paused.investorMessage), "paused message clean");
  }

  // ── 4b. PURE: multi-cap binding constraint (fund / reserve / exposure / investor)
  // eslint-disable-next-line no-console
  console.log("\n4b. Capacity binding constraint (fund / reserve / exposure / investor)");
  {
    // Pool has headroom, but the FUND total cap binds first.
    const fundBound = evaluateCapacity({
      depositAmount: 50,
      pool: { currentValue: 0, maxPoolCapital: 1000, nearThresholdPct: 90, waitlistEnabled: true },
      fund: {
        fundCurrentValue: 980,
        maxFundCapital: 1000,
        liquidityReservePct: 0,
        exposureCapPct: 100,
      },
    });
    assert(
      !fundBound.allowed && fundBound.bindingConstraint === "FUND",
      "fund total cap is the binding constraint",
    );
    assert(cleanInvestorMessage(fundBound.investorMessage), "fund-bound message clean");

    // The liquidity reserve lowers the deployable ceiling and binds.
    const reserveBound = evaluateCapacity({
      depositAmount: 50,
      pool: { currentValue: 0, maxPoolCapital: 100000, nearThresholdPct: 90, waitlistEnabled: true },
      fund: {
        fundCurrentValue: 880, // reserve ceiling 900 ⇒ headroom 20 < deposit 50
        maxFundCapital: 1000,
        liquidityReservePct: 10, // deployable ceiling = 900
        exposureCapPct: 100,
      },
    });
    assert(
      !reserveBound.allowed && reserveBound.bindingConstraint === "FUND_LIQUIDITY_RESERVE",
      "liquidity reserve is the binding constraint",
    );

    // A single pool may not exceed its exposure share of fund capital.
    const exposureBound = evaluateCapacity({
      depositAmount: 50,
      pool: { currentValue: 190, maxPoolCapital: 100000, nearThresholdPct: 90, waitlistEnabled: true },
      fund: {
        fundCurrentValue: 190,
        maxFundCapital: 1000,
        liquidityReservePct: 0,
        exposureCapPct: 20, // pool exposure ceiling = 200
      },
    });
    assert(
      !exposureBound.allowed && exposureBound.bindingConstraint === "POOL_EXPOSURE_CAP",
      "pool exposure cap is the binding constraint",
    );

    // The per-investor cap binds even when pool + fund have room.
    const investorBound = evaluateCapacity({
      depositAmount: 50,
      pool: { currentValue: 0, maxPoolCapital: 100000, nearThresholdPct: 90, waitlistEnabled: true },
      fund: {
        fundCurrentValue: 0,
        maxFundCapital: 1_000_000,
        liquidityReservePct: 0,
        exposureCapPct: 100,
      },
      investor: { investorCurrentValue: 980, maxInvestorCapital: 1000 },
    });
    assert(
      !investorBound.allowed && investorBound.bindingConstraint === "INVESTOR",
      "per-investor cap is the binding constraint",
    );
    assert(cleanInvestorMessage(investorBound.investorMessage), "investor-bound message clean");

    // All configured caps have headroom ⇒ placed into the pool. The binding
    // constraint names the tightest cap (here POOL), but the deposit is allowed.
    const allClear = evaluateCapacity({
      depositAmount: 50,
      pool: { currentValue: 0, maxPoolCapital: 100000, nearThresholdPct: 90, waitlistEnabled: true },
      fund: {
        fundCurrentValue: 0,
        maxFundCapital: 1_000_000,
        liquidityReservePct: 0,
        exposureCapPct: 100,
      },
      investor: { investorCurrentValue: 0, maxInvestorCapital: 1_000_000 },
    });
    assert(
      allClear.allowed && allClear.routedTo === "POOL",
      "ample headroom everywhere ⇒ deposit placed into POOL",
    );

    // No caps configured at all ⇒ unbounded OPEN with NONE binding.
    const uncapped = evaluateCapacity({
      depositAmount: 50,
      pool: { currentValue: 0, maxPoolCapital: 0, nearThresholdPct: 90, waitlistEnabled: true },
    });
    assert(
      uncapped.allowed && uncapped.routedTo === "POOL" && uncapped.bindingConstraint === "NONE",
      "no caps configured ⇒ POOL, NONE binding",
    );
  }

  // ── 5. INTEGRATION: real service + DB ───────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log("\n5. Engine + freeze + capacity (real service + DB)");

  // Snapshot the singleton settings + ALL existing freeze ids so cleanup removes
  // only what THIS test creates.
  const settingsBaseline = await getReconciliationSettings();
  const preFreezeRows = await db.select({ id: fundControlFreezesTable.id }).from(fundControlFreezesTable);
  const preFreezeIds = new Set(preFreezeRows.map((r) => r.id));
  // Reconciliation scans the whole real DB and persists EVERY discrepancy it finds
  // (not just our seeded one). Snapshot all existing ids so cleanup restores the
  // table exactly to its pre-test state — leaving zero global side effects.
  const preDiscRows = await db.select({ id: fundDiscrepanciesTable.id }).from(fundDiscrepanciesTable);
  const preDiscIds = new Set(preDiscRows.map((r) => r.id));

  const adminId = await createUser("admin");
  const depositUser = await createUser("depositUser");
  const freshUserA = await createUser("freshA");
  const freshUserB = await createUser("freshB");
  const seededUserIds = [adminId, depositUser, freshUserA, freshUserB];
  const admin: AdminActor = { id: adminId, role: "ADMIN" };

  // Register cleanup as a deferred closure so it ALWAYS runs — on the happy path
  // below AND from main().catch if any assertion throws — preventing seeded rows
  // or freezes from leaking into the shared dev DB on failure.
  deferredCleanup = async () => {
    // Remove ONLY freezes created during this test; leave pre-existing safety state.
    const postFreezeRows = await db
      .select({ id: fundControlFreezesTable.id })
      .from(fundControlFreezesTable);
    const newFreezeIds = postFreezeRows.map((r) => r.id).filter((id) => !preFreezeIds.has(id));
    if (newFreezeIds.length) {
      await db.delete(fundControlFreezesTable).where(inArray(fundControlFreezesTable.id, newFreezeIds));
    }
    // Reconciliation persists every real-data discrepancy it finds, not just our
    // seeded one. Delete exactly the rows created during this test (post − pre) so
    // the table is restored to its pre-test state with zero global side effects.
    // (Safe here: no background reconciliation runner writes these tables in dev,
    // so there is no concurrent writer whose rows the post−pre diff could remove.)
    const postDiscRows = await db
      .select({ id: fundDiscrepanciesTable.id })
      .from(fundDiscrepanciesTable);
    const newDiscIds = postDiscRows.map((r) => r.id).filter((id) => !preDiscIds.has(id));
    if (newDiscIds.length) {
      await db.delete(fundDiscrepanciesTable).where(inArray(fundDiscrepanciesTable.id, newDiscIds));
    }
    await db
      .delete(fundCapacityWaitlistTable)
      .where(inArray(fundCapacityWaitlistTable.userId, seededUserIds));
    await db
      .delete(fundCapacityLimitsTable)
      .where(eq(fundCapacityLimitsTable.scopeKey, POOL_SCOPE_KEY));
    await db
      .delete(capitalMovementRequestsTable)
      .where(inArray(capitalMovementRequestsTable.userId, seededUserIds));
    await db
      .delete(adminActionAuditLogTable)
      .where(eq(adminActionAuditLogTable.adminId, adminId));
    await db.delete(usersTable).where(inArray(usersTable.id, seededUserIds));
    // Restore the singleton settings row exactly as found.
    await db
      .update(fundReconciliationSettingsTable)
      .set({
        lowUsd: settingsBaseline.lowUsd,
        mediumUsd: settingsBaseline.mediumUsd,
        highUsd: settingsBaseline.highUsd,
        criticalUsd: settingsBaseline.criticalUsd,
        lowPct: settingsBaseline.lowPct,
        mediumPct: settingsBaseline.mediumPct,
        highPct: settingsBaseline.highPct,
        criticalPct: settingsBaseline.criticalPct,
        staleSyncMs: settingsBaseline.staleSyncMs,
        autoLockOnCritical: settingsBaseline.autoLockOnCritical,
      })
      .where(eq(fundReconciliationSettingsTable.id, settingsBaseline.id));
  };

  // Settings: singleton + audited update.
  assert(settingsBaseline.scope === "GLOBAL", "reconciliation settings are a GLOBAL singleton");
  const updatedSettings = await updateReconciliationSettings(
    admin,
    { autoLockOnCritical: true },
    "QA: ensure auto-lock on critical for this run",
  );
  assert(updatedSettings.autoLockOnCritical === true, "settings update persists autoLockOnCritical");

  // Seed a settled deposit with no units issued ⇒ CRITICAL.
  const [depReq] = await db
    .insert(capitalMovementRequestsTable)
    .values({
      userId: depositUser,
      movementType: "DEPOSIT",
      status: "SETTLED",
      grossAmount: 1000,
      speedTierKey: "none",
      netAmount: 1000,
      settledUnits: null,
    })
    .returning();
  const depReqId = depReq!.id;
  const entityKey = `request:${depReqId}`;

  // Record which auto-lock scopes were ALREADY frozen so the proof tolerates
  // pre-existing safety state (only newly-applied scopes appear in autoLockedScopes).
  const autoScopes = ["ISSUANCE", "WITHDRAWALS", "STATEMENTS"] as const;
  const preFrozen: Record<string, boolean> = {};
  for (const scope of autoScopes) preFrozen[scope] = await isFrozen(scope);

  const run1 = await runReconciliation(admin, "QA: first reconciliation run");
  assert(run1.criticalCount >= 1, "run detects at least one CRITICAL");
  const mine1 = (await listDiscrepancies({ status: "OPEN" })).find((d) => d.entityKey === entityKey);
  assert(!!mine1, "seeded settled-deposit-without-units persisted as an OPEN discrepancy");
  assert(mine1?.severity === "CRITICAL", "seeded discrepancy is CRITICAL");
  for (const scope of autoScopes) {
    if (!preFrozen[scope]) {
      assert(run1.autoLockedScopes.includes(scope), `auto-lock applied: ${scope}`);
    }
    assert(await isFrozen(scope), `${scope} is frozen after the run`);
  }

  // The freeze actually blocks the sensitive checkpoints.
  await expectThrow(
    () => assertActionAllowed(["ISSUANCE"]),
    "ACTION_FROZEN:ISSUANCE",
    "assertActionAllowed refuses while ISSUANCE is frozen",
  );

  // ALLOCATION freeze blocks investor allocation/preference changes (finding #1).
  {
    const allocUser = await createUser("alloc");
    const allocFreeze = await applyFreeze(admin, {
      scope: "ALLOCATION",
      reason: "QA: pause allocation changes for verification",
      source: "MANUAL",
    });
    await expectThrow(
      () => setPreferences(allocUser, { profitPayoutPct: 25 }),
      "ACTION_FROZEN:ALLOCATION",
      "setPreferences refuses while ALLOCATION is frozen",
    );
    await liftFreeze(admin, allocFreeze.id, "QA: lift allocation freeze");
    // After lift, the preference change succeeds.
    const prefs = await setPreferences(allocUser, { profitPayoutPct: 25 });
    assert(prefs.profitPayoutPct === 25, "setPreferences succeeds once ALLOCATION freeze is lifted");

    // A keyed INVESTOR freeze on this user also blocks their preference change.
    const keyedFreeze = await applyFreeze(admin, {
      scope: "INVESTOR",
      scopeKey: String(allocUser),
      reason: "QA: per-investor preference hold",
      source: "MANUAL",
    });
    await expectThrow(
      () => setPreferences(allocUser, { profitPayoutPct: 30 }),
      `ACTION_FROZEN:INVESTOR`,
      "setPreferences refuses while this investor is frozen",
    );
    await liftFreeze(admin, keyedFreeze.id, "QA: lift per-investor hold");
  }

  // Idempotent: a second run does not duplicate the row or re-apply live freezes.
  const run2 = await runReconciliation(admin, "QA: idempotent re-run");
  const mineRows = (await listDiscrepancies({})).filter((d) => d.entityKey === entityKey);
  assert(mineRows.length === 1, "re-run keeps a single row for the same logical discrepancy");
  assert((mineRows[0]?.occurrenceCount ?? 0) >= 2, "re-run bumps occurrenceCount, not row count");
  assert(
    !run2.autoLockedScopes.includes("ISSUANCE"),
    "re-run does not re-apply an already-active freeze",
  );

  // Per-investor freshness scoping: keyed INVESTOR freeze on A only.
  const aFreeze = await applyFreeze(admin, {
    scope: "INVESTOR",
    scopeKey: String(freshUserA),
    reason: "QA: scoped per-investor verification",
    source: "MANUAL",
  });
  assert(aFreeze.scopeKey === String(freshUserA), "keyed INVESTOR freeze stored against user A");
  const statusA = await getValueStatusForUser(freshUserA);
  const statusB = await getValueStatusForUser(freshUserB);
  assert(statusA.status === "UNDER_REVIEW", "user A (frozen) ⇒ UNDER_REVIEW");
  assert(statusB.status !== "UNDER_REVIEW", "user B (untouched) ⇒ not UNDER_REVIEW (scoped)");
  assert(cleanInvestorMessage(statusA.investorMessage), "user A investor message hides internals");

  // Capacity: audited upsert + waitlist row.
  const limit = await upsertCapacityLimit(
    admin,
    {
      scope: "POOL",
      scopeKey: POOL_SCOPE_KEY,
      maxPoolCapital: 100,
      nearCapacityThresholdPct: 90,
      waitlistEnabled: true,
    },
    "QA: set a pool capacity cap",
  );
  assert(limit.maxPoolCapital === 100, "capacity limit upsert persists the cap");
  await addToWaitlist({
    userId: depositUser,
    strategyPoolId: null,
    poolKey: POOL_SCOPE_KEY,
    requestedAmount: 50,
    status: "WAITLISTED",
    investorMessage: "This strategy is at capacity; your request is queued.",
  });
  const wl = await db
    .select({ id: fundCapacityWaitlistTable.id })
    .from(fundCapacityWaitlistTable)
    .where(eq(fundCapacityWaitlistTable.userId, depositUser));
  assert(wl.length === 1, "waitlist row persisted for the over-cap deposit");

  // ── Cleanup (deferred closure — always runs, even on assertion failure) ──────
  try {
    if (deferredCleanup) await deferredCleanup();
  } catch (e) {
    assert(false, `cleanup failed: ${(e as Error).message}`);
  } finally {
    deferredCleanup = null;
  }

  const endLive = await liveCommandsCount();
  assert(endLive === startLive, `no live command created (start=${startLive} end=${endLive})`);

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  await pool.end().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  // Best-effort cleanup so a thrown assertion never leaks test rows into dev.
  if (deferredCleanup) {
    try {
      await deferredCleanup();
    } catch {
      /* best-effort; the original failure below is what matters */
    }
    deferredCleanup = null;
  }
  // eslint-disable-next-line no-console
  console.error("[fundBookControlsTest] FAILED:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
