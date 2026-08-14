// Automated, DB-gated runner for the rate-limiter concurrency race test.
//
// WHY THIS EXISTS
//   Task #569 added the no-DB source-scan guard
//   `scripts/src/ci/check-cooldown-advisory-lock.ts`, which fails the build if
//   the per-(action, scope) `pg_advisory_xact_lock` is removed from
//   `consumeRateLimit()`. That guard proves the lock *exists in source* but
//   cannot prove it actually *serializes concurrent first hits* at runtime — a
//   subtle regression (wrong key derivation, session-scoped instead of
//   xact-scoped, lock taken after the SELECT) could still pass the regex scan.
//
//   The behavioral counterpart,
//   `artifacts/api-server/src/lib/security/__qa__/cooldownConcurrentFirstHit.test.ts`,
//   fires N simultaneous first attempts against a live Postgres and asserts the
//   counter lands at exactly one ALLOW (no double-ALLOW). Until now it only ran
//   on demand. This wrapper runs it in the automated `ci` lane.
//
// DEFAULT-SKIP CONTRACT
//   The test imports `@workspace/db`, whose module init THROWS synchronously
//   when `DATABASE_URL` is unset. So we check for `DATABASE_URL` BEFORE
//   spawning anything that would pull that module in. With no DB present this
//   runner prints a SKIP line and exits 0 — it never breaks the no-DB
//   `pnpm run ci:guards` lane. With a DB present it runs the real concurrency
//   test and propagates its exit code, so a behavioral regression fails the
//   build.
//
// Run: pnpm --filter @workspace/scripts run test:cooldown-race-db

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, rel } from "./_lib.js";

const TEST_FILE = join(
  ROOT,
  "artifacts/api-server/src/lib/security/__qa__/cooldownConcurrentFirstHit.test.ts",
);
const API_SERVER_DIR = join(ROOT, "artifacts/api-server");

function main(): void {
  const name = "cooldown-race-db";

  if (!process.env.DATABASE_URL) {
    // No database in this environment — opt-in/default-skip so the no-DB
    // `ci:guards` lane is never broken. The source-scan guard
    // (check-cooldown-advisory-lock) still protects the lock statically.
    // eslint-disable-next-line no-console
    console.log(
      `[SKIP] ${name} — no DATABASE_URL; the rate-limiter race test needs a live Postgres. ` +
        `The source-scan guard (check-cooldown-advisory-lock) still runs.`,
    );
    process.exit(0);
  }

  // eslint-disable-next-line no-console
  console.log(`[RUN] ${name} — DATABASE_URL present; running ${rel(TEST_FILE)} against the live DB`);

  // Run the node:test file from the api-server package so its `tsx`/module
  // resolution matches `pnpm --filter @workspace/api-server run
  // test:cooldown-concurrent-first-hit`.
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "--test-force-exit",
      "src/lib/security/__qa__/cooldownConcurrentFirstHit.test.ts",
    ],
    { cwd: API_SERVER_DIR, stdio: "inherit", env: process.env },
  );

  if (result.error) {
    // eslint-disable-next-line no-console
    console.log(`[FAIL] ${name} — could not launch the test runner: ${result.error.message}`);
    process.exit(1);
  }

  const code = result.status ?? 1;
  // eslint-disable-next-line no-console
  console.log(`[${code === 0 ? "PASS" : "FAIL"}] ${name} (exit ${code})`);
  process.exit(code);
}

main();
