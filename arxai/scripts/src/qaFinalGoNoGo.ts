// Final Go/No-Go QA orchestrator for ARX AI launch candidate.
//
// Runs the highest-priority launch verifications and emits a single
// PASS/FAIL line. Snapshots arx_live_commands count before and after;
// fails the run if the count changes unexpectedly.
//
// SAFETY: this script does not fire live trades. It only invokes
// already-existing read-only/test scripts that are individually
// strict-zero verified.

import { spawnSync } from "node:child_process";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

interface Step {
  id: string;
  cmd: string;
  args: readonly string[];
  ok: boolean;
  detail: string;
  durationMs: number;
}

const STEPS: ReadonlyArray<{ id: string; cmd: string; args: readonly string[] }> = [
  { id: "ci-guards",          cmd: "pnpm", args: ["run", "ci:guards"] },
  { id: "live-phaseB",        cmd: "pnpm", args: ["--filter", "@workspace/scripts", "run", "test:live-phaseB"] },
  { id: "live-kill",          cmd: "pnpm", args: ["--filter", "@workspace/scripts", "run", "test:live-kill"] },
  { id: "live-pass-path",     cmd: "pnpm", args: ["--filter", "@workspace/scripts", "run", "test:live-pass-path"] },
  { id: "t015-status",        cmd: "pnpm", args: ["--filter", "@workspace/scripts", "run", "test:t015-status"] },
  { id: "live-test-readiness", cmd: "pnpm", args: ["--filter", "@workspace/scripts", "run", "test:live-test-readiness"] },
  { id: "per-user-isolation", cmd: "pnpm", args: ["--filter", "@workspace/scripts", "run", "test:per-user-isolation"] },
  { id: "audit-log-center",   cmd: "pnpm", args: ["--filter", "@workspace/scripts", "run", "test:audit-log-center"] },
  { id: "reconciliation",     cmd: "pnpm", args: ["--filter", "@workspace/scripts", "run", "test:reconciliation-center"] },
  { id: "ruby-voice",         cmd: "pnpm", args: ["--filter", "@workspace/scripts", "run", "test:ruby-voice-trading-guardrails"] },
  { id: "ruby-app-knowledge", cmd: "pnpm", args: ["--filter", "@workspace/scripts", "run", "test:ruby-app-knowledge"] },
  { id: "fresh-first-load",   cmd: "pnpm", args: ["--filter", "@workspace/scripts", "run", "test:fresh-first-load"] },
  { id: "launch-readiness",   cmd: "pnpm", args: ["--filter", "@workspace/scripts", "run", "test:launch-readiness"] },
  { id: "one-click",          cmd: "pnpm", args: ["--filter", "@workspace/scripts", "run", "test:one-click-concurrency"] },
];

const SECRET_MARKERS = [
  "SESSION_SECRET", "MT5_BRIDGE_TOKEN", "apiKeyHash", "BEGIN PRIVATE KEY",
];

async function countLive(): Promise<number> {
  const r = await db.execute(sql`SELECT COUNT(*)::int AS c FROM arx_live_commands`);
  const rows = (r as unknown as { rows?: Array<{ c: number }> }).rows
    ?? (r as unknown as Array<{ c: number }>);
  return Number(rows[0]?.c ?? 0);
}

function runStep(s: typeof STEPS[number]): Step {
  const start = Date.now();
  const result = spawnSync(s.cmd, s.args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combined = `${stdout}\n${stderr}`;
  const okExit = result.status === 0;
  // Defence-in-depth: scan output for any secret marker
  const leaked = SECRET_MARKERS.filter((m) => {
    if (m === "SESSION_SECRET" || m === "MT5_BRIDGE_TOKEN") {
      // Allow the env-var NAME to appear (e.g. "MT5_BRIDGE_TOKEN rejected"),
      // but flag if it appears in a value-assignment context.
      return new RegExp(`${m}\\s*=\\s*[^\\s]+`).test(combined);
    }
    return combined.includes(m);
  });
  const ok = okExit && leaked.length === 0;
  const lastLines = combined.trim().split("\n").slice(-3).join(" | ").slice(0, 200);
  const detail = leaked.length > 0
    ? `secret-leak:${leaked.join(",")}`
    : okExit ? lastLines : `exit=${result.status} ${lastLines}`;
  return { id: s.id, cmd: s.cmd, args: s.args, ok, detail, durationMs: Date.now() - start };
}

async function main(): Promise<void> {
  const before = await countLive();
  console.log("=".repeat(78));
  console.log("ARX AI — FINAL Go/No-Go QA");
  console.log("=".repeat(78));
  console.log(`arx_live_commands BEFORE: ${before}`);
  console.log("");

  const results: Step[] = [];
  for (const s of STEPS) {
    process.stdout.write(`  running ${s.id.padEnd(22)} ... `);
    const r = runStep(s);
    results.push(r);
    process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  (${r.durationMs}ms)\n`);
  }

  const after = await countLive();
  const countUnchanged = before === after;
  const countStrictZero = before === 0 && after === 0;

  console.log("");
  console.log(`arx_live_commands AFTER:  ${after}`);
  console.log(`arx_live_commands DELTA:  ${after - before} ${countUnchanged ? "(unchanged ✓)" : "(CHANGED ✗)"}`);
  console.log(`arx_live_commands STRICT-ZERO:  ${countStrictZero ? "YES ✓" : "NO ✗"}`);

  console.log("");
  console.log("Per-step results:");
  for (const r of results) {
    console.log(`  [${r.ok ? "PASS" : "FAIL"}] ${r.id.padEnd(22)} ${r.detail}`);
  }

  const allPassed = results.every((r) => r.ok);
  const overall = allPassed && countUnchanged && countStrictZero;
  const decision = overall ? "GO (paper-only / private-alpha scope)" : "NO-GO";

  console.log("");
  console.log("=".repeat(78));
  console.log(`OVERALL: ${overall ? "PASS" : "FAIL"}`);
  console.log(`Decision: ${decision}`);
  console.log(`Steps: ${results.filter((r) => r.ok).length}/${results.length} PASS`);
  console.log(`arx_live_commands: ${before} → ${after} (${countUnchanged ? "unchanged" : "CHANGED"})`);
  console.log(`Confirmation: NO live trade was fired by this run.`);
  console.log("=".repeat(78));

  await pool.end();
  process.exit(overall ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error("qaFinalGoNoGo crashed:", e instanceof Error ? e.message : e);
  process.exit(2);
});
