// operatorDiagnosticsGatingTest — T012.
//
// Proves the server contract that the AdminDiagnosticsGate front-end
// component relies on:
//
//   T1. Normal-user envelope -> isAdmin=false AND
//                               adminDiagnosticsAvailable=false
//   T2.                       -> adminDiagnostics === null
//   T3.                       -> envelope contains no forbidden secret keys
//   T4. Admin envelope        -> isAdmin=true AND
//                                adminDiagnosticsAvailable=true
//   T5.                       -> isAdminPreviewingUserMode is false/absent
//   T6.                       -> still no forbidden secret keys
//   T7. Gate suppression rule  -> isAdmin=false OR adminDiagnosticsAvailable=false
//                                holds for normal users
//   T8. arx_live_commands count is unchanged across the run.
//
// Inviolables held: no live trade dispatched, no operator phrase typed,
// no env parser broadened, no safety gate weakened. Sessions are minted
// only against existing users (no new accounts created); sessions are
// deleted in a `finally` block so no QA cookies persist.

import { randomBytes, createHash } from "node:crypto";
import { sql, eq, inArray } from "drizzle-orm";
import { db, usersTable, authUserSessionsTable } from "@workspace/db";

const BASE = process.env.QA_BASE_URL ?? "http://localhost:80";
const SESSION_TTL_MS = 15 * 60 * 1000;

const FORBIDDEN_KEYS = new Set([
  "MT5_BRIDGE_TOKEN",
  "SESSION_SECRET",
  "apiKeyHash",
  "bridgeToken",
  "rawBridgeToken",
  "tokenPlaintext",
]);

type Result = { name: string; pass: boolean; detail: string };
const out: Result[] = [];
function pass(name: string, detail: string) { out.push({ name, pass: true, detail }); }
function fail(name: string, detail: string) { out.push({ name, pass: false, detail }); }

async function liveCount(): Promise<number> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM arx_live_commands`);
  const rows = (r as unknown as { rows: { n: number }[] }).rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

async function mintSession(userId: number): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipAddress: "127.0.0.1",
    userAgent: "qa-operator-diag-gating",
  });
  return raw;
}

async function deleteSessionsByRawCookie(raws: string[]): Promise<void> {
  const hashes = raws.map((r) => createHash("sha256").update(r).digest("hex"));
  if (hashes.length === 0) return;
  await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.tokenHash, hashes));
}

async function fetchEnvelope(cookie: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}/api/me/account-mode`, {
    headers: { cookie: `arx_user_session=${cookie}` },
  });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

function deepScanForbidden(node: unknown, path: string[] = []): string[] {
  const hits: string[] = [];
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.has(k)) hits.push([...path, k].join("."));
      hits.push(...deepScanForbidden(v, [...path, k]));
    }
  }
  return hits;
}

async function pickUser(role: "USER" | "ADMIN" | "OWNER"): Promise<{ id: number; email: string | null } | null> {
  const rows = await db
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.role, role))
    .limit(1);
  return rows[0] ?? null;
}

