// Ruby Quality — Outcome Learning & Admin Quality (Task #199) — DB + in-process
// route test. Boots the REAL Express app in-process and exercises the live DB.
//
// Honesty / safety contracts verified here:
//   1. STORAGE: recordSignalOnAppear persists a locked PENDING outcome row.
//   2. FAIL-CLOSED: resolveOutcomeRow on a fresh row with NO trade and NO
//      observable move leaves it PENDING — elapsed time alone never grades.
//   3. RESOLVED STORAGE + SELF-REVIEW: a row carrying real evidence (closed-
//      trade verdict + actual slippage) generates exactly one self-review whose
//      userSummary leaks no internal enum token.
//   4. ADMIN-ONLY: every /api/admin/ruby-quality/* endpoint is 401 for anon and
//      403 for a regular USER, with no metrics/threshold data leaked; a real
//      ADMIN gets 200 with the documented shape (proves correct path mount).
//   5. NO LEAK: the user /me/ruby-quality/reviews endpoint returns the plain
//      userSummary but NEVER the admin-only adminDetail blob.
//   6. NO LIVE SIDE EFFECTS: the whole record→resolve→review cycle creates zero
//      rows in arx_live_commands or mt5_commands.
//
// Run: pnpm --filter @workspace/scripts run test:ruby-quality-route-db

import { randomBytes, createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { pool, db } from "@workspace/db";
import {
  usersTable,
  authUserSessionsTable,
  rubySignalOutcomesTable,
  rubySignalReviewsTable,
  tradesTable,
  adminActionAuditLogTable,
} from "@workspace/db/schema";
import {
  recordSignalOnAppear,
  resolveOutcomeRow,
  generateSelfReview,
} from "../../artifacts/api-server/src/lib/rubyQuality/index.js";
import { getSharedBaseUrl, isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TAG = `qaRubyQuality_${Date.now()}_${randomBytes(3).toString("hex")}`;
const UPPER_SNAKE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

async function createSession(userId: number): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipAddress: "127.0.0.1",
    userAgent: TAG,
  });
  return raw;
}

