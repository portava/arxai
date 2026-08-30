// Capability #28 — DEPLOYMENT + ALERT-PATH test suite.
//
// The core assessment logic is covered by watchdogCore.test.ts. This suite
// covers everything that had to exist before the watchdog could actually be
// RUN somewhere and actually REACH the owner:
//
//   1. The watchdog never reports healthy on an unreadable read — at the
//      assessment layer, at the wire-envelope layer, and at the /healthz
//      layer (which must return 503, not 200).
//   2. The alert fires on a seeded discrepancy, and lands in the product's
//      OWN notification service payload shape (not a new silo).
//   3. A failed delivery is reported as failed. "We tried" is never
//      "we told the owner".
//   4. The watchdog has NO write path to trading tables (source pin, now
//      TRANSITIVE across its whole import graph).
//   5. The runnable deployment package is real: the scripts exist and the
//      process, started against an unreachable database, degrades honestly.
//
// Offline: no DB, no network, no listen(2) (the CI sandbox forbids binding).
//
// Run: pnpm --filter @workspace/api-server run test:watchdog-deployment

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { assessSnapshot, type WatchdogSnapshot } from "../watchdogCore.js";
import {
  buildAlertEnvelope,
  deriveVerdict,
  parseAlertEnvelope,
  redactEvidence,
  MAX_WIRE_FINDINGS,
} from "../watchdogAlertEnvelope.js";
import {
  deliverAlert,
  deliveryIsDegraded,
  summariseDelivery,
  type AlertSinkConfig,
  type FetchLike,
} from "../watchdogAlertSink.js";
import {
  handleWatchdogHealthRequest,
  healthDetailForHost,
  newLivenessState,
  renderWatchdogHealth,
} from "../watchdogHealth.js";
import {
  mapEnvelopeToNotifications,
  WATCHDOG_DRILL_INSTANCE_PREFIX,
  WATCHDOG_DRILL_LABEL,
  WATCHDOG_DRILL_NOTIFICATION_TYPE,
  WATCHDOG_NOTIFICATION_TYPE,
} from "../watchdogNotificationMapper.js";
import { DRILL_NOW_MS, DRILL_SCENARIOS, drillScenario } from "../watchdogDrillFixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_SERVER_ROOT = path.resolve(HERE, "../../../..");
const REPO_ROOT = path.resolve(API_SERVER_ROOT, "../..");
const WATCHDOG_DIR = path.resolve(HERE, "..");

function envelopeFor(snapshot: WatchdogSnapshot) {
  const assessment = assessSnapshot(snapshot, DRILL_NOW_MS);
  return buildAlertEnvelope({
    instanceId: "test-instance",
    topology: "external_host",
    activeFindings: assessment.findings,
    newFindings: assessment.findings,
    nowMs: DRILL_NOW_MS,
    uptimeSeconds: 120,
  });
}

// ── 1. UNREADABLE IS NEVER HEALTHY ──────────────────────────────────────────

test("an unreadable section can never produce a VERIFIED_HEALTHY verdict", () => {
  const s = drillScenario("database_unreadable");
  const env = envelopeFor(s.snapshot);
  assert.equal(env.passVerdict, "CANNOT_VERIFY");
  assert.ok(env.counts.cannotVerify > 0);
  assert.notEqual(env.passVerdict, "VERIFIED_HEALTHY");
});

test("deriveVerdict is total: any cannot_verify key outranks everything, including an otherwise empty pass", () => {
  assert.equal(deriveVerdict([]), "VERIFIED_HEALTHY");
  assert.equal(deriveVerdict([{ key: "kill_switch_engaged", severity: "INFO" }]), "FINDINGS");
  // An INFO-severity cannot_verify would still be CANNOT_VERIFY — the key wins,
  // so a future severity downgrade cannot smuggle blindness through as healthy.
  assert.equal(deriveVerdict([{ key: "cannot_verify:open_positions", severity: "INFO" }]), "CANNOT_VERIFY");
  assert.equal(
    deriveVerdict([{ key: "cannot_verify:safety_core", severity: "CRITICAL" }, { key: "x", severity: "INFO" }]),
    "CANNOT_VERIFY",
  );
});

