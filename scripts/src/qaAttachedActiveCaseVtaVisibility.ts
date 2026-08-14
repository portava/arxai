// Regression: attached users with status='ACTIVE' (uppercase) AND attached
// users with no user_slot_allocation row MUST appear in GET /admin/allocations
// with attachment.attached === true, AND must be excluded from
// /users-eligible. Reproduces the bug behind user 4 (andraie.co@gmail.com)
// being invisible despite being attached.
//
// Safety: creates two throwaway test users + two VTAs pointing at an EXISTING
// shared_master_accounts row. Never inserts arx_live_commands, never seeds
// arx_master_account_config, never touches the master gates. Asserts
// arx_live_commands count is unchanged after the run.

import { randomBytes, createHash } from "node:crypto";
import { eq, sql, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  userSlotAllocationTable,
  virtualTradingAccountsTable,
  sharedMasterAccountsTable,
} from "@workspace/db";

const BASE = process.env.QA_BASE_URL ?? "http://localhost:80";
const OWNER_ID = 4;

if (process.env.QA_ALLOW_DB_MUTATION !== "true") {
  console.error("REFUSED: set QA_ALLOW_DB_MUTATION=true to run this harness (it writes to the DB).");
  process.exit(2);
}
if (process.env.NODE_ENV === "production" || /\.replit\.app/.test(BASE)) {
  console.error(`REFUSED: harness will not run against production-like target (${BASE}).`);
  process.exit(2);
}

let fails = 0;
let total = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  total++;
  if (ok) console.log(`PASS  ${name}`);
  else { fails++; console.log(`FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : ""); }
}

const mintedSessionHashes: string[] = [];
async function mkSession(userId: number): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId, tokenHash,
    expiresAt: new Date(Date.now() + 60_000),
    ipAddress: "127.0.0.1", userAgent: "qa",
  });
  mintedSessionHashes.push(tokenHash);
  return raw;
}

async function http(path: string, opts: { cookie: string }): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${path}`, {
    method: "GET",
    headers: { Cookie: `arx_user_session=${opts.cookie}` },
  });
  const txt = await r.text();
  let body: any = txt;
  try { body = JSON.parse(txt); } catch { /* keep text */ }
  return { status: r.status, body };
}

