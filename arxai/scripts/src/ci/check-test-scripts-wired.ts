import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, rel, reportResult, type CheckResult } from "./_lib.js";
import { INTEGRATION_LANE_KEYS } from "./runIntegrationCiTests.js";

/**
 * Guards against safety/QA tests that exist as a `test:*` package script but
 * were never wired into the root `ci` aggregate, so they silently never run on
 * every commit (the exact gap Task #579 hit with the simulator-mask test).
 *
 * A `test:*` script counts as "wired" when the root `ci` script references it
 * via `pnpm --filter <pkg> run <script>` (or, for the root package, via
 * `pnpm run <script>`). Anything else must be listed in ALLOWLIST below with a
 * deliberate reason, or this guard fails.
 *
 * The guard also flags STALE allowlist entries — a script that was allowlisted
 * but has since been deleted or actually wired into `ci` — so the allowlist
 * does not rot into a rubber stamp.
 */

// Packages whose `test:*` scripts must be wired into `ci` or allowlisted.
// Keyed by the package name used in `pnpm --filter <name>`; "workspace" is the
// repo root, referenced from `ci` as a bare `pnpm run <script>`.
const PACKAGE_FILES: Record<string, string> = {
  workspace: "package.json",
  "@workspace/scripts": "scripts/package.json",
  "@workspace/api-server": "artifacts/api-server/package.json",
  "@workspace/trading-dashboard": "artifacts/trading-dashboard/package.json",
};

/**
 * Intentionally-excluded `test:*` scripts, keyed `<pkg>::<script>`.
 *
 * Two kinds of entries are excluded from the per-commit root `ci` aggregate:
 *
 *   1. MANUAL_ONLY (this set) — NOT run automatically on purpose: manual QA
 *      harnesses that need a live DB-with-data / prod env / running bridge,
 *      exploratory phase smokes, or individual sub-suites already covered by an
 *      umbrella script that IS in `ci` (e.g. the per-engine `test:timing-*` run
 *      together via `test:timing`, several `scalp`/`scanner` locks run via
 *      `test:algorithm-locks`).
 *
 *   2. INTEGRATION LANE — DB-backed / in-process-app safety + contract tests
 *      that cannot live in the offline `ci` lane (they import `@workspace/db`,
 *      which throws when `DATABASE_URL` is unset, or boot the in-process app),
 *      but which DO run automatically before every release via the
 *      `ci:integration` lane (`runIntegrationCiTests.ts`). These keys come from
 *      `INTEGRATION_LANE_KEYS` — that runner is the single source of truth, so
 *      the lane and this allowlist can never drift apart. They are "covered by
 *      the integration lane", NOT "manual only".
 *
 * Adding a NEW safety test? Wire it into the root `ci` script (offline-safe) or,
 * if it needs a DB / the app, add it to `INTEGRATION_LANE_TESTS` in
 * `runIntegrationCiTests.ts`. Only add it to MANUAL_ONLY when it genuinely
 * should not run automatically at all.
 */