test("/healthz returns 503 — not 200 — while the last pass could not read", () => {
  const state = newLivenessState({ instanceId: "i", topology: "same_host", startedAtMs: DRILL_NOW_MS - 60_000, intervalMs: 60_000 });
  state.lastPassCompletedAtMs = DRILL_NOW_MS;
  state.lastVerdict = "CANNOT_VERIFY";
  state.lastCannotVerifyReason = "database unreachable";
  state.passCount = 1;

  const r = renderWatchdogHealth(state, DRILL_NOW_MS);
  assert.equal(r.httpStatus, 503);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.status, "cannot_verify");
  assert.match(r.body.reason, /not a green light/);
});

test("/healthz returns 503 before the first pass and once a pass goes stale", () => {
  const state = newLivenessState({ instanceId: "i", topology: "same_host", startedAtMs: DRILL_NOW_MS, intervalMs: 60_000 });

  const neverRan = renderWatchdogHealth(state, DRILL_NOW_MS + 1_000);
  assert.equal(neverRan.httpStatus, 503);
  assert.equal(neverRan.body.status, "never_ran");

  state.lastPassCompletedAtMs = DRILL_NOW_MS;
  state.lastVerdict = "VERIFIED_HEALTHY";
  state.passCount = 1;
  const fresh = renderWatchdogHealth(state, DRILL_NOW_MS + 10_000);
  assert.equal(fresh.httpStatus, 200);
  assert.equal(fresh.body.status, "watching");

  // 3× the interval later the same VERIFIED_HEALTHY verdict must NOT still read as ok.
  const stale = renderWatchdogHealth(state, DRILL_NOW_MS + 60_000 * 3 + 1_000);
  assert.equal(stale.httpStatus, 503);
  assert.equal(stale.body.status, "stale");
});

test("/livez reports process liveness only and says so, so it cannot be mistaken for a protection green tick", () => {
  const state = newLivenessState({ instanceId: "i", topology: "same_host", startedAtMs: DRILL_NOW_MS, intervalMs: 60_000 });
  const livez = handleWatchdogHealthRequest("/livez", state, DRILL_NOW_MS);
  assert.equal(livez.httpStatus, 200);
  assert.match(JSON.stringify(livez.body), /process liveness only/);
  // …while /healthz on the very same never-ran state refuses.
  assert.equal(handleWatchdogHealthRequest("/healthz", state, DRILL_NOW_MS).httpStatus, 503);
  assert.equal(handleWatchdogHealthRequest("/positions", state, DRILL_NOW_MS).httpStatus, 404);
});

// ── 2. THE ALERT FIRES ON A SEEDED DISCREPANCY ──────────────────────────────

test("a position without protective orders raises a CRITICAL alert through the product notification service", async () => {
  const s = drillScenario("position_without_protective_orders");
  const env = envelopeFor(s.snapshot);

  assert.ok(env.findings.some((f) => f.key === "unprotected_position:9002"), "the unprotected position must be found");
  assert.ok(!env.findings.some((f) => f.key === "unprotected_position:9001"), "the PROTECTED position must not alert");

  const notifications = mapEnvelopeToNotifications(env.findings, env.instanceId);
  const unprotected = notifications.find((n) => n.entityType === "watchdog:unprotected_position");
  assert.ok(unprotected, "an unprotected position must map to a notification");
  assert.equal(unprotected.severity, "critical");
  assert.equal(unprotected.notificationType, WATCHDOG_NOTIFICATION_TYPE);
  assert.equal(unprotected.entityId, 9002, "dedupe must be per-position, not one row for all of them");
  assert.match(unprotected.message, /Alert only — nothing was placed, modified or closed\./);

  // …and it actually leaves the process.
  const sent: unknown[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ notificationsRaised: 1 }) };
  };
  const results = await deliverAlert(env, armedConfig(), fetchImpl);
  assert.equal(sent.length, 1);
  assert.deepEqual(results.find((r) => r.leg === "app"), { leg: "app", status: "delivered", notificationsRaised: 1 });
  assert.equal(deliveryIsDegraded(results), false);
});

test("a main-app outage raises an alert from OUTSIDE the app", () => {
  const env = envelopeFor(drillScenario("main_app_outage").snapshot);
  assert.ok(env.findings.some((f) => f.key === "main_app_silent"));
  const n = mapEnvelopeToNotifications(env.findings, env.instanceId).find((x) => x.entityType === "watchdog:main_app_silent");
  assert.ok(n);
  assert.equal(n.severity, "critical");
  assert.equal(n.actionTarget, "/system-health");
});

test("the healthy control scenario raises nothing — the watchdog does not cry wolf", () => {
  const env = envelopeFor(drillScenario("baseline_all_clear").snapshot);
  assert.equal(env.passVerdict, "VERIFIED_HEALTHY");
  assert.deepEqual(env.findings, []);
  assert.deepEqual(mapEnvelopeToNotifications(env.findings, env.instanceId), []);
});

