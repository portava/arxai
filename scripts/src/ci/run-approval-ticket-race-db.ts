// Phase 6 — DB-gated runner for the approval-ticket dispatch-claim race test.
//
// WHY THIS EXISTS
//   The pure lifecycle law refuses a second dispatch on a ticket it can SEE is
//   already claimed. That is necessary and not sufficient: two requests racing
//   in separate processes each read state='APPROVED' before either writes, so
//   both pass the pure check. Only the database can break that tie.
//
//   approvalTicketRaceDb.test.ts fires N simultaneous claims at one approved
//   ticket against a live Postgres and asserts exactly one wins — plus a
//   control arm, with the CAS predicate removed, that must still produce
//   MULTIPLE winners. If the control ever yields one, the race has stopped
//   reproducing and the primary assertion proves nothing.
//
// DEFAULT-SKIP CONTRACT
//   The test imports @workspace/db, whose module init THROWS synchronously when
//   DATABASE_URL is unset, so the check happens BEFORE anything pulls that
//   module in. With no DB this prints SKIP and exits 0 — it never breaks the
//   no-DB ci:guards lane.
//
//   It writes only synthetic rows (ticket ids prefixed __qa_ticket_race__, a
//   negative synthetic user id) and deletes them in a finally. It never approves
//   a real user, touches broker credentials, or dispatches to a venue.
//
// Run: pnpm --filter @workspace/scripts run test:approval-ticket-race-db

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, rel } from "./_lib.js";

const TEST_REL = "artifacts/api-server/src/lib/phase6/__qa__/approvalTicketRaceDb.test.ts";
const TEST_FILE = join(ROOT, TEST_REL);
const API_SERVER_DIR = join(ROOT, "artifacts/api-server");

function main(): void {
  const name = "approval-ticket-race-db";

  if (!process.env.DATABASE_URL) {
    // eslint-disable-next-line no-console
    console.log(
      `[SKIP] ${name} — no DATABASE_URL; the dispatch-claim race test needs a live Postgres. ` +
        `The pure lifecycle tests (test:phase6-approval) still run.`,
    );
    process.exit(0);
  }

  // eslint-disable-next-line no-console
  console.log(`[RUN] ${name} — DATABASE_URL present; running ${rel(TEST_FILE)} against the live DB`);

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-force-exit", TEST_REL.replace("artifacts/api-server/", "")],
    { cwd: API_SERVER_DIR, stdio: "inherit", env: process.env },
  );

  process.exit(result.status ?? 1);
}

main();
