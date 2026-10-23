// CI guard — one-click-concurrency
//
// Asserts at build time that:
//
//  1. Both one-click scope flags (`demo_one_click_enabled`,
//     `live_one_click_enabled`) DEFAULT FALSE in the schema. Toggle-on
//     must never happen implicitly.
//  2. Standing-consent model (Task #745): the PUT /api/me/one-click route
//     must NO LONGER reject enables for a missing/mismatched typed phrase
//     (flipping the toggle IS consent), but it must still return
//     `LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS` when master-live access
//     is BLOCKED on a live enable. The `REQUIRED_TYPED_PHRASE` constant is
//     kept as the canonical standing-consent marker recorded in audit.
//  3. The PUT route, when enabling LIVE, additionally re-evaluates the
//     master-live user-access gate (`loadAndEvaluateUserMasterLiveAccessGate`).
//     One-click ON is NEVER a bypass of admin approval.
//  4. The fast-path submit endpoint (`/me/one-click/submit-live`) calls
//     `dispatchLiveCommand` so every Phase B gate continues to run.
//  5. `liveCommandPipeline.ts` calls `reserveExposureAtomic` and
//     `withTxAdvisoryLock` so concurrent submissions cannot bypass the
//     master-exposure cap.
//  6. The new schema file contains the partial unique index on
//     `(command_id) WHERE status = 'RESERVED'` so two RESERVED rows
//     for the same command cannot coexist.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult } from "./_lib.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
function read(p: string): string { return readFileSync(join(ROOT, p), "utf-8"); }

export function checkOneClickConcurrency(): CheckResult {
  const violations: string[] = [];
  const schema = read("lib/db/src/schema/oneClickTrade.ts");
  if (!/demo_one_click_enabled[\s\S]{0,160}default\(false\)/.test(schema)) {
    violations.push("demo_one_click_enabled must default(false)");
  }
  if (!/live_one_click_enabled[\s\S]{0,160}default\(false\)/.test(schema)) {
    violations.push("live_one_click_enabled must default(false)");
  }
  if (!/arx_disp_reserv_cmd_reserved_uq[\s\S]{0,160}status = 'RESERVED'/.test(schema)) {
    violations.push("arx_dispatch_exposure_reservations partial unique index on RESERVED command_id missing");
  }

  const route = read("artifacts/api-server/src/routes/meOneClick.ts");
  if (!/REQUIRED_TYPED_PHRASE\s*=\s*"ENABLE ONE CLICK TRADING"/.test(route)) {
    violations.push("REQUIRED_TYPED_PHRASE constant must be exactly 'ENABLE ONE CLICK TRADING'");
  }
  // Standing-consent model: the typed-phrase REJECTION must be gone.
  if (/typedConfirmation !== REQUIRED_TYPED_PHRASE/.test(route)) {
    violations.push("PUT /me/one-click must NOT reject enables on a typed phrase (standing-consent model)");
  }
  if (!/loadAndEvaluateUserMasterLiveAccessGate/.test(route)) {
    violations.push("PUT /me/one-click must re-check master-live user-access gate when enabling LIVE");
  }
  if (!/LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS/.test(route)) {
    violations.push("PUT /me/one-click must return LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS when master-live access is BLOCKED on a live enable");
  }
  if (!/dispatchLiveCommand/.test(route)) {
    violations.push("/me/one-click/submit-live must call dispatchLiveCommand so all gates run");
  }
  if (!/withTxAdvisoryLock/.test(route)) {
    violations.push("/me/one-click/submit-live must hold a per-user advisory lock");
  }
  if (!/tryConsumeToken/.test(route) || !/checkSymbolCooldown/.test(route)) {
    violations.push("/me/one-click/submit-live must apply per-user rate limit + per-symbol cooldown");
  }

  const pipeline = read("artifacts/api-server/src/lib/live/liveCommandPipeline.ts");
  if (!/reserveExposureAtomic/.test(pipeline)) {
    violations.push("liveCommandPipeline.ts must call reserveExposureAtomic before SENT_TO_MT5_LIVE in SHARED_MASTER_MT5");
  }
  if (!/releaseReservation/.test(pipeline)) {
    violations.push("liveCommandPipeline.ts must call releaseReservation on dispatch failure");
  }
  if (!/fulfillReservationByCommandId/.test(pipeline) || !/releaseReservationByCommandId/.test(pipeline)) {
    violations.push("liveCommandPipeline.ts must settle reservations on EA result (fulfill/release-by-command-id)");
  }
  if (!/MASTER_ACCOUNT_NOT_MAPPED/.test(pipeline)) {
    violations.push("liveCommandPipeline.ts must FAIL CLOSED with MASTER_ACCOUNT_NOT_MAPPED when SHARED_MASTER_MT5 has no mapped master account");
  }
  // Reservation must run AFTER user-access gate (defence in depth).
  const idxUser = pipeline.indexOf("loadAndEvaluateUserMasterLiveAccessGate(");
  const idxReserve = pipeline.indexOf("reserveExposureAtomic");
  if (idxUser !== -1 && idxReserve !== -1 && idxReserve < idxUser) {
    violations.push("reserveExposureAtomic must run AFTER user-access gate evaluation");
  }

  const concurrencyDir = "artifacts/api-server/src/lib/concurrency";
  const lock = read(`${concurrencyDir}/advisoryLock.ts`);
  if (!/pg_try_advisory_xact_lock/.test(lock)) {
    violations.push("advisoryLock.ts must use pg_try_advisory_xact_lock (non-blocking, txn-scoped)");
  }
  const ratelim = read(`${concurrencyDir}/rateLimit.ts`);
  if (!/clampPerMinute/.test(ratelim) || !/Math\.min\(120/.test(ratelim)) {
    violations.push("rateLimit.ts must clamp per-minute rate to a server-side ceiling (≤120)");
  }
  const exposure = read(`${concurrencyDir}/exposureReservation.ts`);
  if (!/SUM\(lot_size\)[\s\S]{0,200}arx_dispatch_exposure_reservations[\s\S]{0,80}status = 'RESERVED'/.test(exposure)) {
    violations.push("reserveExposureAtomic must include RESERVED rows in the exposure aggregation");
  }
  if (!/withTxAdvisoryLock\(\s*ARX_LOCK_NS\.MASTER_EXPOSURE/.test(exposure)) {
    violations.push("reserveExposureAtomic must run under ARX_LOCK_NS.MASTER_EXPOSURE advisory lock");
  }

  return {
    name: "one-click-concurrency",
    ok: violations.length === 0,
    violations,
  };
}
