// Runtime QA for the Deriv-synthetic LIVE-confirmation floor (Task #542 / #551).
//
// LIVE-FIRES the real liveCommandPipeline against a throwaway OWNER user and
// proves the per-symbol synthetic-feed-live floor holds at BOTH chokepoints —
// not just for V75, but across a representative slice of the FULL Deriv
// synthetic catalog (standard Volatility, 1-second Volatility, Boom, Crash,
// Step). A per-symbol resolution or classification gap that let one synthetic
// slip past the floor would now fail loudly here. For EACH symbol:
//
//   Pre-floor assertions — the symbol must (a) resolve to a real Deriv broker
//     symbol via resolveDerivSymbol() and (b) classify as a Deriv synthetic /
//     data-only market via getSymbolTradability(). A NOT_FOUND resolution or a
//     non-synthetic classification FAILS the test rather than letting the floor
//     pass vacuously.
//   Test 1 (preflight) — an un-ticking synthetic is refused at createLiveDraft()
//     with reason SYNTHETIC_FEED_NOT_LIVE_CONFIRMED. No arx_live_commands row is
//     written.
//   Test 2 (dispatch re-check) — a draft created WHILE the synthetic is ticking
//     confirms + reaches dispatch, but if the tick goes stale before dispatch
//     the dispatch-time re-check refuses with LIVE_BLOCKED / primaryReason
//     SYNTHETIC_FEED_NOT_LIVE_CONFIRMED:<sym>_no_live_tick, the DB row is
//     LIVE_BLOCKED and was NEVER sent to MT5 (sentToMt5At null).
//   Test 3 (negative control) — a genuinely-ticking synthetic is NOT blocked by
//     the synthetic floor at preflight OR dispatch; it proceeds and blocks only
//     on a LATER, unrelated gate (this user is not admin-approved). This proves
//     the floor is ACCURATE per-symbol, not a blanket synthetic ban, AND that
//     the per-symbol tick actually flowed through the correct resolved derivId.
//
// Safety:
//  - Creates a throwaway OWNER test user; touches no real user data.
//  - No real fill: the master switch / DB arm flag are NOT enabled, all
//    workflows are down, and every command transitions to LIVE_BLOCKED — never
//    SENT_TO_MT5_LIVE. Dispatch != execution.
//  - NEVER weakens the gate under test. The Deriv WS tick cache is stubbed
//    (the documented, test-only seam — same one derivSymbolFeedStatus.test.ts
//    uses) to deterministically present/withhold a live tick per symbol; the
//    floor logic is exercised unchanged. The master connection's broker is
//    genuinely "Deriv (SVG) LLC", so brokerIsDeriv is real, not faked.
//  - Master connection balance/equity/free-margin/heartbeat are bumped for
//    pool freshness/headroom and RESTORED in finally. All seeded rows are
//    deleted in finally; arx_live_commands count is asserted back to baseline.

// The Deriv app-id must be "configured" BEFORE any provider import so the WS
// feed-status helper reports CONNECTING/LIVE_FEED honestly rather than
// UNCONFIGURED. Keep the AUTH_FAILED branch out of play (no token).
const ORIGINAL_DERIV_APP_ID = process.env.DERIV_APP_ID;
const ORIGINAL_DERIV_TOKEN = process.env.DERIV_API_TOKEN;
process.env.DERIV_APP_ID = ORIGINAL_DERIV_APP_ID && ORIGINAL_DERIV_APP_ID.trim()
  ? ORIGINAL_DERIV_APP_ID
  : "test-app-id";
delete process.env.DERIV_API_TOKEN;

import { eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  userSlotAllocationTable,
  userMasterLiveAccessTable,
  arxLiveArmingTable,
  arxLiveCommandsTable,
  arxLiveUserSettingsTable,
  mt5ConnectionTable,
  arxMasterAccountConfigTable,
} from "@workspace/db";

const BASE = process.env.QA_BASE_URL ?? "http://localhost:80";

