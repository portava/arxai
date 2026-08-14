// End-to-end HTTP test for the short-TTL caching of authenticated dashboard reads
// — GET /api/me/timing-brain/:symbol (Task #455), GET /api/me/trade-health
// (Task #461), and GET /api/me/opportunity-map (Task #462).
//
// WHY THIS EXISTS
//   shortTtlCache.test.ts proves the cache primitive is correct in isolation.
//   It never touches the ROUTE layer, so a regression where the endpoints stop
//   sharing the cache (or — worse — start re-stamping a cached read as
//   "fresh now", or leak one user's report to another) would ship silently.
//   This test authenticates seeded users and hits the ACTUAL booted Express
//   endpoints, locking in BOTH the speed win and the honesty guarantee.
//
// WHAT IT PROVES against the REAL HTTP routes (booted app, real session cookie):
//   1. ANON GUARD — anonymous GET on each endpoint → 401.
//   2. TIMING-BRAIN CACHE — two back-to-back authed reads of the same symbol:
//      the second is served from cache (well under the ~50ms target) AND carries
//      the IDENTICAL `generatedAt` as the first — a cached read is never
//      re-stamped as fresh-now (a recompute always mints a new generatedAt).
//   3. TRADE-HEALTH CACHE — two back-to-back authed reads for one user: the
//      second is fast (well under ~50ms) AND carries the IDENTICAL `evaluatedAt`
//      as the first.
//   4. PER-USER ISOLATION — the per-user cache key never serves user A's report
//      to user B. Computed ~30ms apart, A's and B's `evaluatedAt` differ, and
//      each user's own second read returns its OWN cached timestamp (never the
//      other user's).
//   5. OPPORTUNITY-MAP CACHE — the broad-scan map is a GLOBAL (not per-user)
//      market read keyed by universe|timeframe: a second read of one universe is
//      fast + keeps its original `generatedAt`, a different universe gets its own
//      distinct entry, and a second user is served the SAME cached core (shared
//      by design — the inverse of the per-user isolation in (4)).
//
// NOTE ON SCOPE
//   The timing-brain read is symbol-level MARKET DATA, intentionally keyed by
//   symbol|timeframe|tz (shared across users by design — it is not per-user
//   data). The per-user-isolation guarantee therefore lives on trade-health,
//   whose cache key embeds the userId; that is where assertion (4) bites.
//
// SAFETY / ISOLATION
//   - Seeds isolated system users (isSystemUser=true) at fixed emails. Idempotent:
//     deletes leftovers for the fixed identifiers at start and cleans up at the
//     end, even on failure.
//   - Per-user scoped: only the seeded users' reports are asserted.
//   - Never places a trade, never inserts an arx_live_command, never reaches the
//     EA or a broker. Only DATABASE_URL is required. READ-ONLY / advisory.
//   - CI-safe / self-contained: spins up the REAL Express app in-process on an
//     ephemeral port. Set ARX_QA_BASE_URL to probe an already-running server.
//
// Run: pnpm --filter @workspace/scripts run test:cached-read-e2e

import { randomBytes, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { inArray } from "drizzle-orm";
import { db, usersTable, authUserSessionsTable } from "@workspace/db";
import {
  getSharedBaseUrl,
  closeSharedServer,
  isEntrypoint,
  type CiTestResultLike,
} from "./ci/inProcessAppHarness.js";
import { __clearTimingReadCache } from "../../artifacts/api-server/src/brain/timing/timingReadCache.js";
import { __clearOpportunityMapCache } from "../../artifacts/api-server/src/lib/signalIntelligence/opportunityMapReadCache.js";

const EMAIL_A = "qa+cached-read-e2e-a@arx.test";
const EMAIL_B = "qa+cached-read-e2e-b@arx.test";
const ALL_EMAILS = [EMAIL_A, EMAIL_B];

const SYMBOL = "EURUSD";
// A warm in-process cache hit is sub-millisecond to a few ms; the very FIRST
// cache hit of the run also eats one-time JIT/process warmup, so the ceiling has
// to clear that. 100ms is still an order of magnitude below every recompute
// observed here (224ms–1668ms), so this guard fails a recompute regression while
// not flaking on first-hit warmup.
const FAST_MS = 100;

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function cleanup(): Promise<void> {
  const rows = await db.select().from(usersTable).where(inArray(usersTable.email, ALL_EMAILS));
  const ids = rows.map((u) => u.id);
  if (ids.length) {
    await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
    await db.delete(usersTable).where(inArray(usersTable.id, ids));
  }
}

async function seedUser(email: string, name: string): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({ email, name, role: "USER", isSystemUser: true })
    .returning();
  if (!user) throw new Error(`test user creation failed: ${email}`);
  return user.id;
}

