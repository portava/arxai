// Runtime QA for the ARX AI allocation system.
//
// Seeds two real sessions (OWNER + test user), then exercises every admin
// allocation endpoint over HTTP with cookies, verifies response shape +
// math + audit trail + leak surface, and probes the freeze pre-gate via
// a real arx_live_commands row in LIVE_APPROVED state piped through
// liveCommandPipeline.dispatchLiveCommand.
//
// Safety:
//  - Creates throwaway test users; does not touch real user 4 data.
//  - The single arx_live_commands row inserted by the freeze pre-gate
//    test transitions to LIVE_BLOCKED (never SENT_TO_MT5_LIVE) and is
//    deleted in the cleanup block. Verifies the table count is back to
//    the original at the end.
//  - Seeds arx_master_account_config only if missing, restores prior state.
//  - Never weakens any gate.

import { randomBytes, randomUUID, createHash } from "node:crypto";
import { eq, sql, inArray, and } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  userSlotAllocationTable,
  adminActionAuditLogTable,
  arxMasterAccountConfigTable,
  arxLiveCommandsTable,
  mt5ConnectionTable,
} from "@workspace/db";

const BASE = process.env.QA_BASE_URL ?? "http://localhost:80";
const OWNER_ID = 4;

// Hard runtime guard: this harness mutates real DB rows (creates throwaway
// users, may seed mt5_connection + arx_master_account_config). Refuse to
// run unless explicitly allowed AND not pointing at a production-looking URL.
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

async function http(path: string, opts: { method?: string; body?: unknown; cookie: string }): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      Cookie: `arx_user_session=${opts.cookie}`,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const txt = await r.text();
  let body: any = txt;
  try { body = JSON.parse(txt); } catch { /* keep text */ }
  return { status: r.status, body };
}

