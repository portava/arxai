// Production maintenance runner — the single, supported, auditable entrypoint
// for running this repo's idempotent one-off data-fix scripts against the
// database that DATABASE_URL points at.
//
// WHY THIS EXISTS:
//   The individual maintenance scripts (legacy P/L cleanup, UNKNOWN-P/L
//   EA-version backfill, missing-close-fill correction) write to whatever
//   DATABASE_URL points at. From the agent dev environment that is the dev
//   database, and the only access to production is a READ-ONLY replica — so
//   these fixes can never be applied to live data from dev tooling. On top of
//   that, the production schema lags dev until a feature is published, so the
//   columns/tables these fixes target may not exist in production yet.
//
//   This runner is what you run AFTER publishing, from a context that holds
//   production WRITE credentials (e.g. a one-off deploy job — see
//   docs/PRODUCTION_MAINTENANCE_RUNBOOK.md). It wraps the existing scripts with
//   two guarantees they cannot give individually:
//
//     1. DRY-RUN BY DEFAULT. Nothing writes unless you pass --apply (or set
//        ARX_MAINTENANCE_APPLY=true). The flag is forwarded to each job.
//     2. SCHEMA-GATED. Each job declares the columns/tables it needs. The
//        runner verifies they exist in the live DB first and SKIPS (never
//        hard-fails) any job whose schema has not reached production yet,
//        printing a clear "publish first" note. This makes the runner safe to
//        run during/right after a deploy before the schema has caught up.
//
//   The runner never reimplements any fix logic — it shells out to the exact,
//   already-reviewed scripts via their existing pnpm script names, so their
//   per-row safety contracts and idempotency are preserved verbatim.
//
// RUN:
//   pnpm --filter @workspace/scripts run maintenance:prod            # dry-run
//   pnpm --filter @workspace/scripts run maintenance:prod -- --apply  # writes
//
//   Target a single job:
//   pnpm --filter @workspace/scripts run maintenance:prod -- --only=backfill-ea-version
//   pnpm --filter @workspace/scripts run maintenance:prod -- --only=backfill-ea-version --apply

import { spawnSync } from "node:child_process";
import { pool } from "@workspace/db";

const ARGV = process.argv.slice(2);
const APPLY =
  ARGV.some((a) => a === "--apply" || a === "--confirm") ||
  (process.env.ARX_MAINTENANCE_APPLY ?? "").trim().toLowerCase() === "true";
const ONLY = (() => {
  const arg = ARGV.find((a) => a.startsWith("--only="));
  return arg ? arg.slice("--only=".length).trim() : null;
})();

type SchemaRequirement =
  | { kind: "table"; table: string }
  | { kind: "column"; table: string; column: string };

type MaintenanceJob = {
  // Stable selector for --only=<id>.
  id: string;
  // Human-readable purpose.
  description: string;
  // The existing pnpm script name (in scripts/package.json) that performs the
  // fix. We never reimplement the logic here.
  pnpmScript: string;
  // The live-DB columns/tables this fix touches. If any are missing the job is
  // skipped with a "publish first" note rather than erroring.
  requires: SchemaRequirement[];
  // Whether the underlying script honours dry-run-by-default + --apply itself.
  // If false the script always writes when invoked, so in dry-run mode the
  // runner reports it as apply-only and does NOT execute it.
  supportsDryRun: boolean;
};

// The maintenance family. Add new idempotent one-off fixes here.
const JOBS: MaintenanceJob[] = [
  {
    id: "backfill-ea-version",
    description:
      "Backfill reported_ea_version on UNKNOWN-P/L trades from time-bracketed live-test-cycle evidence (leaves P/L untouched).",
    pnpmScript: "backfill:unknown-pnl-ea-version",
    requires: [
      { kind: "column", table: "trades", column: "pnl_status" },
      { kind: "column", table: "trades", column: "reported_ea_version" },
      { kind: "table", table: "arx_live_test_cycles" },
    ],
    supportsDryRun: true,
  },
  {
    id: "legacy-unknown-pnl",
    description:
      "Retag legacy LIVE closes that had no trustworthy broker P/L source as pnlStatus='UNKNOWN' (removes the fabricated number, keeps the close).",
    pnpmScript: "backfill:legacy-unknown-pnl",
    requires: [
      { kind: "column", table: "trades", column: "pnl_status" },
      { kind: "column", table: "trades", column: "data_quality_flag" },
      { kind: "table", table: "live_positions" },
    ],
    supportsDryRun: false,
  },
  {
    id: "missing-close-fill-pnl",
    description:
      "Correct completed live-test cycles whose realised P/L was computed against a missing/zero close fill price (sets P/L to UNKNOWN, audits each).",
    pnpmScript: "correct:missing-close-fill-pnl",
    requires: [
      { kind: "table", table: "arx_live_test_cycles" },
      { kind: "table", table: "live_trading_audit" },
    ],
    supportsDryRun: false,
  },
];