async function main(): Promise<void> {
  const tag = `qaVCASE_${Date.now()}_${randomBytes(3).toString("hex")}`;

  const owner = await db.select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable).where(eq(usersTable.id, OWNER_ID)).limit(1);
  if (!owner[0] || (owner[0].role !== "OWNER" && owner[0].role !== "ADMIN")) {
    console.error(`REFUSED: user ${OWNER_ID} is not OWNER/ADMIN — cannot run admin endpoints.`);
    process.exit(2);
  }

  const smaRows = await db.select({ id: sharedMasterAccountsTable.id })
    .from(sharedMasterAccountsTable).where(eq(sharedMasterAccountsTable.isActive, true)).limit(1);
  if (!smaRows[0]) {
    console.error("REFUSED: no active shared_master_accounts row exists; cannot create attached VTA.");
    process.exit(2);
  }
  const smaId = smaRows[0].id;

  const liveCmdsBefore = await db.execute(sql`SELECT COUNT(*)::int as c FROM arx_live_commands`);
  const liveCmdsBeforeN = Number((liveCmdsBefore.rows[0] as { c: number }).c);

  const [uUpper] = await db.insert(usersTable).values({
    email: `${tag}_upper@arx.test`, name: `${tag} upper`, role: "USER",
  }).returning();
  const [uLower] = await db.insert(usersTable).values({
    email: `${tag}_lower@arx.test`, name: `${tag} lower`, role: "USER",
  }).returning();

  const createdVtaIds: number[] = [];
  try {
    // ACTIVE (uppercase legacy) — NO user_slot_allocation row.
    const [vtaUpper] = await db.insert(virtualTradingAccountsTable).values({
      userId: uUpper.id, accountType: "demo", routingMode: "SHARED_MASTER_MT5",
      sharedMasterAccountId: smaId, status: "ACTIVE",
      virtualBalance: 0, virtualEquity: 0, virtualPnl: 0,
    }).returning();
    createdVtaIds.push(vtaUpper.id);

    // active (lowercase normal) — NO user_slot_allocation row.
    const [vtaLower] = await db.insert(virtualTradingAccountsTable).values({
      userId: uLower.id, accountType: "demo", routingMode: "SHARED_MASTER_MT5",
      sharedMasterAccountId: smaId, status: "active",
      virtualBalance: 0, virtualEquity: 0, virtualPnl: 0,
    }).returning();
    createdVtaIds.push(vtaLower.id);

    const ownerSession = await mkSession(OWNER_ID);
    const list = await http("/api/admin/allocations", { cookie: ownerSession });
    check("GET /admin/allocations → 200 ok",
      list.status === 200 && list.body?.ok === true, { status: list.status });

    const users = (list.body?.users ?? []) as Array<{
      userId: number; email: string | null; totalAllocation: number;
      allocationStatus: string;
      attachment?: { attached: boolean; virtualAccountId: number | null;
        sharedMasterAccountId: number | null; virtualBalance: number;
        virtualEquity: number; shellSynced: boolean; status: string | null };
    }>;

    const upper = users.find((u) => u.userId === uUpper.id);
    const lower = users.find((u) => u.userId === uLower.id);

    check("status='ACTIVE' user appears in /admin/allocations (orphan-attached, no alloc row)",
      !!upper, { uUpperId: uUpper.id });
    check("status='ACTIVE' user has attachment.attached === true",
      upper?.attachment?.attached === true, upper?.attachment);
    check("status='ACTIVE' user has attachment.virtualAccountId set",
      upper?.attachment?.virtualAccountId === vtaUpper.id, upper?.attachment);
    check("status='ACTIVE' user has attachment.sharedMasterAccountId set",
      upper?.attachment?.sharedMasterAccountId === smaId, upper?.attachment);

    check("status='active' user appears in /admin/allocations (orphan-attached, no alloc row)",
      !!lower, { uLowerId: uLower.id });
    check("status='active' user has attachment.attached === true",
      lower?.attachment?.attached === true, lower?.attachment);

    check("ACTIVE user totalAllocation === 0 (no alloc row, synthetic zero)",
      upper?.totalAllocation === 0, { totalAllocation: upper?.totalAllocation });
    check("active user totalAllocation === 0 (no alloc row, synthetic zero)",
      lower?.totalAllocation === 0, { totalAllocation: lower?.totalAllocation });

    // GET must not silently materialise allocation rows for orphan users.
    const persistedAlloc = await db.select({ id: userSlotAllocationTable.id })
      .from(userSlotAllocationTable)
      .where(inArray(userSlotAllocationTable.userId, [uUpper.id, uLower.id]));
    check("GET did NOT persist allocation rows for orphan-attached users",
      persistedAlloc.length === 0, persistedAlloc);

    check("ACTIVE user has a defined allocationStatus (Add/Set controls renderable)",
      typeof upper?.allocationStatus === "string" && upper!.allocationStatus.length > 0,
      { allocationStatus: upper?.allocationStatus });
    check("active user has a defined allocationStatus (Add/Set controls renderable)",
      typeof lower?.allocationStatus === "string" && lower!.allocationStatus.length > 0,
      { allocationStatus: lower?.allocationStatus });

    // Symmetry: /users-eligible MUST exclude both attached users regardless
    // of status casing. The same predicate (vtaStatusActive) guards both
    // inclusion in the list and exclusion from eligible.
    const eligible = await http(`/api/admin/allocations/users-eligible?q=${tag}`,
      { cookie: ownerSession });
    check("GET /users-eligible → 200 ok",
      eligible.status === 200 && eligible.body?.ok === true, { status: eligible.status });
    const elIds = (eligible.body?.users ?? []).map((u: { userId: number }) => u.userId);
    check("eligible search excludes ACTIVE-cased attached user",
      !elIds.includes(uUpper.id), elIds);
    check("eligible search excludes active-cased attached user",
      !elIds.includes(uLower.id), elIds);
  } finally {
    if (createdVtaIds.length > 0) {
      await db.delete(virtualTradingAccountsTable)
        .where(inArray(virtualTradingAccountsTable.id, createdVtaIds));
    }
    await db.delete(userSlotAllocationTable)
      .where(inArray(userSlotAllocationTable.userId, [uUpper.id, uLower.id]));
    if (mintedSessionHashes.length > 0) {
      await db.delete(authUserSessionsTable)
        .where(inArray(authUserSessionsTable.tokenHash, mintedSessionHashes));
    }
    await db.delete(usersTable)
      .where(inArray(usersTable.id, [uUpper.id, uLower.id]));

    const liveCmdsAfter = await db.execute(sql`SELECT COUNT(*)::int as c FROM arx_live_commands`);
    const liveCmdsAfterN = Number((liveCmdsAfter.rows[0] as { c: number }).c);
    check(`arx_live_commands unchanged (${liveCmdsBeforeN} → ${liveCmdsAfterN})`,
      liveCmdsAfterN === liveCmdsBeforeN, { liveCmdsBeforeN, liveCmdsAfterN });
  }

  console.log(`\n${total - fails}/${total} PASS · ${fails} FAIL`);
  if (fails > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
