// investorStatementFileCleanupTest.ts — Automated proof (Task #126) that the
// admin statement-edit endpoint cleans up orphaned uploaded files, and that the
// statement-remove endpoint does NOT (so a later restore still has its file).
//
//   PATCH  /api/admin/investors/:id/statements/:statementId  (edit)
//   DELETE /api/admin/investors/:id/statements/:statementId  (soft remove)
//
// Task #104 added best-effort cleanup of orphaned investor-statement files when
// an admin edits a statement to point at a different file/link. Without a guard,
// a future refactor could silently reintroduce the storage leak (orphaned
// "/objects/..." objects left behind) or — worse — start deleting files on a
// reversible soft-remove, breaking restore.
//
// IT PROVES (all against the REAL Express app in-process, with REAL object
// storage):
//   1. Editing a statement to point at a DIFFERENT uploaded file deletes the
//      previously uploaded "/objects/..." object, and the NEW object survives.
//   2. Editing a statement to point at an external link deletes the previously
//      uploaded object (it is now orphaned).
//   3. No-op: an edit that leaves the fileUrl UNCHANGED never deletes the object.
//   4. No-op: when the OLD fileUrl is an external link there is no object to
//      delete — the edit succeeds and never throws.
//   5. No-op: when the OLD object was already deleted from storage, the edit
//      still succeeds and never throws (missing object treated as success).
//   6. Soft-removing a statement does NOT delete its file (the row still
//      references it and a later restore must work).
//   7. (Task #127) A PUBLISH rejected by file validation (wrong type/size)
//      deletes the freshly uploaded "/objects/..." object — the presigned PUT
//      stores it before validation runs, so a rejection would otherwise leak it.
//   8. (Task #127) An EDIT rejected by file validation deletes the freshly
//      uploaded REPLACEMENT object while the statement's ORIGINAL file survives.
//
// SAFETY / ISOLATION:
//   - Seeds isolated users (fixed TAG) and operates ONLY on their rows.
//   - Every object it uploads is tracked and force-deleted at the end, even on
//     failure (no leaked storage from the test itself).
//   - Idempotent cleanup of every seeded DB row at the end, even on failure.
//   - Never places a trade / touches any execution / live / bridge surface; the
//     starting arx_live_commands count is asserted unchanged at the end.
//   - CI-safe: spins up the REAL Express app in-process on an ephemeral port (no
//     externally-running server required). Set ARX_QA_BASE_URL to probe an
//     already-running server instead. Requires DATABASE_URL and object storage
//     env (PRIVATE_OBJECT_DIR / PUBLIC_OBJECT_SEARCH_PATHS).
//
// Run: pnpm --filter @workspace/scripts run test:investor-statement-file-cleanup

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
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
import { ObjectNotFoundError } from "../../artifacts/api-server/src/lib/objectStorage.js";
import { objectStorageService } from "../../artifacts/api-server/src/lib/investor/statementFiles.js";

const EXTERNAL_BASE = process.env["ARX_QA_BASE_URL"];
const TAG = `qaStmtFile_${Date.now()}_${randomBytes(3).toString("hex")}`;

const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 60 * 60 * 1000;

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

type Actor = { id: number; email: string; cookie: string };

async function createActor(label: string, role: "INVESTOR" | "ADMIN" | "USER"): Promise<Actor> {
  const email = `${TAG}_${label}@arx.test`;
  const [u] = await db
    .insert(usersTable)
    .values({ email, name: `${TAG} ${label}`, role })
    .returning();
  const userId = u!.id;
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return { id: userId, email, cookie: `${USER_SESSION_COOKIE}=${rawToken}` };
}

async function seedProfile(actor: Actor): Promise<void> {
  await db.insert(investorProfilesTable).values({
    userId: actor.id,
    displayName: `${TAG}_name`,
    baseCurrency: "USD",
    status: "active",
  });
}

async function seedStatement(
  ownerId: number,
  adminId: number,
  label: string,
  fileUrl: string,
): Promise<number> {
  const [row] = await db
    .insert(investorStatementsTable)
    .values({
      userId: ownerId,
      title: `${TAG}_${label}`,
      statementType: "STATEMENT",
      summary: `${TAG}_summary_${label}`,
      fileUrl,
      createdByAdminId: adminId,
    })
    .returning();
  return row!.id;
}