test("every drill scenario produces the finding it claims to produce", () => {
  for (const s of DRILL_SCENARIOS) {
    const env = envelopeFor(s.snapshot);
    assert.equal(env.passVerdict, s.expectedVerdict, `${s.id}: wrong verdict`);
    for (const key of s.expectedFindingKeys) {
      assert.ok(env.findings.some((f) => f.key === key), `${s.id}: expected finding ${key}`);
    }
  }
});

// ── A DRILL IS UNMISTAKABLE — IN THE TITLE, NOT ONLY THE BODY ───────────────

test("a drill alert is labelled in the TITLE, which is what web push shows first", () => {
  const env = envelopeFor(drillScenario("position_without_protective_orders").snapshot);
  const real = mapEnvelopeToNotifications(env.findings, "prod-host:4242");
  const drill = mapEnvelopeToNotifications(env.findings, `${WATCHDOG_DRILL_INSTANCE_PREFIX}position_without_protective_orders`);

  const realTitle = real.find((n) => n.entityType === "watchdog:unprotected_position")!.title;
  const drillNotif = drill.find((n) => n.entityType === "watchdog_drill:unprotected_position")!;

  // The defect this test exists for: the drill's title used to be byte-identical
  // to the real CRITICAL, so a 3am push read "Open position with no stop loss
  // recorded" with nothing to distinguish it.
  assert.notEqual(drillNotif.title, realTitle, "a drill title must not be byte-identical to a real alert's");
  assert.ok(drillNotif.title.startsWith(WATCHDOG_DRILL_LABEL), "the title itself must carry the drill label");
  assert.ok(drillNotif.message.startsWith(WATCHDOG_DRILL_LABEL));
  // Severity is deliberately NOT downgraded — the drill proves the critical path.
  assert.equal(drillNotif.severity, "critical");
});

test("a drill cannot occupy a real alert's dedupe slot and swallow it", () => {
  const env = envelopeFor(drillScenario("position_without_protective_orders").snapshot);
  const real = mapEnvelopeToNotifications(env.findings, "prod-host:4242")[0]!;
  const drill = mapEnvelopeToNotifications(env.findings, `${WATCHDOG_DRILL_INSTANCE_PREFIX}x`)[0]!;

  // createNotification dedupes on (userId, notificationType, entityType,
  // entityId, bucket). Sharing all of those inside one 15-minute cooldown
  // window would turn a REAL critical into a silent repeatCount bump on the
  // drill's row, with no push. At least one component must differ.
  assert.equal(real.notificationType, WATCHDOG_NOTIFICATION_TYPE);
  assert.equal(drill.notificationType, WATCHDOG_DRILL_NOTIFICATION_TYPE);
  assert.notEqual(drill.entityType, real.entityType);
});

