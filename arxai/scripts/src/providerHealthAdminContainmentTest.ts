// providerHealthAdminContainmentTest — Task #409 (spec Phase 8).
//
// WHY
//   The Provider Health admin panel exposes a complete, sanitized provider +
//   feed inventory (secret-config masks, router chains, per-probe attempt
//   reasons, admin-only feed status, per-asset-class activity, active
//   consumers). Regular users must NEVER see any of that — they only ever get
//   the small per-symbol ChartFeedStatus contract from /api/chart/feed-status.
//   This test locks BOTH halves of that contract:
//     1. every admin provider/feed endpoint hard-gates on the EFFECTIVE role
//        (req.authUser.role, case-insensitive), so anon -> 401 and any
//        non-admin (incl. admin-previewing-as-user, which carries a USER
//        effective role) -> 403, while ADMIN/OWNER -> 200.
//     2. the admin 200 body actually carries the NEW #409 sections (no
//        false-pass), AND the user-facing /api/chart/feed-status body contains
//        NONE of the admin-inventory keys.
//
// WHAT IT PROVES
//   Auth gate on all 3 admin endpoints:
//     - /api/admin/providers/health
//     - /api/admin/market-data/diagnostics
//     - /api/admin/market-data/mt5-feed
//     anon -> 401 ; USER -> 403 ; VIEWER (a 2nd non-admin role) -> 403 ;
//     ADMIN -> 200 ; OWNER -> 200
//   New admin fields present (no false-pass):
//     - snapshot.feeds.{mt5,deriv,assistant,economicCalendar}
//     - snapshot.assetClassActivity[] with the expected per-row keys
//     - snapshot.activeConsumers[]
//   Regular-user containment:
//     - GET /api/chart/feed-status (as a normal USER) returns ONLY the
//       ChartFeedStatus contract — recursively NONE of
//       {secretMasks,lastFourMasked,providers,routerChains,attempts,
//        adminDetail,feeds,assetClassActivity,activeConsumers,symbolProbes}
//
// SHARED-STATE SAFETY
//   Uses the in-process app harness. Seeds only isolated, uniquely-prefixed
//   isSystemUser accounts (one per role) with sessions, cleaned in a `finally`.
//   Read-only: never places a trade, never inserts a live command, never
//   mutates a provider store, never reaches a real EA.
//
// Run: pnpm --filter @workspace/scripts run test:provider-health-admin-containment

import { randomBytes, createHash } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { db, usersTable, authUserSessionsTable } from "@workspace/db";
import { getSharedBaseUrl, isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const EMAIL_PREFIX = "qa+provider-health-containment";
const SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_COOKIE = "arx_user_session";

const ADMIN_ENDPOINTS = [
  "/api/admin/providers/health",
  "/api/admin/market-data/diagnostics",
  "/api/admin/market-data/mt5-feed",
] as const;

// Keys that belong ONLY to the admin inventory and must never appear in a
// user-facing feed-status payload.
const FORBIDDEN_USER_KEYS = [
  "secretMasks",
  "lastFourMasked",
  "providers",
  "routerChains",
  "attempts",
  "adminDetail",
  "feeds",
  "assetClassActivity",
  "activeConsumers",
  "symbolProbes",
] as const;

let passes = 0;
let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passes++;
    // eslint-disable-next-line no-console
    console.log(`  \u2713 ${label}`);
  } else {
    failures++;
    // eslint-disable-next-line no-console
    console.error(`  \u2717 ${label}`);
  }
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function mintSession(userId: number): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await db.insert(authUserSessionsTable).values({
    userId,
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipAddress: "127.0.0.1",
    userAgent: "qa-provider-health-containment",
  });
  return raw;
}

async function cleanup(): Promise<void> {
  const users = await db.select({ id: usersTable.id }).from(usersTable)
    .where(like(usersTable.email, `${EMAIL_PREFIX}%`));
  const ids = users.map((u) => u.id);
  if (ids.length > 0) {
    await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
    await db.delete(usersTable).where(inArray(usersTable.id, ids));
  }
}