type Resp = { status: number; bodyText: string };
function makeReq(baseUrl: string) {
  return async function req(
    cookie: string | null,
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<Resp> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (cookie) headers["cookie"] = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, bodyText: await r.text() };
  };
}

async function getStatement(id: number) {
  const rows = await db
    .select()
    .from(investorStatementsTable)
    .where(inArray(investorStatementsTable.id, [id]));
  return rows[0] ?? null;
}

async function liveCommandsCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}

// ── Real object-storage helpers ─────────────────────────────────────────────
const uploadedObjects: string[] = [];

/** Upload a tiny valid PDF object and return its "/objects/..." fileUrl. */
async function uploadTestObject(): Promise<string> {
  const uploadURL = await objectStorageService.getObjectEntityUploadURL();
  const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
  const body = Buffer.from(`%PDF-1.4\n${TAG} statement-file test object\n%%EOF\n`);
  const put = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body,
  });
  if (!put.ok) {
    throw new Error(`test object upload failed: HTTP ${put.status}`);
  }
  uploadedObjects.push(objectPath);
  return objectPath;
}

/**
 * Upload an object with a content type the statement validator REJECTS
 * (text/plain is neither PDF nor CSV), returning its "/objects/..." fileUrl.
 * Used to drive the publish/edit rejection-cleanup path: the presigned PUT
 * stores the object before validation runs at publish/edit time.
 */
async function uploadRejectedTypeObject(): Promise<string> {
  const uploadURL = await objectStorageService.getObjectEntityUploadURL();
  const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
  const body = Buffer.from(`${TAG} not a pdf or csv\n`);
  const put = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body,
  });
  if (!put.ok) {
    throw new Error(`rejected-type object upload failed: HTTP ${put.status}`);
  }
  uploadedObjects.push(objectPath);
  return objectPath;
}