async function seedUser(role: "ADMIN" | "USER", key: string = role): Promise<{ id: number; cookie: string }> {
  const [u] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}_${key.toLowerCase()}@arx.test`,
      name: `${TAG} ${key}`,
      role,
    })
    .returning();
  const raw = await createSession(u!.id);
  return { id: u!.id, cookie: `${USER_SESSION_COOKIE}=${raw}` };
}

async function countCommands(): Promise<{ live: number; mt5: number }> {
  const live = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  const mt5 = await pool.query("SELECT COUNT(*)::int AS n FROM mt5_commands");
  return { live: live.rows[0]?.n ?? 0, mt5: mt5.rows[0]?.n ?? 0 };
}

async function cleanup(ids: number[]): Promise<void> {
  // Outcome / review rows are user-scoped evidence; remove only this test's
  // users' rows (fail-open so cleanup never throws).
  for (const id of ids) {
    try { await db.delete(rubySignalReviewsTable).where(eq(rubySignalReviewsTable.userId, id)); } catch { /* fail-open */ }
    try { await db.delete(rubySignalOutcomesTable).where(eq(rubySignalOutcomesTable.userId, id)); } catch { /* fail-open */ }
    try { await db.delete(tradesTable).where(eq(tradesTable.userId, id)); } catch { /* fail-open */ }
  }
  // Remove only THIS test's audit rows (reason carries the unique TAG).
  try { await pool.query("DELETE FROM admin_action_audit_log WHERE reason LIKE $1", [`${TAG}%`]); } catch { /* fail-open */ }
  try { await pool.query("DELETE FROM auth_user_sessions WHERE user_agent = $1", [TAG]); } catch { /* fail-open */ }
  if (ids.length > 0) {
    try { await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [ids]); } catch { /* fail-open */ }
  }
}

export async function run(): Promise<CiTestResultLike> {
  const name = "test:ruby-quality-route-db";
  let passes = 0;
  let failures = 0;
  const check = (label: string, cond: boolean) => {
    if (cond) { passes++; console.log(`  PASS  ${label}`); }
    else { failures++; console.error(`  FAIL  ${label}`); }
  };

  const base = await getSharedBaseUrl();
  const seededIds: number[] = [];

  try {
    const user = await seedUser("USER");
    const admin = await seedUser("ADMIN");
    seededIds.push(user.id, admin.id);

    const cmdBefore = await countCommands();

    // 1. STORAGE — record a signal on appear → locked PENDING row.
    const recorded = await recordSignalOnAppear({
      userId: user.id,
      symbol: "EURUSD",
      timeframe: "M5",
      session: "london",
      direction: "BUY",
      decision: "approve",
      confidenceScore: 78,
      edgeScore: 70,
      entryPrice: 1.1000,
      stopLoss: 1.0950,
      takeProfit: 1.1100,
      explanationUsed: true,
      scannerSignalId: `${TAG}_sig1`,
    });
    check("record: outcome stored as PENDING", recorded.outcomeStatus === "PENDING");
    check("record: row is locked at creation", recorded.locked === true);
    check("record: row scoped to the user", recorded.userId === user.id);

    // Idempotency: same scannerSignalId returns the same row, no duplicate.
    const recordedAgain = await recordSignalOnAppear({
      userId: user.id, symbol: "EURUSD", timeframe: "M5", direction: "BUY",
      decision: "approve", scannerSignalId: `${TAG}_sig1`,
    });
    check("record: idempotent on scannerSignalId", recordedAgain.outcomeId === recorded.outcomeId);

    // 2. FAIL-CLOSED — a no-trade/NONE row has no closed trade and no observable
    //    move (entryPrice null short-circuits candle reads → no network), so the
    //    resolver must leave it PENDING. Elapsed time alone never grades.
    const noTradeRow = await recordSignalOnAppear({
      userId: user.id,
      symbol: "EURUSD",
      timeframe: "M5",
      direction: "NONE",
      decision: "no_trade",
      entryPrice: null,
      scannerSignalId: `${TAG}_sig2`,
    });
    const resolved = await resolveOutcomeRow(noTradeRow);
    check("resolve: no-evidence row stays PENDING (fail-closed)", resolved.changed === false && resolved.row.outcomeStatus === "PENDING");

    // 2b. RESOLVER POSITIVE PATH (real evidence, NOT a manual status write) ----
    //    Record a fresh signal (entryPrice null → resolver skips the network
    //    candle read) and seed a matching CLOSED_WIN trade. The resolver must
    //    match it, grade WIN from the trade's own geometry, link the tradeId,
    //    and the self-review generator must then produce exactly one review.
    const evRow = await recordSignalOnAppear({
      userId: user.id, symbol: "GBPUSD", timeframe: "M5", direction: "BUY",
      decision: "approve", entryPrice: null, scannerSignalId: `${TAG}_sig3`,
    });
    await db.insert(tradesTable).values({
      userId: user.id, symbol: "GBPUSD", direction: "BUY", lot: 0.1,
      entryPrice: 1.2500, stopLoss: 1.2400, takeProfit: 1.2700,
      strategy: "test", confidence: 70, status: "CLOSED_WIN",
      mode: "DEMO", pnl: 200, pnlStatus: "COMPUTED",
      createdAt: evRow.createdAt, closedAt: new Date(),
    });
    const graded = await resolveOutcomeRow(evRow);
    check("resolve(real): closed-trade evidence grades the row", graded.changed === true);
    check("resolve(real): verdict is WIN from trade geometry", graded.row.outcomeStatus === "WIN");
    check("resolve(real): tradeId linked to the matched trade", graded.row.tradeId != null);
    check("resolve(real): userEntered set true on a real entry", graded.row.userEntered === true);
    const gradedReview = await generateSelfReview(graded.row);
    check("resolve(real): a self-review is generated from the resolved row", gradedReview != null);

    // 3. RESOLVED STORAGE + SELF-REVIEW — append real evidence to the recorded
    //    row (this mirrors what the resolver/execution path persists once a
    //    matched closed trade exists) and assert the self-review is generated.
    const [evidenced] = await db
      .update(rubySignalOutcomesTable)
      .set({
        outcomeStatus: "WIN",
        pnlR: 2.0,
        exitReason: "TP",
        userEntered: true,
        timingClass: "ON_TIME",
        actualSlippage: 0.7,           // actual slippage stored when available
        actualStartDrawdown: 0.4,
        maxFavorableExcursion: 2.3,
        maxAdverseExcursion: 0.5,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(rubySignalOutcomesTable.id, recorded.id))
      .returning();
    check("resolve: WIN verdict persisted", evidenced!.outcomeStatus === "WIN");
    check("resolve: actual slippage stored when available", evidenced!.actualSlippage === 0.7);
    check("resolve: resolvedAt stamped on real evidence", evidenced!.resolvedAt != null);

    const review = await generateSelfReview(evidenced!);
    check("review: a self-review row was created", review != null);
    check("review: review scoped to the user", review?.userId === user.id);
    check("review: userSummary is non-empty", (review?.userSummary ?? "").trim().length > 0);
    check("review: userSummary leaks no internal enum token", !UPPER_SNAKE.test(review?.userSummary ?? ""));
    check("review: adminDetail retained in DB (admin-only)", review?.adminDetail != null);

    // Idempotent: a second call returns the same review, no duplicate.
    const reviewAgain = await generateSelfReview(evidenced!);
    check("review: idempotent on outcomeId", reviewAgain?.reviewId === review?.reviewId);

    // PENDING/UNRESOLVED rows never get a review.
    const noReview = await generateSelfReview(noTradeRow);
    check("review: PENDING row never gets a review", noReview === null);

    // 4. ADMIN-ONLY route isolation -----------------------------------------
    const adminPaths = [
      "/api/admin/ruby-quality/metrics",
      "/api/admin/ruby-quality/missed-opportunities",
      "/api/admin/ruby-quality/thresholds",
      "/api/admin/ruby-quality/investor-summary",
    ];
    for (const p of adminPaths) {
      const r = await fetch(`${base}${p}`, { redirect: "manual" });
      check(`anon GET ${p} → 401`, r.status === 401);
      const text = await r.text();
      check(`anon GET ${p} → no metrics/threshold leak`, !text.includes('"metrics"') && !text.includes('"thresholds"') && !text.includes('"summary"'));
    }
    for (const p of adminPaths) {
      const r = await fetch(`${base}${p}`, { headers: { cookie: user.cookie }, redirect: "manual" });
      check(`USER GET ${p} → 403`, r.status === 403);
      const text = await r.text();
      check(`USER GET ${p} → no admin data leak`, !text.includes('"metrics"') && !text.includes('"thresholds"') && !text.includes('"summary"'));
    }

    // ADMIN positive paths prove the routes are mounted at the documented paths.
    {
      const r = await fetch(`${base}/api/admin/ruby-quality/metrics?symbol=EURUSD`, { headers: { cookie: admin.cookie }, redirect: "manual" });
      check("ADMIN GET metrics → 200", r.status === 200);
      const body = (await r.json().catch(() => null)) as { metrics?: { totals?: unknown } } | null;
      check("ADMIN GET metrics → carries a metrics.totals object", body?.metrics?.totals != null);
    }
    {
      const r = await fetch(`${base}/api/admin/ruby-quality/thresholds`, { headers: { cookie: admin.cookie }, redirect: "manual" });
      check("ADMIN GET thresholds → 200", r.status === 200);
      const body = (await r.json().catch(() => null)) as { thresholds?: unknown; defaults?: unknown } | null;
      check("ADMIN GET thresholds → carries thresholds + defaults", body?.thresholds != null && body?.defaults != null);
    }
    {
      // Audited POST requires a reason (≥3 chars); a missing reason → 400.
      const bad = await fetch(`${base}/api/admin/ruby-quality/thresholds`, {
        method: "POST",
        headers: { cookie: admin.cookie, "content-type": "application/json" },
        body: JSON.stringify({ thresholds: { minConfidence: 60 } }),
        redirect: "manual",
      });
      check("ADMIN POST thresholds without reason → 400", bad.status === 400);

      const ok = await fetch(`${base}/api/admin/ruby-quality/thresholds`, {
        method: "POST",
        headers: { cookie: admin.cookie, "content-type": "application/json" },
        body: JSON.stringify({ reason: `${TAG} tuning`, thresholds: { minConfidence: 61 } }),
        redirect: "manual",
      });
      check("ADMIN POST thresholds with reason → 200 (audited)", ok.status === 200);
      const body = (await ok.json().catch(() => null)) as { thresholds?: { minConfidence?: number } } | null;
      check("ADMIN POST thresholds → returns updated value", body?.thresholds?.minConfidence === 61);

      // The audited mutation must have written a fail-closed audit row carrying
      // the admin id, the action, and the exact reason.
      const auditRows = await db.select().from(adminActionAuditLogTable)
        .where(eq(adminActionAuditLogTable.action, "RUBY_QUALITY_THRESHOLDS_UPDATE"));
      const auditRow = auditRows.find((a) => a.reason === `${TAG} tuning`);
      check("ADMIN POST thresholds → wrote an admin_action_audit_log row", auditRow != null);
      check("ADMIN POST thresholds → audit row carries the admin id", auditRow?.adminId === admin.id);
    }

    // 5. NO LEAK — the user reviews endpoint returns userSummary, never adminDetail.
    {
      const r = await fetch(`${base}/api/me/ruby-quality/reviews`, { headers: { cookie: user.cookie }, redirect: "manual" });
      check("USER GET reviews → 200", r.status === 200);
      const text = await r.text();
      check("USER GET reviews → contains userSummary", text.includes('"userSummary"'));
      check("USER GET reviews → never leaks adminDetail", !text.includes('"adminDetail"'));
      const body = JSON.parse(text) as { reviews?: { outcomeId?: string }[] };
      check("USER GET reviews → includes the resolved review", (body.reviews ?? []).some((x) => x.outcomeId === recorded.outcomeId));
    }
    {
      const r = await fetch(`${base}/api/me/ruby-quality/outcomes`, { headers: { cookie: user.cookie }, redirect: "manual" });
      check("USER GET outcomes → 200", r.status === 200);
      const body = (await r.json().catch(() => null)) as { outcomes?: { outcomeId?: string }[] } | null;
      check("USER GET outcomes → includes the recorded outcome", (body?.outcomes ?? []).some((x) => x.outcomeId === recorded.outcomeId));
    }

    // 5b. PER-USER ISOLATION — a second user's outcome + review must NEVER appear
    //     in the first user's /me endpoints, and vice-versa.
    const userB = await seedUser("USER", "USERB");
    seededIds.push(userB.id);
    const bOutcome = await recordSignalOnAppear({
      userId: userB.id, symbol: "USDJPY", timeframe: "M5", direction: "SELL",
      decision: "approve", entryPrice: 150.0, stopLoss: 150.5, takeProfit: 149.0,
      scannerSignalId: `${TAG}_sigB`,
    });
    const [bEvidenced] = await db
      .update(rubySignalOutcomesTable)
      .set({ outcomeStatus: "LOSS", pnlR: -1, exitReason: "SL", userEntered: true, resolvedAt: new Date() })
      .where(eq(rubySignalOutcomesTable.id, bOutcome.id))
      .returning();
    await generateSelfReview(bEvidenced!);
    {
      const r = await fetch(`${base}/api/me/ruby-quality/outcomes`, { headers: { cookie: user.cookie }, redirect: "manual" });
      const body = (await r.json().catch(() => null)) as { outcomes?: { outcomeId?: string }[] } | null;
      check("isolation: user A outcomes exclude user B's outcome", !(body?.outcomes ?? []).some((x) => x.outcomeId === bOutcome.outcomeId));
    }
    {
      const r = await fetch(`${base}/api/me/ruby-quality/reviews`, { headers: { cookie: user.cookie }, redirect: "manual" });
      const body = (await r.json().catch(() => null)) as { reviews?: { outcomeId?: string }[] } | null;
      check("isolation: user A reviews exclude user B's review", !(body?.reviews ?? []).some((x) => x.outcomeId === bOutcome.outcomeId));
    }
    {
      const r = await fetch(`${base}/api/me/ruby-quality/outcomes`, { headers: { cookie: userB.cookie }, redirect: "manual" });
      const body = (await r.json().catch(() => null)) as { outcomes?: { outcomeId?: string }[] } | null;
      check("isolation: user B outcomes exclude user A's outcome", !(body?.outcomes ?? []).some((x) => x.outcomeId === recorded.outcomeId));
      check("isolation: user B sees only its own outcome", (body?.outcomes ?? []).some((x) => x.outcomeId === bOutcome.outcomeId));
    }

    // 6. NO LIVE SIDE EFFECTS — the whole cycle created no live/mt5 command rows.
    const cmdAfter = await countCommands();
    check("no live side effects: arx_live_commands unchanged", cmdAfter.live === cmdBefore.live);
    check("no live side effects: mt5_commands unchanged", cmdAfter.mt5 === cmdBefore.mt5);
  } finally {
    await cleanup(seededIds);
  }

  console.log(`\n${name}: ${passes} passed, ${failures} failed`);
  return { name, passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run()
    .then(async (res) => {
      const { closeSharedServer } = await import("./ci/inProcessAppHarness.js");
      await closeSharedServer().catch(() => {});
      process.exit(res.failures > 0 ? 1 : 0);
    })
    .catch(async (err) => {
      const { closeSharedServer } = await import("./ci/inProcessAppHarness.js");
      await closeSharedServer().catch(() => {});
      console.error("[rubyQualityRouteDbTest] FAILED:", err);
      process.exit(1);
    });
}