function log(line = "") {
  // eslint-disable-next-line no-console
  console.log(line);
}

async function tableExists(table: string): Promise<boolean> {
  const res = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1",
    [table],
  );
  return (res.rowCount ?? 0) > 0;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const res = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1",
    [table, column],
  );
  return (res.rowCount ?? 0) > 0;
}

async function missingRequirements(job: MaintenanceJob): Promise<string[]> {
  const missing: string[] = [];
  for (const req of job.requires) {
    if (req.kind === "table") {
      if (!(await tableExists(req.table))) missing.push(`table ${req.table}`);
    } else {
      if (!(await columnExists(req.table, req.column))) {
        missing.push(`column ${req.table}.${req.column}`);
      }
    }
  }
  return missing;
}

function runJob(job: MaintenanceJob): "DONE" | "FAILED" {
  const args = ["--filter", "@workspace/scripts", "run", job.pnpmScript];
  // Forward the apply flag only to scripts that understand it. Always-write
  // scripts are only ever invoked under --apply (see main()).
  if (APPLY && job.supportsDryRun) args.push("--", "--apply");
  const result = spawnSync("pnpm", args, { stdio: "inherit", env: process.env });
  return result.status === 0 ? "DONE" : "FAILED";
}

async function main() {
  const mode = APPLY ? "APPLY (writes enabled)" : "DRY-RUN (no writes)";
  log("==================================================================");
  log("[maintenance:prod] ARX production maintenance runner");
  log(`[maintenance:prod] Mode: ${mode}`);
  if (ONLY) log(`[maintenance:prod] Filter: --only=${ONLY}`);
  log("==================================================================");
  log();

  const selected = ONLY ? JOBS.filter((j) => j.id === ONLY) : JOBS;
  if (selected.length === 0) {
    log(`[maintenance:prod] No job matches --only=${ONLY}.`);
    log(`[maintenance:prod] Known jobs: ${JOBS.map((j) => j.id).join(", ")}`);
    return 1;
  }

  const summary: { id: string; outcome: string }[] = [];

  for (const job of selected) {
    log(`------------------------------------------------------------------`);
    log(`[maintenance:prod] Job: ${job.id}`);
    log(`[maintenance:prod]   ${job.description}`);
    log(`[maintenance:prod]   script: ${job.pnpmScript}`);

    // Schema gate — publish first if anything is missing.
    const missing = await missingRequirements(job);
    if (missing.length > 0) {
      log(
        `[maintenance:prod]   SKIPPED — live schema is missing: ${missing.join(", ")}.`,
      );
      log(
        "[maintenance:prod]   Publish the feature so the schema reaches this DB, then re-run.",
      );
      summary.push({ id: job.id, outcome: "SKIPPED (schema not present)" });
      log();
      continue;
    }

    // Apply-only scripts never run in dry-run mode (they always write).
    if (!APPLY && !job.supportsDryRun) {
      log(
        "[maintenance:prod]   APPLY-ONLY — this script always writes when invoked and has no",
      );
      log(
        "[maintenance:prod]   native dry-run, so it is NOT executed in dry-run mode. It will run",
      );
      log("[maintenance:prod]   only when you pass --apply.");
      summary.push({ id: job.id, outcome: "DEFERRED (apply-only, not run in dry-run)" });
      log();
      continue;
    }

    const outcome = runJob(job);
    summary.push({
      id: job.id,
      outcome: outcome === "DONE" ? (APPLY ? "APPLIED" : "DRY-RUN OK") : "FAILED",
    });
    log();
  }

  log("==================================================================");
  log("[maintenance:prod] Summary");
  for (const row of summary) log(`    ${row.id.padEnd(26)} ${row.outcome}`);
  log("==================================================================");
  if (!APPLY) {
    log(
      "[maintenance:prod] DRY-RUN complete. Re-run with `-- --apply` (or set",
    );
    log(
      "[maintenance:prod] ARX_MAINTENANCE_APPLY=true) from a context with production write",
    );
    log("[maintenance:prod] credentials to make the changes.");
  }

  return summary.some((s) => s.outcome === "FAILED") ? 1 : 0;
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error("[maintenance:prod] FAILED:", err);
    process.exit(1);
  },
);