const MANUAL_ONLY = new Set<string>([
  // Covered automatically by the test:timing umbrella (already in root `ci`):
  "@workspace/api-server::test:timing-broadflow",
  "@workspace/api-server::test:timing-composer",
  "@workspace/api-server::test:timing-heat",
  "@workspace/api-server::test:timing-news",
  "@workspace/api-server::test:timing-session",
  "@workspace/api-server::test:timing-tradeability",
  "@workspace/api-server::test:timing-trap",
  // Covered automatically by the test:fast-unit umbrella (already in root `ci`).
  // These fast, pure api-server unit tests used to each pay a full cold tsx
  // start in `ci`; they now run together in ONE shared process via
  // `test:fast-unit` (node --test-isolation=none over the same test files).
  // Each remains independently runnable via its own script for local debugging.
  "@workspace/api-server::test:algorithm-locks",
  "@workspace/api-server::test:chart-candle-shape",
  "@workspace/api-server::test:deriv-symbol-feed",
  "@workspace/api-server::test:scanner-chart-freshness",
  "@workspace/api-server::test:scanner-scanonce-concurrency",
  "@workspace/api-server::test:selected-market",
  "@workspace/api-server::test:symbol-truth",
  // Additional fast, pure api-server unit tests folded into `test:fast-unit`
  // (Task #594): they used to each pay a full cold tsx start in `ci` and now run
  // together in the same shared process. Each remains independently runnable via
  // its own script for local debugging.
  "@workspace/api-server::test:feed-truth-honesty",
  "@workspace/api-server::test:simulator-surface-rbac",
  "@workspace/api-server::test:aaci-execution",
  "@workspace/api-server::test:aaci-learning",
  "@workspace/api-server::test:security-handshake-enforcement",
  "@workspace/api-server::test:command-integrity",
  "@workspace/api-server::test:chart-truth-fixtures",
  "@workspace/api-server::test:scanner-outage-injection",
  "@workspace/api-server::test:position-freshness",
  "@workspace/api-server::test:scalp-engine",
  "@workspace/api-server::test:scalp-manage",
  "@workspace/api-server::test:scalp-run-on",
  "@workspace/api-server::test:scalp-journal",
  "@workspace/api-server::test:short-ttl-cache",
  // These were redundantly wired BOTH individually in `ci` AND already inside the
  // `test:fast-unit` file list (so they ran twice). The duplicate individual `ci`
  // steps were removed (Task #594); they remain covered by `test:fast-unit`.
  "@workspace/api-server::test:scalp-addon-tiers",
  "@workspace/api-server::test:scalp-addon-forced-zero",
  "@workspace/api-server::test:market-sufficiency",
  "@workspace/api-server::test:trade-health-readiness",
  "@workspace/api-server::test:entry-sufficiency",
  "@workspace/api-server::test:governance-advisory-ruby",
  // Covered automatically by the test:scanner-truth umbrella (already in root
  // `ci`): the SelectedMarketPanel honesty render-proof runs inside that
  // aggregate; this standalone script is kept only for local debugging.
  "@workspace/trading-dashboard::test:selected-market-panel",
  // Need an externally-started API server / seeded data (hit the localhost proxy, not self-contained):
  "@workspace/api-server::test:scanner-manual-scan-access",
  "@workspace/scripts::test:account-mode",
  "@workspace/scripts::test:demo-arming",
  "@workspace/scripts::test:demo-verify",
  "@workspace/scripts::test:investor-isolation-deny",
  "@workspace/scripts::test:investor-statement-file-cleanup",
  "@workspace/scripts::test:investor-statement-file-serving-access",
  "@workspace/scripts::test:investor-statement-transparency",
  "@workspace/scripts::test:pool-view-export",
  "@workspace/scripts::test:rg",
  "@workspace/scripts::test:t015-status",
  "@workspace/scripts::test:trading-school-progress",
  "@workspace/scripts::test:ux9",
  // Need a live MT5 bridge / running server / seeded data, or are genuinely failing (do not pass self-contained):
  "@workspace/scripts::test:agent-seed",
  "@workspace/scripts::test:audit-log-center",
  "@workspace/scripts::test:auth-login-roles",
  "@workspace/scripts::test:beta-10",
  "@workspace/scripts::test:beta-invite-gate",
  "@workspace/scripts::test:registration-keys",
  // DB-backed manual QA harness: seeds/cleans its own beta_invites rows and
  // self-exits via process.exit/pool.end, so it suits neither the offline `ci`
  // lane (imports @workspace/db) nor the in-process integration lane.
  // Runs as part of ci:guards (pnpm run ci:guards → run-all.ts). The `test:*`
  // entry is kept for standalone invocation but the guard itself is already
  // covered automatically by every `ci` run.
  "@workspace/scripts::test:scanner-verdict-import-boundary",
  // broker-hub-no-execution guard runs inside ci:guards (run-all.ts). The
  // standalone script is kept for on-demand invocation. The negative-fixture
  // (test:broker-hub-contracts) is a pure offline test available standalone.
  "@workspace/scripts::test:broker-hub-no-execution",
  "@workspace/scripts::test:broker-hub-contracts",
  // MT5 projection boundary test uses an injected reader and performs no DB IO.
  // It stays targeted because broker-hub has its own required phase-entry lane.
  "@workspace/api-server::test:broker-hub-mt5-projection",
  // Pure projection/feature-flag proof; the schema constraints are release-gated
  // separately by test:broker-hub-metadata-db in ci:integration.
  "@workspace/api-server::test:broker-hub-metadata",
  "@workspace/scripts::test:registration-key-expiry-sweep",
  "@workspace/scripts::test:cached-read-e2e",
  "@workspace/scripts::test:chart-symbol-propagation",
  "@workspace/scripts::test:crash-hardening",
  "@workspace/scripts::test:deriv-scanner-feed",
  "@workspace/scripts::test:deriv-warmup",
  "@workspace/scripts::test:deriv-warmup-ui-verify",
  "@workspace/scripts::test:fresh-first-load",
  "@workspace/scripts::test:launch-readiness",
  "@workspace/scripts::test:live-arming",
  "@workspace/scripts::test:live-kill",
  "@workspace/scripts::test:live-phaseB-checklist",
  "@workspace/scripts::test:live-pipeline",
  "@workspace/scripts::test:live-test-readiness",
  "@workspace/scripts::test:master-bridge-gate",
  "@workspace/scripts::test:master-bridge-live",
  "@workspace/scripts::test:multi-user-trade-queue",
  "@workspace/scripts::test:onboarding",
  "@workspace/scripts::test:operator-funded-pilot",
  "@workspace/scripts::test:per-user-account-shell",
  "@workspace/scripts::test:per-user-isolation",
  "@workspace/scripts::test:playbook",
  "@workspace/scripts::test:position-mini-chart",
  "@workspace/scripts::test:provider-health-admin-containment",
  "@workspace/scripts::test:radar",
  "@workspace/scripts::test:reconciliation-center",
  "@workspace/scripts::test:ruby-app-knowledge",
  "@workspace/scripts::test:ruby-voice-trading-guardrails",
  "@workspace/scripts::test:scanner-real-feed",
  "@workspace/scripts::test:scanner-selected-market",
  "@workspace/scripts::test:system",
  "@workspace/scripts::test:ux3",
  "@workspace/scripts::test:ux4",
  "@workspace/scripts::test:ux5",
  "@workspace/scripts::test:ux6",
  "@workspace/scripts::test:ux7",
  "@workspace/scripts::test:ux8",
  "workspace::test:system",
  // Crash / error out when run self-contained (real failure or missing fixture):
  "@workspace/scripts::test:attached-active-case",
  "@workspace/scripts::test:demo-dispatch-3b",
  "@workspace/scripts::test:operator-diag-gating",
  "@workspace/scripts::test:synthetic-live-floor",
  // Hold an open DB pool/timer and never exit — would hang the lane:
  "@workspace/scripts::test:account-shell-route",
  "@workspace/scripts::test:aggregates-exclude-unknown",
  "@workspace/scripts::test:arx-focus-phase2",
  "@workspace/scripts::test:backfill-ea-version",
  "@workspace/scripts::test:section-25",
  // Task #747 — convenience umbrella that re-runs the one-click safety trio
  // (frontend consent + pure 18-gate + DB route). Each constituent is ALREADY
  // covered automatically (test:one-click-consent and test:one-click-gates are
  // in root `ci`; test:one-click-route runs in the integration lane), and the
  // umbrella's DB route leg cannot run in the offline `ci` lane. It exists only
  // as a one-shot local/manual aggregate, so it is deliberately not in `ci`.
  "workspace::test:one-click-safety",
]);