test("the drill label is defined once and the drill script imports it", () => {
  const src = readFileSync(path.resolve(API_SERVER_ROOT, "src/scripts/watchdogDrill.ts"), "utf8");
  assert.ok(src.includes("WATCHDOG_DRILL_LABEL"), "the drill must import the shared label, not redeclare the string");
  assert.ok(src.includes("WATCHDOG_DRILL_INSTANCE_PREFIX"), "the drill instance prefix the mapper keys off must be the shared one");
  assert.ok(!/const DRILL_PREFIX = "/.test(src), "a second copy of the label would let the two sides drift apart");
});

test("the drill label is idempotent — the mapper never double-prefixes an already-labelled message", () => {
  const env = envelopeFor(drillScenario("main_app_outage").snapshot);
  const preLabelled = env.findings.map((f) => ({ ...f, message: WATCHDOG_DRILL_LABEL + f.message }));
  const n = mapEnvelopeToNotifications(preLabelled, `${WATCHDOG_DRILL_INSTANCE_PREFIX}main_app_outage`)[0]!;
  const occurrences = n.message.split(WATCHDOG_DRILL_LABEL).length - 1;
  assert.equal(occurrences, 1, "the label must appear exactly once in the message");
});

// ── THE HEALTH PORT IS UNAUTHENTICATED ──────────────────────────────────────

test("the health port binds loopback by default and the doc states why", () => {
  const src = readFileSync(path.resolve(API_SERVER_ROOT, "src/watchdog.ts"), "utf8");
  assert.ok(src.includes('WATCHDOG_DEFAULT_HEALTH_HOST = "127.0.0.1"'), "an unauthenticated body must not default to a public bind");
  assert.ok(!/ARX_WATCHDOG_HEALTH_HOST \?\? "0\.0\.0\.0"/.test(src), "0.0.0.0 must not be the fallback");
  const doc = readFileSync(path.resolve(REPO_ROOT, "docs/WATCHDOG_DEPLOYMENT.md"), "utf8");
  assert.match(doc, /unauthenticated/i, "the doc must warn that /healthz has no auth");
  assert.match(doc, /127\.0\.0\.1/, "the doc must state the loopback default");
});

test("a non-loopback bind serves counts, never the scoped keys that name individual positions", () => {
  assert.equal(healthDetailForHost("127.0.0.1"), "full");
  assert.equal(healthDetailForHost("::1"), "full");
  assert.equal(healthDetailForHost("0.0.0.0"), "redacted");
  assert.equal(healthDetailForHost("10.0.0.5"), "redacted");

  const state = newLivenessState({ instanceId: "prod-box-7:4242", topology: "external_host", startedAtMs: DRILL_NOW_MS - 60_000, intervalMs: 60_000 });
  state.lastPassCompletedAtMs = DRILL_NOW_MS;
  state.lastVerdict = "FINDINGS";
  state.activeFindingKeys = ["unprotected_position:9002", "stuck_command:311"];
  state.lastDeliverySummary = "app:delivered";
  state.passCount = 3;

  const local = renderWatchdogHealth(state, DRILL_NOW_MS, "full");
  assert.deepEqual(local.body.activeFindingKeys, ["unprotected_position:9002", "stuck_command:311"]);
  assert.equal(local.body.instanceId, "prod-box-7:4242");

  const exposed = renderWatchdogHealth(state, DRILL_NOW_MS, "redacted");
  const wire = JSON.stringify(exposed.body);
  assert.ok(!wire.includes("9002"), "an anonymous caller must not learn WHICH position is unprotected");
  assert.ok(!wire.includes("311"));
  assert.ok(!wire.includes("prod-box-7"), "nor the host the watchdog runs on");
  assert.ok(!wire.includes("external_host"));
  assert.deepEqual(exposed.body.activeFindingKeys, []);
  // …while the monitoring signal is byte-for-byte unchanged.
  assert.equal(exposed.httpStatus, local.httpStatus);
  assert.equal(exposed.body.status, local.body.status);
  assert.equal(exposed.body.ok, local.body.ok);
  assert.equal(exposed.body.activeFindingCount, 2);
  assert.equal(exposed.body.alertPath.degraded, local.body.alertPath.degraded);
});

test("the cannot-verify driver message is withheld on the unauthenticated body but the status is not", () => {
  const state = newLivenessState({ instanceId: "i", topology: "same_host", startedAtMs: DRILL_NOW_MS - 60_000, intervalMs: 60_000 });
  state.lastPassCompletedAtMs = DRILL_NOW_MS;
  state.lastVerdict = "CANNOT_VERIFY";
  state.lastCannotVerifyReason = "connect ECONNREFUSED db.internal.example:5432";
  state.passCount = 1;

  const exposed = renderWatchdogHealth(state, DRILL_NOW_MS, "redacted");
  assert.equal(exposed.httpStatus, 503, "redaction must never soften the verdict");
  assert.equal(exposed.body.status, "cannot_verify");
  assert.match(exposed.body.reason, /not a green light/);
  assert.ok(!exposed.body.reason.includes("db.internal.example"), "a driver message can name the database host");

  assert.match(renderWatchdogHealth(state, DRILL_NOW_MS, "full").body.reason, /db\.internal\.example/);
});

test("the detail level travels through the request router, so /healthz cannot bypass it", () => {
  const state = newLivenessState({ instanceId: "secret-host:9", topology: "same_host", startedAtMs: DRILL_NOW_MS - 60_000, intervalMs: 60_000 });
  state.lastPassCompletedAtMs = DRILL_NOW_MS;
  state.lastVerdict = "VERIFIED_HEALTHY";
  state.passCount = 1;
  const r = handleWatchdogHealthRequest("/healthz", state, DRILL_NOW_MS, "redacted");
  assert.equal(r.httpStatus, 200);
  assert.ok(!JSON.stringify(r.body).includes("secret-host"));
});

// ── 3. DELIVERY IS NEVER ASSUMED ────────────────────────────────────────────

function armedConfig(): AlertSinkConfig {
  return { ingestUrl: "https://example.invalid/api/watchdog/alerts", ingestToken: "x".repeat(32), webhookUrl: null, timeoutMs: 1_000 };
}

test("an unreachable app is reported as unreachable, never as delivered", async () => {
  const env = envelopeFor(drillScenario("position_without_protective_orders").snapshot);
  const fetchImpl: FetchLike = async () => { throw new Error("connect ECONNREFUSED"); };
  const results = await deliverAlert(env, armedConfig(), fetchImpl);
  const app = results.find((r) => r.leg === "app");
  assert.equal(app?.status, "unreachable");
  assert.ok(deliveryIsDegraded(results), "an unreachable app path IS a degraded alert path");
  assert.match(summariseDelivery(results), /app:unreachable/);
});

test("a refusal (bad token, ingest disarmed) is reported as refused with its status", async () => {
  const env = envelopeFor(drillScenario("main_app_outage").snapshot);
  const fetchImpl: FetchLike = async () => ({ ok: false, status: 503, text: async () => JSON.stringify({ error: "ingest_not_configured" }) });
  const results = await deliverAlert(env, armedConfig(), fetchImpl);
  assert.deepEqual(results.find((r) => r.leg === "app"), { leg: "app", status: "refused", httpStatus: 503, reason: "ingest_not_configured" });
  assert.ok(deliveryIsDegraded(results));
});

test("an unconfigured alert path is 'not_configured' and still degraded — a silent no-op would look like success", async () => {
  const env = envelopeFor(drillScenario("main_app_outage").snapshot);
  let called = 0;
  const fetchImpl: FetchLike = async () => { called++; return { ok: true, status: 200, text: async () => "{}" }; };

  const noUrl = await deliverAlert(env, { ingestUrl: null, ingestToken: "x".repeat(32), webhookUrl: null, timeoutMs: 1_000 }, fetchImpl);
  assert.equal(noUrl.find((r) => r.leg === "app")?.status, "not_configured");
  assert.ok(deliveryIsDegraded(noUrl));

  // No token → fail closed, do NOT POST unauthenticated.
  const noToken = await deliverAlert(env, { ingestUrl: "https://example.invalid/x", ingestToken: null, webhookUrl: null, timeoutMs: 1_000 }, fetchImpl);
  assert.equal(noToken.find((r) => r.leg === "app")?.status, "not_configured");
  assert.equal(called, 0, "an unarmed sink must not put an unauthenticated request on the wire");
});

test("the ingest token is presented as a bearer header and never placed in the URL or the body", async () => {
  const env = envelopeFor(drillScenario("main_app_outage").snapshot);
  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const cfg = armedConfig();
  await deliverAlert(env, cfg, fetchImpl);
  assert.equal(seen[0]!.headers.authorization, `Bearer ${cfg.ingestToken}`);
  assert.ok(!seen[0]!.url.includes(cfg.ingestToken!), "the token must never reach a URL/query string");
  assert.ok(!seen[0]!.body.includes(cfg.ingestToken!), "the token must never reach the request body");
});

// ── Redaction on the wire ───────────────────────────────────────────────────

test("evidence is stripped of identity and secret-shaped keys before it leaves the watchdog", () => {
  const r = redactEvidence({ positionId: 42, userId: 7, email: "a@b.c", databaseUrl: "postgres://u:p@h/d", symbol: "EURUSD", nested: { x: 1 } });
  assert.equal(r.positionId, 42);
  assert.equal(r.symbol, "EURUSD");
  assert.ok(!("userId" in r), "userId must be dropped — an operator alert carries no trader identity");
  assert.ok(!("email" in r));
  assert.equal(r.databaseUrl, "[REDACTED]");
  assert.equal(r.nested, "[object]", "structured evidence is summarised, not forwarded verbatim");
});

test("the unprotected-position alert carries no userId even though the finding did", () => {
  const env = envelopeFor(drillScenario("position_without_protective_orders").snapshot);
  const f = env.findings.find((x) => x.key === "unprotected_position:9002")!;
  assert.equal(f.evidence.positionId, 9002);
  assert.ok(!("userId" in f.evidence));
  assert.ok(!JSON.stringify(env).includes("\"userId\""));
});

// ── Envelope parsing (the app side must not trust the sender) ───────────────

test("the app re-redacts on receipt and refuses malformed or oversized envelopes", () => {
  const good = envelopeFor(drillScenario("main_app_outage").snapshot);
  const round = parseAlertEnvelope(JSON.parse(JSON.stringify(good)));
  assert.ok(round.ok);
  assert.equal(round.value.passVerdict, "FINDINGS");

  // A sender that "forgot" to redact is redacted again on receipt.
  const dirty = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
  (dirty.findings as Record<string, unknown>[])[0]!.evidence = { userId: 7, token: "abc" };
  const reparsed = parseAlertEnvelope(dirty);
  assert.ok(reparsed.ok);
  assert.ok(!("userId" in reparsed.value.findings[0]!.evidence));
  assert.equal(reparsed.value.findings[0]!.evidence.token, "[REDACTED]");

  assert.equal(parseAlertEnvelope(null).ok, false);
  assert.equal(parseAlertEnvelope({ ...good, version: 99 }).ok, false);
  assert.equal(parseAlertEnvelope({ ...good, source: "somebody-else" }).ok, false);
  assert.equal(parseAlertEnvelope({ ...good, passVerdict: "ALL_GOOD" }).ok, false);
  const flood = { ...good, findings: Array.from({ length: MAX_WIRE_FINDINGS + 1 }, () => ({ key: "k", severity: "INFO", message: "m" })) };
  assert.equal(parseAlertEnvelope(flood).ok, false, "an unbounded fan-out must be refused");
});

// ── 4. NO WRITE PATH TO TRADING TABLES (transitive source pin) ─────────────

const WRITE_SQL = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|CREATE\s+(TABLE|ROLE|INDEX)|DROP\s+|GRANT\s+|ALTER\s+TABLE)\b/i;
const ALLOWED_BARE_SPECIFIERS = new Set(["pg", "node:http", "node:os"]);

