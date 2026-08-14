// fundBookTierIntegrationTest.ts — DB integration proof (Task #613, the
// non-blocking follow-up from the Task #610 review) for the tier-engine
// recompute that drives tier-based investor buy-in pricing on the BALANCED pool.
//
// Task #610 added per-pool share-price TIERS: as the pool's FINALIZED total NAV
// grows, the investor buy-in price steps up (T1 "Founder" $1.00 → T2 "Early
// Believer" $1.10 → …). Task #612 then wired `recomputeAndAdvanceTier` into
// EVERY finalized-NAV mutation path (deposit settle, withdrawal settle, periodic
// fee) so the tier state + append-only tier event ledger are updated INSIDE the
// caller's transaction. The pure tier math is already locked by
// `fundbook-tier-math.test.ts`; THIS test exercises the same engine against a
// REAL Postgres database (no HTTP) to prove the persistence + transaction
// semantics that the pure test cannot.
//
// IT PROVES (REAL service + DB, no HTTP):
//   - A FINALIZED total-NAV crossing of a tier threshold advances the persisted
//     tier and appends EXACTLY ONE TIER_CHANGE event (T1→T2 at $25,000, the
//     buy-in price moving $1.00 → $1.10) — recorded inside a real transaction.
//   - FLOATING / unrealized P/L NEVER advances the tier: an estimated NAV pushed
//     several tiers past the threshold while the finalized NAV stays in-band
//     leaves the active tier unchanged and writes NO new event (the finalized
//     basis is the only thing that moves the tier).
//   - Withdrawals are evaluated on the FINALIZED basis and the stair-step rule
//     holds the tier: dropping the finalized NAV back below the T2 threshold does
//     NOT downgrade the tier and writes NO event (existing investors are never
//     repriced downward).
//   - The recompute participates in the CALLER'S transaction: a recompute issued
//     inside a db.transaction that then throws is fully rolled back — no tier
//     state change and no orphan event row survive.
//   - Per-POOL isolation: recomputing a different pool creates/updates only that
//     pool's tier state and never mutates the BALANCED pool's tier state.
//
// SAFETY / ISOLATION:
//   - Operates on the shared BALANCED (+ a second) seed pool. The pool NAV
//     snapshot(s) AND the pool-scoped tier_state / price-ladder rows are captured
//     and restored EXACTLY as found.
//   - Deterministic isolation: the tier_state rows are RESET to clean at the
//     START of the run so the T1 baseline never depends on accumulated dev-DB
//     drift (a tier_state row left advanced by a prior run would otherwise persist
//     via the no-downgrade stair-step rule and fail step 1 — the self-perpetuating
//     pollution this test previously suffered). Only the tier_event rows this run
//     appends (id beyond the captured baseline) are removed — the append-only
//     ledger is otherwise untouched. Cleanup is idempotent and runs even on
//     failure.
//   - Never places a trade / touches any execution / live / bridge surface; the
//     starting arx_live_commands count is asserted unchanged at the end.
//   - Only DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:fundbook-tier

import { eq, inArray } from "drizzle-orm";
import {
  pool,
  db,
  strategyPoolsTable,
  strategyPoolNavTable,
  fundBookPoolTierStateTable,
  fundBookPoolTierEventsTable,
  fundBookSharePriceTiersTable,
} from "@workspace/db";
import {
  recomputeAndAdvanceTier,
  getPoolTierState,
} from "../../artifacts/api-server/src/lib/fundbook/tierEngine.js";

const BALANCED_KEY = "BALANCED";
// A second, distinct pool used only to prove per-pool isolation.
const OTHER_KEY = "CONSERVATIVE";

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

async function liveCommandsCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}
async function tierEventCount(poolId: number): Promise<number> {
  const rows = await db
    .select()
    .from(fundBookPoolTierEventsTable)
    .where(eq(fundBookPoolTierEventsTable.strategyPoolId, poolId));
  return rows.length;
}

type NavSnapshot = typeof strategyPoolNavTable.$inferSelect;

