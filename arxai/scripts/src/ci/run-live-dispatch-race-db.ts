// P0-1 — automated, DB-gated runner for the live-dispatch double-send race test.
//
// WHY THIS EXISTS
//   `scripts/src/ci/check-live-dispatch-cas.ts` proves the status predicate
//   EXISTS in source. It cannot prove the predicate actually serializes
//   concurrent dispatches at runtime — a wrong column, a predicate on the
//   wrong status, or a driver that silently drops the condition would still
//   pass a regex scan.
//
//   The behavioural counterpart,
//   `artifacts/api-server/src/lib/live/__qa__/liveDispatchDoubleSendRace.test.ts`,
//   fires N simultaneous claims at one LIVE_APPROVED command against a live
//   Postgres and asserts exactly one wins (plus a pre-fix control arm that
//   must still reproduce multiple winners). This wrapper runs it in the
//   automated `ci` lane.
//
// DEFAULT-SKIP CONTRACT
//   The test imports `@workspace/db`, whose module init THROWS synchronously
//   when `DATABASE_URL` is unset. So we check for `DATABASE_URL` BEFORE
//   spawning anything that would pull that module in. With no DB present this
//   runner prints a SKIP line and exits 0 — it never breaks the no-DB
//   `pnpm run ci:guards` lane. With a DB present it runs the real concurrency
//   test and propagates its exit code.
//
//   The test only ever writes synthetic rows (command_id prefixed
//   `__qa_dispatch_race__`, negative synthetic user id) and deletes them in a
//   `finally`. It never arms a user, approves anyone, touches broker
//   credentials, or dispatches to a bridge.
//
// Run: pnpm --filter @workspace/scripts run test:live-dispatch-race-db

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, rel } from "./_lib.js";

const TEST_REL = "artifacts/api-server/src/lib/live/__qa__/liveDispatchDoubleSendRace.test.ts";
const TEST_FILE = join(ROOT, TEST_REL);
const API_SERVER_DIR = join(ROOT, "artifacts/api-server");

function main(): void {
  const name = "live-dispatch-race-db";

  if (!process.env.DATABASE_URL) {
    // eslint-disable-next-line no-console
    console.log(
      `[SKIP] ${name} — no DATABASE_URL; the live-dispatch race test needs a live Postgres. ` +
        `The source-scan guard (check-live-dispatch-cas) still runs.`,
    );
    process.exit(0);
  }

  // eslint-disable-next-line no-console
  console.log(`[RUN] ${name} — DATABASE_URL present; running ${rel(TEST_FILE)} against the live DB`);

  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "--test-force-exit",
      "src/lib/live/__qa__/liveDispatchDoubleSendRace.test.ts",
    ],
    { cwd: API_SERVER_DIR, stdio: "inherit", env: process.env },
  );

  process.exit(result.status ?? 1);
}

main();