// Hard runtime guard: this harness mutates real DB rows (it seeds + then deletes
// a throwaway OWNER user, briefly bumps then restores the master connection, and
// asserts arx_live_commands back to baseline). Refuse to run unless explicitly
// allowed.
if (process.env.QA_ALLOW_DB_MUTATION !== "true") {
  console.error("REFUSED: set QA_ALLOW_DB_MUTATION=true to run this harness (it writes to the DB).");
  process.exit(2);
}
// Production is DEFAULT-DENY. A controlled operator-run smoke against the
// deployed environment catches the one drift the DB-free unit test cannot —
// real broker-connection shape + master-account resolution — but it is allowed
// ONLY when the operator ALSO sets the dedicated QA_ALLOW_PROD_SMOKE=true opt-in
// (see docs/SYNTHETIC_LIVE_FLOOR_SMOKE_RUNBOOK.md). The opt-in lifts NOTHING
// else: no real fill can occur (the master switch / DB arm flag are not enabled,
// every command transitions to LIVE_BLOCKED, never SENT_TO_MT5_LIVE), and every
// seeded row plus the master-connection bump are restored in finally.
const looksProd = process.env.NODE_ENV === "production" || /\.replit\.app/.test(BASE);
const allowProdSmoke = process.env.QA_ALLOW_PROD_SMOKE === "true";
if (looksProd && !allowProdSmoke) {
  console.error(
    `REFUSED: harness will not run against production-like target (${BASE}) unless QA_ALLOW_PROD_SMOKE=true is explicitly set (see docs/SYNTHETIC_LIVE_FLOOR_SMOKE_RUNBOOK.md).`,
  );
  process.exit(2);
}
if (looksProd && allowProdSmoke) {
  console.warn(
    `WARNING: running the synthetic-live-floor smoke against a PRODUCTION-like target (${BASE}) — QA_ALLOW_PROD_SMOKE=true. It seeds + deletes a throwaway OWNER user and briefly bumps then restores the master connection; arx_live_commands is asserted back to baseline. No real fill occurs.`,
  );
}

