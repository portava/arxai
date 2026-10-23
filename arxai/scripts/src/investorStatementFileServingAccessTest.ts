// investorStatementFileServingAccessTest.ts — Automated proof of the FULL
// investor-statement file lifecycle: serving, access control, replacement
// cleanup (incl. shared-object protection), soft-remove/restore, external
// links, missing objects, and security (cross-investor, unauthenticated,
// admin-only routes, direct object-URL guessing).
//
// This is the access/serving complement to investorStatementFileCleanupTest.ts
// (which proves orphan cleanup on edit). It runs against the REAL Express app
// in-process with REAL object storage — no mocks.
//
// Routes exercised:
//   GET    /api/me/investor/documents                          (investor list)
//   GET    /api/me/investor/documents/:statementId/file        (investor serve)
//   GET    /api/admin/investors/:id/statements/:sid/file       (admin serve)
//   PATCH  /api/admin/investors/:id/statements/:sid            (edit/replace)
//   DELETE /api/admin/investors/:id/statements/:sid?reason=    (soft remove)
//   POST   /api/admin/investors/:id/statements/:sid/status     (restore)
//
// IT PROVES:
//   1.  Investor can access their OWN statement file (200 + bytes).
//   2.  Investor CANNOT access another investor's file (404, scoped).
//   3.  Unauthenticated access is rejected (401) on investor + admin serve.
//   4.  Admin can access via the approved admin path (200); a non-admin
//       (investor / plain USER) is refused (403) on the admin path.
//   5.  After replace, the investor serve resolves to the NEW file only; the
//       old orphaned object is deleted and no longer serves.
//   6.  External-link statements are NOT routed through internal object serving
//       (investor + admin serve 404; the link is exposed for the UI to open).
//   7.  Soft-remove keeps the object in storage for restore: the investor serve
//       is blocked (404) while REMOVED, the admin serve still works, and after
//       RESTORE the investor serve resolves again to the same valid file.
//   8.  There is NO hard delete (soft-remove is the contract): the row + file
//       survive a DELETE, and the file becomes downloadable again on restore.
//   9.  A missing/already-deleted object returns a clean controlled 404 (never
//       a 500 / crash / raw stack trace / backend path).
//   10. A file shared by a SECOND statement is NOT deleted when one statement
//       is edited away from it (reference-aware cleanup).
//   11. Direct object-URL guessing does not serve: the app exposes no public
//       /objects route — only the guarded, scoped statement serve routes.
//   12. Investor-facing error bodies never leak raw backend paths or stack
//       traces (clean JSON { ok:false, error, message }).
//
// SAFETY / ISOLATION:
//   - Seeds isolated users (fixed TAG) and operates ONLY on their rows.
//   - Every uploaded object is tracked and force-deleted at the end, even on
//     failure (no leaked storage from the test itself).
//   - Idempotent cleanup of every seeded DB row at the end, even on failure.
//   - Never places a trade / touches any execution / live / bridge surface; the
//     starting arx_live_commands count is asserted unchanged at the end.
//   - CI-safe: spins up the REAL Express app in-process on an ephemeral port.
//     Set ARX_QA_BASE_URL to probe an already-running server instead. Requires
//     DATABASE_URL and object storage env (PRIVATE_OBJECT_DIR /
//     PUBLIC_OBJECT_SEARCH_PATHS).
//
// Run: pnpm --filter @workspace/scripts run test:investor-statement-file-serving-access

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
const TAG = `qaStmtServe_${Date.now()}_${randomBytes(3).toString("hex")}`;

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
    displayName: `${TAG}_name_${actor.id}`,
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
    method: "GET" | "POST" | "PATCH" | "DELETE",
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

async function liveCommandsCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}

// ── Real object-storage helpers ─────────────────────────────────────────────
const uploadedObjects: string[] = [];

/** Upload a tiny valid PDF object carrying a distinctive marker; return path. */
async function uploadTestObject(marker: string): Promise<string> {
  const uploadURL = await objectStorageService.getObjectEntityUploadURL();
  const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
  const body = Buffer.from(`%PDF-1.4\n${TAG} statement file MARKER=${marker}\n%%EOF\n`);
  const put = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body,
  });
  if (!put.ok) throw new Error(`test object upload failed: HTTP ${put.status}`);
  uploadedObjects.push(objectPath);
  return objectPath;
}

async function objectExists(fileUrl: string): Promise<boolean> {
  try {
    await objectStorageService.getObjectEntityFile(fileUrl);
    return true;
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return false;
    throw err;
  }
}

