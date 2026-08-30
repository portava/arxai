// Phase 6 — execution-safety guard.
//
// Closes three claims the guard-scope audit found had NO guard at all. Each was
// enforced by a unit test on one module, which proves that module behaves — and
// proves nothing about a SECOND implementation added elsewhere. A unit test
// cannot see code that does not import it.
//
//   R1  DIRECT ADAPTER BYPASS. Only the dispatch pipeline may invoke a venue
//       adapter's deliver(). A route, worker, script or sibling file in
//       lib/live/ that called an adapter directly would place an order without
//       the gate wall, the CAS claim or the exposure reservation.
//
//   R2  TIER ESCALATION. Only executionTier.ts may decide a tier, and only
//       guidedDispatchEntry.ts may read ARX_EXECUTION_TIER from the
//       environment. A second reader elsewhere could pick a tier by its own
//       rules — including "if the var is set, go live", the exact escalation
//       resolveExecutionTier exists to make impossible.
//
//   R3  APPROVAL OWNER SCOPING. Any handler touching approvalTicketsRepo must
//       resolve an authenticated user. A route that read a ticket by id alone
//       would let user A act on user B's order.
//
// Every rule strips comments before matching, because this file and the code it
// guards both DESCRIBE the forbidden patterns in prose, and a guard that
// matches its own documentation is worse than no guard: it fails loudly for the
// wrong reason and gets disabled.

import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

const API_SRC = join(ROOT, "artifacts/api-server/src");
const SCAN_ROOTS = [
  API_SRC,
  join(ROOT, "lib/domain/src"),
  join(ROOT, "lib/db/src"),
  join(ROOT, "scripts/src"),
  join(ROOT, "artifacts/trading-dashboard/src"),
];

/** The files allowed to invoke a venue adapter's deliver():
 *  the MT5 dispatch pipeline, and the ONE guided composition point (whose
 *  singularity is itself asserted by the Tier 0 product certificate). */
const DISPATCH_PIPELINE = "artifacts/api-server/src/lib/live/liveCommandPipeline.ts";
const GUIDED_COMPOSITION_POINT = "artifacts/api-server/src/lib/phase6/guidedDispatchEntry.ts";
/** The adapter classes themselves define deliver(); that is not a call site. */
const ADAPTER_DEFINITIONS = [
  "artifacts/api-server/src/lib/live/executionAdapter.ts",
  "artifacts/api-server/src/lib/deriv/execution/derivExecutionAdapter.ts",
];
/** The ONE file allowed to read the tier from the environment. */
const TIER_ENV_READER = "artifacts/api-server/src/lib/phase6/guidedDispatchEntry.ts";
/** The ONE module allowed to decide what a tier value means. */
const TIER_RESOLVER = "lib/domain/src/safety-contracts/executionTier.ts";

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const isTest = (p: string): boolean => p.includes("__qa__") || p.endsWith(".test.ts") || p.endsWith(".test.tsx");

