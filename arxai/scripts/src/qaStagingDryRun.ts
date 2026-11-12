// scripts/src/qaStagingDryRun.ts
//
// ARX AI — End-to-End Staging Dry Run orchestrator.
//
// Runs the required staging acceptance suites, snapshots
// arx_live_commands before+after, scans aggregate stdout for secret markers,
// and emits a single PASS/FAIL report grouped by persona / category.
//
// NO new test suites are created here. This is a pure orchestrator that
// reuses what already ships — the spec said explicitly: do not duplicate QA.
//
// Safety invariants enforced by the orchestrator itself:
//  - refuses to run if NODE_ENV === "production"
//  - refuses to run if ARX_LIVE_BROKER_EXECUTION_ENABLED === "true"
//  - snapshots arx_live_commands count from the DB before AND after
//  - aborts FAIL if synthetic command fixtures leak between suites
//  - scans every suite's stdout for raw-token / hash / secret markers
//
// The disposable wrapper supplies the database, paused API and network sandbox.
// Run with:  pnpm --filter @workspace/scripts run qa:staging:full

import { runChild } from "./staging/child.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pool } from "@workspace/db";

type Persona = "BrandNew" | "DemoTrader" | "PersonalMt5" | "SharedMaster" | "Admin"
             | "TradingSafety" | "QueueConcurrency" | "Privacy" | "Eleanor" | "Voice"
             | "Reconciliation" | "AuditExport" | "ProductionLockdown" | "CIGuards";

interface SuiteSpec {
  name: string;          // npm script name
  personas: Persona[];
  timeoutMs?: number;
  note?: string;
}

// Curated list — covers every persona/category the BUILD spec called out.
// Sequenced light → heavy so a fast failure surfaces quickly.
const SUITES: SuiteSpec[] = [
  // CI guards first (cheapest, broadest coverage)
  { name: "ci:guards", personas: ["CIGuards"] },

  // Privacy / isolation
  { name: "test:per-user-isolation", personas: ["Privacy"] },
  { name: "test:per-user-account-shell", personas: ["Privacy", "DemoTrader"] },

  // Production lockdown
  { name: "test:launch-readiness", personas: ["ProductionLockdown", "Admin"] },

  // Brand-new user journey
  { name: "test:fresh-first-load", personas: ["BrandNew"] },
  { name: "test:onboarding", personas: ["BrandNew"] },

  // Demo trader journey
  { name: "test:demo-verify", personas: ["DemoTrader"] },
  { name: "test:demo-arming", personas: ["DemoTrader"] },
  { name: "test:demo-dispatch-3a", personas: ["DemoTrader"] },
  { name: "test:demo-dispatch-3b", personas: ["DemoTrader"] },
  { name: "test:position-mini-chart", personas: ["DemoTrader"] },
  { name: "test:scanner-selected-market", personas: ["DemoTrader"], timeoutMs: 300_000 },

  // Personal MT5 + shared master journeys
  { name: "test:master-live-access", personas: ["PersonalMt5", "SharedMaster"] },
  { name: "test:master-bridge", personas: ["SharedMaster"] },
  { name: "test:master-bridge-gate", personas: ["SharedMaster"] },
  { name: "test:master-bridge-live", personas: ["SharedMaster"] },

  // Trading safety — live gates (every one must remain blocked)
  { name: "test:live-arming", personas: ["TradingSafety"] },
  { name: "test:live-pipeline", personas: ["TradingSafety"] },
  { name: "test:live-kill", personas: ["TradingSafety"] },
  { name: "test:live-phaseB", personas: ["TradingSafety"] },
  { name: "test:live-pass-path", personas: ["TradingSafety"] },

  // Queue / concurrency
  { name: "test:one-click-concurrency", personas: ["QueueConcurrency"] },
  { name: "test:multi-user-trade-queue", personas: ["QueueConcurrency"], timeoutMs: 300_000 },

  // Audit + reconciliation + admin
  { name: "test:audit-log-center", personas: ["AuditExport", "Reconciliation", "Admin"] },

  // Eleanor
  { name: "test:eleanor-app-knowledge", personas: ["Eleanor"] },
  { name: "test:eleanor-voice-trading-guardrails", personas: ["Eleanor", "Voice"] },
];