async function loadNav(poolId: number): Promise<NavSnapshot> {
  const rows = await db
    .select()
    .from(strategyPoolNavTable)
    .where(eq(strategyPoolNavTable.strategyPoolId, poolId))
    .limit(1);
  if (!rows[0]) throw new Error(`NAV row missing for pool ${poolId}`);
  return rows[0];
}

// Overwrite ONLY the finalized/estimated NAV inputs the tier engine reads,
// leaving the rest of the row alone. The full snapshot is restored in cleanup.
async function setNavInputs(
  poolId: number,
  v: { realizedPl?: number; unrealizedPl?: number; depositsAllocated?: number; withdrawalsRedeemed?: number; feesAccrued?: number; totalUnitsOutstanding?: number },
): Promise<void> {
  await db
    .update(strategyPoolNavTable)
    .set({
      realizedPl: v.realizedPl ?? 0,
      unrealizedPl: v.unrealizedPl ?? 0,
      depositsAllocated: v.depositsAllocated ?? 0,
      withdrawalsRedeemed: v.withdrawalsRedeemed ?? 0,
      feesAccrued: v.feesAccrued ?? 0,
      totalUnitsOutstanding: v.totalUnitsOutstanding ?? 0,
    })
    .where(eq(strategyPoolNavTable.strategyPoolId, poolId));
}

async function restoreNav(snap: NavSnapshot): Promise<void> {
  await db
    .update(strategyPoolNavTable)
    .set({
      navPerUnit: snap.navPerUnit,
      totalUnitsOutstanding: snap.totalUnitsOutstanding,
      totalPoolValue: snap.totalPoolValue,
      realizedPl: snap.realizedPl,
      unrealizedPl: snap.unrealizedPl,
      feesAccrued: snap.feesAccrued,
      depositsAllocated: snap.depositsAllocated,
      withdrawalsRedeemed: snap.withdrawalsRedeemed,
      approvedAdjustments: snap.approvedAdjustments,
      highWaterValue: snap.highWaterValue,
      currentDrawdownPercent: snap.currentDrawdownPercent,
      navStatus: snap.navStatus,
    })
    .where(eq(strategyPoolNavTable.strategyPoolId, snap.strategyPoolId));
}

type TierStateRow = typeof fundBookPoolTierStateTable.$inferSelect;
type SharePriceTierRow = typeof fundBookSharePriceTiersTable.$inferSelect;