export function checkPhase6ExecutionSafety(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];
  let scanned = 0;
  let deliverSites = 0;
  let tierEnvSites = 0;
  let ticketRepoFiles = 0;
  let killSwitchReleaseFiles = 0;

  for (const root of SCAN_ROOTS) {
    for (const f of walk(root)) {
      if (!f.endsWith(".ts") && !f.endsWith(".tsx")) continue;
      const path = rel(f);
      // Guards quote what they forbid; tests construct violations deliberately.
      if (path.startsWith("scripts/src/ci/") || isTest(path)) continue;
      const src = strip(read(f));
      scanned++;

      // ── R1 — direct adapter bypass ────────────────────────────────────
      // Matches an adapter-shaped receiver, not the generic word "deliver":
      // `xAdapter.deliver(` / `derivAdapter.deliver(` / `adapter.deliver(`.
      // Audit H14: the original regex required at least one character BEFORE
      // "adapter", so a receiver named exactly `adapter` — the most natural
      // spelling, and the one the guided composition point itself uses — was
      // invisible. Registry lookups (`REGISTRY[venue].deliver(`) were too.
      const deliverRe = /\b((?:[A-Za-z_$][\w$]*)?[Aa]dapter|[A-Za-z_$][\w$]*\[[^\]]+\])\s*\.\s*deliver\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = deliverRe.exec(src)) !== null) {
        deliverSites++;
        if (path === DISPATCH_PIPELINE || path === GUIDED_COMPOSITION_POINT) continue;
        if (ADAPTER_DEFINITIONS.includes(path)) continue;
        const line = src.slice(0, m.index).split("\n").length;
        violations.push(
          `${path}:~${line} → direct adapter dispatch \`${m[1]}.deliver(\` outside the pipeline. ` +
          `Order delivery must go through ${DISPATCH_PIPELINE}, which owns the gate wall, ` +
          `the CAS claim and the exposure reservation.`,
        );
      }

      // ── R2 — tier escalation ──────────────────────────────────────────
      const tierEnvRe = /process\.env\s*(\[\s*["'`][^"'`]*EXECUTION_TIER[^"'`]*["'`]\s*\]|\.\s*\w*EXECUTION_TIER\w*)/g;
      while ((m = tierEnvRe.exec(src)) !== null) {
        tierEnvSites++;
        if (path === TIER_ENV_READER) continue;
        const line = src.slice(0, m.index).split("\n").length;
        violations.push(
          `${path}:~${line} → reads the execution tier from the environment. Only ` +
          `${TIER_ENV_READER} may do so, and only resolveExecutionTier may decide what a ` +
          `value means — a second reader could escalate on mere presence.`,
        );
      }
      // A hard-coded sendable tier outside the resolver bypasses resolution.
      if (path !== TIER_RESOLVER) {
        const litRe = /["'`](TIER_[1234]_[A-Z_]+)["'`]\s*(?:as\s+const)?\s*[;,)]/g;
        while ((m = litRe.exec(src)) !== null) {
          const line = src.slice(0, m.index).split("\n").length;
          violations.push(
            `${path}:~${line} → hard-codes tier ${m[1]} outside ${TIER_RESOLVER}. ` +
            `Tiers must come from resolveExecutionTier so TIER_3/TIER_4 stay unreachable.`,
          );
        }
      }

      // ── R4 — kill-switch release writers ──────────────────────────────
      // Audit 2026-08-30: POST /admin/trading/reset-kill released the global
      // emergency stop with nothing but an admin session and four characters
      // of prose — a third writer neither ceremony knew about. Any ROUTE that
      // writes emergencyKillSwitch:false must be one of the two release
      // surfaces, and any surface outside the activate-step ceremony must
      // consult the cold-posture policy in the same file.
      if (path.startsWith("artifacts/api-server/src/routes/")) {
        const releaseWriteRe = /emergencyKillSwitch\s*:\s*false/;
        if (releaseWriteRe.test(src)) {
          killSwitchReleaseFiles++;
          const allowed = [
            "artifacts/api-server/src/routes/adminLiveSharedReadiness.ts",
            "artifacts/api-server/src/routes/adminTrading.ts",
          ];
          if (!allowed.includes(path)) {
            violations.push(
              `${path} → writes emergencyKillSwitch:false. Releasing the emergency stop is ` +
              `restricted to the two audited release surfaces (activate-step ceremony and the ` +
              `cold-posture doorways); a third writer bypasses both.`,
            );
          } else if (path.endsWith("adminTrading.ts") && !src.includes("killSwitchReleaseViolations")) {
            violations.push(
              `${path} → writes emergencyKillSwitch:false without consulting ` +
              `killSwitchReleaseViolations. The reset-kill route must keep the cold-posture wall.`,
            );
          }
        }
      }

      // ── R3 — approval owner scoping ───────────────────────────────────
      if (src.includes("approvalTicketsRepo")) {
        ticketRepoFiles++;
        const isRoute = path.startsWith("artifacts/api-server/src/routes/");
        if (isRoute) {
          // A route touching tickets must resolve an authenticated user AND
          // never use the unscoped read.
          if (!/requireUser/.test(src)) {
            violations.push(
              `${path} → touches approvalTicketsRepo without requireUser. An unauthenticated ` +
              `handler could act on any user's ticket.`,
            );
          }
          if (/approvalTicketsRepo\s*\.\s*findTicketById\s*\(/.test(src)) {
            violations.push(
              `${path} → uses findTicketById (UNSCOPED). Routes must use findOwnedTicket, ` +
              `which puts ownership in the WHERE clause so a caller cannot forget it.`,
            );
          }
        }
      }
    }
  }

  notes.push(`Scanned ${scanned} file(s) across ${SCAN_ROOTS.length} roots (guards and tests excluded).`);
  notes.push(`R1 adapter deliver() call sites: ${deliverSites} (allowed: dispatch pipeline, guided composition point, adapter definitions).`);
  notes.push(`R2 tier-from-environment reads: ${tierEnvSites} (allowed: ${TIER_ENV_READER}).`);
  notes.push(`R3 files touching approvalTicketsRepo: ${ticketRepoFiles}.`);
  notes.push(`R4 route files writing emergencyKillSwitch:false: ${killSwitchReleaseFiles} (allowed: the two audited release surfaces).`);
  notes.push(
    "Inviolable: order delivery passes the gate wall; tiers come from resolveExecutionTier; " +
    "approval tickets are owner-scoped in the query.",
  );
  return { name: "phase6-execution-safety", ok: violations.length === 0, violations, notes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkPhase6ExecutionSafety();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
