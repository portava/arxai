// Integration CI lane — runs the safety/contract tests that need a provisioned
// Postgres (and, where applicable, the in-process Express app) before they can
// run, so they are no longer "manual only" and instead execute automatically
// before every release.
//
// WHY THIS EXISTS
//   The root `ci` aggregate is the per-commit, offline-safe lane: it must pass
//   with NO database, so it only contains pure / no-IO tests. A second tier of
//   real safety/contract tests imports `@workspace/db` (whose module init THROWS
//   synchronously when `DATABASE_URL` is unset) or boots the in-process app, so
//   they cannot live in `ci`. Until now they were allowlisted as "manual only"
//   in `check-test-scripts-wired.ts` and therefore NEVER ran automatically.
//
//   This lane is the documented home for those tests. It provisions the DB
//   schema ONCE, then (1) runs every `run()`-exporting test in a single shared
//   process via the `ci:integration-inprocess` aggregator
//   (`runIntegrationInProcessTests.ts`), which boots the in-process Express app
//   at most once, and (2) spawns the remaining tests (top-level-`process.exit`
//   scripts and node:test files) as their real package `test:*` script. It
//   propagates a non-zero exit if any of them fail.
//
// API SERVER LIFECYCLE (self-boot, enforced)
//   This lane does NOT spawn a separate API-server process. Every test listed in
//   INTEGRATION_LANE_TESTS that needs HTTP is self-booting: it brings up the
//   Express app IN-PROCESS via `inProcessAppHarness` (`getSharedBaseUrl()`), runs
//   against it over loopback, and tears it down with the test runner. Pure
//   DB/contract tests need no server at all. This was verified empirically: all
//   listed tests pass with only `DATABASE_URL` set and no running workflow. The
//   wiring guard (`check-test-scripts-wired.ts`) imports INTEGRATION_LANE_KEYS,
//   so a test added here MUST remain self-contained — do not add a test that
//   depends on an externally-started server, or this contract silently breaks.
//   That same import means THIS file must NEVER statically import a test module
//   (they import `@workspace/db`, whose init throws with no DATABASE_URL); the
//   shared-process aggregator does that and is only spawned after provisioning.
//
// RELEASE-GATE / DATABASE_URL CONTRACT
//   This lane is registered as a validation command and is meant to run as a
//   release gate. Its DATABASE_URL handling is context-aware so it can never
//   produce a false-green "ran but tested nothing" signal in CI/release:
//     - CI / release context (`CI` truthy, as `.replit` sets in deployment, or
//       `ARX_REQUIRE_INTEGRATION_DB` truthy): a missing `DATABASE_URL` is a HARD
//       FAILURE (exit 1). The suite must actually run before a release.
//     - Local/interactive dev (no CI flag): a missing `DATABASE_URL` SKIPs with
//       exit 0 (mirrors run-cooldown-race-db.ts) so it never breaks a no-DB
//       shell. The offline `ci` lane still runs every commit regardless.
//   With a DB present it always provisions the schema and runs the full suite,
//   failing on any regression. Run: `pnpm run ci:integration`.

import { spawnSync } from "node:child_process";
import { ROOT } from "./_lib.js";
import { isEntrypoint } from "./inProcessAppHarness.js";

export interface IntegrationLaneTest {
  /** pnpm `--filter` target. */
  pkg: "@workspace/scripts" | "@workspace/api-server";
  /** The `test:*` script name in that package. */
  script: string;
  /**
   * When true, this test exports `run(): Promise<CiTestResultLike>` and is run
   * IN-PROCESS by the shared-boot aggregator (`runIntegrationInProcessTests.ts`)
   * instead of being spawned as its own pnpm/tsx child — so the whole group pays
   * Node + tsx + app-boot startup ONCE. The aggregator keeps its coverage in
   * lockstep with these flags. Tests without this flag (top-level `process.exit`
   * scripts and node:test files) are spawned individually as before.
   */
  inProcess?: boolean;
}