// Secret-shape markers — VALUE-shaped tokens that must NEVER appear in
// aggregated stdout. Field NAMES (apiKeyHash, tokenHash, bridgeTokenHash)
// are deliberately NOT flagged because QA suites legitimately echo them
// in assertion text like "assert apiKeyHash absent from response body".
// Only patterns that indicate an actual secret VALUE is leaking are flagged.
const SECRET_MARKERS = [
  "SESSION_SECRET=",     // env-var value emission
  "MT5_BRIDGE_TOKEN=",   // env-var value emission
  "Bearer ey",           // JWT in Authorization header
  "X-MT5-Bridge-Token: ", // header with trailing space → value follows
];

interface SuiteResult {
  name: string;
  personas: Persona[];
  status: "PASS" | "FAIL";
  exitCode: number | null;
  durationMs: number;
  tailLine: string;
  note?: string;
}

async function getArxLiveCommandsCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS c FROM arx_live_commands");
  return r.rows[0].c as number;
}

async function runSuite(spec: SuiteSpec): Promise<SuiteResult> {
  const t0 = Date.now();
  const timeoutMs = spec.timeoutMs ?? 180_000;
  const res = await runChild("pnpm", ["--silent", "--filter", "@workspace/scripts", "run", spec.name], {
    timeoutMs, env: process.env, cwd: resolve(import.meta.dirname, "../.."),
  });
  if (res.interrupted) throw new Error("Staging acceptance interrupted; child group stopped");
  const durationMs = Date.now() - t0;
  const out = res.output;
  writeFileSync(resolve(process.env.ARX_STAGING_LOG_DIR!, `${spec.name.replace(/[^a-z0-9-]/gi, "_")}.log`), out, { mode: 0o600 });
  const lines = out.trim().split("\n").filter((l) => l.trim().length > 0);
  const tailLine = lines[lines.length - 1] ?? "(no output)";
  const timedOut = res.timedOut;
  const passed = res.status === 0 && !timedOut;
  let status: SuiteResult["status"] = "PASS";
  if (!passed) { status = "FAIL"; console.log(out); }
  if (timedOut) console.log(`  [timeout] suite="${spec.name}" killed after ${timeoutMs / 1000}s`);

  // secret-marker scan on this suite's stdout
  for (const marker of SECRET_MARKERS) {
    if (out.includes(marker)) {
      console.log(`  [secret-marker] suite="${spec.name}" found="${marker}"`);
      status = "FAIL";
    }
  }

  // store the raw output for later aggregated scan
  AGGREGATE_STDOUT.push(`\n===== ${spec.name} =====\n${out}`);
  return { name: spec.name, personas: spec.personas, status, exitCode: res.status, durationMs, tailLine: tailLine.slice(0, 240), note: spec.note };
}

const AGGREGATE_STDOUT: string[] = [];

