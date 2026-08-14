// QA — One-Click Toggle + Concurrency Hardening (Pass 1, Parts 7+8).
//
// SCOPE: pure static + in-process probes. Runs NO real trade against any
// broker. The exposure-reservation probes are SELF-ISOLATING: they create
// a DEDICATED, freshly-seeded `shared_master_accounts` fixture row that
// nothing else references, so its open exposure starts at exactly zero
// regardless of whatever rows earlier lane tests (shared-positions-truth,
// live-position-exposure, …) left behind. This is what lets the test run
// safely in the shared sequential `ci:integration` lane rather than being
// manual-only. At the very end we assert `arx_live_commands` count is
// unchanged, release every test reservation, and delete the fixture.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "@workspace/db";

const ROOT = join(import.meta.dirname, "..", "..");
function readFile(p: string): string { return readFileSync(join(ROOT, p), "utf-8"); }
const API_LIB = "../../artifacts/api-server/src/lib";

type Result = { id: number; name: string; ok: boolean; detail: string };
const results: Result[] = [];
function record(id: number, name: string, ok: boolean, detail: string) {
  results.push({ id, name, ok, detail });
}

async function preLiveCount(): Promise<number> {
  const r = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM arx_live_commands`);
  return Number(((r as unknown as { rows: { n: string }[] }).rows[0]).n);
}

// Sentinel connection id for the dedicated QA fixture master. It is far
// outside any real `mt5_connection` range and carries a recognisable
// broker-name marker so a leftover row from a crashed run can be cleaned
// up deterministically. `shared_master_accounts.connection_id` has a
// UNIQUE index, so we delete any prior fixture before inserting.
const QA_MASTER_CONNECTION_ID = 2_000_000_777;
const QA_MASTER_MARKER = "QA_ONE_CLICK_TEST_MASTER";

/**
 * Create a DEDICATED, freshly-seeded master account so the exposure probes
 * have a pristine baseline (zero open lots, zero reservations) no matter
 * what other lane tests left in `shared_trade_attribution` /
 * `arx_dispatch_exposure_reservations`. A brand-new master id is referenced
 * by no attribution rows, so `sumExposure()` sees exactly 0 for it.
 */
async function createDedicatedTestMaster(): Promise<number> {
  await cleanupTestMaster();
  const r = await pool.query<{ id: number }>(
    `INSERT INTO shared_master_accounts
       (connection_id, account_type, broker_name, account_number_masked,
        status, is_active, max_total_exposure_lots)
     VALUES ($1, 'demo', $2, '•••• QA', 'inactive', false, 0.05)
     RETURNING id`,
    [QA_MASTER_CONNECTION_ID, QA_MASTER_MARKER],
  );
  return Number(((r as unknown as { rows: { id: number }[] }).rows[0]).id);
}

/**
 * Remove the dedicated fixture + any reservations scoped to it. We match on
 * BOTH the sentinel connection_id AND the broker-name marker so this can never
 * delete a real row even if the sentinel id were ever reused.
 */
async function cleanupTestMaster(): Promise<void> {
  await pool.query(
    `DELETE FROM arx_dispatch_exposure_reservations
      WHERE shared_master_account_id IN
        (SELECT id FROM shared_master_accounts
          WHERE connection_id = $1 AND broker_name = $2)`,
    [QA_MASTER_CONNECTION_ID, QA_MASTER_MARKER],
  ).catch(() => {});
  await pool.query(
    `DELETE FROM shared_master_accounts
      WHERE connection_id = $1 AND broker_name = $2`,
    [QA_MASTER_CONNECTION_ID, QA_MASTER_MARKER],
  ).catch(() => {});
}

async function main() {
  const beforeLiveCount = await preLiveCount();

  // Dynamically pull in the api-server concurrency primitives via tsx's
  // ts-relative resolution. This avoids making `@workspace/scripts`
  // depend on `@workspace/api-server`.
  const { ARX_LOCK_NS, withTxAdvisoryLock, hashKey32 } = await import(
    `${API_LIB}/concurrency/advisoryLock.ts`
  ) as typeof import("../../artifacts/api-server/src/lib/concurrency/advisoryLock.js");
  const { tryConsumeToken, checkSymbolCooldown, clampPerMinute, __resetRateLimitersForTesting } = await import(
    `${API_LIB}/concurrency/rateLimit.ts`
  ) as typeof import("../../artifacts/api-server/src/lib/concurrency/rateLimit.js");
  const { reserveExposureAtomic, releaseReservation, __releaseAllReservationsForMasterTesting } = await import(
    `${API_LIB}/concurrency/exposureReservation.ts`
  ) as typeof import("../../artifacts/api-server/src/lib/concurrency/exposureReservation.js");

  // ── Static / wiring probes ────────────────────────────────────────
  const schema = readFile("lib/db/src/schema/oneClickTrade.ts");
  record(1, "Defaults OFF — demo_one_click_enabled default(false)",
    /demo_one_click_enabled[\s\S]{0,160}default\(false\)/.test(schema),
    "schema/oneClickTrade.ts");
  record(2, "Defaults OFF — live_one_click_enabled default(false)",
    /live_one_click_enabled[\s\S]{0,160}default\(false\)/.test(schema),
    "schema/oneClickTrade.ts");
  record(3, "Reservation table has partial unique index on RESERVED command_id",
    /arx_disp_reserv_cmd_reserved_uq[\s\S]{0,160}status = 'RESERVED'/.test(schema),
    "schema/oneClickTrade.ts");

  const route = readFile("artifacts/api-server/src/routes/meOneClick.ts");
  record(4, "Typed-confirmation phrase pinned to 'ENABLE ONE CLICK TRADING'",
    /REQUIRED_TYPED_PHRASE\s*=\s*"ENABLE ONE CLICK TRADING"/.test(route),
    "routes/meOneClick.ts");
  record(5, "Standing consent — PUT no longer rejects enables on a typed phrase, but still blocks live without master-live access",
    !/typedConfirmation !== REQUIRED_TYPED_PHRASE/.test(route)
      && /LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS/.test(route),
    "routes/meOneClick.ts");
  record(6, "Enabling LIVE re-checks master-live user-access gate",
    /loadAndEvaluateUserMasterLiveAccessGate/.test(route),
    "routes/meOneClick.ts");
  record(7, "submit-live calls dispatchLiveCommand (all live gates run)",
    /dispatchLiveCommand/.test(route),
    "routes/meOneClick.ts");
  record(8, "submit-live runs under per-user advisory lock",
    /withTxAdvisoryLock\(\s*ARX_LOCK_NS\.USER_SUBMIT/.test(route),
    "routes/meOneClick.ts");

  const pipeline = readFile("artifacts/api-server/src/lib/live/liveCommandPipeline.ts");
  record(9, "Pipeline takes atomic exposure reservation before SENT_TO_MT5_LIVE",
    /reserveExposureAtomic[\s\S]{0,4000}SENT_TO_MT5_LIVE/.test(pipeline),
    "lib/live/liveCommandPipeline.ts");
  record(10, "Pipeline releases reservation on dispatch DB failure",
    /releaseReservation/.test(pipeline),
    "lib/live/liveCommandPipeline.ts");

  // ── In-process behaviour probes ───────────────────────────────────
  __resetRateLimitersForTesting();
  record(11, "Rate limit clamps per-minute to 1..120",
    clampPerMinute(0) === 1 && clampPerMinute(99999) === 120 && clampPerMinute(20) === 20,
    "rateLimit.clampPerMinute");

  // Burst: cap=5 → first 5 pass, 6th refused
  const burst = Array.from({ length: 6 }, () => tryConsumeToken("qa:burst", 5));
  record(12, "Token-bucket refuses 6th submission at cap=5",
    burst.slice(0, 5).every(Boolean) && burst[5] === false,
    `consumed=${JSON.stringify(burst)}`);

  const cool1 = checkSymbolCooldown("QA_SYM_X", 1);
  const cool2 = checkSymbolCooldown("QA_SYM_X", 1);
  const coolOtherUser = checkSymbolCooldown("QA_SYM_X", 2);
  record(13, "Per-user, per-symbol cooldown blocks double-tap but not other users",
    cool1 === true && cool2 === false && coolOtherUser === true,
    `u1.first=${cool1} u1.second=${cool2} u2.first=${coolOtherUser}`);

  let secondAcquired: boolean | null = null;
  const first = withTxAdvisoryLock(ARX_LOCK_NS.USER_SUBMIT, 9_999_991, async () => {
    const r2 = await withTxAdvisoryLock(ARX_LOCK_NS.USER_SUBMIT, 9_999_991, async () => "inner-ran");
    secondAcquired = r2.acquired;
    return "outer-ok";
  });
  const firstRes = await first;
  record(14, "Advisory lock refuses re-entrant acquisition on same key",
    firstRes.acquired === true && secondAcquired === false,
    `first.acquired=${firstRes.acquired} second.acquired=${secondAcquired}`);

  record(15, "hashKey32 returns a stable int32",
    Number.isInteger(hashKey32("EURUSD")) && hashKey32("EURUSD") === hashKey32("EURUSD"),
    `EURUSD=${hashKey32("EURUSD")}`);

  // ── Exposure-reservation atomicity ────────────────────────────────
  // A dedicated, freshly-seeded master (cap 0.05, zero open lots / zero
  // reservations) so the "succeeds under cap" probe is independent of any
  // exposure earlier lane tests left behind.
  const masterId = await createDedicatedTestMaster();
  await __releaseAllReservationsForMasterTesting(masterId);

  const rA = await reserveExposureAtomic({
    sharedMasterAccountId: masterId, addingLot: 0.03,
    userId: 1, commandId: `qa_cmd_A_${Date.now()}`, symbol: "EURUSD",
  });
  const rB = await reserveExposureAtomic({
    sharedMasterAccountId: masterId, addingLot: 0.03,
    userId: 1, commandId: `qa_cmd_B_${Date.now()}`, symbol: "EURUSD",
  });
  record(16, "Atomic exposure: A (0.03) succeeds under cap 0.05",
    rA.ok === true, JSON.stringify(rA));
  record(17, "Atomic exposure: B (0.03 + reserved 0.03) refused — overflow",
    rB.ok === false && rB.reason === "MASTER_ACCOUNT_EXPOSURE_LIMIT_REACHED",
    JSON.stringify(rB));

  // Parallel race: 10 simultaneous reservations of 0.01 with cap 0.05 →
  // at most 5 succeed; remaining are refused with the exposure reason.
  await __releaseAllReservationsForMasterTesting(masterId);
  const parallel = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      reserveExposureAtomic({
        sharedMasterAccountId: masterId, addingLot: 0.01,
        userId: 1, commandId: `qa_cmd_P${i}_${Date.now()}`, symbol: "EURUSD",
      })),
  );
  const passes = parallel.filter((r) => r.ok).length;
  const SAFE_REFUSALS = new Set([
    "MASTER_ACCOUNT_EXPOSURE_LIMIT_REACHED",
    "MASTER_EXPOSURE_LOCKED",
  ]);
  const safeRefusals = parallel.filter((r) =>
    !r.ok && SAFE_REFUSALS.has((r as { reason: string }).reason),
  ).length;
  // The real invariant: total reserved lots never exceed the cap, and
  // every non-pass is a recognised safe refusal (either overflow or
  // lock contention — both refuse the dispatch).
  const reservedTotal = passes * 0.01;
  record(18, "10 parallel reservations: reserved ≤ cap AND every refusal is a safe reason",
    reservedTotal <= 0.05 && passes + safeRefusals === 10,
    `passes=${passes} safeRefusals=${safeRefusals} reservedTotal=${reservedTotal}`);

  // Release everything we touched.
  await __releaseAllReservationsForMasterTesting(masterId);
  if (rA.ok) await releaseReservation(rA.reservationId).catch(() => {});

  // ── Final invariant: no row inserted into arx_live_commands. ──────
  const afterLiveCount = await preLiveCount();
  record(19, "INVARIANT — arx_live_commands count unchanged (no auto-fire)",
    afterLiveCount === beforeLiveCount,
    `before=${beforeLiveCount} after=${afterLiveCount}`);

  const noLeak = !/X-MT5-Bridge-Token|apiKeyHash|SESSION_SECRET|MT5_BRIDGE_TOKEN/.test(route);
  record(20, "No secrets/tokens leaked from one-click route source",
    noLeak, "routes/meOneClick.ts");

  let pass = 0;
  for (const r of results) {
    const tag = r.ok ? "PASS" : "FAIL";
    // eslint-disable-next-line no-console
    console.log(`[${tag}] ${r.id.toString().padStart(2, "0")} — ${r.name} :: ${r.detail}`);
    if (r.ok) pass++;
  }
  // eslint-disable-next-line no-console
  console.log(`\n${pass}/${results.length} probes passed`);

  // Always remove the dedicated fixture (and its reservations) so the lane
  // DB is left exactly as we found it.
  await cleanupTestMaster();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("QA crashed:", e);
  process.exit(1);
});