// DB-backed / in-process-app tests that run automatically before every release
// via the `ci:integration` lane. The runner is the single source of truth; we
// pull its keys here so the lane and this allowlist can never silently diverge.
const INTEGRATION_LANE = new Set<string>(INTEGRATION_LANE_KEYS);

// Effective allowlist: a test is "excluded from ci" if it is manual-only OR
// covered by the integration lane. Both groups are deliberate, documented
// exclusions from the per-commit `ci` aggregate.
const ALLOWLIST = new Set<string>([...MANUAL_ONLY, ...INTEGRATION_LANE]);

const ROOT_PKG_NAME = "workspace";

function loadScripts(file: string): Record<string, string> {
  const raw = readFileSync(join(ROOT, file), "utf8");
  return (JSON.parse(raw).scripts ?? {}) as Record<string, string>;
}

function buildReferencedSet(ciScript: string): Set<string> {
  const referenced = new Set<string>();
  // `pnpm --filter @workspace/<name> run <script>`
  const filterRe = /--filter\s+(@workspace\/[\w-]+)\s+run\s+([\w:-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = filterRe.exec(ciScript)) !== null) {
    referenced.add(`${m[1]}::${m[2]}`);
  }
  // root-package scripts referenced as a bare `pnpm run <script>`
  const rootRe = /pnpm\s+run\s+(test:[\w:-]+)/g;
  while ((m = rootRe.exec(ciScript)) !== null) {
    referenced.add(`${ROOT_PKG_NAME}::${m[1]}`);
  }
  return referenced;
}