async function main() {
  console.log("=".repeat(78));
  console.log("ARX AI — End-to-End Staging Dry Run (qa:staging:full)");
  console.log("=".repeat(78));

  // ── ENV guards ────────────────────────────────────────────────────────────
  const nodeEnv = process.env["NODE_ENV"] ?? "development";
  const liveSwitch = process.env["ARX_LIVE_BROKER_EXECUTION_ENABLED"] ?? "";
  console.log(`environment      = NODE_ENV=${nodeEnv} ARX_LIVE_BROKER_EXECUTION_ENABLED=${liveSwitch || "<unset>"}`);
  if (nodeEnv === "production") {
    console.log("ABORT: refusing to run dry-run in NODE_ENV=production"); process.exit(2);
  }
  if (liveSwitch === "true") {
    console.log("ABORT: refusing to run dry-run while live master switch is ON"); process.exit(2);
  }
  console.log("[env] staging-safe (NOT production, live master switch NOT enabled)");

  const dbUrl = process.env["DATABASE_URL"];
  if (!process.env.ARX_STAGING_DISPOSABLE_DB || !dbUrl || new URL(dbUrl).pathname !== `/${process.env.ARX_STAGING_DISPOSABLE_DB}`) {
    throw new Error("Run qa:staging:full through the disposable staging harness");
  }
  if (!dbUrl) { console.log("ABORT: DATABASE_URL not set"); process.exit(2); }

  // ── arx_live_commands snapshot BEFORE ─────────────────────────────────────
  const liveCountBefore = await getArxLiveCommandsCount();
  console.log(`[snapshot] arx_live_commands BEFORE = ${liveCountBefore}`);

  // ── run all suites ────────────────────────────────────────────────────────
  const results: SuiteResult[] = [];
  for (const spec of SUITES) {
    process.stdout.write(`-- ${spec.name.padEnd(38)} ... `);
    const commandCountBefore = await getArxLiveCommandsCount();
    const r = await runSuite(spec);
    const commandCountAfter = await getArxLiveCommandsCount();
    if (commandCountBefore !== commandCountAfter) {
      console.log(`[fixture-leak] ${spec.name}: live command rows ${commandCountBefore} -> ${commandCountAfter}`);
      r.status = "FAIL";
    }
    results.push(r);
    process.stdout.write(`${r.status} (${(r.durationMs/1000).toFixed(1)}s)\n`);
  }

  // ── arx_live_commands snapshot AFTER ──────────────────────────────────────
  const liveCountAfter = await getArxLiveCommandsCount();
  await pool.end();
  console.log(`[snapshot] arx_live_commands AFTER  = ${liveCountAfter}`);

  // ── aggregated secret-marker scan (extra safety) ──────────────────────────
  const aggregate = AGGREGATE_STDOUT.join("");
  const aggregateMarkers = SECRET_MARKERS.filter((m) => aggregate.includes(m));

  // ── report ────────────────────────────────────────────────────────────────
  console.log("");
  console.log("=".repeat(78));
  console.log("Per-suite results:");
  console.log("=".repeat(78));
  for (const r of results) {
    const tag = r.status === "PASS" ? "PASS" : "FAIL";
    console.log(`  [${tag}] ${r.name.padEnd(38)} ${r.tailLine}`);
    if (r.note) console.log(`               note: ${r.note}`);
  }

  // persona coverage matrix
  console.log("");
  console.log("Persona / category coverage:");
  const personas: Persona[] = ["BrandNew","DemoTrader","PersonalMt5","SharedMaster","Admin","TradingSafety","QueueConcurrency","Privacy","Eleanor","Voice","Reconciliation","AuditExport","ProductionLockdown","CIGuards"];
  for (const p of personas) {
    const hit = results.filter((r) => r.personas.includes(p));
    const allPass = hit.length > 0 && hit.every((r) => r.status === "PASS");
    const anyFail = hit.some((r) => r.status === "FAIL");
    const tag = anyFail ? "FAIL" : (allPass ? "PASS" : (hit.length === 0 ? "n/a " : "PART"));
    console.log(`  [${tag}] ${p.padEnd(20)} ${hit.map((r) => r.name).join(", ") || "(no suite)"}`);
  }

  // invariants
  const liveUnchanged = liveCountBefore === liveCountAfter;
  console.log("");
  console.log("Invariants:");
  console.log(`  [${liveUnchanged?"PASS":"FAIL"}] arx_live_commands unchanged   start=${liveCountBefore} end=${liveCountAfter}`);
  console.log(`  [${aggregateMarkers.length===0?"PASS":"FAIL"}] no secret markers in stdout  scanned=${SECRET_MARKERS.length} found=${aggregateMarkers.length}`);

  // overall verdict
  const hardFails = results.filter((r) => r.status === "FAIL").length;
  const passes = results.filter((r) => r.status === "PASS").length;
  const overall = hardFails === 0 && liveUnchanged && aggregateMarkers.length === 0 ? "PASS" : "FAIL";

  console.log("");
  console.log("=".repeat(78));
  console.log(`OVERALL: ${overall}   suites: ${passes} PASS / ${hardFails} FAIL`);
  console.log(`arx_live_commands: ${liveCountBefore} → ${liveCountAfter} (${liveUnchanged?"unchanged":"CHANGED — abort"})`);
  console.log(`secret leakage probe: ${aggregateMarkers.length===0?"clean":"DIRTY ("+aggregateMarkers.join(",")+")"}`);
  console.log(liveUnchanged ? "Evidence: live command row count unchanged; this alone does not certify broker-side activity." : "FAIL: live command row count changed during the dry run.");
  console.log("=".repeat(78));

  process.exit(overall === "PASS" ? 0 : 1);
}

main().catch((e) => { console.error("orchestrator crashed:", e); process.exit(2); });