async function main(): Promise<void> {
  // ── Setup ──────────────────────────────────────────────────────────────
  const ownerSession = await mkSession(OWNER_ID);
  const testEmail = `qa-alloc-${Date.now()}@arx.test`;
  const [testUser] = await db.insert(usersTable).values({
    email: testEmail,
    passwordHash: "qa-no-login",
    role: "USER",
  }).returning();
  if (!testUser) throw new Error("test user creation failed");
  const testSession = await mkSession(testUser.id);

  const [transferUser] = await db.insert(usersTable).values({
    email: `qa-alloc-xfer-${Date.now()}@arx.test`,
    passwordHash: "qa-no-login",
    role: "USER",
  }).returning();
  if (!transferUser) throw new Error("transfer user creation failed");

  // Seed master config if missing so we can exercise funding mutations.
  // The fixture writes a large balance directly onto the master connection
  // row so allocation math has headroom. Restored at cleanup.
  const masterPrior = await db.select().from(arxMasterAccountConfigTable).limit(1);
  let qaSeededMaster = false;
  let qaSeededMasterConfigId: number | null = null;
  let qaUsedConnId: number | null = null;
  let priorConnBalance: number | null = null;
  let priorConnEquity: number | null = null;
  let priorConnFreeMargin: number | null = null;
  let priorConnHeartbeat: Date | null = null;
  if (masterPrior.length === 0) {
    // Deterministic target: prefer explicit QA_MASTER_CONN_ID env, else the
    // lowest-id connection. Never an arbitrary limit(1) without ordering.
    const pinId = process.env.QA_MASTER_CONN_ID ? Number(process.env.QA_MASTER_CONN_ID) : null;
    const liveConns = pinId != null
      ? await db.select().from(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, pinId)).limit(1)
      : await db.select().from(mt5ConnectionTable).orderBy(mt5ConnectionTable.id).limit(1);
    const conn = liveConns[0];
    if (!conn) throw new Error("no mt5_connection row to seed master config against (set QA_MASTER_CONN_ID)");
    qaUsedConnId = conn.id;
    priorConnBalance = conn.accountBalance != null ? Number(conn.accountBalance) : null;
    priorConnEquity = conn.accountEquity != null ? Number(conn.accountEquity) : null;
    priorConnFreeMargin = conn.freeMargin != null ? Number(conn.freeMargin) : null;
    priorConnHeartbeat = conn.lastHeartbeat ?? null;
    await db.update(mt5ConnectionTable).set({
      accountBalance: 10000,
      accountEquity: 10000,
      freeMargin: 10000,
      lastHeartbeat: new Date(),
    }).where(eq(mt5ConnectionTable.id, conn.id));
    const [cfg] = await db.insert(arxMasterAccountConfigTable).values({
      masterConnectionId: conn.id,
      label: "QA seeded master (auto-cleanup)",
      isActive: true,
      notes: "qa-runtime",
    }).returning();
    qaSeededMaster = true;
    qaSeededMasterConfigId = cfg?.id ?? null;
  }

  const liveCmdsBefore = await db.execute(sql`SELECT COUNT(*)::int as c FROM arx_live_commands`);
  const liveCmdsBeforeN = Number((liveCmdsBefore.rows[0] as { c: number }).c);
  let seededLiveCmdId: string | null = null;

  try {
    // ── 1. GET /api/admin/allocations ────────────────────────────────────
    const list = await http("/api/admin/allocations", { cookie: ownerSession });
    check("admin GET /allocations responds 200", list.status === 200, list.status);
    check("admin GET returns ok=true", list.body?.ok === true, list.body);
    check("admin GET has summary block", typeof list.body?.summary === "object");
    check("admin GET has master block", typeof list.body?.master === "object");
    check("admin GET master.configured=true", list.body?.master?.configured === true, list.body?.master);
    check("admin GET master.balance is a number", typeof list.body?.master?.balance === "number");
    check("admin GET master.headroom is a number", typeof list.body?.master?.headroom === "number");

    // ── 2. Normal user blocked from admin list ───────────────────────────
    const userHitsAdmin = await http("/api/admin/allocations", { cookie: testSession });
    check("normal user blocked from admin list (403)", userHitsAdmin.status === 403, userHitsAdmin.status);

    // ── 3. /api/me/allocation (no allocation yet) ────────────────────────
    const meEmpty = await http("/api/me/allocation", { cookie: testSession });
    check("me/allocation ok before any allocation", meEmpty.status === 200 && meEmpty.body?.ok === true);
    check("me/allocation hasAllocation=false before alloc", meEmpty.body?.hasAllocation === false);

    // ── 4. add over master capacity → must refuse ────────────────────────
    const overAdd = await http(`/api/admin/allocations/${testUser.id}/add`, {
      method: "POST", cookie: ownerSession,
      body: { amount: 100_000_000, note: "qa-over" },
    });
    check("add over master capacity → 409 EXCEEDS_MASTER_CAPACITY",
      overAdd.status === 409 && overAdd.body?.error === "EXCEEDS_MASTER_CAPACITY", overAdd);

    // ── 5. add 100 (valid) ───────────────────────────────────────────────
    const add1 = await http(`/api/admin/allocations/${testUser.id}/add`, {
      method: "POST", cookie: ownerSession,
      body: { amount: 100, note: "qa-add-1" },
    });
    check("add 100 → 200 ok", add1.status === 200 && add1.body?.ok === true, add1);
    check("add 100 → newTotal=100", add1.body?.newTotal === 100, add1.body);
    check("add 100 → DB manual=100, ai=0",
      Number(add1.body?.alloc?.manualAllocatedFunds) === 100 &&
      Number(add1.body?.alloc?.aiAllocatedFunds) === 0, add1.body?.alloc);

    // ── 6. AI sleeve > total → refuse ────────────────────────────────────
    const aiOver = await http(`/api/admin/allocations/${testUser.id}/ai`, {
      method: "POST", cookie: ownerSession,
      body: { aiAmount: 500, aiStrategyMode: "balanced" },
    });
    check("AI sleeve > total → 409 AI_EXCEEDS_TOTAL",
      aiOver.status === 409 && aiOver.body?.error === "AI_EXCEEDS_TOTAL", aiOver);

    // ── 7. AI valid split ────────────────────────────────────────────────
    const aiOk = await http(`/api/admin/allocations/${testUser.id}/ai`, {
      method: "POST", cookie: ownerSession,
      body: { aiAmount: 40, aiStrategyMode: "balanced", aiAutoTradingEnabled: true, aiMaxLot: 0.05, aiMaxDailyLoss: 25 },
    });
    check("AI set 40 → 200 ok", aiOk.status === 200 && aiOk.body?.ok === true, aiOk);
    const afterAi = await db.select().from(userSlotAllocationTable).where(eq(userSlotAllocationTable.userId, testUser.id)).limit(1);
    check("AI set 40 → DB manual=60, ai=40",
      Number(afterAi[0]?.manualAllocatedFunds) === 60 && Number(afterAi[0]?.aiAllocatedFunds) === 40,
      { manual: afterAi[0]?.manualAllocatedFunds, ai: afterAi[0]?.aiAllocatedFunds });
    check("AI set 40 → strategyMode=balanced, auto=true",
      afterAi[0]?.aiStrategyMode === "balanced" && afterAi[0]?.aiAutoTradingEnabled === true);

    // ── 8. set 200 ───────────────────────────────────────────────────────
    const setOk = await http(`/api/admin/allocations/${testUser.id}/set`, {
      method: "POST", cookie: ownerSession,
      body: { amount: 200, note: "qa-set-200" },
    });
    check("set 200 → 200 ok", setOk.status === 200 && setOk.body?.ok === true, setOk);
    const afterSet = await db.select().from(userSlotAllocationTable).where(eq(userSlotAllocationTable.userId, testUser.id)).limit(1);
    check("set 200 → DB total=200, AI bucket preserved=40, manual=160",
      Number(afterSet[0]?.allocatedFunds) === 200 &&
      Number(afterSet[0]?.aiAllocatedFunds) === 40 &&
      Number(afterSet[0]?.manualAllocatedFunds) === 160, afterSet[0]);

    // ── 9. transfer 50 to second user ────────────────────────────────────
    const xfer = await http(`/api/admin/allocations/${testUser.id}/transfer`, {
      method: "POST", cookie: ownerSession,
      body: { toUserId: transferUser.id, amount: 50, note: "qa-xfer" },
    });
    check("transfer 50 → 200 ok", xfer.status === 200 && xfer.body?.ok === true, xfer);
    check("transfer from.new=150 / to.new=50",
      xfer.body?.from?.new === 150 && xfer.body?.to?.new === 50, xfer.body);

    // ── 10. remove 25 ────────────────────────────────────────────────────
    const rem = await http(`/api/admin/allocations/${testUser.id}/remove`, {
      method: "POST", cookie: ownerSession,
      body: { amount: 25, note: "qa-rem" },
    });
    check("remove 25 → 200 ok newTotal=125",
      rem.status === 200 && rem.body?.ok === true && rem.body?.newTotal === 125, rem);

    // ── 11. freeze (full) ────────────────────────────────────────────────
    const fz = await http(`/api/admin/allocations/${testUser.id}/freeze`, {
      method: "POST", cookie: ownerSession,
      body: { freezeType: "full", reason: "qa-freeze" },
    });
    check("freeze full → 200 ok", fz.status === 200 && fz.body?.ok === true, fz);
    const afterFz = await db.select().from(userSlotAllocationTable).where(eq(userSlotAllocationTable.userId, testUser.id)).limit(1);
    check("freeze full → status=frozen, trading+ai frozen",
      afterFz[0]?.allocationStatus === "frozen" &&
      afterFz[0]?.tradingFrozen === true &&
      afterFz[0]?.aiTradingFrozen === true, afterFz[0]);

    // ── 12. me/allocation while frozen — UX + leak audit ─────────────────
    const meFrozen = await http("/api/me/allocation", { cookie: testSession });
    check("me/allocation while frozen → 200 ok",
      meFrozen.status === 200 && meFrozen.body?.ok === true);
    check("me/allocation while frozen → isFrozen=true",
      meFrozen.body?.isFrozen === true, meFrozen.body);
    check("me/allocation while frozen → freezeMessage non-empty",
      typeof meFrozen.body?.freezeMessage === "string" && meFrozen.body.freezeMessage.length > 0);
    const meJson = JSON.stringify(meFrozen.body);
    const leakKeys = ["frozenByUserId", "frozenAt", "ipAddress", "user_slot_allocation",
      "masterBalance", "masterEquity", "freeMargin", "MT5_BRIDGE_TOKEN",
      "assignedByUserId", "tokenHash", "passwordHash", "headroom",
      "\"balance\":", "\"equity\":"];
    for (const k of leakKeys) {
      check(`me/allocation has no '${k}'`, !meJson.includes(k));
    }

    // ── 13. Live dispatch freeze pre-gate — seed real LIVE_APPROVED row ─
    // Inserts a row directly in LIVE_APPROVED state for the frozen user
    // and calls dispatchLiveCommand. Must transition to LIVE_BLOCKED with
    // reason USER_ALLOCATION_FROZEN. Never SENT_TO_MT5_LIVE.
    const commandId = `qa_lvcmd_${randomUUID()}`;
    await db.insert(arxLiveCommandsTable).values({
      commandId,
      userId: testUser.id,
      bridgeConnectionId: null,
      accountLogin: null,
      brokerServer: null,
      accountNumber: "0",
      commandType: "PLACE_LIVE_MARKET_ORDER",
      status: "LIVE_APPROVED",
      symbol: "EURUSD", side: "BUY", orderType: "MARKET",
      requestedVolume: 0.01,
      stopLoss: 1.0, takeProfit: 1.2,
      sourcePage: "QA_RUNTIME",
      confirmedAt: new Date(),
      payload: {},
    });
    seededLiveCmdId = commandId;

    const { dispatchLiveCommand } = await import(
      "../../artifacts/api-server/src/lib/live/liveCommandPipeline.js"
    );
    const dispatch = await dispatchLiveCommand({ userId: testUser.id, commandId });
    check("frozen dispatch → not ok", dispatch.ok === false, dispatch);
    check("frozen dispatch → reason=LIVE_BLOCKED",
      (dispatch as { reason?: string }).reason === "LIVE_BLOCKED", dispatch);
    const primary = (dispatch as { primaryReason?: string }).primaryReason;
    check("frozen dispatch → primaryReason=USER_ALLOCATION_FROZEN",
      primary === "USER_ALLOCATION_FROZEN", dispatch);
    const rowAfter = await db.select().from(arxLiveCommandsTable)
      .where(eq(arxLiveCommandsTable.commandId, commandId)).limit(1);
    check("frozen dispatch → DB status=LIVE_BLOCKED",
      rowAfter[0]?.status === "LIVE_BLOCKED", rowAfter[0]);
    check("frozen dispatch → DB rejectionReason=USER_ALLOCATION_FROZEN",
      rowAfter[0]?.rejectionReason === "USER_ALLOCATION_FROZEN", rowAfter[0]);
    check("frozen dispatch → never reached SENT_TO_MT5_LIVE",
      rowAfter[0]?.sentToMt5At == null, rowAfter[0]);

    // ── 13b. tradingFrozen semantics — entry BLOCKED, close/modify ALLOWED ─
    // Unfreeze first, then set tradingFrozen-only (not full freeze). The
    // freeze pre-gate must block PLACE_LIVE_MARKET_ORDER, but allow
    // CLOSE_LIVE_POSITION and MODIFY_LIVE_SLTP to proceed past freeze (they
    // will still be BLOCKED by downstream gates — pilot, EA inputs, etc. —
    // but NOT by the freeze gate; rejectionReason must NOT be a freeze code).
    await db.update(userSlotAllocationTable).set({
      allocationStatus: "active",
      tradingFrozen: true,
      aiTradingFrozen: false,
    }).where(eq(userSlotAllocationTable.userId, testUser.id));

    const { dispatchLiveCommand: dispatchAgain } = await import(
      "../../artifacts/api-server/src/lib/live/liveCommandPipeline.js"
    );

    async function seedAndDispatch(commandType: string, suffix: string) {
      const cid = `qa_lvcmd_${suffix}_${randomUUID()}`;
      await db.insert(arxLiveCommandsTable).values({
        commandId: cid, userId: testUser.id,
        bridgeConnectionId: null, accountLogin: null, brokerServer: null,
        accountNumber: "0", commandType, status: "LIVE_APPROVED",
        symbol: "EURUSD", side: "BUY", orderType: "MARKET",
        requestedVolume: 0.01, stopLoss: 1.0, takeProfit: 1.2,
        sourcePage: "QA_RUNTIME", confirmedAt: new Date(), payload: {},
      });
      const res = await dispatchAgain({ userId: testUser.id, commandId: cid });
      const dbRow = await db.select().from(arxLiveCommandsTable)
        .where(eq(arxLiveCommandsTable.commandId, cid)).limit(1);
      return { cid, res, row: dbRow[0] };
    }

    const entry = await seedAndDispatch("PLACE_LIVE_MARKET_ORDER", "tf-entry");
    check("tradingFrozen + entry → BLOCKED by freeze (USER_TRADING_FROZEN)",
      (entry.res as { primaryReason?: string }).primaryReason === "USER_TRADING_FROZEN",
      entry.res);
    check("tradingFrozen + entry → never reached SENT_TO_MT5_LIVE",
      entry.row?.sentToMt5At == null, entry.row);

    const closeR = await seedAndDispatch("CLOSE_LIVE_POSITION", "tf-close");
    check("tradingFrozen + close → freeze gate did NOT block (rejection != freeze code)",
      closeR.row?.rejectionReason !== "USER_TRADING_FROZEN" &&
      closeR.row?.rejectionReason !== "USER_ALLOCATION_FROZEN",
      closeR.row);
    check("tradingFrozen + close → still never reached SENT_TO_MT5_LIVE",
      closeR.row?.sentToMt5At == null, closeR.row);

    const modR = await seedAndDispatch("MODIFY_LIVE_SLTP", "tf-mod");
    check("tradingFrozen + modify → freeze gate did NOT block (rejection != freeze code)",
      modR.row?.rejectionReason !== "USER_TRADING_FROZEN" &&
      modR.row?.rejectionReason !== "USER_ALLOCATION_FROZEN",
      modR.row);
    check("tradingFrozen + modify → still never reached SENT_TO_MT5_LIVE",
      modR.row?.sentToMt5At == null, modR.row);

    await db.delete(arxLiveCommandsTable).where(inArray(arxLiveCommandsTable.commandId,
      [entry.cid, closeR.cid, modR.cid]));

    // ── 14. Unfreeze ─────────────────────────────────────────────────────
    const ufz = await http(`/api/admin/allocations/${testUser.id}/unfreeze`, {
      method: "POST", cookie: ownerSession,
      body: { unfreezeType: "full", note: "qa-unfreeze" },
    });
    check("unfreeze full → 200 ok", ufz.status === 200 && ufz.body?.ok === true, ufz);
    const afterUfz = await db.select().from(userSlotAllocationTable).where(eq(userSlotAllocationTable.userId, testUser.id)).limit(1);
    check("unfreeze → status=active, trading+ai unfrozen",
      afterUfz[0]?.allocationStatus === "active" &&
      afterUfz[0]?.tradingFrozen === false &&
      afterUfz[0]?.aiTradingFrozen === false, afterUfz[0]);

    // ── 15. History ──────────────────────────────────────────────────────
    const hist = await http(`/api/admin/allocations/${testUser.id}/history`, { cookie: ownerSession });
    check("history → 200 ok", hist.status === 200 && hist.body?.ok === true, hist);
    const histActions = (hist.body?.transactions ?? []).map((t: { action: string }) => t.action);
    const expected = ["ALLOCATION_ADD", "ALLOCATION_AI_SET", "ALLOCATION_SET",
      "ALLOCATION_TRANSFER_OUT", "ALLOCATION_REMOVE",
      "ALLOCATION_FREEZE_FULL", "ALLOCATION_UNFREEZE_FULL"];
    for (const a of expected) {
      check(`audit contains ${a}`, histActions.includes(a), histActions);
    }
    check("only 1 ALLOCATION_ADD audit row (failed over-add rolled back)",
      histActions.filter((a: string) => a === "ALLOCATION_ADD").length === 1, histActions);
    check("only 1 ALLOCATION_AI_SET audit row (failed AI-over rolled back)",
      histActions.filter((a: string) => a === "ALLOCATION_AI_SET").length === 1, histActions);

    // ── 16. History blocked for normal user ──────────────────────────────
    const userHistAttempt = await http(`/api/admin/allocations/${testUser.id}/history`, { cookie: testSession });
    check("normal user blocked from history (403)", userHistAttempt.status === 403, userHistAttempt.status);

    // ── 17. Final cross-app math: admin list + me/allocation ─────────────
    const list2 = await http("/api/admin/allocations", { cookie: ownerSession });
    const me = (list2.body?.users ?? []).find((u: { userId: number }) => u.userId === testUser.id);
    check("admin list reflects testUser totalAllocation=125",
      me?.totalAllocation === 125, me);
    check("admin list reflects testUser allocationStatus=active",
      me?.allocationStatus === "active", me);
    const meFinal = await http("/api/me/allocation", { cookie: testSession });
    check("me/allocation final isFrozen=false, totalAllocation=125",
      meFinal.body?.isFrozen === false && meFinal.body?.totalAllocation === 125, meFinal.body);

    // ── 18. Cross-app slot summary endpoint (used by LiveSlotSummaryCard) ─
    const slot = await http("/api/me/live/slot-summary", { cookie: testSession });
    check("me/live/slot-summary endpoint responds (not 404)",
      slot.status !== 404, slot.status);

  } finally {
    // ── Cleanup ───────────────────────────────────────────────────────────
    if (seededLiveCmdId) {
      await db.delete(arxLiveCommandsTable).where(eq(arxLiveCommandsTable.commandId, seededLiveCmdId));
    }
    if (qaSeededMaster && qaSeededMasterConfigId != null) {
      await db.delete(arxMasterAccountConfigTable).where(eq(arxMasterAccountConfigTable.id, qaSeededMasterConfigId));
    }
    if (qaSeededMaster && qaUsedConnId != null) {
      await db.update(mt5ConnectionTable).set({
        accountBalance: priorConnBalance,
        accountEquity: priorConnEquity,
        freeMargin: priorConnFreeMargin,
        lastHeartbeat: priorConnHeartbeat,
      }).where(eq(mt5ConnectionTable.id, qaUsedConnId));
    }
    // Token-scoped cleanup: delete ONLY the session rows we minted, never
    // every session for the owner — that would invalidate real OWNER logins.
    if (mintedSessionHashes.length > 0) {
      await db.delete(authUserSessionsTable)
        .where(inArray(authUserSessionsTable.tokenHash, mintedSessionHashes));
    }
    await db.delete(userSlotAllocationTable).where(eq(userSlotAllocationTable.userId, testUser.id));
    await db.delete(userSlotAllocationTable).where(eq(userSlotAllocationTable.userId, transferUser.id));
    await db.delete(adminActionAuditLogTable).where(eq(adminActionAuditLogTable.targetUserId, testUser.id));
    await db.delete(adminActionAuditLogTable).where(eq(adminActionAuditLogTable.targetUserId, transferUser.id));
    await db.delete(usersTable).where(eq(usersTable.id, testUser.id));
    await db.delete(usersTable).where(eq(usersTable.id, transferUser.id));

    const liveCmdsAfter = await db.execute(sql`SELECT COUNT(*)::int as c FROM arx_live_commands`);
    const liveCmdsAfterN = Number((liveCmdsAfter.rows[0] as { c: number }).c);
    check(`arx_live_commands restored (${liveCmdsBeforeN} → ${liveCmdsAfterN})`,
      liveCmdsAfterN === liveCmdsBeforeN, { liveCmdsBeforeN, liveCmdsAfterN });
  }

  console.log(`\n${total - fails}/${total} PASS · ${fails} FAIL`);
  if (fails > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