// Single source of truth for which tests this lane covers. The wiring guard
// (`check-test-scripts-wired.ts`) imports this list so the ALLOWLIST and this
// lane can never silently drift apart.
export const INTEGRATION_LANE_TESTS: readonly IntegrationLaneTest[] = [
  // @workspace/scripts — DB-backed / in-process-app safety + contract tests.
  { pkg: "@workspace/scripts", script: "test:live-command-lifecycle" },
  { pkg: "@workspace/scripts", script: "test:bridge-v2-kernel" },
  { pkg: "@workspace/scripts", script: "test:broker-symbol-name" },
  { pkg: "@workspace/scripts", script: "test:live-broker-resolver" },
  { pkg: "@workspace/scripts", script: "test:agent-advisory" },
  { pkg: "@workspace/scripts", script: "test:agent-review-scoring" },
  // Task #721 — registration-key roleGrant → users.role E2E proof. Self-boots
  // the REAL Express app in-process (via app.listen on an ephemeral loopback
  // port), mints real INVESTOR/ADMIN/USER registration keys, registers through
  // POST /api/auth/register, and asserts the persisted users.role plus atomic
  // invite acceptance. Owns REGISTRATION_KEY_PEPPER on its own process only and
  // cleans up every seeded row in finally. Imports @workspace/db, so it lives
  // in the integration lane.
  { pkg: "@workspace/scripts", script: "test:registration-key-rolegrant" },
  { pkg: "@workspace/scripts", script: "test:candle-depth-diagnostics", inProcess: true },
  // Promoted from MANUAL_ONLY (Task — manual→auto safety-lane widening). Each was
  // verified to pass self-contained with only DATABASE_URL set: pure / pure-DB
  // contract tests, or HTTP tests that self-boot the Express app in-process via
  // `inProcessAppHarness` (`getSharedBaseUrl()`). None depend on an externally
  // started workflow, a live MT5 bridge, prod env, or pre-seeded data.
  { pkg: "@workspace/scripts", script: "test:admin-unrestricted-risk" },
  { pkg: "@workspace/scripts", script: "test:agent-court-autowire" },
  { pkg: "@workspace/scripts", script: "test:agent-factory-db" },
  { pkg: "@workspace/scripts", script: "test:agent-governance-trace-persist" },
  { pkg: "@workspace/scripts", script: "test:agent-lifecycle-db" },
  { pkg: "@workspace/scripts", script: "test:agent-lifecycle-runner" },
  { pkg: "@workspace/scripts", script: "test:agent-speed" },
  { pkg: "@workspace/scripts", script: "test:alert-notification-contract" },
  { pkg: "@workspace/scripts", script: "test:alerts-grouping-bulk" },
  { pkg: "@workspace/scripts", script: "test:arx-focus-superset" },
  { pkg: "@workspace/scripts", script: "test:bridge-mode-and-toggles" },
  { pkg: "@workspace/scripts", script: "test:bridge-v2-ingest-feed" },
  { pkg: "@workspace/scripts", script: "test:broker-candle-coverage-route", inProcess: true },
  { pkg: "@workspace/scripts", script: "test:candle-depth-route", inProcess: true },
  { pkg: "@workspace/scripts", script: "test:chart-brain-benchmark" },
  { pkg: "@workspace/scripts", script: "test:chart-decision-receipts" },
  { pkg: "@workspace/scripts", script: "test:demo-dispatch-3a" },
  { pkg: "@workspace/scripts", script: "test:ea-update-check-contract" },
  { pkg: "@workspace/scripts", script: "test:fundbook-tier" },
  { pkg: "@workspace/scripts", script: "test:handshake-monitor-perm", inProcess: true },
  { pkg: "@workspace/scripts", script: "test:investor-live-balance-db", inProcess: true },
  { pkg: "@workspace/scripts", script: "test:investor-performance-route", inProcess: true },
  { pkg: "@workspace/scripts", script: "test:live-cycle-close-guard", inProcess: true },
  { pkg: "@workspace/scripts", script: "test:master-bridge" },
  { pkg: "@workspace/scripts", script: "test:master-live-access" },
  { pkg: "@workspace/scripts", script: "test:mode-scope" },
  { pkg: "@workspace/scripts", script: "test:per-user-trading-mode" },
  { pkg: "@workspace/scripts", script: "test:pg-unique-violation" },
  { pkg: "@workspace/scripts", script: "test:realized-daily-pnl", inProcess: true },
  { pkg: "@workspace/scripts", script: "test:reconcile-orphans" },
  { pkg: "@workspace/scripts", script: "test:ruby-draw-setup-route", inProcess: true },
  { pkg: "@workspace/scripts", script: "test:ruby-quality-route-db", inProcess: true },
  { pkg: "@workspace/scripts", script: "test:shared-bridge-reconciliation" },
  { pkg: "@workspace/scripts", script: "test:shared-bridge-attach-flow" },
  { pkg: "@workspace/scripts", script: "test:shared-positions-truth" },
  { pkg: "@workspace/scripts", script: "test:watchlist-universe-gate", inProcess: true },
  // Promoted from MANUAL_ONLY once made self-isolating: it now seeds a
  // DEDICATED master-account fixture (zero open exposure) instead of reusing
  // whatever master other lane tests left exposure on, so its "succeeds under
  // cap" probe no longer depends on lane ordering.
  { pkg: "@workspace/scripts", script: "test:one-click-concurrency" },
  // @workspace/api-server — DB-backed node:test safety + contract tests.
  { pkg: "@workspace/api-server", script: "test:product-role" },
  { pkg: "@workspace/api-server", script: "test:mt5-broker-feed" },
  { pkg: "@workspace/api-server", script: "test:live-outcome-map" },
  { pkg: "@workspace/api-server", script: "test:bridged-close-ticket" },
  { pkg: "@workspace/api-server", script: "test:scanner-enrichment-concurrency" },
  { pkg: "@workspace/api-server", script: "test:scanner-truth-caps" },
  // Task #792 — thin-feed scanner honesty. Exercises the REAL scanner read path
  // (scanSymbolTimeframe → analyzeViaRouter → routeCandles → mt5Provider) against
  // the live in-memory broker seam: a FRESH but too-thin LIVE feed (fewer than
  // MIN_SUFFICIENT_CLOSED_BARS closed bars) must be forced to
  // dataSource "AWAITING_FEED" + dataStatus "no_data" so a thin feed can never
  // present a full-confidence live score, while a sufficient fresh feed stays
  // LIVE_FEED/live. Router-backed (no module mocks); lives in the integration lane.
  { pkg: "@workspace/api-server", script: "test:scanner-thin-feed-downgrade" },
  // Task #794 — STALE-feed scanner honesty (sibling to the thin-feed test).
  // Exercises the SAME real scanner read path (scanSymbolTimeframe →
  // analyzeViaRouter → routeCandles → mt5Provider) against the live in-memory
  // broker seam: a feed with PLENTY of closed bars (over the sufficiency floor)
  // whose newest bar trails the current bar by >= STALE_TRAILING_INTERVALS must
  // be demoted dataSource "STALE_FEED" + dataStatus "stale" (non-selectable) so
  // a stale feed can never present a full-confidence live score, while a
  // sufficient FRESH feed stays LIVE_FEED/live. Router-backed (no module mocks);
  // lives in the integration lane.
  { pkg: "@workspace/api-server", script: "test:scanner-stale-feed-downgrade" },
  // Kill-simulator-fallback command — NO-feed scanner honesty (sibling to the
  // thin/stale-feed tests). Exercises the SAME real scanner read path with the
  // broker seam EMPTY and all external HTTP providers hard-blocked (fetch
  // rejects): a symbol with genuinely NO candles must scan to an honest
  // AWAITING_FEED/"no_data" row for EVERY asset class — never a SIMULATOR row
  // with fabricated OHLC-derived scores. Also statically locks marketScanner.ts
  // against reintroducing a bare simulator `analyzeMarket(` call. Router-backed
  // (no module mocks); lives in the integration lane.
  { pkg: "@workspace/api-server", script: "test:scanner-no-feed-honesty" },
  // Promoted from MANUAL_ONLY (Task — manual→auto safety-lane widening); same
  // self-contained verification as the scripts block above.
  { pkg: "@workspace/api-server", script: "test:agent-household-report" },
  { pkg: "@workspace/api-server", script: "test:agent-learning-camp" },
  { pkg: "@workspace/api-server", script: "test:cooldown-concurrent-first-hit" },
  { pkg: "@workspace/api-server", script: "test:daily-report-scheduler" },
  { pkg: "@workspace/api-server", script: "test:live-position-exposure" },
  { pkg: "@workspace/api-server", script: "test:manual-scan-cooldown-durable" },
  { pkg: "@workspace/api-server", script: "test:session-aware-chart-feed" },
  // Task #617 — Pattern Truth learning loop. Pure-DB (no app boot): records +
  // resolves pattern outcomes and aggregates reliability under negative
  // synthetic userIds, cleaning up in finally.
  { pkg: "@workspace/api-server", script: "test:pattern-outcome-learning" },
  // Task #649 — Trendline Truth learning loop. Same pure-DB shape as the
  // pattern loop: records + resolves trendline outcomes, asserts synthetic
  // buckets separately, fail-closed grading, idempotent lock, and the
  // applyTrendlineLearning runtime wiring (record + ceiling-bounded nudge),
  // all under negative synthetic userIds with finally cleanup.
  { pkg: "@workspace/api-server", script: "test:trendline-outcome-learning" },
  // Task #638 — economic-calendar page route safety-net. Drives the REAL
  // newsCalendar router over HTTP; provider-agnostic FRED/TE central resolution
  // + honest empty/not-configured/fetch-error states. Imports @workspace/db via
  // the router (no DB query of its own), so it lives in the integration lane.
  { pkg: "@workspace/api-server", script: "test:economic-calendar-route" },
  // Task #646 — per-user assistant-name route round-trip + isolation proof.
  // Boots the REAL meAssistantSettings router on loopback, seeds two real users
  // with genuine sessions, and proves GET/PATCH persist, invalid input is
  // rejected without partial write, and user A's custom name never leaks to user
  // B. Imports @workspace/db via the router, so it lives in the integration lane.
  { pkg: "@workspace/api-server", script: "test:assistant-settings-route" },
  // Task #660 — Profit Mission Phase 1 route per-user isolation + no-secret-leak
  // proof. Boots the REAL profitMissions router on loopback, seeds two real users
  // with genuine sessions, and proves anonymous 401s, a feed-gated estimate-
  // labelled create, owner list/get/pulse, and that user B can never see or read
  // user A's mission. Imports @workspace/db via the router, so it lives here.
  { pkg: "@workspace/api-server", script: "test:profit-mission-route" },
  // Profit Mission Phase 3 (fallback reconstruction from Task #662 spec) — the
  // multi-agent proposal route proof. Boots the REAL profitMissions router on
  // loopback, seeds two real users with genuine sessions, and proves anonymous
  // 401s, idempotent 8-agent seeding, an honest advisory scan (selection only,
  // never fabricated), proposal listing, and strict per-user/per-mission
  // isolation. Imports @workspace/db via the router, so it lives here.
  { pkg: "@workspace/api-server", script: "test:mission-agents-route" },
  // Profit Mission Phase 5 (Task #664) — the Trade Draft route proof. Boots the
  // REAL profitMissions router on loopback, seeds two real users with genuine
  // sessions, deterministically seeds an actionable proposal, and proves anonymous
  // 401s, that approving an actionable proposal yields an `approved` draft + EXACTLY
  // ONE `draft_approved` journal event and NEVER an order/execution row, that a weak
  // proposal is refused (409), the reject path, and strict per-user/per-mission
  // isolation. Imports @workspace/db via the router, so it lives here.
  { pkg: "@workspace/api-server", script: "test:mission-draft-route" },
  // Profit Mission Phase 6 (Task #665) — the gated execution-hook proof. Exercises
  // `dispatchApprovedDraft` against a real DB with an injected executor SPY: proves
  // demo/paper never call the live seam, a live dispatch routes through the SAME
  // instant-trade seam (source "mission") and cannot bypass its gates (stricter-only
  // mission gate blocks first; a downstream rejection leaves the draft approved; a
  // success flips it to executed exactly once), plus strict per-user isolation.
  // Imports @workspace/db via the hook, so it lives here.
  { pkg: "@workspace/api-server", script: "test:mission-execution-route" },
  // Profit Mission Phase 8 (Task #667) — protective EXIT management proof.
  // Exercises `manageMissionTradeExit` against a real DB with an injected executor
  // SPY: proves a protective CLOSE routes ONLY through the existing instant-trade
  // seam (source "mission", no new path), a downstream rejection surfaces
  // `execution_rejected` with nothing falsely dispatched, no open position yields
  // an honest `no_open_position`, and strict per-user isolation (user B cannot
  // manage user A's trade). Imports @workspace/db via the manager, so it lives here.
  { pkg: "@workspace/api-server", script: "test:mission-exit-route" },
  // Profit Mission Phase 9 (Task #668) — Testing Lab + demo/live promotion gates
  // route proof. Boots the REAL profitMissions router on loopback, seeds two real
  // users with genuine sessions, and proves anonymous 401s, strict per-user/per-
  // mission isolation (user B 404s on user A's testing/drift/promotion/briefing/
  // report), that an APPROVAL level applies but a live-auto level is refused
  // without explicit enablement (409) AND — even with enablement — is NOT applied
  // while the evidence gates (backtest/forward/demo sample) fail, that the Mission
  // Risk Certificate is phrase-gated + append-only and alone cannot satisfy the
  // remaining gates, that drift with no forward evidence is honest (no demotion),
  // honest advisory briefing/eod/report payloads, and an admin detail route that
  // 403s a USER, 200s + audits an ADMIN, and leaks no broker secrets. Imports
  // @workspace/db via the router, so it lives here.
  { pkg: "@workspace/api-server", script: "test:mission-phase9-route" },
  // Task #799 — Testing Lab + Profit Mission end-to-end smoke. Boots the REAL
  // backtestRuns + profitMissions routers on loopback (real db, no mocked
  // internals) and locks the two key user flows: a deterministic POST
  // /backtest-runs COMPLETES with real metrics that then APPEAR via
  // list/detail/trades (identical config reproduces identical results); and a
  // created mission's pulse carries non-null feasibility, after which an
  // actionable seeded proposal approves into an `approved` (never `executed`)
  // trade draft. Imports @workspace/db via the routers, so it lives here.
  { pkg: "@workspace/api-server", script: "test:testing-lab-smoke" },
  // Live-Position Truth (Phase 1) — advisory-tool refusal lock. Seeds a single
  // throwaway user with an unsynced and a verified live_positions row and invokes
  // the REAL Ruby advisory tools (intelligence / close-review / exit / market-
  // context / decision), proving each withholds advice on the not-broker-verified
  // row, never over-blocks the verified row, and never crosses users. Imports
  // @workspace/db via tools.ts, so it lives in the integration lane.
  { pkg: "@workspace/api-server", script: "test:advisory-truth-gate" },
  // Task #705 — Claude Backend Fix Agent ROUTE safety proof. Boots the REAL
  // adminAiFixAgent router on loopback with the provider replaced by an
  // instrumented fake, seeds a real ADMIN + a real USER with genuine sessions,
  // and proves every route is admin-gated (anon 401 / USER 403), that a disabled
  // agent 409s WITHOUT writing a run row, that an admin diagnose persists exactly
  // one completed run (dryRun=true/applied=false) + one audit row in one tx, that
  // propose-patch reports applied=false, and that the /runs ledger leaks no
  // secrets and never exposes the redacted input or raw output. Imports
  // @workspace/db via the router, so it lives in the integration lane.
  { pkg: "@workspace/api-server", script: "test:fix-agent-route" },
  // Task #743 Cluster D — Live Entitlement & Emergency-Close Lock ROUTE/flow
  // proof. Boots the REAL adminTrading + adminBridgeControl + meTrades routers on
  // loopback, seeds OWNER/ADMIN/INVESTOR/USER users with genuine sessions, and
  // proves: (A) admin/live-control routes deny anon/INVESTOR/USER at the route
  // level (403) while ADMIN/OWNER pass; (C/D) the emergency-close role gate beats
  // a correct phrase and a wrong phrase is refused (400) before any dispatch; and
  // (B) the /me/trades/close handler scopes ownership by userId (no cross-user
  // close) and writes an HONEST QUEUED audit row (never EXECUTED) carrying
  // liveApprovedAtClose + closePolicy. Never mutates the global_trading_settings
  // singleton — it probes the envelope and branches. Imports @workspace/db via
  // the routers, so it lives in the integration lane.
  { pkg: "@workspace/api-server", script: "test:cluster-d-route" },
  // Task #773 — two-tier human-trader experience ROUTE proof. Boots the REAL
  // meUnifiedMode router on loopback, seeds a PENDING and an APPROVED trader with
  // genuine sessions, calls GET /api/me/account-mode, and asserts the EXACT
  // approval predicate `useTraderTier` consumes resolves PENDING ⇒ not approved
  // and APPROVED ⇒ approved (and anon ⇒ 401). Forces shared-master routing via
  // the per-user override so it never mutates the global_trading_settings
  // singleton; varies ONLY the master-live approval input. Imports @workspace/db
  // via the router, so it lives in the integration lane.
  { pkg: "@workspace/api-server", script: "test:trader-tier-route" },
  // Task #735 — expiring-registration-keys email digest WORKER scheduling proof.
  // The pure email body builder is leak-tested in securityRegressionSuite; this
  // covers the scheduler's three key behaviours against the real DB WITHOUT ever
  // sending an email: the no-noise rule (empty expiring list ⇒ no email + no
  // durable marker), the durable per-UTC-day guard (a second same-day run is a
  // no-op with no second audit marker), and the recipient contract
  // (non-system ADMIN/OWNER with an email only). Far-future clocks isolate it
  // from real data; every seeded row is removed in finally. Imports
  // @workspace/db, so it lives in the integration lane.
  { pkg: "@workspace/api-server", script: "test:expiring-keys-digest" },
  // Task #736 — in-app admin "Expiring Soon" registration-keys panel route proof.
  // Boots the REAL adminBetaControl router on loopback and proves both new
  // endpoints are admin-gated (anon 401 / USER 403), that expiring-soon returns
  // in-window PENDING keys masked + soonest-first + floored daysLeft in EXACT
  // parity with the email digest (reuses listExpiringPendingKeys + maskArxKey +
  // daysUntilExpiry, never leaks a raw key/hash), and that send-digest runs the
  // SAME worker entrypoint and returns its structured result. Seeds tagged
  // beta_invites rows removed in finally. Imports @workspace/db via the router,
  // so it lives in the integration lane.
  { pkg: "@workspace/api-server", script: "test:expiring-keys-admin-route" },
  // Task #752 — Admin Cockpit control-room ROUTE/flow proof. Boots the REAL
  // adminCockpit router on loopback with the per-user session shim and proves:
  // anon 401 / INVESTOR+USER 403 on every read + a write; OWNER-vs-ADMIN broker
  // masking on /bridge, /open-trades, and trader detail; reason (>=3) enforced
  // on approve/emergency-close/freeze; /refresh + /manual-note write an
  // admin_cockpit_audit_log mirror (note persisted); emergency-close routes the
  // existing runEmergencyClose path; investor freeze/unfreeze flips the profile
  // status through the existing audited write; pattern-sync is admin-only +
  // advisory + honest. Seeds tagged QA users/rows removed in finally. Imports
  // @workspace/db via the router, so it lives in the integration lane.
  { pkg: "@workspace/api-server", script: "test:admin-cockpit-route" },
  // Task #747 — one-click / fast-trade live ROUTE no-bypass proof. Boots the
  // REAL meOneClick router on loopback, seeds two real users with genuine
  // sessions, and proves: anonymous 401; standing-consent disabled → 412 with
  // ZERO arx_live_commands AND ZERO mt5_commands; consent ON but not master-live
  // approved → 403 with still ZERO command rows (the toggle is consent, never
  // approval, and never reaches createLiveDraft/dispatch); enabling the live
  // toggle without access → 403 + not persisted; the (user_id, idempotency_key)
  // partial unique index rejects a duplicate ACTIVE dispatch (23505) while
  // allowing a terminal LIVE_BLOCKED retry; and strict per-user isolation.
  // Imports @workspace/db via the router, so it lives in the integration lane.
  { pkg: "@workspace/api-server", script: "test:one-click-route" },
  // Task #748 — one-click standing-consent AUDIT-marker proof. Boots the REAL
  // meOneClick router on loopback, seeds two real users with genuine sessions,
  // and proves an enable (demo + master-live-approved live) always writes an
  // ENABLE_* one_click_audit row carrying the canonical consent marker, a
  // disable writes a DISABLE_* row with NO consent phrase, a blocked live enable
  // writes NO enable audit row, and strict per-user isolation. Imports
  // @workspace/db via the router, so it lives in the integration lane.
  { pkg: "@workspace/api-server", script: "test:one-click-consent-audit" },
] as const;