/** Comments are stripped before specifier extraction so prose about imports
 *  (these files are full of it) can neither add nor hide an edge. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Every syntactic form that can pull another module into this graph. The
 * original pin matched only `… from "x";` — with the trailing semicolon —
 * which silently skipped `await import(…)`, `require(…)`, a side-effect
 * `import "x"`, and any semicolon-less import. An import the walker does not
 * match is never enqueued and never scanned, so a blind spot here is a hole in
 * the whole no-write-path guarantee, not a cosmetic gap.
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*["']([^"']+)["']/g,                 // import/export … from "x"  (semicolon optional)
  /^\s*(?:import|export)\s*["']([^"']+)["']/gm, // side-effect import "x"
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,     // dynamic  await import("x")
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,    // CJS      require("x")
];

/** A dynamic specifier that is not a string literal cannot be followed
 *  statically, so it must not exist inside this graph at all. */
const UNANALYZABLE_DYNAMIC = /\b(?:import|require)\s*\(\s*(?!["'])[^)\s]/g;

export interface ExtractedSpecifiers {
  specifiers: string[];
  /** Count of `import(expr)` / `require(expr)` the walker cannot follow. */
  unanalyzable: number;
}

/** PURE and directly testable — the walker's blind spots are now assertable. */
export function extractModuleSpecifiers(rawSrc: string): ExtractedSpecifiers {
  const src = stripComments(rawSrc);
  const specifiers = new Set<string>();
  for (const re of SPECIFIER_PATTERNS) {
    for (const m of src.matchAll(re)) specifiers.add(m[1]!);
  }
  return { specifiers: [...specifiers], unanalyzable: [...src.matchAll(UNANALYZABLE_DYNAMIC)].length };
}

/** Walk the import graph from watchdog.ts and return every local file it pulls in. */
function watchdogModuleGraph(): { files: string[]; bareSpecifiers: Set<string>; unanalyzable: { file: string; count: number }[] } {
  const entry = path.resolve(API_SERVER_ROOT, "src/watchdog.ts");
  const seen = new Set<string>();
  const bare = new Set<string>();
  const unanalyzable: { file: string; count: number }[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const { specifiers, unanalyzable: dyn } = extractModuleSpecifiers(readFileSync(file, "utf8"));
    if (dyn > 0) unanalyzable.push({ file, count: dyn });
    for (const spec of specifiers) {
      if (!spec.startsWith(".")) { bare.add(spec); continue; }
      const base = path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts"));
      const resolved = [base, `${base}.ts`, path.join(base, "index.ts")].find((c) => existsSync(c));
      if (resolved) queue.push(resolved);
      else throw new Error(`watchdog graph: cannot resolve ${spec} from ${file}`);
    }
  }
  return { files: [...seen], bareSpecifiers: bare, unanalyzable };
}

test("the import walker itself has no blind spot — every module-pulling form is matched", () => {
  // This is the test the pin was missing. Each line below is a real way to
  // reach @workspace/db that the previous `… from "x";` regex silently skipped.
  const evasions = [
    'import { db } from "@workspace/db"',                 // no trailing semicolon
    'const { db } = await import("@workspace/db");',      // dynamic
    'const { db } = require("@workspace/db");',           // CJS
    'import "@workspace/db";',                            // side-effect only
    'export { db } from "@workspace/db"',                 // re-export, no semicolon
    'export * from "@workspace/db";',                     // star re-export
    'import\n  type X\n  from "@workspace/db";',          // multi-line
  ];
  for (const line of evasions) {
    const { specifiers } = extractModuleSpecifiers(line);
    assert.ok(specifiers.includes("@workspace/db"), `the walker missed an import form: ${JSON.stringify(line)}`);
  }
  // A commented-out import is NOT an edge.
  assert.deepEqual(extractModuleSpecifiers('// import { db } from "@workspace/db";').specifiers, []);
  assert.deepEqual(extractModuleSpecifiers('/* import { db } from "@workspace/db"; */').specifiers, []);
  // …and a specifier the walker cannot follow is counted, not ignored.
  assert.equal(extractModuleSpecifiers("await import(someVariable);").unanalyzable, 1);
  assert.equal(extractModuleSpecifiers('await import("./x.js");').unanalyzable, 0);
});

test("no module in the watchdog graph imports through an expression the pin cannot follow", () => {
  const { unanalyzable } = watchdogModuleGraph();
  assert.deepEqual(
    unanalyzable.map((u) => `${path.relative(REPO_ROOT, u.file)} (${u.count})`),
    [],
    "a computed import() specifier makes the transitive pin unenforceable — keep watchdog imports static and literal",
  );
});

test("the ENTIRE watchdog import graph contains no write statement and no execution surface", () => {
  const { files } = watchdogModuleGraph();
  assert.ok(files.length >= 4, `expected the entry plus its pure modules, got ${files.length}`);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    // Strip comments so prose describing writes (this file is full of it)
    // cannot pass or fail the pin by accident.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!WRITE_SQL.test(code), `${path.relative(REPO_ROOT, f)} must contain no write/DDL SQL`);
    // `killSwitchEngaged` is a READ of safety_core and is allowed; anything
    // that could ENGAGE, RELEASE or BYPASS it is not.
    for (const banned of ["@workspace/db", "deliver(", "liveCommandPipeline", "guidedDispatchEntry", "killSwitchBypass", "engageKillSwitch", "releaseKillSwitch", "approvalTickets", "drizzle"]) {
      assert.ok(!code.includes(banned), `${path.relative(REPO_ROOT, f)} must not reference the execution surface: ${banned}`);
    }
  }
});

test("the watchdog's transitive dependency surface stays pg + node builtins — no app, no @workspace/db", () => {
  const { bareSpecifiers } = watchdogModuleGraph();
  for (const spec of bareSpecifiers) {
    assert.ok(ALLOWED_BARE_SPECIFIERS.has(spec), `watchdog may not depend on "${spec}" — allowed: ${[...ALLOWED_BARE_SPECIFIERS].join(", ")}`);
  }
  assert.ok(!bareSpecifiers.has("@workspace/db"), "the watchdog must hold its own connection, never the app's write pool");
});

test("the watchdog still forces a read-only session on its own connection", () => {
  const src = readFileSync(path.resolve(API_SERVER_ROOT, "src/watchdog.ts"), "utf8");
  assert.ok(src.includes("SET default_transaction_read_only = on"));
});

test("the watchdog's own heartbeat is written by the APP, not by the watchdog", () => {
  // The heartbeat table exists, and the only writer is the ingest route.
  const routeSrc = readFileSync(path.resolve(API_SERVER_ROOT, "src/routes/watchdogIngest.ts"), "utf8");
  assert.ok(routeSrc.includes("watchdogHeartbeatsTable"));
  const { files } = watchdogModuleGraph();
  for (const f of files) {
    assert.ok(!readFileSync(f, "utf8").includes("watchdogHeartbeatsTable"),
      "the read-only watchdog process must not reference its own heartbeat table");
  }
});

// ── The ingest route fails closed ───────────────────────────────────────────

test("the ingest route refuses to accept anything while its token env is unset", () => {
  const src = readFileSync(path.resolve(API_SERVER_ROOT, "src/routes/watchdogIngest.ts"), "utf8");
  assert.ok(src.includes("ingest_not_configured"), "an unarmed ingest must refuse loudly, not accept quietly");
  assert.ok(src.includes("timingSafeEqual"), "the bearer comparison must be constant-time");
  assert.ok(!WRITE_SQL.test(src.replace(/^\s*\/\/.*$/gm, "")), "the ingest route writes via drizzle only — no raw write SQL");
  // It may write notifications and its heartbeat; it may not touch execution.
  for (const banned of ["liveCommandPipeline", "guidedDispatchEntry", "livePositionsTable", "mt5CommandsTable"]) {
    assert.ok(!src.includes(banned), `the ingest route must not touch ${banned}`);
  }
});

test("POST /watchdog/alerts is on the public allowlist (it has no session by design) and nothing else was opened", () => {
  const gate = readFileSync(path.resolve(API_SERVER_ROOT, "src/lib/auth/globalGate.ts"), "utf8");
  assert.ok(gate.includes('"/watchdog/alerts"'), "the watchdog POST must reach its own token check");
  assert.ok(!gate.includes('"/admin/watchdog/status"'), "the admin status read must stay behind the session gate");
});

// ── 5. THE DEPLOYMENT PACKAGE IS REAL ───────────────────────────────────────

test("the documented run commands actually exist as scripts", () => {
  const rootPkg = JSON.parse(readFileSync(path.resolve(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const apiPkg = JSON.parse(readFileSync(path.resolve(API_SERVER_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  // docs/WATCHDOG.md promised `pnpm run watchdog` for a whole phase while no
  // such script existed. This test is why that cannot recur.
  assert.ok(rootPkg.scripts.watchdog, "root script `watchdog` must exist");
  assert.ok(rootPkg.scripts["watchdog:once"], "root script `watchdog:once` must exist");
  assert.ok(apiPkg.scripts.watchdog, "api-server script `watchdog` must exist");
  assert.ok(apiPkg.scripts["watchdog:once"], "api-server script `watchdog:once` must exist");
  assert.ok(apiPkg.scripts["drill:watchdog"], "the drill must be runnable");
  assert.ok(existsSync(path.resolve(REPO_ROOT, "scripts/watchdog/start-watchdog.sh")), "the start script must exist");
  assert.ok(existsSync(path.resolve(REPO_ROOT, "docs/WATCHDOG_DEPLOYMENT.md")));
  assert.ok(existsSync(path.resolve(REPO_ROOT, "docs/WATCHDOG_DRILL.md")));
  assert.ok(existsSync(path.resolve(REPO_ROOT, "docs/migrations-pending/hold-watchdog-deploy.sql")));
});

test("the deployment doc states, for every topology, what it does NOT protect against", () => {
  const doc = readFileSync(path.resolve(REPO_ROOT, "docs/WATCHDOG_DEPLOYMENT.md"), "utf8");
  for (const topology of ["same_host", "second_repl", "external_host"]) {
    assert.ok(doc.includes(topology), `topology ${topology} must be documented`);
  }
  assert.match(doc, /dies with the box/i, "the same-host topology's fatal limitation must be stated plainly");
});

test("the watchdog process, pointed at an unreachable database, degrades honestly instead of passing", () => {
  // The real binary, the real exit code. Port 1 is never a Postgres server.
  let stderr = "";
  let status = 0;
  try {
    execFileSync(process.execPath, ["--import", "tsx", "src/watchdog.ts", "--once"], {
      cwd: API_SERVER_ROOT,
      env: {
        ...process.env,
        ARX_WATCHDOG_DATABASE_URL: "postgresql://nobody:nothing@127.0.0.1:1/arx_does_not_exist",
        ARX_WATCHDOG_ALERT_INGEST_URL: "",
        ARX_WATCHDOG_INGEST_TOKEN: "",
        ARX_WATCHDOG_WEBHOOK_URL: "",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    status = err.status ?? -1;
    stderr = err.stderr ?? "";
  }
  assert.equal(status, 2, "an unreachable database must exit 2 (cannot verify), never 0");
  assert.match(stderr, /cannot_verify:database_connection/, "it must say it cannot verify");
  assert.match(stderr, /UNVERIFIABLE/, "…in words a human reads as 'I could not check', not 'all clear'");
  assert.ok(!/watchdog_pass_verified_healthy/.test(stderr), "it must never claim a healthy pass it did not make");
  assert.match(stderr, /watchdog_alert_path_not_armed/, "an unarmed alert path must be announced, not hidden");
});