let fails = 0;
let total = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  total++;
  if (ok) console.log(`PASS  ${name}`);
  else { fails++; console.log(`FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : ""); }
}

// Representative slice of the Deriv synthetic catalog — one symbol from each
// distinct family AND derivId shape so a per-family resolution/classification
// gap can't hide: standard Volatility (R_75), 1-second Volatility (1HZ100V),
// Boom (BOOM1000), Crash (CRASH1000), Step (stpRNG), Jump (JD100).
const SYMBOLS = ["V75", "V100_1S", "BOOM1000", "CRASH1000", "STEP", "JUMP100"] as const;

async function main(): Promise<void> {
  // Dynamic imports so the pipeline + provider singletons are the SAME module
  // instances the WS stub below mutates (shared process module graph).
  const { createLiveDraft, confirmLiveCommand, dispatchLiveCommand } =
    await import("../../artifacts/api-server/src/lib/live/liveCommandPipeline.js");
  const { getDerivWsClient } =
    await import("../../artifacts/api-server/src/lib/data/providers/derivWsClient.js");
  const { getDerivSymbolFeedStatus, resolveDerivSymbol } =
    await import("../../artifacts/api-server/src/lib/data/providers/derivProvider.js");
  const { getSymbolTradability } =
    await import("../../artifacts/api-server/src/lib/data/symbolTradability.js");
  const { resolveActiveMasterConnectionId } =
    await import("../../artifacts/api-server/src/lib/live/masterBridgePool.js");

  // ── Pre-floor assertions (per symbol) ──────────────────────────────────
  // Every symbol must resolve to a real Deriv broker symbol AND classify as a
  // Deriv synthetic / data-only market BEFORE the floor is exercised, so a
  // NOT_FOUND resolution or a misclassification fails loudly rather than
  // letting the floor pass vacuously. Build the per-symbol derivId map here.
  const derivIdBySymbol = new Map<string, string>();
  for (const sym of SYMBOLS) {
    const resolved = resolveDerivSymbol(sym);
    check(`${sym} resolves to a real Deriv broker symbol (not NOT_FOUND)`,
      resolved != null && typeof resolved.derivId === "string" && resolved.derivId.length > 0,
      resolved);
    if (!resolved) throw new Error(`resolveDerivSymbol(${sym}) returned null; cannot exercise the floor.`);
    derivIdBySymbol.set(sym, resolved.derivId);

    const trad = await getSymbolTradability(sym, 0);
    check(`${sym} classifies as Deriv synthetic/data-only (floor engages)`,
      trad.assetClass === "synthetic" || trad.dataProvider === "deriv", trad);
    if (!(trad.assetClass === "synthetic" || trad.dataProvider === "deriv")) {
      throw new Error(`${sym} is not a Deriv synthetic; cannot exercise the synthetic floor.`);
    }
  }

  // ── Deriv WS tick-cache stub (documented test-only seam) ────────────────
  // Force a fully-connected client with NO real socket, then seed/clear a
  // GIVEN symbol's per-symbol tick to flip getDerivSymbolFeedStatus(sym).hasRecentTick.
  const wsClient = getDerivWsClient() as unknown as {
    ensureConnection: () => void;
    connected: boolean;
    activeSymbolsCount: number | null;
    authorized: boolean;
    lastAuthorizeError: string | null;
    lastTickAt: number | null;
    lastTickBySymbol: Map<string, { symbol: string; epoch: number; quote: number }>;
  };
  wsClient.ensureConnection = () => {};
  wsClient.connected = true;
  wsClient.activeSymbolsCount = 14;
  wsClient.authorized = false;
  wsClient.lastAuthorizeError = null;
  wsClient.lastTickAt = null;
  wsClient.lastTickBySymbol = new Map();

  const seedTick = (sym: string) => {
    const derivId = derivIdBySymbol.get(sym)!;
    wsClient.lastTickBySymbol.set(derivId, { symbol: derivId, epoch: Math.floor(Date.now() / 1000), quote: 100 });
  };
  const clearTick = () => wsClient.lastTickBySymbol.clear();

  // ── Master connection fixture (bump for pool freshness/headroom) ────────
  const masterConnId = await resolveActiveMasterConnectionId();
  if (masterConnId == null) throw new Error("no active master connection configured");
  const connRows = await db.select().from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.id, masterConnId)).limit(1);
  const conn = connRows[0];
  if (!conn) throw new Error(`master connection ${masterConnId} not found`);
  // The synthetic-floor reason path (SYNTHETIC_FEED_NOT_LIVE_CONFIRMED vs the
  // permanent SYMBOL_NOT_LIVE_TRADABLE data-only floor) only fires when the
  // master broker is Deriv. Assert that's genuinely the case — never fake it.
  const brokerIsDeriv = /deriv/i.test(conn.brokerName ?? "");
  check(`active master broker is Deriv (real, not faked): ${conn.brokerName ?? "(null)"}`,
    brokerIsDeriv, conn.brokerName);
  if (!brokerIsDeriv) {
    throw new Error(`active master broker "${conn.brokerName}" is not Deriv; the SYNTHETIC floor reason cannot fire.`);
  }
  const priorBalance = conn.accountBalance != null ? Number(conn.accountBalance) : null;
  const priorEquity = conn.accountEquity != null ? Number(conn.accountEquity) : null;
  const priorFreeMargin = conn.freeMargin != null ? Number(conn.freeMargin) : null;
  const priorHeartbeat = conn.lastHeartbeat ?? null;

  const liveCmdsBefore = await db.execute(sql`SELECT COUNT(*)::int as c FROM arx_live_commands`);
  const liveCmdsBeforeN = Number((liveCmdsBefore.rows[0] as { c: number }).c);

  let testUserId: number | null = null;

  try {
    await db.update(mt5ConnectionTable).set({
      accountBalance: 100_000,
      accountEquity: 100_000,
      freeMargin: 100_000,
      lastHeartbeat: new Date(),
    }).where(eq(mt5ConnectionTable.id, masterConnId));

    // ── Throwaway OWNER user + minimal live-ready rows ────────────────────
    // role=OWNER drives the owner-unrestricted profile (assignedRiskTemplateId
    // null → fallback). approvedForMasterLive=false avoids MISSING_RISK_TEMPLATE
    // and gives test 3 a clean LATER gate to block on. SL/TP requirements are
    // relaxed via the user's OWN settings (legitimate per-user config — it does
    // NOT touch the synthetic floor) so no flaky live-quote SL-sanity dependency.
    // allowedSymbols carries the FULL representative set so every symbol clears
    // gate 13 (SYMBOL_NOT_ALLOWED) and the synthetic floor is what we observe.
    const [testUser] = await db.insert(usersTable).values({
      email: `qa-synth-floor-${Date.now()}@arx.test`,
      passwordHash: "qa-no-login",
      role: "OWNER",
    }).returning();
    if (!testUser) throw new Error("test user creation failed");
    testUserId = testUser.id;

    await db.insert(arxLiveArmingTable).values({
      userId: testUser.id,
      isArmed: true,
      killSwitchEngaged: false,
      maxLotConfirmed: 1.0,
      accountNumberConfirmed: "99999999",
    });
    await db.insert(userMasterLiveAccessTable).values({
      userId: testUser.id,
      approvedForMasterLive: false,
      requireTakeProfit: false,
    });
    await db.insert(userSlotAllocationTable).values({
      userId: testUser.id,
      allocatedFunds: 50,
      reservedRisk: 0,
      allocationStatus: "active",
      tradingFrozen: false,
      isActive: true,
    });
    await db.insert(arxLiveUserSettingsTable).values({
      userId: testUser.id,
      allowedSymbols: [...SYMBOLS],
      requireStopLoss: false,
      adminAllowNoStopLoss: false,
      maxLotPerMarket: {},
    });

    // ── Per-symbol floor proof ─────────────────────────────────────────────
    for (const sym of SYMBOLS) {
      console.log(`\n── ${sym} ──`);
      const draftInput = {
        userId: testUser.id,
        commandType: "PLACE_LIVE_MARKET_ORDER" as const,
        symbol: sym,
        side: "BUY" as const,
        orderType: "MARKET",
        requestedVolume: 0.01,
      };

      // ── TEST 1 — PREFLIGHT floor blocks an un-ticking synthetic ──────────
      // Snapshot the count immediately BEFORE the draft: prior symbols' test
      // 2/3 legitimately persist LIVE_BLOCKED rows, so the assertion is "no NEW
      // row vs. just before this preflight", not "back to start-of-run baseline".
      clearTick();
      check(`[${sym}] feed status reports NOT live with no tick`,
        getDerivSymbolFeedStatus(sym).hasRecentTick === false);
      const cmdsBefore1 = await db.execute(sql`SELECT COUNT(*)::int as c FROM arx_live_commands`);
      const cmdsBefore1N = Number((cmdsBefore1.rows[0] as { c: number }).c);
      const draft1 = await createLiveDraft(draftInput);
      check(`[${sym}] preflight refuses un-ticking synthetic with SYNTHETIC_FEED_NOT_LIVE_CONFIRMED`,
        draft1.ok === false && draft1.reason === "SYNTHETIC_FEED_NOT_LIVE_CONFIRMED", draft1);
      const cmdsAfter1 = await db.execute(sql`SELECT COUNT(*)::int as c FROM arx_live_commands`);
      check(`[${sym}] preflight refusal wrote NO arx_live_commands row`,
        Number((cmdsAfter1.rows[0] as { c: number }).c) === cmdsBefore1N);

      // ── TEST 2 — DISPATCH re-check blocks a tick-gone-stale synthetic ────
      seedTick(sym);
      check(`[${sym}] feed status reports LIVE with a fresh tick (test 2 draft)`,
        getDerivSymbolFeedStatus(sym).hasRecentTick === true);
      const draft2 = await createLiveDraft(draftInput);
      check(`[${sym}] ticking synthetic passes preflight at draft time (test 2)`,
        draft2.ok === true, draft2);
      if (draft2.ok === true) {
        const commandId2 = draft2.command.commandId;
        const confirm2 = await confirmLiveCommand({ userId: testUser.id, commandId: commandId2 });
        check(`[${sym}] test 2 draft confirms to LIVE_APPROVED`, confirm2.ok === true, confirm2);
        // Tick goes stale between confirm and dispatch.
        clearTick();
        check(`[${sym}] feed status reports NOT live before dispatch (test 2)`,
          getDerivSymbolFeedStatus(sym).hasRecentTick === false);
        const dispatch2 = await dispatchLiveCommand({ userId: testUser.id, commandId: commandId2 });
        const d2 = dispatch2 as unknown as {
          ok: boolean; reason?: string; primaryReason?: string; blockReasons?: string[];
        };
        check(`[${sym}] dispatch re-check blocks stale synthetic with LIVE_BLOCKED`,
          d2.ok === false && d2.reason === "LIVE_BLOCKED", dispatch2);
        check(`[${sym}] dispatch primaryReason is SYNTHETIC_FEED_NOT_LIVE_CONFIRMED:<sym>_no_live_tick`,
          typeof d2.primaryReason === "string"
          && d2.primaryReason === `SYNTHETIC_FEED_NOT_LIVE_CONFIRMED:${sym}_no_live_tick`,
          d2.primaryReason);
        check(`[${sym}] dispatch blockReasons carries the synthetic reason`,
          Array.isArray(d2.blockReasons)
          && d2.blockReasons.includes(`SYNTHETIC_FEED_NOT_LIVE_CONFIRMED:${sym}_no_live_tick`),
          d2.blockReasons);
        const row2 = await db.select().from(arxLiveCommandsTable)
          .where(eq(arxLiveCommandsTable.commandId, commandId2)).limit(1);
        check(`[${sym}] DB row is LIVE_BLOCKED and was NEVER sent to MT5 (sentToMt5At null)`,
          row2[0]?.status === "LIVE_BLOCKED" && row2[0]?.sentToMt5At == null,
          { status: row2[0]?.status, sentToMt5At: row2[0]?.sentToMt5At });
      }

      // ── TEST 3 — NEGATIVE CONTROL: a ticking synthetic is NOT floor-blocked ─
      seedTick(sym);
      check(`[${sym}] feed status reports LIVE with a fresh tick (test 3)`,
        getDerivSymbolFeedStatus(sym).hasRecentTick === true);
      const draft3 = await createLiveDraft(draftInput);
      check(`[${sym}] ticking synthetic passes the preflight floor (test 3)`,
        draft3.ok === true, draft3);
      if (draft3.ok === true) {
        const commandId3 = draft3.command.commandId;
        const confirm3 = await confirmLiveCommand({ userId: testUser.id, commandId: commandId3 });
        check(`[${sym}] test 3 draft confirms to LIVE_APPROVED`, confirm3.ok === true, confirm3);
        // Tick STAYS fresh through dispatch.
        seedTick(sym);
        const dispatch3 = await dispatchLiveCommand({ userId: testUser.id, commandId: commandId3 });
        const d3 = dispatch3 as unknown as { ok: boolean; reason?: string; primaryReason?: string };
        const primary3 = d3.primaryReason ?? "";
        // It may still be blocked (this user is not admin-approved) — that's
        // expected — but NEVER by the synthetic floor.
        check(`[${sym}] ticking synthetic is NOT blocked by the synthetic floor at dispatch`,
          !primary3.startsWith("SYNTHETIC_FEED_NOT_LIVE_CONFIRMED")
          && !primary3.startsWith("SYMBOL_NOT_LIVE_TRADABLE"),
          { ok: d3.ok, reason: d3.reason, primaryReason: d3.primaryReason });
        check(`[${sym}] ticking synthetic still subject to OTHER gates (no real fill: not SENT_TO_MT5_LIVE)`,
          d3.ok === false, dispatch3);
        const row3 = await db.select().from(arxLiveCommandsTable)
          .where(eq(arxLiveCommandsTable.commandId, commandId3)).limit(1);
        check(`[${sym}] test 3 DB row was NEVER sent to MT5 (sentToMt5At null)`,
          row3[0]?.sentToMt5At == null, { status: row3[0]?.status, sentToMt5At: row3[0]?.sentToMt5At });
      }
    }
  } finally {
    // ── Cleanup (FK-safe order) + master restore ──────────────────────────
    if (testUserId != null) {
      await db.delete(arxLiveCommandsTable).where(eq(arxLiveCommandsTable.userId, testUserId));
      await db.delete(arxLiveUserSettingsTable).where(eq(arxLiveUserSettingsTable.userId, testUserId));
      await db.delete(userSlotAllocationTable).where(eq(userSlotAllocationTable.userId, testUserId));
      await db.delete(userMasterLiveAccessTable).where(eq(userMasterLiveAccessTable.userId, testUserId));
      await db.delete(arxLiveArmingTable).where(eq(arxLiveArmingTable.userId, testUserId));
      await db.delete(usersTable).where(eq(usersTable.id, testUserId));
    }
    await db.update(mt5ConnectionTable).set({
      accountBalance: priorBalance,
      accountEquity: priorEquity,
      freeMargin: priorFreeMargin,
      lastHeartbeat: priorHeartbeat,
    }).where(eq(mt5ConnectionTable.id, masterConnId));

    const liveCmdsAfter = await db.execute(sql`SELECT COUNT(*)::int as c FROM arx_live_commands`);
    const liveCmdsAfterN = Number((liveCmdsAfter.rows[0] as { c: number }).c);
    check(`arx_live_commands restored to baseline (${liveCmdsBeforeN} → ${liveCmdsAfterN})`,
      liveCmdsAfterN === liveCmdsBeforeN, { liveCmdsBeforeN, liveCmdsAfterN });

    // Restore Deriv env.
    if (ORIGINAL_DERIV_APP_ID === undefined) delete process.env.DERIV_APP_ID;
    else process.env.DERIV_APP_ID = ORIGINAL_DERIV_APP_ID;
    if (ORIGINAL_DERIV_TOKEN === undefined) delete process.env.DERIV_API_TOKEN;
    else process.env.DERIV_API_TOKEN = ORIGINAL_DERIV_TOKEN;
  }

  console.log(`\n${total - fails}/${total} PASS · ${fails} FAIL`);
  if (fails > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
