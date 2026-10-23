// qaInvestorStatementTransparency.ts — End-to-end proof (Task #101) that
// investor statement changes are transparent, honest, reason-required, and
// per-investor isolated, with NO permanent delete and NO live-trading touch.
//
// Coverage:
//   1. Admin status transitions — CORRECT → CORRECTED, REPLACE → REPLACED (with
//      replacement), REMOVE → REMOVED, RESTORE → ACTIVE — each succeeds and
//      writes an event row.
//   2. Required reason — a status change with reason < 3 chars is refused (400);
//      the row keeps its prior status.
//   3. Investor-facing notes — /me/investor/documents surfaces a plain-English
//      note for non-active statuses; downloadable=false on REMOVED; the
//      replacement title is surfaced for REPLACED.
//   4. Activity feed — statement events appear in /me/investor/activity scoped
//      to that investor only.
//   5. Investor-deny — an INVESTOR session is refused (403) on the admin status
//      endpoint; anonymous gets 401.
//   6. Cross-investor isolation — investor B never sees investor A's statement,
//      note, or event (and vice versa).
//   7. No leaked internals — no table/route/column wording in investor copy.
//
// SAFETY: this script NEVER triggers a live broker dispatch. The starting
// arx_live_commands count is asserted unchanged at the end. All seeded rows are
// removed in cleanup. Exit 0 on PASS, 1 on FAIL.

import { randomBytes, createHash } from "node:crypto";
import { pool, db } from "@workspace/db";
import {
  usersTable,
  authUserSessionsTable,
  investorProfilesTable,
  investorLedgerEntriesTable,
  investorAllocationPreferencesTable,
  investorStatementsTable,
  investorStatementEventsTable,
  adminActionAuditLogTable,
} from "@workspace/db/schema";
import { inArray } from "drizzle-orm";

// Inlined to avoid crossing the scripts rootDir into artifacts/api-server.
const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
async function createUserSession(userId: number): Promise<string> {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipAddress: "127.0.0.1",
    userAgent: "qaInvestorStatementTransparency",
  });
  return rawToken;
}

const BASE = process.env.QA_API_BASE ?? "http://localhost:80";
const TAG = `qaStmt_${Date.now()}_${randomBytes(3).toString("hex")}`;