/** True if the object still exists in storage; false if ObjectNotFound. */
async function objectExists(fileUrl: string): Promise<boolean> {
  try {
    await objectStorageService.getObjectEntityFile(fileUrl);
    return true;
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return false;
    throw err;
  }
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("investorStatementFileCleanupTest");
  // eslint-disable-next-line no-console
  console.log("================================\n");

  const startLive = await liveCommandsCount();

  // ── Resolve a base URL: in-process ephemeral server unless ARX_QA_BASE_URL. ─
  let server: Server | null = null;
  let baseUrl: string;
  if (EXTERNAL_BASE) {
    baseUrl = EXTERNAL_BASE;
    // eslint-disable-next-line no-console
    console.log(`[setup] probing external server at ${baseUrl}\n`);
  } else {
    const app = (await import("../../artifacts/api-server/src/app.js")).default;
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    // eslint-disable-next-line no-console
    console.log(`[setup] in-process app listening on ${baseUrl}\n`);
  }
  const req = makeReq(baseUrl);

  let investor: Actor | null = null;
  let admin: Actor | null = null;

  try {
    investor = await createActor("A", "INVESTOR");
    admin = await createActor("ADM", "ADMIN");
    await seedProfile(investor);

    const editUrl = (uid: number, sid: number) =>
      `/api/admin/investors/${uid}/statements/${sid}`;

    // ── 1. Edit → different uploaded file: old object deleted, new survives ───
    // eslint-disable-next-line no-console
    console.log("1. Editing to a DIFFERENT uploaded file deletes the old object, keeps the new");
    {
      const oldObj = await uploadTestObject();
      const newObj = await uploadTestObject();
      const stmt = await seedStatement(investor.id, admin.id, "swap", oldObj);
      assert(await objectExists(oldObj), "precondition: old object exists before edit");
      assert(await objectExists(newObj), "precondition: new object exists before edit");

      const res = await req(admin.cookie, "PATCH", editUrl(investor.id, stmt), {
        title: `${TAG}_swap_edited`,
        fileUrl: newObj,
        reason: "Replaced the uploaded statement file.",
      });
      const row = await getStatement(stmt);
      assert(res.status === 200, `edit HTTP 200 (got ${res.status})`);
      assert(row?.fileUrl === newObj, `statement now references the new object`);
      assert((await objectExists(oldObj)) === false, `old (orphaned) object was DELETED`);
      assert((await objectExists(newObj)) === true, `new object still EXISTS`);
    }

    // ── 2. Edit → external link: old uploaded object deleted ─────────────────
    // eslint-disable-next-line no-console
    console.log("\n2. Editing an uploaded file to an external link deletes the old object");
    {
      const oldObj = await uploadTestObject();
      const stmt = await seedStatement(investor.id, admin.id, "tolink", oldObj);
      assert(await objectExists(oldObj), "precondition: old object exists before edit");

      const res = await req(admin.cookie, "PATCH", editUrl(investor.id, stmt), {
        title: `${TAG}_tolink_edited`,
        fileUrl: `https://example.test/${TAG}-external.pdf`,
        reason: "Switched to an external link.",
      });
      const row = await getStatement(stmt);
      assert(res.status === 200, `edit HTTP 200 (got ${res.status})`);
      assert(
        row?.fileUrl === `https://example.test/${TAG}-external.pdf`,
        `statement now references the external link`,
      );
      assert((await objectExists(oldObj)) === false, `old (orphaned) object was DELETED`);
    }

    // ── 3. No-op: unchanged fileUrl never deletes the object ─────────────────
    // eslint-disable-next-line no-console
    console.log("\n3. An edit with UNCHANGED fileUrl never deletes the object");
    {
      const obj = await uploadTestObject();
      const stmt = await seedStatement(investor.id, admin.id, "keep", obj);

      // 3a. Edit with NO fileUrl in the body (left untouched).
      const res1 = await req(admin.cookie, "PATCH", editUrl(investor.id, stmt), {
        title: `${TAG}_keep_edited_1`,
        reason: "Title-only edit, file untouched.",
      });
      assert(res1.status === 200, `title-only edit HTTP 200 (got ${res1.status})`);
      assert((await objectExists(obj)) === true, `object survives a title-only edit`);

      // 3b. Edit passing the SAME fileUrl explicitly.
      const res2 = await req(admin.cookie, "PATCH", editUrl(investor.id, stmt), {
        title: `${TAG}_keep_edited_2`,
        fileUrl: obj,
        reason: "Re-saving the same file.",
      });
      const row = await getStatement(stmt);
      assert(res2.status === 200, `same-file edit HTTP 200 (got ${res2.status})`);
      assert(row?.fileUrl === obj, `statement still references the same object`);
      assert((await objectExists(obj)) === true, `object survives a same-file edit`);
    }

    // ── 4. No-op: external-link OLD fileUrl — nothing to delete, never throws ─
    // eslint-disable-next-line no-console
    console.log("\n4. When the OLD fileUrl is an external link, the edit succeeds (nothing to delete)");
    {
      const stmt = await seedStatement(
        investor.id,
        admin.id,
        "fromlink",
        `https://example.test/${TAG}-old-external.pdf`,
      );
      const newObj = await uploadTestObject();
      const res = await req(admin.cookie, "PATCH", editUrl(investor.id, stmt), {
        title: `${TAG}_fromlink_edited`,
        fileUrl: newObj,
        reason: "External link → uploaded file.",
      });
      const row = await getStatement(stmt);
      assert(res.status === 200, `edit HTTP 200 (got ${res.status})`);
      assert(row?.fileUrl === newObj, `statement now references the uploaded object`);
      assert((await objectExists(newObj)) === true, `new object exists (edit did not fail)`);
    }

    // ── 5. No-op: already-deleted OLD object — edit still succeeds ────────────
    // eslint-disable-next-line no-console
    console.log("\n5. When the OLD object is already gone, the edit still succeeds (never throws)");
    {
      const oldObj = await uploadTestObject();
      const stmt = await seedStatement(investor.id, admin.id, "ghost", oldObj);
      // Delete the object out from under the statement before the edit.
      await objectStorageService.deleteObjectEntity(oldObj);
      assert((await objectExists(oldObj)) === false, "precondition: old object already deleted");

      const newObj = await uploadTestObject();
      const res = await req(admin.cookie, "PATCH", editUrl(investor.id, stmt), {
        title: `${TAG}_ghost_edited`,
        fileUrl: newObj,
        reason: "Old object already deleted; edit must not throw.",
      });
      const row = await getStatement(stmt);
      assert(res.status === 200, `edit HTTP 200 despite missing old object (got ${res.status})`);
      assert(row?.fileUrl === newObj, `statement now references the new object`);
      assert((await objectExists(newObj)) === true, `new object exists (edit completed)`);
    }

    // ── 6. Soft-remove does NOT delete the file (restore must still work) ─────
    // eslint-disable-next-line no-console
    console.log("\n6. Soft-removing a statement does NOT delete its file");
    {
      const obj = await uploadTestObject();
      const stmt = await seedStatement(investor.id, admin.id, "remove", obj);
      assert(await objectExists(obj), "precondition: file exists before remove");

      const res = await req(
        admin.cookie,
        "DELETE",
        `${editUrl(investor.id, stmt)}?reason=${encodeURIComponent("Removed pending re-issue.")}`,
      );
      const row = await getStatement(stmt);
      assert(res.status === 200, `remove HTTP 200 (got ${res.status})`);
      assert(row != null, `statement row still present (soft-delete)`);
      assert(row?.status === "REMOVED", `statement status is REMOVED (got ${row?.status})`);
      assert(row?.fileUrl === obj, `statement still references its file after remove`);
      assert((await objectExists(obj)) === true, `file SURVIVES the soft-remove (restore stays possible)`);
    }

    const publishUrl = (uid: number) => `/api/admin/investors/${uid}/statements`;

    // ── 7. Publish REJECTED by validation deletes the freshly uploaded object ─
    // eslint-disable-next-line no-console
    console.log("\n7. A publish rejected by file validation deletes the orphaned uploaded object");
    {
      const badObj = await uploadRejectedTypeObject();
      assert(await objectExists(badObj), "precondition: rejected-type object exists before publish");

      const res = await req(admin.cookie, "POST", publishUrl(investor.id), {
        title: `${TAG}_publish_reject`,
        fileUrl: badObj,
        reason: "Publishing a non-PDF/CSV file should be rejected and cleaned up.",
      });
      assert(res.status === 400, `publish rejected HTTP 400 (got ${res.status})`);
      assert(
        res.bodyText.includes("UNSUPPORTED_FILE_TYPE"),
        `publish error is UNSUPPORTED_FILE_TYPE`,
      );
      assert((await objectExists(badObj)) === false, `rejected upload was DELETED (no leak)`);
    }

    // ── 8. Edit REJECTED by validation deletes the freshly uploaded object ────
    // eslint-disable-next-line no-console
    console.log("\n8. An edit rejected by file validation deletes the orphaned replacement object");
    {
      const goodObj = await uploadTestObject();
      const stmt = await seedStatement(investor.id, admin.id, "editreject", goodObj);
      const badObj = await uploadRejectedTypeObject();
      assert(await objectExists(badObj), "precondition: rejected-type replacement exists before edit");

      const res = await req(admin.cookie, "PATCH", editUrl(investor.id, stmt), {
        title: `${TAG}_edit_reject`,
        fileUrl: badObj,
        reason: "Replacing with a non-PDF/CSV file should be rejected and cleaned up.",
      });
      const row = await getStatement(stmt);
      assert(res.status === 400, `edit rejected HTTP 400 (got ${res.status})`);
      assert(
        res.bodyText.includes("UNSUPPORTED_FILE_TYPE"),
        `edit error is UNSUPPORTED_FILE_TYPE`,
      );
      assert(row?.fileUrl === goodObj, `statement still references its ORIGINAL object (edit aborted)`);
      assert((await objectExists(badObj)) === false, `rejected replacement was DELETED (no leak)`);
      assert((await objectExists(goodObj)) === true, `original object SURVIVES the rejected edit`);
    }
  } catch (e) {
    assert(false, `unexpected error: ${(e as Error).message}`);
  } finally {
    // Force-delete every object the test uploaded (idempotent / ignore-missing).
    for (const obj of uploadedObjects) {
      await objectStorageService.deleteObjectEntity(obj).catch(() => {});
    }
    const ids = [investor?.id, admin?.id].filter(
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
      assert(false, `cleanup failed: ${(e as Error).message}`);
    }
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  }

  const endLive = await liveCommandsCount();
  assert(endLive === startLive, `no live command created (start=${startLive} end=${endLive})`);

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  await pool.end().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error("[investorStatementFileCleanupTest] FAILED:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