export function checkTestScriptsWired(): CheckResult {
  const violations: string[] = [];
  const rootPkgPath = PACKAGE_FILES[ROOT_PKG_NAME];
  const ciScript = loadScripts(rootPkgPath).ci;
  if (!ciScript) {
    return {
      name: "test-scripts-wired",
      ok: false,
      violations: [`root ${rootPkgPath} has no "ci" script to inspect`],
    };
  }

  const referenced = buildReferencedSet(ciScript);

  // Every existing test:* script must be referenced by ci OR allowlisted.
  const allTestKeys = new Set<string>();
  let totalTests = 0;
  for (const [pkgName, file] of Object.entries(PACKAGE_FILES)) {
    const scripts = loadScripts(file);
    for (const script of Object.keys(scripts)) {
      if (!script.startsWith("test:")) continue;
      const key = `${pkgName}::${script}`;
      allTestKeys.add(key);
      totalTests++;
      if (referenced.has(key)) continue;
      if (ALLOWLIST.has(key)) continue;
      violations.push(
        `${key} is a test script but is neither referenced by root "ci" nor allowlisted — ` +
          `wire it into the "ci" script in package.json, or add it to ALLOWLIST in ${rel(
            join(ROOT, "scripts/src/ci/check-test-scripts-wired.ts"),
          )} with a reason`,
      );
    }
  }

  // Stale allowlist hygiene: an allowlisted key that no longer exists, or that
  // is now actually wired into ci, should be removed. The guidance names the
  // exact list to edit (MANUAL_ONLY vs the integration runner).
  for (const key of ALLOWLIST) {
    const where = INTEGRATION_LANE.has(key)
      ? "INTEGRATION_LANE_TESTS in scripts/src/ci/runIntegrationCiTests.ts"
      : "MANUAL_ONLY in scripts/src/ci/check-test-scripts-wired.ts";
    if (!allTestKeys.has(key)) {
      violations.push(
        `allowlist entry ${key} no longer exists as a test script — remove it from ${where}`,
      );
    } else if (referenced.has(key)) {
      violations.push(
        `allowlist entry ${key} is now wired into "ci" — remove it from ${where} (it is covered)`,
      );
    }
  }

  // An integration-lane key must not ALSO be marked manual-only: that would be a
  // contradictory, duplicated exclusion.
  for (const key of INTEGRATION_LANE) {
    if (MANUAL_ONLY.has(key)) {
      violations.push(
        `${key} is in BOTH the integration lane and MANUAL_ONLY — remove it from MANUAL_ONLY ` +
          `(the integration lane runs it automatically before every release)`,
      );
    }
  }

  const wiredCount = [...allTestKeys].filter((k) => referenced.has(k)).length;
  return {
    name: "test-scripts-wired",
    ok: violations.length === 0,
    violations,
    notes: [
      `Inspected ${totalTests} test:* script(s) across ${
        Object.keys(PACKAGE_FILES).length
      } package(s): ${wiredCount} wired into ci, ${INTEGRATION_LANE.size} covered by the ` +
        `integration lane (ci:integration), ${MANUAL_ONLY.size} manual-only.`,
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkTestScriptsWired();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