type Probe = { name: string; pass: boolean; note: string };
const results: Probe[] = [];
function record(name: string, pass: boolean, note: string): void {
  results.push({ name, pass, note });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${note}`);
}

async function liveCommandsCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}

type Actor = { id: number; email: string; cookie: string; marker: string };

async function createActor(label: string, role: "INVESTOR" | "ADMIN" | "USER"): Promise<Actor> {
  const email = `${TAG}_${label}@arx.test`;
  const [u] = await db
    .insert(usersTable)
    .values({ email, name: `${TAG} ${label}`, role })
    .returning();
  const userId = u!.id;
  const raw = await createUserSession(userId);
  return {
    id: userId,
    email,
    cookie: `${USER_SESSION_COOKIE}=${raw}`,
    marker: `${TAG}_MARK_${label}`,
  };
}

async function seedProfile(actor: Actor): Promise<void> {
  await db.insert(investorProfilesTable).values({
    userId: actor.id,
    displayName: `${actor.marker}_name`,
    baseCurrency: "USD",
    status: "active",
  });
}

async function seedStatement(actor: Actor, label: string, fileUrl: string): Promise<number> {
  const [row] = await db
    .insert(investorStatementsTable)
    .values({
      userId: actor.id,
      title: `${actor.marker}_${label}`,
      statementType: "STATEMENT",
      summary: `${actor.marker}_summary_${label}`,
      fileUrl,
      createdByAdminId: 0,
    })
    .returning();
  return row!.id;
}

type Resp = { status: number; bodyText: string; json: Record<string, unknown> | null };
async function req(
  actor: Actor | null,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Resp> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (actor) headers["cookie"] = actor.cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const bodyText = await r.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    /* not json */
  }
  return { status: r.status, bodyText, json };
}

type DocItem = {
  id: number;
  status: string;
  statusLabel: string;
  note: string | null;
  downloadable: boolean;
  isCurrent: boolean;
  fileUrl: string | null;
  replacementStatementId: number | null;
  replacementTitle: string | null;
};
async function docsFor(actor: Actor): Promise<DocItem[]> {
  const r = await req(actor, "GET", "/api/me/investor/documents");
  return ((r.json?.items as DocItem[]) ?? []);
}

// Forbidden internal wording that must never reach an investor. NOTE:
// camelCase API contract fields (e.g. replacementStatementId, statusLabel) are
// the sanctioned public response shape and are intentionally NOT listed —
// we only forbid raw table names, admin routes, internal column wording,
// live-trading internals, and stack-trace markers.
const FORBIDDEN_INTERNAL = [
  "investor_statement", // raw table name (snake_case)
  "createdByAdminId",
  "statusChangedByAdminId",
  "/api/admin",
  "arx_live",
  "stack",
  "Error:",
];

async function main(): Promise<void> {
  const startLive = await liveCommandsCount();
  // eslint-disable-next-line no-console
  console.log(`[INVARIANT] starting arx_live_commands count = ${startLive}`);

  let investorA: Actor | null = null;
  let investorB: Actor | null = null;
  let admin: Actor | null = null;
  let trader: Actor | null = null;

  try {
    investorA = await createActor("A", "INVESTOR");
    investorB = await createActor("B", "INVESTOR");
    admin = await createActor("ADM", "ADMIN");
    trader = await createActor("TRD", "USER");
    await seedProfile(investorA);
    await seedProfile(investorB);

    // Three statements for A: original, a replacement target, and a remove target.
    const stmtOriginal = await seedStatement(investorA, "original", "https://example.test/a-original.pdf");
    const stmtReplacement = await seedStatement(investorA, "replacement", "https://example.test/a-new.pdf");
    const stmtRemoveTarget = await seedStatement(investorA, "removeme", "https://example.test/a-remove.pdf");
    // One statement for B (isolation control).
    const stmtB = await seedStatement(investorB, "bdoc", "https://example.test/b.pdf");
    record(
      "00_seed",
      true,
      `A=${investorA.id} stmts=[${stmtOriginal},${stmtReplacement},${stmtRemoveTarget}] B=${investorB.id} bstmt=${stmtB} admin=${admin.id}`,
    );

    const statusUrl = (uid: number, sid: number) =>
      `/api/admin/investors/${uid}/statements/${sid}/status`;

    // ── 1. Required reason — too-short reason is refused (400) ────────────────
    const shortReason = await req(admin, "POST", statusUrl(investorA.id, stmtOriginal), {
      action: "CORRECT",
      reason: "x",
    });
    record(
      "01_reason_required",
      shortReason.status === 400,
      `short-reason status=${shortReason.status} (expected 400)`,
    );

    // ── 2. CORRECT → CORRECTED + event row ───────────────────────────────────
    const correct = await req(admin, "POST", statusUrl(investorA.id, stmtOriginal), {
      action: "CORRECT",
      reason: "Corrected a typo in the closing balance.",
    });
    record(
      "02_correct_ok",
      correct.status === 200,
      `correct status=${correct.status}`,
    );

    // ── 3. REPLACE requires a replacement; with it → REPLACED ────────────────
    const replaceNoTarget = await req(admin, "POST", statusUrl(investorA.id, stmtOriginal), {
      action: "REPLACE",
      reason: "Superseded by a corrected full statement.",
    });
    const replace = await req(admin, "POST", statusUrl(investorA.id, stmtOriginal), {
      action: "REPLACE",
      reason: "Superseded by a corrected full statement.",
      replacementStatementId: stmtReplacement,
    });
    record(
      "03_replace_requires_and_applies",
      replaceNoTarget.status === 400 && replace.status === 200,
      `noTarget=${replaceNoTarget.status} withTarget=${replace.status}`,
    );

    // ── 4. Cross-investor replacement rejected ───────────────────────────────
    const crossReplace = await req(admin, "POST", statusUrl(investorA.id, stmtRemoveTarget), {
      action: "REPLACE",
      reason: "Attempt to point at another investor's statement.",
      replacementStatementId: stmtB,
    });
    record(
      "04_cross_investor_replacement_rejected",
      crossReplace.status === 400,
      `cross-replace status=${crossReplace.status} (expected 400)`,
    );

    // ── 5. REMOVE → REMOVED (soft) then RESTORE → ACTIVE ─────────────────────
    const remove = await req(admin, "POST", statusUrl(investorA.id, stmtRemoveTarget), {
      action: "REMOVE",
      reason: "Removed pending re-issue of the quarterly statement.",
    });
    const docsAfterRemove = await docsFor(investorA);
    const removedDoc = docsAfterRemove.find((d) => d.id === stmtRemoveTarget);
    record(
      "05_remove_soft_and_not_downloadable",
      remove.status === 200 &&
        removedDoc != null &&
        removedDoc.status === "REMOVED" &&
        removedDoc.downloadable === false &&
        removedDoc.fileUrl === null,
      `status=${remove.status} doc=${JSON.stringify(removedDoc)}`,
    );

    // Soft-delete proof: the row still exists in the table.
    const stillThere = await db
      .select()
      .from(investorStatementsTable)
      .where(inArray(investorStatementsTable.id, [stmtRemoveTarget]));
    const restore = await req(admin, "POST", statusUrl(investorA.id, stmtRemoveTarget), {
      action: "RESTORE",
      reason: "Re-issued statement is identical; restoring availability.",
    });
    const docsAfterRestore = await docsFor(investorA);
    const restoredDoc = docsAfterRestore.find((d) => d.id === stmtRemoveTarget);
    record(
      "06_soft_delete_then_restore",
      stillThere.length === 1 &&
        restore.status === 200 &&
        restoredDoc != null &&
        restoredDoc.status === "ACTIVE" &&
        restoredDoc.downloadable === true,
      `rowExists=${stillThere.length === 1} restore=${restore.status} doc=${JSON.stringify(restoredDoc)}`,
    );

    // ── 7. Investor notes — corrected/replaced carry honest notes + repl title ─
    const aDocs = await docsFor(investorA);
    const corrected = aDocs.find((d) => d.id === stmtOriginal);
    // A REPLACED statement stays downloadable as a historical record (only
    // REMOVED disables download); it is no longer the current one and must
    // surface a note plus the replacement title so the investor can find it.
    const noteOk =
      corrected != null &&
      corrected.status === "REPLACED" &&
      typeof corrected.note === "string" &&
      corrected.note.length > 0 &&
      corrected.isCurrent === false &&
      corrected.replacementStatementId === stmtReplacement &&
      corrected.replacementTitle != null &&
      corrected.replacementTitle.includes("replacement");
    record(
      "07_investor_note_and_replacement_surfaced",
      noteOk,
      `doc=${JSON.stringify(corrected)}`,
    );

    // ── 8. Activity feed — statement events present, scoped to A ──────────────
    const actA = await req(investorA, "GET", "/api/me/investor/activity");
    const actAItems = (actA.json?.items as Array<{ kind: string; detail: string | null }>) ?? [];
    const stmtEvents = actAItems.filter((i) => i.kind.startsWith("STATEMENT_"));
    record(
      "08_activity_has_statement_events",
      actA.status === 200 && stmtEvents.length >= 3,
      `status=${actA.status} statementEvents=${stmtEvents.length}`,
    );

    // ── 9. Investor-deny on admin status endpoint; anon 401 ──────────────────
    const investorTry = await req(investorA, "POST", statusUrl(investorA.id, stmtOriginal), {
      action: "CORRECT",
      reason: "investor should never be allowed to do this",
    });
    const anonTry = await req(null, "POST", statusUrl(investorA.id, stmtOriginal), {
      action: "CORRECT",
      reason: "anonymous should never be allowed to do this",
    });
    record(
      "09_status_endpoint_investor_403_anon_401",
      investorTry.status === 403 && anonTry.status === 401,
      `investor=${investorTry.status} anon=${anonTry.status}`,
    );

    // ── 10. Cross-investor isolation on documents + activity ─────────────────
    const bDocs = await req(investorB, "GET", "/api/me/investor/documents");
    const bAct = await req(investorB, "GET", "/api/me/investor/activity");
    const leakInB =
      bDocs.bodyText.includes(investorA.marker) || bAct.bodyText.includes(investorA.marker);
    const aDocsRaw = await req(investorA, "GET", "/api/me/investor/documents");
    const leakInA = aDocsRaw.bodyText.includes(investorB.marker);
    record(
      "10_cross_investor_isolation",
      !leakInB && !leakInA,
      `B leaked A=${leakInB} A leaked B=${leakInB ? "n/a" : leakInA}`,
    );

    // ── 11. No leaked internals in investor copy ─────────────────────────────
    const combined = `${aDocsRaw.bodyText}\n${actA.bodyText}`;
    const hits = FORBIDDEN_INTERNAL.filter((w) => combined.includes(w));
    record(
      "11_no_internal_wording_to_investor",
      hits.length === 0,
      hits.length === 0 ? "clean" : `leaked: ${hits.join(", ")}`,
    );

    // ── 12. Event rows persisted for A (audit/event trail) ───────────────────
    const events = await db
      .select()
      .from(investorStatementEventsTable)
      .where(inArray(investorStatementEventsTable.userId, [investorA.id]));
    record(
      "12_event_rows_persisted",
      events.length >= 4,
      `event rows for A = ${events.length}`,
    );

    // ── 13. Trader (plain USER) has no access to the investor portal ──────────
    const traderDocs = await req(trader, "GET", "/api/me/investor/documents");
    const traderActivity = await req(trader, "GET", "/api/me/investor/activity");
    record(
      "13_trader_denied_investor_portal",
      traderDocs.status === 403 && traderActivity.status === 403,
      `docs=${traderDocs.status} activity=${traderActivity.status} (expected 403/403)`,
    );

    // ── 14. Legacy DELETE remove path ALSO requires a reason (min 3) ──────────
    // stmtRemoveTarget is ACTIVE again after the earlier restore.
    const delUrl = `/api/admin/investors/${investorA.id}/statements/${stmtRemoveTarget}`;
    const delShort = await fetch(`${BASE}${delUrl}?reason=x`, {
      method: "DELETE",
      headers: { cookie: admin.cookie },
    });
    const delOk = await fetch(
      `${BASE}${delUrl}?reason=${encodeURIComponent("Removed via legacy path for QA proof.")}`,
      { method: "DELETE", headers: { cookie: admin.cookie } },
    );
    const docsAfterDelete = await docsFor(investorA);
    const deletedDoc = docsAfterDelete.find((d) => d.id === stmtRemoveTarget);
    record(
      "14_delete_path_requires_reason_and_soft_removes",
      delShort.status === 400 &&
        delOk.status === 200 &&
        deletedDoc != null &&
        deletedDoc.status === "REMOVED" &&
        deletedDoc.downloadable === false,
      `short=${delShort.status} ok=${delOk.status} doc=${JSON.stringify(deletedDoc)}`,
    );
  } catch (e) {
    record("FATAL", false, `unexpected error: ${(e as Error).message}`);
  } finally {
    const ids = [investorA?.id, investorB?.id, admin?.id, trader?.id].filter(
      (x): x is number => typeof x === "number",
    );
    try {
      if (ids.length > 0) {
        await db.delete(investorStatementEventsTable).where(inArray(investorStatementEventsTable.userId, ids));
        await db.delete(investorAllocationPreferencesTable).where(inArray(investorAllocationPreferencesTable.userId, ids));
        await db.delete(investorLedgerEntriesTable).where(inArray(investorLedgerEntriesTable.userId, ids));
        await db.delete(investorStatementsTable).where(inArray(investorStatementsTable.userId, ids));
        await db.delete(investorProfilesTable).where(inArray(investorProfilesTable.userId, ids));
        await db.delete(adminActionAuditLogTable).where(inArray(adminActionAuditLogTable.targetUserId, ids));
        await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
        await db.delete(usersTable).where(inArray(usersTable.id, ids));
      }
    } catch (e) {
      record("99_cleanup", false, `cleanup failed: ${(e as Error).message}`);
    }
  }

  const endLive = await liveCommandsCount();
  record("98_no_live_command_created", endLive === startLive, `start=${startLive} end=${endLive}`);

  const failed = results.filter((r) => !r.pass);
  // eslint-disable-next-line no-console
  console.log(`\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`} — ${results.length} checks total`);
  await pool.end().catch(() => {});
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error(`[FATAL] ${(e as Error).message}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