async function getJson(
  base: string,
  path: string,
  cookie: string | null,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = `${SESSION_COOKIE}=${cookie}`;
  const r = await fetch(`${base}${path}`, { headers });
  let body: unknown = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

// Recursively collect every object key in a JSON value.
function collectKeys(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("providerHealthAdminContainmentTest");
  // eslint-disable-next-line no-console
  console.log("==================================\n");

  await cleanup();
  const base = await getSharedBaseUrl();

  try {
    // ── Seed: one user per role with a session ───────────────────────────────
    const [adminUser] = await db.insert(usersTable).values({
      email: `${EMAIL_PREFIX}-admin@arx.test`, name: "QA PH Admin", role: "ADMIN", isSystemUser: true,
    }).returning();
    const [ownerUser] = await db.insert(usersTable).values({
      email: `${EMAIL_PREFIX}-owner@arx.test`, name: "QA PH Owner", role: "OWNER", isSystemUser: true,
    }).returning();
    const [normalUser] = await db.insert(usersTable).values({
      email: `${EMAIL_PREFIX}-user@arx.test`, name: "QA PH User", role: "USER", isSystemUser: true,
    }).returning();
    const [viewerUser] = await db.insert(usersTable).values({
      email: `${EMAIL_PREFIX}-viewer@arx.test`, name: "QA PH Viewer", role: "VIEWER", isSystemUser: true,
    }).returning();
    if (!adminUser || !ownerUser || !normalUser || !viewerUser) throw new Error("user creation failed");

    const adminCookie = await mintSession(adminUser.id);
    const ownerCookie = await mintSession(ownerUser.id);
    const userCookie = await mintSession(normalUser.id);
    const viewerCookie = await mintSession(viewerUser.id);

    // ── AUTH GATE on every admin endpoint ────────────────────────────────────
    for (const ep of ADMIN_ENDPOINTS) {
      const anon = await getJson(base, ep, null);
      assert(anon.status === 401, `${ep} : anonymous -> 401 (got ${anon.status})`);

      const asUser = await getJson(base, ep, userCookie);
      assert(asUser.status === 403, `${ep} : USER -> 403 (got ${asUser.status})`);

      const asViewer = await getJson(base, ep, viewerCookie);
      assert(asViewer.status === 403, `${ep} : VIEWER (non-admin role) -> 403 (got ${asViewer.status})`);

      const asAdmin = await getJson(base, ep, adminCookie);
      assert(asAdmin.status === 200, `${ep} : ADMIN -> 200 (got ${asAdmin.status})`);

      const asOwner = await getJson(base, ep, ownerCookie);
      assert(asOwner.status === 200, `${ep} : OWNER -> 200 (got ${asOwner.status})`);
    }

    // ── NEW #409 admin fields present (no false-pass) ─────────────────────────
    const health = await getJson(base, "/api/admin/providers/health", adminCookie);
    const snapshot = (health.body as { snapshot?: Record<string, unknown> })?.snapshot;
    assert(!!snapshot, "providers/health: snapshot present in admin body");

    const feeds = snapshot?.["feeds"] as Record<string, unknown> | undefined;
    assert(!!feeds, "snapshot.feeds present");
    assert(
      !!feeds && typeof feeds["mt5"] === "object"
        && typeof (feeds["mt5"] as Record<string, unknown>)["heartbeat"] === "object"
        && typeof (feeds["mt5"] as Record<string, unknown>)["quotePush"] === "object"
        && typeof (feeds["mt5"] as Record<string, unknown>)["candlePush"] === "object",
      "snapshot.feeds.mt5 has heartbeat + quotePush + candlePush",
    );
    assert(!!feeds && typeof feeds["deriv"] === "object", "snapshot.feeds.deriv present");
    assert(!!feeds && typeof feeds["assistant"] === "object", "snapshot.feeds.assistant present");
    assert(!!feeds && typeof feeds["economicCalendar"] === "object", "snapshot.feeds.economicCalendar present");

    const activity = snapshot?.["assetClassActivity"];
    assert(Array.isArray(activity) && activity.length > 0, `snapshot.assetClassActivity is a non-empty array (len=${Array.isArray(activity) ? activity.length : "n/a"})`);
    if (Array.isArray(activity) && activity[0]) {
      const row = activity[0] as Record<string, unknown>;
      const need = ["assetClass", "representativeSymbol", "latestCandleProvider", "aiUsable", "feedQuality", "staleReason", "fallbackReason"];
      assert(need.every((k) => k in row), `assetClassActivity row carries expected keys (${need.join(",")})`);
    }

    const consumers = snapshot?.["activeConsumers"];
    assert(Array.isArray(consumers), "snapshot.activeConsumers is an array");

    // ── REGULAR-USER CONTAINMENT: /api/chart/feed-status ──────────────────────
    const feedStatus = await getJson(base, "/api/chart/feed-status?symbol=EURUSD&timeframe=M5", userCookie);
    assert(feedStatus.status === 200, `chart/feed-status as USER -> 200 (got ${feedStatus.status})`);
    // It must be the ChartFeedStatus contract — prove a contract field is present.
    const fsBody = feedStatus.body as Record<string, unknown> | null;
    assert(!!fsBody && "quality" in fsBody && "aiUsable" in fsBody, "chart/feed-status returns the ChartFeedStatus contract (quality + aiUsable)");

    const userKeys = new Set<string>();
    collectKeys(feedStatus.body, userKeys);
    for (const forbidden of FORBIDDEN_USER_KEYS) {
      assert(!userKeys.has(forbidden), `chart/feed-status contains NO admin key "${forbidden}"`);
    }

    // Exact top-level allowlist — beyond the blacklist, prove the body carries
    // ONLY the known ChartFeedStatus contract keys, so a FUTURE leak under a
    // brand-new key name (not in FORBIDDEN_USER_KEYS) still fails the test.
    const CHART_FEED_STATUS_KEYS = new Set([
      "symbol", "displaySymbol", "assetClass", "source", "isLive",
      "lastTickTime", "lastCandleTime", "latencyMs", "missingCandleCount",
      "duplicateCount", "outOfOrderCount", "invalidOhlcCount", "trailingIntervals",
      "stale", "quality", "warning", "aiUsable", "feedReadinessState", "message",
    ]);
    const topLevelKeys = fsBody ? Object.keys(fsBody) : [];
    const unexpected = topLevelKeys.filter((k) => !CHART_FEED_STATUS_KEYS.has(k));
    assert(
      unexpected.length === 0,
      `chart/feed-status carries ONLY the ChartFeedStatus contract keys (unexpected: ${unexpected.join(",") || "none"})`,
    );
  } finally {
    await cleanup();
  }

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "providerHealthAdminContainmentTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    async (err) => {
      await cleanup().catch(() => {});
      // eslint-disable-next-line no-console
      console.error("[providerHealthAdminContainmentTest] FAILED:", err);
      process.exit(1);
    },
  );
}
