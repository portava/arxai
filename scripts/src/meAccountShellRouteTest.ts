// End-to-end HTTP test for GET /api/me/account-shell and the live balance SSE
// stream (Task #444).
//
// WHY THIS EXISTS
//   investorLiveBalanceDbTest.ts proves buildInvestorLiveBalanceSnapshot() is
//   correct when called directly. It never touches the ROUTE layer, so a
//   regression that only manifests over HTTP — a hang (the mode-scope ⇄
//   account-shell ⇄ investor-snapshot recursion that previously froze the real
//   endpoint), a 500, an auth misfire, or a mode misroute — would ship silently.
//   This test authenticates a seeded LIVE_SHARED user and hits the ACTUAL booted
//   Express endpoints, asserting the canonical `live` block within a HARD timeout
//   so a hang fails loudly instead of stalling CI.
//
// WHAT IT PROVES against the REAL HTTP routes (booted app, real session cookie):
//   1. ANON GUARD — anonymous GET /api/me/account-shell → 401 AUTH_REQUIRED.
//   2. NO-HANG + CANONICAL SHELL — an authenticated LIVE_SHARED user's GET
//      returns 200 within a hard timeout, with the canonical `live` block:
//      source=live_shared, allocatedBalance/realizedPnL/floatingPnL/liveEquity/
//      openTradeCount computed from THAT user's rows, freshness=fresh.
//   3. SSE PARITY — the /me/live/account-stream SSE emits an account_snapshot
//      whose `live` block agrees number-for-number with the shell's `live`
//      block (the Task #430 single-source-of-truth invariant), also under a
//      hard timeout so a stalled stream fails the test.
//
// SAFETY / ISOLATION
//   - Seeds isolated system users (isSystemUser=true) at fixed emails + one
//     throwaway fake master mt5_connection. Idempotent: deletes leftovers for
//     the fixed identifiers at start and cleans up everything at the end, even
//     on failure.
//   - Per-user scoped: only the seeded investor's rows are asserted.
//   - Never places a trade, never inserts an arx_live_command, never reaches the
//     EA or a broker. Only DATABASE_URL is required.
//   - CI-safe / self-contained: spins up the REAL Express app in-process on an
//     ephemeral port. Set ARX_QA_BASE_URL to probe an already-running server.
//
// Run: pnpm --filter @workspace/scripts run test:account-shell-route

import { randomBytes, createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  mt5ConnectionTable,
  userSlotAllocationTable,
  virtualTradingAccountsTable,
  arxLiveArmingTable,
  arxLivePositionsTable,
  arxMasterBridgePoolTable,
} from "@workspace/db";
import {
  getSharedBaseUrl,
  closeSharedServer,
  isEntrypoint,
  type CiTestResultLike,
} from "./ci/inProcessAppHarness.js";

const CONN_NAME = "qa-account-shell-route-fake-master";
const EMAIL_MASTER = "qa+account-shell-route-master@arx.test";
const EMAIL_INVESTOR = "qa+account-shell-route-investor@arx.test";
const ALL_EMAILS = [EMAIL_MASTER, EMAIL_INVESTOR];

const TICKET_1 = "QA-ASR-1";
const TICKET_2 = "QA-ASR-2";

// Canonical seeded figures — asserted on the live block over HTTP.
const ALLOCATED = 5_000;
const REALIZED = 200;
const FLOATING = 80; // +50 + +30
const LIVE_EQUITY = ALLOCATED + REALIZED + FLOATING; // 5280

// Hard timeouts: a hung route/stream must FAIL, never stall the suite.
const SHELL_TIMEOUT_MS = 10_000;
const SSE_TIMEOUT_MS = 15_000;

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

async function cleanup(): Promise<void> {
  const leftoverConns = await db
    .select()
    .from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.connectionName, CONN_NAME));
  for (const c of leftoverConns) {
    await db
      .delete(arxMasterBridgePoolTable)
      .where(eq(arxMasterBridgePoolTable.masterConnectionId, c.id));
  }

  const rows = await db.select().from(usersTable).where(inArray(usersTable.email, ALL_EMAILS));
  const ids = rows.map((u) => u.id);
  for (const id of ids) {
    await db.delete(arxLivePositionsTable).where(eq(arxLivePositionsTable.userId, id));
    await db.delete(virtualTradingAccountsTable).where(eq(virtualTradingAccountsTable.userId, id));
    await db.delete(arxLiveArmingTable).where(eq(arxLiveArmingTable.userId, id));
    await db.delete(userSlotAllocationTable).where(eq(userSlotAllocationTable.userId, id));
    await db.delete(mt5ConnectionTable).where(eq(mt5ConnectionTable.userId, id));
    await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, id));
  }
  if (ids.length) await db.delete(usersTable).where(inArray(usersTable.id, ids));
}

