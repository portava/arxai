// RANKS 34, 35, 77 — cross-user leakage and dead preference stores in the
// notification pipeline, plus RANK 4's PAPER_ONLY help envelope.
//
// These are DB-touching subsystems, so this suite pins the two things that can
// be proven offline and are exactly where each defect lived:
//   * the pure key/gate functions (scopedDedupeKey, categoryEnabled), and
//   * the SHAPE of the queries and route handlers, read from source — because
//     every one of these defects was a missing `userId` in a where-clause or a
//     handler that threw the authenticated user away, which no unit test of the
//     surrounding logic could ever see.

// Offline lane: importing service.ts pulls in @workspace/db, which throws
// synchronously without a DATABASE_URL. A dummy pointing at a closed port keeps
// this suite offline — nothing here executes a query, and any accidental one
// would fail loudly rather than touch a real database.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Dynamic import: a static one is hoisted ABOVE the DATABASE_URL assignment
// above, and @workspace/db throws at module-evaluation time without it.
const { scopedDedupeKey, categoryEnabled } = await import("../service.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/**
 * Source with comments stripped.
 *
 * Every one of these fixes documents the exact string it removed (that is how
 * the next reader learns what was wrong), so a "this text must no longer
 * appear" assertion has to look at CODE, not at the comment quoting the old
 * code. Positive assertions still run against the full source.
 */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const service = read("artifacts/api-server/src/lib/notifications/service.ts");
const routes = read("artifacts/api-server/src/routes/notifications.ts");
const rules = read("artifacts/api-server/src/lib/notifications/rules.ts");
const helpRoutes = read("artifacts/api-server/src/routes/help.ts");
const helpTopics = read("artifacts/api-server/src/lib/onboarding/help.ts");
const whyBlocked = read("artifacts/api-server/src/lib/onboarding/whyBlocked.ts");
const meNotifications = read("artifacts/api-server/src/routes/meNotifications.ts");
const sendService = read("artifacts/api-server/src/lib/push/sendService.ts");
const prefsSchema = read("lib/db/src/schema/userNotifications.ts");

// ── RANK 34 — one user's alert absorbed into another's row ─────────────────
//
// THE DEFECT: the dedupe lookup was
//     .where(eq(notificationsTable.dedupeKey, input.dedupeKey))
// with NO userId, against a GLOBAL unique index. Many rule keys are
// user-independent by construction, so when two users hit their daily loss
// limit on the same day the second user's CRITICAL notification found the
// FIRST user's row and merely bumped its repeatCount. The user with the losing
// account was the one who never got told.

test("rank 34: the rule keys really are user-independent (the defect is real)", () => {
  // Non-vacuous: prove the premise before asserting the fix.
  assert.match(rules, /dedupeKey: `HH:DAILY_LOSS_HIT:\$\{new Date\(\)\.toISOString\(\)\.slice\(0,10\)\}`/);
  assert.match(rules, /dedupeKey: `HH:DAILY_LOSS_NEAR:\$\{new Date\(\)\.toISOString\(\)\.slice\(0,10\)\}`/);
});

test("rank 34: two users sharing a raw dedupe key get distinct stored keys", () => {
  const raw = "HH:DAILY_LOSS_HIT:2026-08-29";
  assert.notEqual(scopedDedupeKey(1, raw), scopedDedupeKey(2, raw));
  assert.equal(scopedDedupeKey(1, raw), scopedDedupeKey(1, raw));
});

test("rank 34: system-wide events get their own namespace, distinct from every user", () => {
  const raw = "DD:WIDE_SPREAD:EURUSD:1";
  const system = scopedDedupeKey(null, raw);
  assert.equal(system, scopedDedupeKey(undefined, raw));
  assert.notEqual(system, scopedDedupeKey(0, raw));
  assert.notEqual(system, scopedDedupeKey(1, raw));
});

test("rank 34: the namespace cannot be forged by a crafted raw key", () => {
  // `u2::x` supplied as a raw key by user 1 must not collide with user 2's row.
  assert.notEqual(scopedDedupeKey(1, "u2::x"), scopedDedupeKey(2, "x"));
});

test("rank 34: the lookup filters on the owner, not only the key", () => {
  assert.match(service, /const storedDedupeKey = scopedDedupeKey\(ownerId, input\.dedupeKey\)/);
  assert.match(service, /eq\(notificationsTable\.dedupeKey, storedDedupeKey\), ownerMatch/);
  assert.match(service, /isNull\(notificationsTable\.userId\)/);
  // …and the row is written with the scoped key, so the global unique index
  // becomes a per-user one.
  assert.match(service, /dedupeKey: storedDedupeKey/);
  // The old unscoped lookup is gone.
  assert.doesNotMatch(code(service), /where\(eq\(notificationsTable\.dedupeKey, input\.dedupeKey\)\)/);
});

// ── RANK 35 — the digest leaked other users' critical alert titles ─────────

test("rank 35: generateDigest is scoped to one user", () => {
  assert.match(service, /export async function generateDigest\(userId: number/);
  assert.match(service, /eq\(notificationsTable\.userId, userId\)/);
  assert.match(service, /values\(\{\s*userId, digestId/);
});

test("rank 35: latestDigest is scoped to one user", () => {
  assert.match(service, /export async function latestDigest\(userId: number\)/);
  assert.match(service, /where\(eq\(notificationDigestsTable\.userId, userId\)\)/);
});

test("rank 35: the digest routes no longer discard the authenticated user", () => {
  assert.match(routes, /latestDigest\(req\.authUser!\.id\)/);
  assert.match(routes, /generateDigest\(req\.authUser!\.id, hours\)/);
  // The `_req` that threw the user away is gone from the digest handler.
  assert.doesNotMatch(routes, /router\.get\("\/notifications\/digest", requireUser, async \(_req/);
});

test("rank 35: the ownerless log trail is admin-only", () => {
  // notification_logs has no user column: nothing in it can be shown to be the
  // caller's own data, so it must not be served to a plain authenticated user.
  assert.match(routes, /router\.get\("\/notifications\/logs", requireAdmin/);
});

// ── RANK 79 — fabricated CRITICAL alerts seeded into a real inbox ──────────

test("rank 79: seeding and system ingest are operator-only", () => {
  assert.match(routes, /router\.post\("\/notifications\/demo", requireAdmin/);
  assert.match(routes, /router\.post\("\/notifications\/ingest", requireAdmin/);
  assert.match(routes, /router\.post\("\/notifications\/test-event", requireAdmin/);
});

test("rank 79: every seeded row is stamped DEMO in the title and metadata", () => {
  assert.match(service, /export const DEMO_TITLE_PREFIX = "\[DEMO\] "/);
  assert.match(service, /title: `\$\{DEMO_TITLE_PREFIX\}\$\{i\.title\}`/);
  assert.match(service, /metadata: \{ \.\.\.\(i\.metadata \?\? \{\}\), demo: true \}/);
});

// ── RANK 77 — three preference stores, one reachable screen ────────────────

test("rank 77: the in-app category gate reads the canonical per-user row", () => {
  assert.match(service, /userNotificationPreferencesTable/);
  assert.match(service, /async function canonicalCategoryPrefs/);
  // …and it is that row, not notification_preferences, that gates notify().
  assert.match(service, /const prefs = await canonicalCategoryPrefs\(ownerId\)/);
});

test("rank 77: SAFETY and SYSTEM can never be switched off", () => {
  const allOff = {
    inAppEnabled: false, riskAlertsEnabled: false, tradeEventsEnabled: false,
    aiCoachingEnabled: false, mt5StatusEnabled: false,
  };
  assert.equal(categoryEnabled(allOff, "SAFETY"), true);
  assert.equal(categoryEnabled(allOff, "SYSTEM"), true);
  // …while the switchable categories genuinely switch.
  assert.equal(categoryEnabled(allOff, "RISK"), false);
  assert.equal(categoryEnabled(allOff, "TRADE"), false);
  assert.equal(categoryEnabled(allOff, "COACH"), false);
  assert.equal(categoryEnabled(allOff, "BROKER"), false);
});

test("rank 77: an unknown category defaults to DELIVER, not to silence", () => {
  const allOff = {
    inAppEnabled: false, riskAlertsEnabled: false, tradeEventsEnabled: false,
    aiCoachingEnabled: false, mt5StatusEnabled: false,
  };
  assert.equal(categoryEnabled(allOff, "SOMETHING_NEW"), true);
});

test("rank 77: a missing preference row fails OPEN (never silently withholds)", () => {
  // Not being able to read a preference is not permission to hide a risk alert.
  assert.match(service, /A missing row FAILS OPEN/);
  assert.match(service, /if \(prefs\) \{/);
});

test("rank 77: minimumPushSeverity now has a column AND a writer", () => {
  // The gate that could never be reached by any value.
  assert.match(sendService, /minimumPushSeverity/);
  assert.match(prefsSchema, /minimumPushSeverity: text\("minimum_push_severity"\)/);
  assert.match(meNotifications, /PUSH_SEVERITY_VALUES = \["info", "warning", "critical"\]/);
  assert.match(meNotifications, /patch\["minimumPushSeverity"\] = body\["minimumPushSeverity"\]/);
});

test("rank 77: an invalid severity is refused loudly, not dropped", () => {
  assert.match(meNotifications, /INVALID_MINIMUM_PUSH_SEVERITY/);
  assert.match(meNotifications, /res\.status\(400\)/);
});

test("rank 77: the PATCH echoes which fields it actually persisted", () => {
  // So a client can never paint "Saved" over a field the server dropped.
  assert.match(meNotifications, /updatedFields: Object\.keys\(patch\)/);
});

// ── RANK 4 — the Help Center told every user the app cannot trade live ─────

test("rank 4: the help envelope no longer hard-codes PAPER_ONLY", () => {
  const src = code(helpRoutes);
  assert.doesNotMatch(src, /appMode: "PAPER_ONLY"/);
  assert.doesNotMatch(src, /liveTradingStatus: "DISABLED"/);
  assert.doesNotMatch(src, /canPlaceLiveTrade: false/);
});

test("rank 4: it reports the caller's real mode, per-user", () => {
  assert.match(helpRoutes, /computeAccountShell\(userId\)/);
  assert.match(helpRoutes, /getMyArming\(userId\)/);
  assert.match(helpRoutes, /resolveLiveBrokerExecutionEnabledAsync\(\)/);
  // Every route is authenticated — the answer is per-user, so it has to be.
  for (const path of ["/help/topics", "/help/topic/:key", "/help/page", "/help/explain", "/help/why-blocked"]) {
    const rx = new RegExp(`"${path.replace(/[/:]/g, (c) => `\\${c}`)}",\\s*requireUser`);
    assert.match(helpRoutes, rx, `${path} must require an authenticated user`);
  }
});

test("rank 4: an unreadable mode degrades to null with a reason, never to PAPER_ONLY", () => {
  assert.match(helpRoutes, /appMode: null, appModeUnavailableReason: "NO_AUTHENTICATED_USER"/);
  assert.match(helpRoutes, /appModeUnavailableReason: "MODE_READ_FAILED"/);
});

test("rank 4: no help topic still claims live trading is impossible", () => {
  const banned = [
    /PAPER_ONLY/,
    /Live trading is disabled/i,
    /does not allow live order placement/i,
    /It cannot place, modify, or close orders/i,
    /never grant live-trading permission/i,
  ];
  const src = code(helpTopics);
  for (const rx of banned) {
    assert.doesNotMatch(src, rx, `help topics still assert ${rx}`);
  }
});

test("rank 4: the topics describe the real gate chain instead", () => {
  assert.match(helpTopics, /default-deny/);
  assert.match(helpTopics, /23 gates|23 Phase B gates/);
  assert.match(helpTopics, /an order you approve can reach a real broker/);
});

test("rank 4: whyBlocked can express more than one answer", () => {
  assert.match(whyBlocked, /export type LiveTradingStatus = "ALLOWED" \| "BLOCKED" \| "UNKNOWN"/);
  // The hard-coded falsehoods are gone.
  const src = code(whyBlocked);
  assert.doesNotMatch(src, /const aaCanPlaceTrades = false/);
  assert.doesNotMatch(src, /This app is PAPER_ONLY/);
  assert.doesNotMatch(src, /The broker connector is read-only/);
  // …and it reads the real per-user chain.
  assert.match(whyBlocked, /userTradingPermissionsTable\.liveApproved/);
  assert.match(whyBlocked, /globalTradingSettingsTable\.emergencyKillSwitch/);
  assert.match(whyBlocked, /getMyArming\(userId\)/);
});

test("rank 4: a failed readiness read is UNKNOWN, not 'blocked' and not 'allowed'", () => {
  assert.match(whyBlocked, /degraded \? "UNKNOWN"/);
  assert.match(whyBlocked, /Treat this as unknown, not as safe/);
});

test("rank 4: whyBlocked is per-user", () => {
  assert.match(whyBlocked, /export async function explainBlockedAction\(action: BlockedAction, userId: number\)/);
  assert.match(whyBlocked, /getCriticalUnread\(userId\)/);
});
