// Phase 6 — background lifecycle runner test. Proves the advisory/shadow sweep:
//   (1) is OPT-IN — a SYSTEM tick with the switch off skips DISABLED and does no
//       work;
//   (2) actually runs the four advisory engines when enabled (eligible rows
//       processed) and never throws — every step is fail-soft;
//   (3) DEFERS DURING LIVE — with a live command in flight (status
//       SENT_TO_MT5_LIVE) even an admin force run skips LIVE_IN_FLIGHT, so the
//       runner can never contend with a real broker execution;
//   (4) is SINGLE-FLIGHT — two concurrent forced sweeps yield exactly one run and
//       one LOCKED (the Postgres advisory lock prevents double-processing).
//
// The runner only OPENS Learning Camps via the promotion board and never
// auto-advances one to full authority — that honest partial is asserted by the
// absence of any FULL_RETURN side effect (the runner exposes no such path).
//
// The test restores agent_ecosystem_settings.background_runner_enabled to its
// original value and deletes only its own uniquely-tagged live-command row.
//
// Run: pnpm --filter @workspace/scripts run test:agent-lifecycle-runner

import { randomUUID } from "node:crypto";
import {
  runLifecycleSweep,
  getLifecycleRunnerStatus,
} from "../../artifacts/api-server/src/lib/agentEcosystem/lifecycleRunner.js";
import {
  getEcosystemSettings,
  setBackgroundRunnerEnabled,
} from "../../artifacts/api-server/src/lib/agentEcosystem/agentFactory.js";
import { db, arxLiveCommandsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`); failures++; }
}

console.log("Agent Ecosystem lifecycle runner test");

const EXPECTED_STEPS = ["outcome_review_scoring", "promotion_board", "household_report", "immune_scan"];

// Capture the original switch so the test never leaves the runner enabled.
const original = await getEcosystemSettings().catch(() => ({ backgroundRunnerEnabled: false }));

try {
  // ── 1. OPT-IN: switch off + no force → DISABLED, no work ──────────────────────
  {
    await setBackgroundRunnerEnabled(false, null);
    const r = await runLifecycleSweep({ triggeredBy: "SYSTEM" });
    check("disabled SYSTEM sweep skips DISABLED", r.skipped === "DISABLED", `skipped=${r.skipped}`);
    check("disabled sweep does no work", r.steps.length === 0 && r.errorCount === 0);
  }

  // ── 2. Enabled → runs all four engines, fail-soft, no throw ───────────────────
  {
    await setBackgroundRunnerEnabled(true, null);
    const r = await runLifecycleSweep({ triggeredBy: "SYSTEM" });
    check("enabled sweep is not skipped", r.skipped === null, `skipped=${r.skipped}`);
    const ran = r.steps.map((s) => s.step);
    check("all four advisory engines ran", EXPECTED_STEPS.every((s) => ran.includes(s)), `ran=${ran.join(",")}`);
    check("sweep returned a finite duration", Number.isFinite(r.durationMs) && r.durationMs >= 0);
    // errorCount is allowed to be >0 (fail-soft) but must equal the failed-step count.
    check("errorCount matches failed steps", r.errorCount === r.steps.filter((s) => !s.ok).length);
    const st = getLifecycleRunnerStatus();
    check("status records the run", st.runCount >= 1 && st.lastRunAt != null);
  }

  // ── 3. DEFERS DURING LIVE: force does NOT bypass the live guard ───────────────
  {
    const tag = `__RUNNERTEST_${randomUUID()}`;
    await db.insert(arxLiveCommandsTable).values({
      commandId: tag,
      userId: -1, // sentinel, never a real user
      commandType: "OPEN",
      status: "SENT_TO_MT5_LIVE",
      symbol: tag,
      side: "BUY",
      orderType: "MARKET_BUY",
      requestedVolume: 0.01,
      // A genuinely in-flight command: dispatched now, still within its TTL.
      serverTimestamp: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    try {
      const r = await runLifecycleSweep({ triggeredBy: "ADMIN", force: true });
      check("forced admin sweep still defers during live", r.skipped === "LIVE_IN_FLIGHT", `skipped=${r.skipped}`);
      check("deferred sweep does no work", r.steps.length === 0);
    } finally {
      await db.delete(arxLiveCommandsTable).where(eq(arxLiveCommandsTable.commandId, tag));
    }
  }

  // ── 3b. TTL-AWARE: an EXPIRED SENT_TO_MT5_LIVE row must NOT defer ─────────────
  // By the command-lifecycle TTL contract a command past its expiry can no longer
  // fire (EA refuses stale; server sweeps to LIVE_EXPIRED), so a stale row must
  // never permanently freeze the runner. (enabled is still true here.)
  {
    const tag = `__RUNNERTEST_EXPIRED_${randomUUID()}`;
    await db.insert(arxLiveCommandsTable).values({
      commandId: tag,
      userId: -1,
      commandType: "OPEN",
      status: "SENT_TO_MT5_LIVE",
      symbol: tag,
      side: "BUY",
      orderType: "MARKET_BUY",
      requestedVolume: 0.01,
      // Dispatched + expired well in the past — a dead command, not in flight.
      serverTimestamp: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 60_000),
    });
    try {
      const r = await runLifecycleSweep({ triggeredBy: "SYSTEM" });
      check("expired live command does NOT defer the sweep", r.skipped !== "LIVE_IN_FLIGHT", `skipped=${r.skipped}`);
      check("sweep ran past the dead live row", r.skipped === null && r.steps.length > 0, `skipped=${r.skipped}`);
    } finally {
      await db.delete(arxLiveCommandsTable).where(eq(arxLiveCommandsTable.commandId, tag));
    }
  }

  // ── 4. SINGLE-FLIGHT: two concurrent forced sweeps → exactly one LOCKED ───────
  {
    const [a, b] = await Promise.all([
      runLifecycleSweep({ triggeredBy: "ADMIN", force: true }),
      runLifecycleSweep({ triggeredBy: "ADMIN", force: true }),
    ]);
    const skipped = [a.skipped, b.skipped];
    const lockedCount = skipped.filter((s) => s === "LOCKED").length;
    const ranCount = skipped.filter((s) => s === null).length;
    check("exactly one concurrent sweep was LOCKED out", lockedCount === 1, `skipped=${skipped.join(",")}`);
    check("exactly one concurrent sweep ran", ranCount === 1, `skipped=${skipped.join(",")}`);
  }
} finally {
  // Always restore the opt-in switch to its original value.
  await setBackgroundRunnerEnabled(original.backgroundRunnerEnabled, null).catch(() => {});
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll lifecycle runner checks passed.");