async function seedUser(email: string, name: string): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({ email, name, role: "USER", isSystemUser: true })
    .returning();
  if (!user) throw new Error(`test user creation failed: ${email}`);
  // Arm for live — getUserModeScope resolves an armed user to LIVE_SHARED, the
  // ONLY mode that lets the snapshot include live positions.
  await db.insert(arxLiveArmingTable).values({
    userId: user.id,
    isArmed: true,
    armedAt: new Date(),
    armedByUserId: user.id,
    killSwitchAcknowledged: true,
    killSwitchEngaged: false,
  });
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

// Read an SSE stream until the first `account_snapshot` event (or timeout),
// then abort. Returns the parsed event payload.
async function readFirstAccountSnapshot(
  url: string,
  cookie: string,
  timeoutMs: number,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { cookie, accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE connect failed: status=${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = frame
          .split("\n")
          .find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const json = JSON.parse(dataLine.slice("data:".length).trim());
        if (json?.type === "account_snapshot") {
          await reader.cancel().catch(() => {});
          return json;
        }
      }
    }
    throw new Error("SSE stream ended before an account_snapshot event");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("meAccountShellRouteTest");
  // eslint-disable-next-line no-console
  console.log("=======================\n");

  await cleanup();

  const baseUrl = await getSharedBaseUrl();
  const SHELL_PATH = "/api/me/account-shell";
  const STREAM_PATH = "/api/me/live/account-stream";

  const NOW = Date.now();
  const FRESH = new Date(NOW - 1_000); // 1s ago → fresh

  try {
    // ── Seed master system user + throwaway fake master mt5_connection ───────
    const masterUserId = await seedUser(EMAIL_MASTER, "QA ASR Master");
    const [conn] = await db
      .insert(mt5ConnectionTable)
      .values({
        userId: masterUserId,
        connectionName: CONN_NAME,
        status: "connected",
        accountType: "live",
        accountBalance: 1_000_000,
        accountEquity: 1_000_000,
        freeMargin: 1_000_000,
        margin: 0,
        accountCurrency: "USD",
        lastHeartbeat: new Date(),
      })
      .returning();
    if (!conn) throw new Error("fake master connection creation failed");

    // ── Seed one armed LIVE_SHARED investor + session cookie ─────────────────
    const investorId = await seedUser(EMAIL_INVESTOR, "QA ASR Investor");
    await db.insert(userSlotAllocationTable).values({
      userId: investorId,
      allocatedFunds: ALLOCATED,
      manualAllocatedFunds: ALLOCATED,
      reservedRisk: 0,
      accountCurrency: "USD",
    });
    await db.insert(virtualTradingAccountsTable).values({
      userId: investorId,
      routingMode: "SHARED_MASTER_MT5",
      accountType: "live",
      virtualPnl: REALIZED,
      status: "active",
    });
    const openedAt = new Date(NOW - 60_000);
    await db.insert(arxLivePositionsTable).values([
      { userId: investorId, bridgeConnectionId: conn.id, brokerTicket: TICKET_1, symbol: "EURUSD", side: "BUY", volume: 0.1, entryPrice: 1.1, floatingPl: 50, openedAt, closedAt: null, lastSyncedAt: FRESH },
      { userId: investorId, bridgeConnectionId: conn.id, brokerTicket: TICKET_2, symbol: "GBPUSD", side: "BUY", volume: 0.1, entryPrice: 1.27, floatingPl: 30, openedAt, closedAt: null, lastSyncedAt: FRESH },
    ]);
    const cookie = await issueSession(investorId);

    // ── (1) ANON GUARD — anonymous shell GET → 401 ───────────────────────────
    // eslint-disable-next-line no-console
    console.log("(1) anonymous GET /api/me/account-shell → 401");
    const anonRes = await fetch(`${baseUrl}${SHELL_PATH}`, { method: "GET", redirect: "manual" });
    const anonJson = (await anonRes.json().catch(() => null)) as any;
    assert(anonRes.status === 401, `anon shell GET → 401 (got ${anonRes.status})`);
    assert(
      anonJson?.error === "AUTH_REQUIRED",
      `anon error === "AUTH_REQUIRED" (got ${String(anonJson?.error)})`,
    );

    // ── (2) NO-HANG + CANONICAL SHELL — authed LIVE_SHARED GET within timeout ─
    // eslint-disable-next-line no-console
    console.log("\n(2) authed LIVE_SHARED GET returns canonical live block (no hang)");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SHELL_TIMEOUT_MS);
    let shell: any;
    try {
      const res = await fetch(`${baseUrl}${SHELL_PATH}`, {
        method: "GET",
        headers: { cookie },
        redirect: "manual",
        signal: controller.signal,
      });
      assert(res.status === 200, `authed shell GET → 200 within ${SHELL_TIMEOUT_MS}ms (got ${res.status})`);
      shell = await res.json();
    } catch (e) {
      assert(false, `authed shell GET completed within ${SHELL_TIMEOUT_MS}ms (threw: ${(e as Error).name})`);
      shell = null;
    } finally {
      clearTimeout(timer);
    }

    const live = shell?.live;
    assert(shell?.ok === true, `shell ok === true (got ${String(shell?.ok)})`);
    assert(shell?.userId === investorId, `shell userId === investor (got ${String(shell?.userId)})`);
    assert(live != null && typeof live === "object", "shell carries a live block");
    assert(live?.source === "live_shared", `live.source === live_shared (got ${String(live?.source)})`);
    assert(live?.allocatedBalance === ALLOCATED, `live.allocatedBalance === ${ALLOCATED} (got ${String(live?.allocatedBalance)})`);
    assert(live?.realizedPnL === REALIZED, `live.realizedPnL === ${REALIZED} (got ${String(live?.realizedPnL)})`);
    assert(live?.floatingPnL === FLOATING, `live.floatingPnL === +${FLOATING} (got ${String(live?.floatingPnL)})`);
    assert(live?.liveEquity === LIVE_EQUITY, `live.liveEquity === ${LIVE_EQUITY} (got ${String(live?.liveEquity)})`);
    assert(live?.openTradeCount === 2, `live.openTradeCount === 2 (got ${String(live?.openTradeCount)})`);
    assert(live?.freshness?.status === "fresh", `live.freshness.status === fresh (got ${String(live?.freshness?.status)})`);

    // ── (3) SSE PARITY — stream emits the same canonical numbers ─────────────
    // eslint-disable-next-line no-console
    console.log("\n(3) SSE /me/live/account-stream agrees number-for-number");
    let sse: any = null;
    try {
      sse = await readFirstAccountSnapshot(`${baseUrl}${STREAM_PATH}`, cookie, SSE_TIMEOUT_MS);
      assert(true, `SSE emitted an account_snapshot within ${SSE_TIMEOUT_MS}ms`);
    } catch (e) {
      assert(false, `SSE emitted an account_snapshot within ${SSE_TIMEOUT_MS}ms (failed: ${(e as Error).message})`);
    }
    const sseLive = sse?.live;
    assert(sseLive != null && typeof sseLive === "object", "SSE event carries a live block");
    assert(sseLive?.source === "live_shared", `SSE live.source === live_shared (got ${String(sseLive?.source)})`);
    assert(sseLive?.allocatedBalance === ALLOCATED, `SSE live.allocatedBalance === ${ALLOCATED} (got ${String(sseLive?.allocatedBalance)})`);
    assert(sseLive?.realizedPnL === REALIZED, `SSE live.realizedPnL === ${REALIZED} (got ${String(sseLive?.realizedPnL)})`);
    assert(sseLive?.floatingPnL === FLOATING, `SSE live.floatingPnL === +${FLOATING} (got ${String(sseLive?.floatingPnL)})`);
    assert(sseLive?.liveEquity === LIVE_EQUITY, `SSE live.liveEquity === ${LIVE_EQUITY} (got ${String(sseLive?.liveEquity)})`);
    assert(sseLive?.openTradeCount === 2, `SSE live.openTradeCount === 2 (got ${String(sseLive?.openTradeCount)})`);
    // Number-for-number parity with the shell (the Task #430 invariant).
    if (live && sseLive) {
      assert(
        sseLive.allocatedBalance === live.allocatedBalance &&
          sseLive.realizedPnL === live.realizedPnL &&
          sseLive.floatingPnL === live.floatingPnL &&
          sseLive.liveEquity === live.liveEquity &&
          sseLive.openTradeCount === live.openTradeCount,
        "SSE live block matches the shell live block number-for-number",
      );
    }
  } finally {
    await cleanup();
  }

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "meAccountShellRouteTest", passes, failures };
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
      console.error("[meAccountShellRouteTest] FAILED:", err);
      process.exit(1);
    },
  );
}