/** True when the body looks like a clean JSON error (no stack/backend path). */
function isCleanErrorBody(bodyText: string): boolean {
  if (/\bat\s+\w+.*\(.*:\d+:\d+\)/.test(bodyText)) return false; // stack frame
  if (/\/home\/runner\/|node_modules|\.ts:\d+|\.js:\d+/.test(bodyText)) return false; // path
  try {
    const j = JSON.parse(bodyText) as Record<string, unknown>;
    return j.ok === false && typeof j.error === "string";
  } catch {
    // Non-JSON is only acceptable if it is clearly not a stack/path (e.g. empty).
    return bodyText.trim().length === 0;
  }
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("investorStatementFileServingAccessTest");
  // eslint-disable-next-line no-console
  console.log("======================================\n");

  const startLive = await liveCommandsCount();

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

  let investorA: Actor | null = null;
  let investorB: Actor | null = null;
  let admin: Actor | null = null;
  let plainUser: Actor | null = null;

  try {
    investorA = await createActor("A", "INVESTOR");
    investorB = await createActor("B", "INVESTOR");
    admin = await createActor("ADM", "ADMIN");
    plainUser = await createActor("USR", "USER");
    await seedProfile(investorA);
    await seedProfile(investorB);

    const meFile = (sid: number) => `/api/me/investor/documents/${sid}/file`;
    const adminFile = (uid: number, sid: number) =>
      `/api/admin/investors/${uid}/statements/${sid}/file`;
    const editUrl = (uid: number, sid: number) => `/api/admin/investors/${uid}/statements/${sid}`;
    const statusUrl = (uid: number, sid: number) =>
      `/api/admin/investors/${uid}/statements/${sid}/status`;

    // ── 1. Investor can access their OWN file; B cannot access A's file ────────
    // eslint-disable-next-line no-console
    console.log("1. Investor serves own file; cross-investor access is denied");
    const objA = await uploadTestObject("A_OWN");
    const stmtA = await seedStatement(investorA.id, admin.id, "ownA", objA);
    {
      const own = await req(investorA.cookie, "GET", meFile(stmtA));
      assert(own.status === 200, `A serves own file 200 (got ${own.status})`);
      assert(own.bodyText.includes("MARKER=A_OWN"), "A receives the correct file bytes");

      const cross = await req(investorB.cookie, "GET", meFile(stmtA));
      assert(cross.status === 404, `B blocked from A's file 404 (got ${cross.status})`);
      assert(!cross.bodyText.includes("MARKER=A_OWN"), "B never receives A's bytes");

      // A non-investor USER is denied outright by the investor route's role gate
      // (403); an investor scoped away from the row gets 404. Either is a hard
      // denial — what matters is no foreign bytes are ever served.
      const usr = await req(plainUser!.cookie, "GET", meFile(stmtA));
      assert(usr.status === 403 || usr.status === 404, `plain USER denied A's file (got ${usr.status})`);
      assert(!usr.bodyText.includes("MARKER=A_OWN"), "plain USER never receives A's bytes");
    }

    // ── 2. Unauthenticated access is rejected (401) ───────────────────────────
    // eslint-disable-next-line no-console
    console.log("\n2. Unauthenticated access is rejected");
    {
      const anonMe = await req(null, "GET", meFile(stmtA));
      assert(anonMe.status === 401, `anon investor serve 401 (got ${anonMe.status})`);
      const anonAdmin = await req(null, "GET", adminFile(investorA.id, stmtA));
      assert(anonAdmin.status === 401, `anon admin serve 401 (got ${anonAdmin.status})`);
    }

    // ── 3. Admin path serves; non-admins are refused (403) ────────────────────
    // eslint-disable-next-line no-console
    console.log("\n3. Admin serve works; non-admins refused on the admin path");
    {
      const ok = await req(admin.cookie, "GET", adminFile(investorA.id, stmtA));
      assert(ok.status === 200, `admin serves A's file 200 (got ${ok.status})`);
      assert(ok.bodyText.includes("MARKER=A_OWN"), "admin receives the correct bytes");

      const inv = await req(investorB.cookie, "GET", adminFile(investorA.id, stmtA));
      assert(inv.status === 403, `investor refused on admin path 403 (got ${inv.status})`);
      const usr = await req(plainUser!.cookie, "GET", adminFile(investorA.id, stmtA));
      assert(usr.status === 403, `plain USER refused on admin path 403 (got ${usr.status})`);
    }

    // ── 4. Replace → investor serve resolves to NEW only; old object gone ─────
    // eslint-disable-next-line no-console
    console.log("\n4. After replace, the investor serve returns the NEW file only");
    {
      const oldObj = await uploadTestObject("REPL_OLD");
      const stmt = await seedStatement(investorA.id, admin.id, "repl", oldObj);
      const before = await req(investorA.cookie, "GET", meFile(stmt));
      assert(before.bodyText.includes("MARKER=REPL_OLD"), "precondition: serves old file");

      const newObj = await uploadTestObject("REPL_NEW");
      const edit = await req(admin.cookie, "PATCH", editUrl(investorA.id, stmt), {
        title: `${TAG}_repl_edited`,
        fileUrl: newObj,
        reason: "Replaced the uploaded statement file.",
      });
      assert(edit.status === 200, `replace edit 200 (got ${edit.status})`);

      const after = await req(investorA.cookie, "GET", meFile(stmt));
      assert(after.status === 200 && after.bodyText.includes("MARKER=REPL_NEW"), "serves NEW file");
      assert(!after.bodyText.includes("MARKER=REPL_OLD"), "never serves the OLD file");
      assert((await objectExists(oldObj)) === false, "old orphaned object DELETED");
      assert((await objectExists(newObj)) === true, "new object survives");
    }

    // ── 5. External-link statements are NOT served through object serving ─────
    // eslint-disable-next-line no-console
    console.log("\n5. External-link statements 404 on both internal serve routes");
    {
      const link = `https://example.test/${TAG}-external.pdf`;
      const stmt = await seedStatement(investorA.id, admin.id, "ext", link);
      const me = await req(investorA.cookie, "GET", meFile(stmt));
      assert(me.status === 404, `investor serve 404 for external link (got ${me.status})`);
      const adm = await req(admin.cookie, "GET", adminFile(investorA.id, stmt));
      assert(adm.status === 404, `admin serve 404 for external link (got ${adm.status})`);
      assert(!me.bodyText.includes("example.test"), "internal serve never proxies the external URL");

      // The list exposes the external link so the UI can open it directly.
      const list = await req(investorA.cookie, "GET", "/api/me/investor/documents");
      assert(list.status === 200 && list.bodyText.includes(link), "list exposes the external link for the UI");
    }

    // ── 6. Soft-remove blocks investor serve, keeps file, restore re-enables ──
    // eslint-disable-next-line no-console
    console.log("\n6. Soft-remove blocks investor download but keeps the file for restore");
    {
      const obj = await uploadTestObject("REMOVE_RESTORE");
      const stmt = await seedStatement(investorA.id, admin.id, "rm", obj);
      assert((await req(investorA.cookie, "GET", meFile(stmt))).status === 200, "precondition: serves before remove");

      const rm = await req(
        admin.cookie,
        "DELETE",
        `${editUrl(investorA.id, stmt)}?reason=${encodeURIComponent("Removed pending re-issue.")}`,
      );
      assert(rm.status === 200, `soft-remove 200 (got ${rm.status})`);

      const meRemoved = await req(investorA.cookie, "GET", meFile(stmt));
      assert(meRemoved.status === 404, `investor serve blocked while REMOVED (got ${meRemoved.status})`);
      assert(isCleanErrorBody(meRemoved.bodyText), "removed serve returns a clean error body");
      assert((await objectExists(obj)) === true, "file SURVIVES the soft-remove (restore possible)");
      // Admin retains access to the removed statement's file (needed to verify before restore).
      const admRemoved = await req(admin.cookie, "GET", adminFile(investorA.id, stmt));
      assert(admRemoved.status === 200, `admin still serves removed statement's file (got ${admRemoved.status})`);

      const restore = await req(admin.cookie, "POST", statusUrl(investorA.id, stmt), {
        action: "RESTORE",
        reason: "Restoring the statement.",
      });
      assert(restore.status === 200, `restore 200 (got ${restore.status})`);
      const meRestored = await req(investorA.cookie, "GET", meFile(stmt));
      assert(
        meRestored.status === 200 && meRestored.bodyText.includes("MARKER=REMOVE_RESTORE"),
        "investor serve resolves to the SAME valid file after restore",
      );
    }

    // ── 7. Missing object → clean 404 (never a crash / stack / backend path) ──
    // eslint-disable-next-line no-console
    console.log("\n7. A missing object returns a clean controlled 404");
    {
      const obj = await uploadTestObject("GHOST");
      const stmt = await seedStatement(investorA.id, admin.id, "ghost", obj);
      await objectStorageService.deleteObjectEntity(obj); // delete out from under the row
      assert((await objectExists(obj)) === false, "precondition: object deleted from storage");

      const me = await req(investorA.cookie, "GET", meFile(stmt));
      assert(me.status === 404, `investor serve 404 for missing object (got ${me.status})`);
      assert(isCleanErrorBody(me.bodyText), "missing-object serve body is clean (no stack/path)");
      const adm = await req(admin.cookie, "GET", adminFile(investorA.id, stmt));
      assert(adm.status === 404, `admin serve 404 for missing object (got ${adm.status})`);
      assert(isCleanErrorBody(adm.bodyText), "admin missing-object body is clean");
    }

    // ── 8. Shared file is NOT deleted when one statement is edited away ───────
    // eslint-disable-next-line no-console
    console.log("\n8. A file shared by a second statement survives an edit-away (reference-aware)");
    {
      const shared = await uploadTestObject("SHARED");
      const stmtShareA = await seedStatement(investorA.id, admin.id, "shareA", shared);
      const stmtShareB = await seedStatement(investorB!.id, admin.id, "shareB", shared);

      const newForA = await uploadTestObject("SHARED_NEW_A");
      const edit = await req(admin.cookie, "PATCH", editUrl(investorA.id, stmtShareA), {
        title: `${TAG}_shareA_edited`,
        fileUrl: newForA,
        reason: "Moving statement A to its own file.",
      });
      assert(edit.status === 200, `edit-away of A 200 (got ${edit.status})`);
      assert((await objectExists(shared)) === true, "SHARED object SURVIVES (still referenced by B)");

      const bServe = await req(investorB!.cookie, "GET", meFile(stmtShareB));
      assert(
        bServe.status === 200 && bServe.bodyText.includes("MARKER=SHARED"),
        "B still serves the shared file after A was edited away",
      );
      const aServe = await req(investorA.cookie, "GET", meFile(stmtShareA));
      assert(
        aServe.status === 200 && aServe.bodyText.includes("MARKER=SHARED_NEW_A"),
        "A now serves its own new file",
      );

      // And the inverse: editing B away too leaves NO references → object deleted.
      const newForB = await uploadTestObject("SHARED_NEW_B");
      const edit2 = await req(admin.cookie, "PATCH", editUrl(investorB!.id, stmtShareB), {
        title: `${TAG}_shareB_edited`,
        fileUrl: newForB,
        reason: "Moving statement B to its own file too.",
      });
      assert(edit2.status === 200, `edit-away of B 200 (got ${edit2.status})`);
      assert((await objectExists(shared)) === false, "shared object DELETED once no statement references it");
    }

    // ── 9. Direct object-URL guessing does not serve (no public /objects) ─────
    // eslint-disable-next-line no-console
    console.log("\n9. The app exposes no public /objects route (URL guessing fails)");
    {
      const guessed = `/objects/uploads/${randomBytes(8).toString("hex")}`;
      const anon = await req(null, "GET", guessed);
      assert(anon.status === 404, `anon /objects guess not served (got ${anon.status})`);
      const auth = await req(investorA.cookie, "GET", guessed);
      assert(auth.status === 404, `authed /objects guess not served (got ${auth.status})`);
      assert(!anon.bodyText.includes("MARKER="), "no object bytes ever leak from a guessed path");
    }

    // ── 10. Bad statement id → clean controlled error, never a crash ──────────
    // eslint-disable-next-line no-console
    console.log("\n10. Malformed / unknown statement ids return clean controlled errors");
    {
      const badId = await req(investorA.cookie, "GET", "/api/me/investor/documents/not-a-number/file");
      assert(badId.status === 400, `non-numeric id 400 (got ${badId.status})`);
      assert(isCleanErrorBody(badId.bodyText), "bad-id body is clean");
      const unknown = await req(investorA.cookie, "GET", meFile(999999999));
      assert(unknown.status === 404, `unknown id 404 (got ${unknown.status})`);
      assert(isCleanErrorBody(unknown.bodyText), "unknown-id body is clean");
    }
  } catch (e) {
    assert(false, `unexpected error: ${(e as Error).message}`);
  } finally {
    for (const obj of uploadedObjects) {
      await objectStorageService.deleteObjectEntity(obj).catch(() => {});
    }
    const ids = [investorA?.id, investorB?.id, admin?.id, plainUser?.id].filter(
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
  console.error("[investorStatementFileServingAccessTest] FAILED:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