// Load the RAW tier_state row (not the derived getPoolTierState shape) so it can
// be re-inserted byte-for-byte in cleanup.
async function loadTierStateRow(poolId: number): Promise<TierStateRow | null> {
  const rows = await db
    .select()
    .from(fundBookPoolTierStateTable)
    .where(eq(fundBookPoolTierStateTable.strategyPoolId, poolId))
    .limit(1);
  return rows[0] ?? null;
}
async function loadSharePriceTiers(poolId: number): Promise<SharePriceTierRow[]> {
  return db
    .select()
    .from(fundBookSharePriceTiersTable)
    .where(eq(fundBookSharePriceTiersTable.strategyPoolId, poolId));
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("fundBookTierIntegrationTest");
  // eslint-disable-next-line no-console
  console.log("===========================\n");

  const startLive = await liveCommandsCount();

  // Resolve the pools and capture restore baselines BEFORE any mutation.
  const balancedRow = (
    await db.select().from(strategyPoolsTable).where(eq(strategyPoolsTable.poolKey, BALANCED_KEY)).limit(1)
  )[0];
  const otherRow = (
    await db.select().from(strategyPoolsTable).where(eq(strategyPoolsTable.poolKey, OTHER_KEY)).limit(1)
  )[0];
  assert(balancedRow != null, "BALANCED seed pool exists");
  assert(otherRow != null, `${OTHER_KEY} seed pool exists (per-pool isolation)`);
  if (!balancedRow || !otherRow) {
    // eslint-disable-next-line no-console
    console.error("required seed pools missing — aborting");
    await pool.end().catch(() => {});
    process.exit(1);
    return;
  }
  const balancedId = balancedRow.id;
  const otherId = otherRow.id;

  const navBaseline = await loadNav(balancedId);
  // Tier_event ledger baseline: only rows appended beyond these ids are deleted.
  const balancedEventBaseline = await tierEventCount(balancedId);
  const otherEventBaseline = await tierEventCount(otherId);

  // ── Deterministic isolation (capture → reset → restore) ───────────────────
  // Capture the EXACT pre-existing tier_state + price-ladder rows for both pools
  // so cleanup restores them byte-for-byte. Then DELETE the tier_state rows so
  // this run starts from a guaranteed-clean T1 baseline regardless of accumulated
  // dev-DB drift. Without this reset, a tier_state row left advanced by a prior
  // run (via that run's NAV manipulation) would persist through the no-downgrade
  // stair-step rule and fail step 1's "baseline is T1" assertion — the
  // self-perpetuating pollution this test previously suffered. seedTiersForPool
  // (idempotent) inside recompute reseeds the price ladder if it was empty.
  const origBalancedTierState = await loadTierStateRow(balancedId);
  const origOtherTierState = await loadTierStateRow(otherId);
  const origBalancedTiers = await loadSharePriceTiers(balancedId);
  const origOtherTiers = await loadSharePriceTiers(otherId);
  await db.delete(fundBookPoolTierStateTable).where(eq(fundBookPoolTierStateTable.strategyPoolId, balancedId));
  await db.delete(fundBookPoolTierStateTable).where(eq(fundBookPoolTierStateTable.strategyPoolId, otherId));

  try {
    // ── 1. Baseline: a clean (zeroed) finalized NAV sits at T1, no event ───────
    // eslint-disable-next-line no-console
    console.log("1. Clean finalized NAV ⇒ T1 Founder, no tier event");
    await setNavInputs(balancedId, {}); // all zeros
    const base = await recomputeAndAdvanceTier(balancedId, { reason: "qa baseline" });
    assert(base.tierState.activeTierNum === 1, `baseline active tier is T1 (got ${base.tierState.activeTierNum})`);
    assert(approx(base.tierState.activeBuyInPrice, 1.0), "baseline buy-in price is $1.00");
    assert(approx(base.finalizedTotalNav, 0), "baseline finalized NAV is 0 (startingCapital 0)");
    assert(
      (await tierEventCount(balancedId)) === balancedEventBaseline,
      "no tier event written for a no-op recompute (tier unchanged)",
    );

    // ── 2. FINALIZED crossing $25,000 ⇒ advance T1→T2, exactly ONE event ───────
    // eslint-disable-next-line no-console
    console.log("\n2. Finalized NAV crosses $25,000 ⇒ T1→T2, one TIER_CHANGE event");
    await setNavInputs(balancedId, { depositsAllocated: 30_000 }); // finalized = 30,000
    const cross = await recomputeAndAdvanceTier(balancedId, { reason: "qa finalized crossing" });
    assert(cross.tierChanged, "recompute reports tierChanged on a finalized crossing");
    assert(cross.tierState.activeTierNum === 2, `active tier advanced to T2 (got ${cross.tierState.activeTierNum})`);
    assert(cross.tierState.activeTierLabel === "Early Believer", "T2 label is 'Early Believer'");
    assert(approx(cross.tierState.activeBuyInPrice, 1.1), "buy-in price stepped up to $1.10");
    assert(approx(cross.finalizedTotalNav, 30_000), "finalized NAV snapshot is $30,000");
    assert(
      (await tierEventCount(balancedId)) === balancedEventBaseline + 1,
      "exactly one tier event appended on the crossing",
    );
    {
      const ev = (
        await db
          .select()
          .from(fundBookPoolTierEventsTable)
          .where(eq(fundBookPoolTierEventsTable.strategyPoolId, balancedId))
          .orderBy(fundBookPoolTierEventsTable.id)
      ).at(-1)!;
      assert(ev.eventType === "TIER_CHANGE", `appended event is a TIER_CHANGE (got ${ev.eventType})`);
      assert(ev.tierNumBefore === 1 && ev.tierNumAfter === 2, "event records the T1→T2 transition");
      assert(approx(ev.sharePriceBefore ?? 0, 1.0) && approx(ev.sharePriceAfter, 1.1), "event records $1.00 → $1.10");
      assert(approx(ev.finalizedNavAfter, 30_000), "event records the $30,000 finalized NAV that triggered it");
    }

    // ── 3. FLOATING (unrealized) P/L never advances the tier ───────────────────
    // eslint-disable-next-line no-console
    console.log("\n3. Floating/unrealized P/L past several tiers ⇒ tier stays T2, no event");
    const beforeFloatEvents = await tierEventCount(balancedId);
    // Finalized stays at $30,000 (T2 band) but estimated balloons to $130,000
    // (which, on a FINALIZED basis, would be T4). The tier must NOT move.
    await setNavInputs(balancedId, { depositsAllocated: 30_000, unrealizedPl: 100_000 });
    const floatRc = await recomputeAndAdvanceTier(balancedId, { reason: "qa floating must not advance" });
    assert(!floatRc.tierChanged, "floating P/L does not change the tier");
    assert(floatRc.tierState.activeTierNum === 2, `active tier still T2 under floating gains (got ${floatRc.tierState.activeTierNum})`);
    assert(approx(floatRc.finalizedTotalNav, 30_000), "finalized NAV unaffected by floating P/L");
    assert(approx(floatRc.estimatedTotalNav, 130_000), "estimated NAV reflects the floating gain ($130,000)");
    assert(
      (await tierEventCount(balancedId)) === beforeFloatEvents,
      "no tier event written for a floating-only NAV change",
    );

    // ── 4. Withdrawal (finalized basis) ⇒ stair-step holds, no downgrade ───────
    // eslint-disable-next-line no-console
    console.log("\n4. Finalized NAV drops below $25,000 (withdrawal) ⇒ tier holds at T2, no event");
    const beforeWdEvents = await tierEventCount(balancedId);
    // Redeem $20,000: finalized = 30,000 − 20,000 = 10,000 (back in the T1 band).
    await setNavInputs(balancedId, { depositsAllocated: 30_000, withdrawalsRedeemed: 20_000 });
    const wdRc = await recomputeAndAdvanceTier(balancedId, { reason: "qa withdrawal finalized basis" });
    assert(approx(wdRc.finalizedTotalNav, 10_000), "withdrawal lowers the finalized NAV to $10,000");
    assert(!wdRc.tierChanged, "a finalized drop does NOT change the tier (stair-step, no downgrade)");
    assert(wdRc.tierState.activeTierNum === 2, `tier held at T2 after the drop (got ${wdRc.tierState.activeTierNum})`);
    assert(approx(wdRc.tierState.activeBuyInPrice, 1.1), "buy-in price stays at the highest-reached $1.10");
    assert(
      (await tierEventCount(balancedId)) === beforeWdEvents,
      "no tier event written on a non-advancing (downgrade-suppressed) recompute",
    );

    // ── 5. Recompute participates in the caller's transaction (atomic rollback) ─
    // eslint-disable-next-line no-console
    console.log("\n5. Recompute inside a transaction that throws ⇒ fully rolled back");
    const beforeRollbackEvents = await tierEventCount(balancedId);
    const beforeRollbackState = (await getPoolTierState(balancedId))!;
    // Push the finalized NAV well into T5 territory, but throw before commit.
    await setNavInputs(balancedId, { depositsAllocated: 300_000 }); // would be T5 ($200k–$350k)
    let threw = false;
    try {
      await db.transaction(async (tx) => {
        await recomputeAndAdvanceTier(balancedId, { reason: "qa rollback", runner: tx });
        throw new Error("intentional rollback");
      });
    } catch {
      threw = true;
    }
    assert(threw, "the wrapping transaction threw as expected");
    const afterRollbackState = (await getPoolTierState(balancedId))!;
    assert(
      afterRollbackState.activeTierNum === beforeRollbackState.activeTierNum,
      `tier state unchanged after rollback (still T${beforeRollbackState.activeTierNum})`,
    );
    assert(
      approx(afterRollbackState.finalizedTotalNav, beforeRollbackState.finalizedTotalNav),
      "finalized-NAV snapshot unchanged after rollback (recompute joined the caller's tx)",
    );
    assert(
      (await tierEventCount(balancedId)) === beforeRollbackEvents,
      "no orphan tier event survived the rolled-back transaction",
    );

    // ── 6. Per-pool isolation ──────────────────────────────────────────────────
    // eslint-disable-next-line no-console
    console.log("\n6. Recomputing a different pool never mutates BALANCED's tier state");
    const balancedStateBeforeOther = (await getPoolTierState(balancedId))!;
    const otherRc = await recomputeAndAdvanceTier(otherId, { reason: "qa per-pool isolation" });
    assert(otherRc.tierState.strategyPoolId === otherId, "the other pool got its own tier state row");
    const balancedStateAfterOther = (await getPoolTierState(balancedId))!;
    assert(
      balancedStateAfterOther.activeTierNum === balancedStateBeforeOther.activeTierNum &&
        approx(balancedStateAfterOther.finalizedTotalNav, balancedStateBeforeOther.finalizedTotalNav),
      "BALANCED tier state untouched by the other pool's recompute",
    );
  } catch (e) {
    assert(false, `unexpected error: ${(e as Error).message}`);
  } finally {
    try {
      // Remove only the tier events THIS test appended (beyond the baselines).
      const balancedEvents = await db
        .select()
        .from(fundBookPoolTierEventsTable)
        .where(eq(fundBookPoolTierEventsTable.strategyPoolId, balancedId))
        .orderBy(fundBookPoolTierEventsTable.id);
      const balancedExcessIds = balancedEvents.slice(balancedEventBaseline).map((r) => r.id);
      if (balancedExcessIds.length > 0) {
        await db.delete(fundBookPoolTierEventsTable).where(inArray(fundBookPoolTierEventsTable.id, balancedExcessIds));
      }
      const otherEvents = await db
        .select()
        .from(fundBookPoolTierEventsTable)
        .where(eq(fundBookPoolTierEventsTable.strategyPoolId, otherId))
        .orderBy(fundBookPoolTierEventsTable.id);
      const otherExcessIds = otherEvents.slice(otherEventBaseline).map((r) => r.id);
      if (otherExcessIds.length > 0) {
        await db.delete(fundBookPoolTierEventsTable).where(inArray(fundBookPoolTierEventsTable.id, otherExcessIds));
      }

      // Restore tier_state EXACTLY as captured: delete whatever this run created,
      // then re-insert the original row if one existed. Idempotent and never
      // self-perpetuating — the start-of-run reset guarantees a clean T1 baseline
      // next time regardless of what is restored here.
      for (const [poolId, orig] of [
        [balancedId, origBalancedTierState],
        [otherId, origOtherTierState],
      ] as const) {
        await db.delete(fundBookPoolTierStateTable).where(eq(fundBookPoolTierStateTable.strategyPoolId, poolId));
        if (orig) await db.insert(fundBookPoolTierStateTable).values(orig);
      }
      // Price ladder: seedTiersForPool only INSERTS missing canonical rows and
      // never mutates existing ones, so a pool that already had tiers is intact.
      // Only remove the ladder this run seeded (pools that had none before).
      if (origBalancedTiers.length === 0) {
        await db.delete(fundBookSharePriceTiersTable).where(eq(fundBookSharePriceTiersTable.strategyPoolId, balancedId));
      }
      if (origOtherTiers.length === 0) {
        await db.delete(fundBookSharePriceTiersTable).where(eq(fundBookSharePriceTiersTable.strategyPoolId, otherId));
      }

      // Restore the BALANCED NAV snapshot exactly as found.
      await restoreNav(navBaseline);
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
  console.error("[fundBookTierIntegrationTest] FAILED:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