async function main() {
  if (process.env.QA_ALLOW_DB_MUTATION !== "true") {
    console.error("Refusing: set QA_ALLOW_DB_MUTATION=true to run (minted sessions are cleaned up in finally).");
    process.exit(2);
  }

  const liveBefore = await liveCount();

  const userRow = await pickUser("USER");
  const adminRow = (await pickUser("ADMIN")) ?? (await pickUser("OWNER"));
  if (!userRow || !adminRow) {
    console.error(`Missing baseline accounts (user=${!!userRow}, admin/owner=${!!adminRow}).`);
    process.exit(2);
  }

  const userCookie = await mintSession(userRow.id);
  const adminCookie = await mintSession(adminRow.id);
  const minted = [userCookie, adminCookie];

  try {
    // T1+T2+T3: normal user
    const userRes = await fetchEnvelope(userCookie);
    const ub = userRes.body;
    if (userRes.status === 200 && ub?.ok === true && ub.isAdmin === false && ub.adminDiagnosticsAvailable === false) {
      pass("T1 normal-user envelope hides diagnostics",
        `isAdmin=${ub.isAdmin} adminDiagnosticsAvailable=${ub.adminDiagnosticsAvailable}`);
    } else {
      fail("T1 normal-user envelope hides diagnostics",
        `status=${userRes.status} isAdmin=${ub?.isAdmin} adminDiagAvail=${ub?.adminDiagnosticsAvailable}`);
    }

    if (ub?.adminDiagnostics === null || ub?.adminDiagnostics === undefined) {
      pass("T2 normal-user envelope.adminDiagnostics is null", `value=${ub?.adminDiagnostics}`);
    } else {
      fail("T2 normal-user envelope.adminDiagnostics is null", `got=${JSON.stringify(ub?.adminDiagnostics).slice(0,120)}`);
    }

    const userForbidden = deepScanForbidden(ub);
    if (userForbidden.length === 0) {
      pass("T3 normal-user envelope has no forbidden secret keys", "0 hits");
    } else {
      fail("T3 normal-user envelope has no forbidden secret keys", `hits=${userForbidden.join(",")}`);
    }

    // T4+T5+T6: admin
    const adminRes = await fetchEnvelope(adminCookie);
    const ab = adminRes.body;
    if (adminRes.status === 200 && ab?.ok === true && ab.isAdmin === true && ab.adminDiagnosticsAvailable === true) {
      pass("T4 admin envelope exposes diagnostics flag",
        `isAdmin=${ab.isAdmin} adminDiagnosticsAvailable=${ab.adminDiagnosticsAvailable}`);
    } else {
      fail("T4 admin envelope exposes diagnostics flag",
        `status=${adminRes.status} isAdmin=${ab?.isAdmin} adminDiagAvail=${ab?.adminDiagnosticsAvailable}`);
    }

    if (ab?.isAdminPreviewingUserMode === false || ab?.isAdminPreviewingUserMode === undefined) {
      pass("T5 admin (not previewing) has isAdminPreviewingUserMode false/absent",
        `value=${ab?.isAdminPreviewingUserMode}`);
    } else {
      fail("T5 admin (not previewing) has isAdminPreviewingUserMode false/absent",
        `value=${ab?.isAdminPreviewingUserMode}`);
    }

    const adminForbidden = deepScanForbidden(ab);
    if (adminForbidden.length === 0) {
      pass("T6 admin envelope has no forbidden secret keys", "0 hits");
    } else {
      fail("T6 admin envelope has no forbidden secret keys", `hits=${adminForbidden.join(",")}`);
    }

    // T7: gate suppression contract for normal users
    const blocks = (ub?.isAdmin === false) || (ub?.adminDiagnosticsAvailable === false);
    if (blocks) {
      pass("T7 user gate suppression contract holds", "isAdmin=false OR adminDiagnosticsAvailable=false");
    } else {
      fail("T7 user gate suppression contract holds",
        `isAdmin=${ub?.isAdmin} adminDiagAvail=${ub?.adminDiagnosticsAvailable}`);
    }

    // T8: arx_live_commands unchanged
    const liveAfter = await liveCount();
    if (liveAfter === liveBefore) {
      pass("T8 arx_live_commands unchanged", `before=${liveBefore} after=${liveAfter}`);
    } else {
      fail("T8 arx_live_commands unchanged", `before=${liveBefore} after=${liveAfter}`);
    }
  } finally {
    try { await deleteSessionsByRawCookie(minted); } catch (e) { console.error("session cleanup failed:", e); }
  }

  let passes = 0, fails = 0;
  for (const r of out) {
    const tag = r.pass ? "PASS" : "FAIL";
    console.log(`${tag}  ${r.name} — ${r.detail}`);
    r.pass ? passes++ : fails++;
  }
  console.log(`\n=== Operator Diagnostics Gating ${passes}/${passes + fails} PASS, ${fails} FAIL ===`);

  const pool = (db as unknown as { $client?: { end?: () => Promise<void> } }).$client;
  if (pool?.end) await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