/** Stable `<pkg>::<script>` keys, the same shape the wiring guard uses. */
export const INTEGRATION_LANE_KEYS: readonly string[] = INTEGRATION_LANE_TESTS.map(
  (t) => `${t.pkg}::${t.script}`,
);

function log(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

// Provision the DB schema so a fresh CI database can run the suite. Idempotent:
// `push-force` no-ops when the schema already matches. `push-force` (not `push`)
// because stdin is closed in CI and interactive `push` would hang.
function provisionDb(): boolean {
  log("[integration] provisioning DB schema (db push-force)…");
  const res = spawnSync(
    "pnpm",
    ["--filter", "@workspace/db", "run", "push-force"],
    { cwd: ROOT, stdio: "inherit", env: process.env },
  );
  if (res.error || (res.status ?? 1) !== 0) {
    log(`[integration] FAIL — DB provisioning failed (exit ${res.status ?? "error"})`);
    return false;
  }
  return true;
}

function runOne(t: IntegrationLaneTest): boolean {
  const key = `${t.pkg}::${t.script}`;
  log(`\n──────── ${key} ────────`);
  const res = spawnSync(
    "pnpm",
    ["--filter", t.pkg, "run", t.script],
    { cwd: ROOT, stdio: "inherit", env: process.env },
  );
  const code = res.error ? 1 : res.status ?? 1;
  log(`[${code === 0 ? "PASS" : "FAIL"}] ${key} (exit ${code})`);
  return code === 0;
}

// Run all `inProcess`-flagged lane tests in ONE shared process via the
// `ci:integration-inprocess` aggregator (`runIntegrationInProcessTests.ts`). That
// aggregator statically imports the test `run()`s — which pull in `@workspace/db`
// — so it must NEVER be imported from here (this module is imported by the wiring
// guard with no DATABASE_URL). We invoke it as a child process instead.
function runInProcessAggregate(): boolean {
  const res = spawnSync(
    "pnpm",
    ["--filter", "@workspace/scripts", "run", "ci:integration-inprocess"],
    { cwd: ROOT, stdio: "inherit", env: process.env },
  );
  const code = res.error ? 1 : res.status ?? 1;
  return code === 0;
}

// Truthy only for the conventional CI/release markers. `.replit` sets
// `CI = "true"` for the deployment build context; `ARX_REQUIRE_INTEGRATION_DB`
// is an explicit override for any other release pipeline.
function isReleaseContext(): boolean {
  const truthy = (v: string | undefined): boolean =>
    ["true", "1", "yes"].includes((v ?? "").trim().toLowerCase());
  return truthy(process.env.CI) || truthy(process.env.ARX_REQUIRE_INTEGRATION_DB);
}

function main(): void {
  log("runIntegrationCiTests — DB + in-process-app safety lane");
  log("======================================================");

  if (!process.env.DATABASE_URL) {
    // In a CI/release context a missing DB must NOT silently pass — that would be
    // a false-green "ran but tested nothing" signal. Fail hard so the release is
    // blocked until a database is provisioned.
    if (isReleaseContext()) {
      log(
        "[FAIL] integration lane requires DATABASE_URL in a CI/release context " +
          "(CI / ARX_REQUIRE_INTEGRATION_DB is set) but none is present. The full " +
          "safety suite must actually run before a release — refusing to report a " +
          "false-green pass.",
      );
      process.exit(1);
    }
    log(
      "[SKIP] integration lane — no DATABASE_URL in a local/dev context; these " +
        "tests import @workspace/db and need a live Postgres. The offline `ci` " +
        "lane still runs every commit.",
    );
    process.exit(0);
  }

  if (!provisionDb()) process.exit(1);

  const inProcessTests = INTEGRATION_LANE_TESTS.filter((t) => t.inProcess === true);
  const spawnedTests = INTEGRATION_LANE_TESTS.filter((t) => t.inProcess !== true);
  const failed: string[] = [];

  // (1) Run every `run()`-exporting test in ONE shared process (boots the
  // in-process Express app at most once) instead of spawning a fresh pnpm/tsx
  // child each — the repeated startup this lane used to pay. Run it FIRST, right
  // after provisioning, to minimise exposure to state left by later spawned
  // tests. The aggregator asserts its coverage stays in lockstep with the
  // `inProcess` flags above.
  log(`\n──────── ci:integration-inprocess (${inProcessTests.length} in-process tests) ────────`);
  const aggregateOk = runInProcessAggregate();
  log(
    `[${aggregateOk ? "PASS" : "FAIL"}] ci:integration-inprocess — ${inProcessTests.length} ` +
      `aggregated in-process test(s)`,
  );
  if (!aggregateOk) {
    failed.push(`ci:integration-inprocess (${inProcessTests.length} aggregated tests)`);
  }

  // (2) The remaining tests are NOT `run()`-exporters (top-level `process.exit`
  // scripts, or node:test files) and stay spawned as their real `test:*` script.
  for (const t of spawnedTests) {
    if (!runOne(t)) failed.push(`${t.pkg}::${t.script}`);
  }

  log("\n======================================================");
  log(
    `Integration lane: ${spawnedTests.length} spawned + ${inProcessTests.length} in-process ` +
      `= ${INTEGRATION_LANE_TESTS.length} total test(s)`,
  );
  if (failed.length > 0) {
    log("FAILED:");
    for (const f of failed) log(`  ✗ ${f}`);
    process.exit(1);
  }
  log("All integration-lane safety tests passed.");
  process.exit(0);
}

if (isEntrypoint(import.meta.url)) {
  main();
}