// Issue a real session cookie the auth middleware accepts (SHA-256 of a raw
// token; server stores only the hash).
async function issueSession(userId: number): Promise<string> {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `arx_user_session=${rawToken}`;
}

interface TimedGet {
  status: number;
  ms: number;
  body: Record<string, unknown>;
}

async function timedGet(url: string, cookie: string | null): Promise<TimedGet> {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  const t0 = performance.now();
  const res = await fetch(url, { method: "GET", headers, redirect: "manual" });
  // Drain the body inside the timed window — a cache hit must be fast end-to-end.
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const ms = performance.now() - t0;
  return { status: res.status, ms, body };
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("meCachedReadEndToEndTest");
  // eslint-disable-next-line no-console
  console.log("========================\n");

  await cleanup();

  const baseUrl = await getSharedBaseUrl();
  const TIMING_URL = `${baseUrl}/api/me/timing-brain/${SYMBOL}?timeframe=M15`;
  const HEALTH_URL = `${baseUrl}/api/me/trade-health`;
  // Two SMALL universes so each cold scan is cheap and deterministic.
  const OPP_METALS_URL = `${baseUrl}/api/me/opportunity-map?marketGroup=metals`;
  const OPP_SYNTH_URL = `${baseUrl}/api/me/opportunity-map?marketGroup=synthetic`;

  try {
    const idA = await seedUser(EMAIL_A, "QA Cached Read A");
    const idB = await seedUser(EMAIL_B, "QA Cached Read B");
    const cookieA = await issueSession(idA);
    const cookieB = await issueSession(idB);

    // ── (0) ANON GUARD — both endpoints require auth ─────────────────────────
    // eslint-disable-next-line no-console
    console.log("(0) anonymous GETs are rejected");
    const anonTiming = await timedGet(TIMING_URL, null);
    assert(anonTiming.status === 401, `anon timing-brain GET → 401 (got ${anonTiming.status})`);
    const anonHealth = await timedGet(HEALTH_URL, null);
    assert(anonHealth.status === 401, `anon trade-health GET → 401 (got ${anonHealth.status})`);

    // ── (1) TIMING-BRAIN CACHE — second read is fast + same generatedAt ──────
    // Clear the (symbol-keyed, shared) cache so the first call is a real miss
    // that computes, and the second is provably served from cache.
    // eslint-disable-next-line no-console
    console.log("\n(1) timing-brain: 2nd read is cached (fast + identical generatedAt)");
    __clearTimingReadCache();

    const timing1 = await timedGet(TIMING_URL, cookieA);
    assert(timing1.status === 200, `timing-brain read #1 → 200 (got ${timing1.status})`);
    const gen1 = typeof timing1.body["generatedAt"] === "string" ? (timing1.body["generatedAt"] as string) : null;
    assert(gen1 !== null && gen1.length > 0, `read #1 carries a generatedAt (got ${String(gen1)})`);

    const timing2 = await timedGet(TIMING_URL, cookieA);
    assert(timing2.status === 200, `timing-brain read #2 → 200 (got ${timing2.status})`);
    const gen2 = typeof timing2.body["generatedAt"] === "string" ? (timing2.body["generatedAt"] as string) : null;
    assert(
      gen2 !== null && gen2 === gen1,
      `read #2 reports the ORIGINAL generatedAt — never re-stamped fresh-now (#1=${String(gen1)} #2=${String(gen2)})`,
    );
    assert(
      timing2.ms < FAST_MS,
      `timing-brain read #2 served from cache in <${FAST_MS}ms (got ${timing2.ms.toFixed(1)}ms; #1 was ${timing1.ms.toFixed(1)}ms)`,
    );

    // ── (2) TRADE-HEALTH CACHE + (3) PER-USER ISOLATION ──────────────────────
    // eslint-disable-next-line no-console
    console.log("\n(2/3) trade-health: cached per user + no cross-user leak");

    // A computes first (cache miss).
    const healthA1 = await timedGet(HEALTH_URL, cookieA);
    assert(healthA1.status === 200, `trade-health A read #1 → 200 (got ${healthA1.status})`);
    const evalA1 = typeof healthA1.body["evaluatedAt"] === "string" ? (healthA1.body["evaluatedAt"] as string) : null;
    assert(evalA1 !== null && evalA1.length > 0, `A read #1 carries an evaluatedAt (got ${String(evalA1)})`);

    // Gap so B's independent computation gets a distinct evaluatedAt — if B were
    // wrongly served A's cached entry, B's evaluatedAt would EQUAL A's.
    await sleep(30);

    // B computes its own (different per-user cache key → cache miss, fresh stamp).
    const healthB1 = await timedGet(HEALTH_URL, cookieB);
    assert(healthB1.status === 200, `trade-health B read #1 → 200 (got ${healthB1.status})`);
    const evalB1 = typeof healthB1.body["evaluatedAt"] === "string" ? (healthB1.body["evaluatedAt"] as string) : null;
    assert(evalB1 !== null && evalB1.length > 0, `B read #1 carries an evaluatedAt (got ${String(evalB1)})`);
    assert(
      evalB1 !== null && evalB1 !== evalA1,
      `PER-USER ISOLATION: B's report is its OWN, not A's cached one (A=${String(evalA1)} B=${String(evalB1)})`,
    );

    // A's second read — fast, and its OWN original timestamp (not B's).
    const healthA2 = await timedGet(HEALTH_URL, cookieA);
    assert(healthA2.status === 200, `trade-health A read #2 → 200 (got ${healthA2.status})`);
    const evalA2 = typeof healthA2.body["evaluatedAt"] === "string" ? (healthA2.body["evaluatedAt"] as string) : null;
    assert(
      evalA2 !== null && evalA2 === evalA1,
      `A read #2 reports A's ORIGINAL evaluatedAt — cached, not re-stamped (#1=${String(evalA1)} #2=${String(evalA2)})`,
    );
    assert(
      healthA2.ms < FAST_MS,
      `trade-health A read #2 served from cache in <${FAST_MS}ms (got ${healthA2.ms.toFixed(1)}ms; #1 was ${healthA1.ms.toFixed(1)}ms)`,
    );

    // B's second read — fast, and its OWN original timestamp (not A's).
    const healthB2 = await timedGet(HEALTH_URL, cookieB);
    assert(healthB2.status === 200, `trade-health B read #2 → 200 (got ${healthB2.status})`);
    const evalB2 = typeof healthB2.body["evaluatedAt"] === "string" ? (healthB2.body["evaluatedAt"] as string) : null;
    assert(
      evalB2 !== null && evalB2 === evalB1,
      `B read #2 reports B's ORIGINAL evaluatedAt — cached, not re-stamped (#1=${String(evalB1)} #2=${String(evalB2)})`,
    );
    assert(
      healthB2.ms < FAST_MS,
      `trade-health B read #2 served from cache in <${FAST_MS}ms (got ${healthB2.ms.toFixed(1)}ms; #1 was ${healthB1.ms.toFixed(1)}ms)`,
    );
    assert(
      evalA2 !== null && evalB2 !== null && evalA2 !== evalB2,
      `cross-user cache keys never collide: A#2 (${String(evalA2)}) !== B#2 (${String(evalB2)})`,
    );

    // ── (4) OPPORTUNITY-MAP CACHE — global core keyed by universe|timeframe ───
    // The opportunity map is NOT per-user data (a global market scan), so unlike
    // trade-health its cache is intentionally SHARED across users and keyed by
    // universe|timeframe only.
    // eslint-disable-next-line no-console
    console.log("\n(4) opportunity-map: shared cache keyed by universe|timeframe");
    __clearOpportunityMapCache();

    const oppAnon = await timedGet(OPP_METALS_URL, null);
    assert(oppAnon.status === 401, `anon opportunity-map GET → 401 (got ${oppAnon.status})`);

    const opp1 = await timedGet(OPP_METALS_URL, cookieA);
    assert(opp1.status === 200, `opportunity-map metals read #1 → 200 (got ${opp1.status})`);
    const oppGen1 = typeof opp1.body["generatedAt"] === "string" ? (opp1.body["generatedAt"] as string) : null;
    assert(oppGen1 !== null && oppGen1.length > 0, `metals read #1 carries a generatedAt (got ${String(oppGen1)})`);

    const opp2 = await timedGet(OPP_METALS_URL, cookieA);
    assert(opp2.status === 200, `opportunity-map metals read #2 → 200 (got ${opp2.status})`);
    const oppGen2 = typeof opp2.body["generatedAt"] === "string" ? (opp2.body["generatedAt"] as string) : null;
    assert(
      oppGen2 !== null && oppGen2 === oppGen1,
      `metals read #2 reports the ORIGINAL generatedAt — never re-stamped fresh-now (#1=${String(oppGen1)} #2=${String(oppGen2)})`,
    );
    assert(
      opp2.ms < FAST_MS,
      `opportunity-map metals read #2 served from cache in <${FAST_MS}ms (got ${opp2.ms.toFixed(1)}ms; #1 was ${opp1.ms.toFixed(1)}ms)`,
    );

    // A DIFFERENT universe is a DIFFERENT cache key → its own fresh scan + stamp.
    const oppSynth = await timedGet(OPP_SYNTH_URL, cookieA);
    assert(oppSynth.status === 200, `opportunity-map synthetic read → 200 (got ${oppSynth.status})`);
    const oppGenSynth = typeof oppSynth.body["generatedAt"] === "string" ? (oppSynth.body["generatedAt"] as string) : null;
    assert(
      oppGenSynth !== null && oppGenSynth !== oppGen1,
      `distinct universe → distinct cache entry (metals=${String(oppGen1)} synthetic=${String(oppGenSynth)})`,
    );

    // The metals entry is untouched by the synthetic read (keys never collide).
    const opp3 = await timedGet(OPP_METALS_URL, cookieA);
    assert(
      typeof opp3.body["generatedAt"] === "string" && opp3.body["generatedAt"] === oppGen1,
      `metals entry intact after a different-universe read (got ${String(opp3.body["generatedAt"])})`,
    );

    // A SECOND user is served the SAME cached core (shared by design — the
    // inverse of the per-user isolation asserted in (3)).
    const oppB = await timedGet(OPP_METALS_URL, cookieB);
    assert(oppB.status === 200, `opportunity-map metals read (user B) → 200 (got ${oppB.status})`);
    assert(
      typeof oppB.body["generatedAt"] === "string" && oppB.body["generatedAt"] === oppGen1,
      `CROSS-USER SHARED: user B gets the SAME cached core as user A (A=${String(oppGen1)} B=${String(oppB.body["generatedAt"])})`,
    );
    assert(
      oppB.ms < FAST_MS,
      `opportunity-map user B read served from shared cache in <${FAST_MS}ms (got ${oppB.ms.toFixed(1)}ms)`,
    );
  } finally {
    await cleanup();
  }

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "meCachedReadEndToEndTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    async (r) => {
      await closeSharedServer().catch(() => {});
      process.exit(r.failures > 0 ? 1 : 0);
    },
    async (err) => {
      await cleanup().catch(() => {});
      await closeSharedServer().catch(() => {});
      // eslint-disable-next-line no-console
      console.error("[meCachedReadEndToEndTest] FAILED:", err);
      process.exit(1);
    },
  );
}
