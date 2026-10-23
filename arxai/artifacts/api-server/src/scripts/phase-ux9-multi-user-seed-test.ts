// Phase UX9 hardening — seeded multi-user reconciliation suite.
//
// Spawned by scripts/src/phase-ux9-execution-reconciliation-test.ts as the
// "real-DB multi-user" half of T508. Self-contained: seeds 2 users + 2
// connections + 2 mt5_commands with COLLIDING broker_position_id tickets,
// drives the reconciler, exercises the stuck-command watchdog per user,
// asserts the new composite unique index, and verifies every tenant-safety
// + safety-envelope invariant the user spec requires.
//
// NON-DESTRUCTIVE: cleans up every seeded row in reverse FK order.
//
// Usage:
//   pnpm --filter @workspace/api-server exec tsx src/scripts/phase-ux9-multi-user-seed-test.ts

import { db } from "@workspace/db";
import {
  usersTable, mt5ConnectionTable, mt5CommandsTable,
  livePositionsTable, tradeActionRequestsTable,
  globalTradingSettingsTable, notificationsTable,
} from "@workspace/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { reconcileExecutionResult } from "../lib/mt5/executionReconciler.js";
import { sweepStuckCommands } from "../lib/mt5/stuckCommandWatchdog.js";
import { placeLiveOrderGuarded } from "../lib/adminTrading/placeOrder.js";

type R = { name: string; pass: boolean; detail?: string };
const results: R[] = [];
function rec(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const SECRET_KEYS = [
  "apiKeyHash", "passwordHash", "tokenLast4", "tokenHash",
  "encryptedCredentials", "MT5_BRIDGE_TOKEN", "SESSION_SECRET",
];
function leakedSecrets(o: unknown): string[] {
  const found = new Set<string>();
  function walk(x: unknown) {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      if (SECRET_KEYS.includes(k) && v != null) found.add(k);
      walk(v);
    }
  }
  walk(o); return [...found];
}

async function main() {
  const createdUserIds: number[] = [];
  const createdConnIds: number[] = [];
  const createdCmdIds: number[] = [];
  const createdLpIds: number[] = [];
  const createdArIds: number[] = [];
  const createdNotifIds: number[] = [];

  // Snapshot global settings to restore at end.
  const [globalBefore] = await db.select().from(globalTradingSettingsTable).limit(1);
  if (!globalBefore) throw new Error("global_trading_settings row missing");

  const stamp = Date.now();
  // Collision ticket — same broker_position_id from two different EAs.
  const sharedTicket = `ux9h-${stamp}`;
  const sharedOrderTicket = `ord-${stamp}`;

  try {
    // ── Seed: 2 users + 2 demo connections ──
    const [u1] = await db.insert(usersTable).values({
      email: `ux9h-u1-${stamp}@arx.test`, name: "UX9H U1",
      role: "USER", passwordHash: "x",
    } as never).returning();
    const [u2] = await db.insert(usersTable).values({
      email: `ux9h-u2-${stamp}@arx.test`, name: "UX9H U2",
      role: "USER", passwordHash: "x",
    } as never).returning();
    createdUserIds.push(u1!.id, u2!.id);

    const [c1] = await db.insert(mt5ConnectionTable).values({
      userId: u1!.id, connectionName: "UX9H u1 demo",
      accountNumber: `99000${stamp % 1000}1`, brokerName: "TestBroker",
      accountType: "demo", status: "connected",
    } as never).returning();
    const [c2] = await db.insert(mt5ConnectionTable).values({
      userId: u2!.id, connectionName: "UX9H u2 demo",
      accountNumber: `99000${stamp % 1000}2`, brokerName: "TestBroker",
      accountType: "demo", status: "connected",
    } as never).returning();
    createdConnIds.push(c1!.id, c2!.id);

    // ── Seed: one OPEN command per user, same broker symbol+side ──
    const [cmd1] = await db.insert(mt5CommandsTable).values({
      userId: u1!.id, mt5ConnectionId: c1!.id, action: "OPEN",
      symbol: "EURUSD", side: "BUY", lot: 0.10,
      status: "sent", safetyMode: "paper_only",
    } as never).returning();
    const [cmd2] = await db.insert(mt5CommandsTable).values({
      userId: u2!.id, mt5ConnectionId: c2!.id, action: "OPEN",
      symbol: "EURUSD", side: "BUY", lot: 0.05,
      status: "sent", safetyMode: "paper_only",
    } as never).returning();
    createdCmdIds.push(cmd1!.id, cmd2!.id);

    // ── Seed: one action_request per user, linked to its command ──
    const [ar1] = await db.insert(tradeActionRequestsTable).values({
      userId: u1!.id, tradeCommandId: cmd1!.id, actionType: "OPEN_TRADE",
      requestedMode: "DEMO", accountType: "demo", routingMode: "USER_OWNED_MT5",
      symbol: "EURUSD", side: "BUY", lotSize: 0.10,
      status: "sent_to_mt5", tradeKey: `ux9h-${stamp}-1`,
    } as never).returning();
    const [ar2] = await db.insert(tradeActionRequestsTable).values({
      userId: u2!.id, tradeCommandId: cmd2!.id, actionType: "OPEN_TRADE",
      requestedMode: "DEMO", accountType: "demo", routingMode: "USER_OWNED_MT5",
      symbol: "EURUSD", side: "BUY", lotSize: 0.05,
      status: "sent_to_mt5", tradeKey: `ux9h-${stamp}-2`,
    } as never).returning();
    createdArIds.push(ar1!.id, ar2!.id);

    // ── 21. Same broker_position_id from two different users does NOT collide ──
    const cmd1Row = (await db.select().from(mt5CommandsTable)
      .where(eq(mt5CommandsTable.id, cmd1!.id)).limit(1))[0]!;
    const out1 = await reconcileExecutionResult({
      command: cmd1Row,
      result: {
        commandId: cmd1!.id, actionRequestId: ar1!.id, status: "executed",
        mt5OrderTicket: sharedOrderTicket, mt5PositionTicket: sharedTicket,
        symbol: "EURUSD", side: "BUY", lotSizeFilled: 0.10,
        fillPrice: 1.10000, executedAt: new Date(),
      },
    });
    const cmd2Row = (await db.select().from(mt5CommandsTable)
      .where(eq(mt5CommandsTable.id, cmd2!.id)).limit(1))[0]!;
    const out2 = await reconcileExecutionResult({
      command: cmd2Row,
      result: {
        commandId: cmd2!.id, actionRequestId: ar2!.id, status: "executed",
        mt5OrderTicket: sharedOrderTicket, mt5PositionTicket: sharedTicket,
        symbol: "EURUSD", side: "BUY", lotSizeFilled: 0.05,
        fillPrice: 1.10010, executedAt: new Date(),
      },
    });
    const lpRows = await db.select().from(livePositionsTable)
      .where(and(
        eq(livePositionsTable.brokerPositionId, sharedTicket),
        inArray(livePositionsTable.userId, [u1!.id, u2!.id]),
      ));
    for (const r of lpRows) createdLpIds.push(r.id);
    const lpU1 = lpRows.find((r) => r.userId === u1!.id);
    const lpU2 = lpRows.find((r) => r.userId === u2!.id);
    rec("21 same broker_position_id reported by 2 users yields 2 distinct live_positions rows",
      lpRows.length === 2 && !!lpU1 && !!lpU2
      && lpU1.id !== lpU2.id && lpU1.lotSize === 0.10 && lpU2.lotSize === 0.05
      && out1.ok && out2.ok && !!out1.livePositionId && !!out2.livePositionId
      && out1.livePositionId !== out2.livePositionId,
      `rows=${lpRows.length} u1lp=${lpU1?.id} u2lp=${lpU2?.id}`);

    // ── 22. Duplicate callback for same (user, command) → idempotent ──
    const cmd1After = (await db.select().from(mt5CommandsTable)
      .where(eq(mt5CommandsTable.id, cmd1!.id)).limit(1))[0]!;
    const out1Dup = await reconcileExecutionResult({
      command: cmd1After,
      result: {
        commandId: cmd1!.id, actionRequestId: ar1!.id, status: "executed",
        mt5OrderTicket: sharedOrderTicket, mt5PositionTicket: sharedTicket,
        fillPrice: 1.10000, executedAt: new Date(),
      },
    });
    const lpAfterDup = await db.select().from(livePositionsTable)
      .where(and(
        eq(livePositionsTable.brokerPositionId, sharedTicket),
        eq(livePositionsTable.userId, u1!.id),
      ));
    rec("22 duplicate callback for same (user, command) is rejected as duplicate",
      out1Dup.reconciled === false && out1Dup.duplicate === true
      && lpAfterDup.length === 1,
      `dup=${out1Dup.duplicate} reason=${out1Dup.reason} rows=${lpAfterDup.length}`);

    // ── 23. Wrong actionRequestId is rejected (other user's AR) ──
    // Seed a 3rd OPEN command for u1 and try to reconcile it pointing to u2's
    // action request. The reconciler scopes action_request lookup by
    // command.userId, so u2's AR must NOT be touched.
    const [cmd3] = await db.insert(mt5CommandsTable).values({
      userId: u1!.id, mt5ConnectionId: c1!.id, action: "OPEN",
      symbol: "GBPUSD", side: "SELL", lot: 0.07,
      status: "sent", safetyMode: "paper_only",
    } as never).returning();
    createdCmdIds.push(cmd3!.id);
    const ar2Before = (await db.select().from(tradeActionRequestsTable)
      .where(eq(tradeActionRequestsTable.id, ar2!.id)).limit(1))[0]!;
    await reconcileExecutionResult({
      command: cmd3!,
      result: {
        commandId: cmd3!.id, actionRequestId: ar2!.id, // foreign AR id
        status: "executed",
        mt5OrderTicket: `ord-${stamp}-x`, mt5PositionTicket: `tkt-${stamp}-x`,
        symbol: "GBPUSD", side: "SELL", lotSizeFilled: 0.07,
        fillPrice: 1.27000, executedAt: new Date(),
      },
    });
    const ar2After = (await db.select().from(tradeActionRequestsTable)
      .where(eq(tradeActionRequestsTable.id, ar2!.id)).limit(1))[0]!;
    rec("23 wrong actionRequestId (foreign user) is ignored — other user's AR untouched",
      ar2Before.updatedAt?.getTime() === ar2After.updatedAt?.getTime()
      && ar2After.userId === u2!.id,
      `before=${ar2Before.updatedAt?.toISOString()} after=${ar2After.updatedAt?.toISOString()}`);

    // Cleanup the LP created by cmd3 so the next assertions stay tight.
    const cmd3Lps = await db.select().from(livePositionsTable)
      .where(eq(livePositionsTable.brokerPositionId, `tkt-${stamp}-x`));
    for (const r of cmd3Lps) createdLpIds.push(r.id);

    // ── 24. Watchdog state transitions stay per-user ──
    // Seed a stuck command for u1 only (created > 5min ago, status=PENDING).
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000);
    const [stuck1] = await db.insert(mt5CommandsTable).values({
      userId: u1!.id, mt5ConnectionId: c1!.id, action: "MODIFY",
      symbol: "EURUSD", side: "BUY", lot: 0,
      status: "PENDING", safetyMode: "paper_only",
    } as never).returning();
    createdCmdIds.push(stuck1!.id);
    await db.update(mt5CommandsTable).set({ createdAt: sixMinAgo })
      .where(eq(mt5CommandsTable.id, stuck1!.id));

    // u2 has a fresh PENDING command — must NOT be swept.
    const [fresh2] = await db.insert(mt5CommandsTable).values({
      userId: u2!.id, mt5ConnectionId: c2!.id, action: "MODIFY",
      symbol: "EURUSD", side: "BUY", lot: 0,
      status: "PENDING", safetyMode: "paper_only",
    } as never).returning();
    createdCmdIds.push(fresh2!.id);

    const sweep = await sweepStuckCommands();
    const stuck1After = (await db.select().from(mt5CommandsTable)
      .where(eq(mt5CommandsTable.id, stuck1!.id)).limit(1))[0]!;
    const fresh2After = (await db.select().from(mt5CommandsTable)
      .where(eq(mt5CommandsTable.id, fresh2!.id)).limit(1))[0]!;
    rec("24 watchdog only marks u1's stuck command — u2's fresh command untouched",
      stuck1After.status === "failed" && stuck1After.userId === u1!.id
      && fresh2After.status === "PENDING" && fresh2After.userId === u2!.id
      && sweep.marked >= 1,
      `u1=${stuck1After.status} u2=${fresh2After.status} swept=${sweep.marked}`);

    // ── 25. Reconciler never opens/closes trades — only mirrors broker ──
    // Verified by counting mt5_commands rows for u1 BEFORE and AFTER another
    // reconcile call. Reconciler must NOT create new commands.
    const u1CmdCountBefore = Number((await db.select({ c: sql<number>`count(*)` })
      .from(mt5CommandsTable).where(eq(mt5CommandsTable.userId, u1!.id)))[0]!.c);
    const [cmd4] = await db.insert(mt5CommandsTable).values({
      userId: u1!.id, mt5ConnectionId: c1!.id, action: "CLOSE",
      symbol: "EURUSD", side: "BUY", lot: 0.10,
      status: "sent", safetyMode: "paper_only",
    } as never).returning();
    createdCmdIds.push(cmd4!.id);
    const cmd4CountSeed = Number((await db.select({ c: sql<number>`count(*)` })
      .from(mt5CommandsTable).where(eq(mt5CommandsTable.userId, u1!.id)))[0]!.c);
    await reconcileExecutionResult({
      command: cmd4!,
      result: {
        commandId: cmd4!.id, status: "executed",
        mt5OrderTicket: sharedOrderTicket, mt5PositionTicket: sharedTicket,
        symbol: "EURUSD", side: "BUY", lotSizeFilled: 0.10,
        fillPrice: 1.10500, executedAt: new Date(),
      },
    });
    const u1CmdCountAfter = Number((await db.select({ c: sql<number>`count(*)` })
      .from(mt5CommandsTable).where(eq(mt5CommandsTable.userId, u1!.id)))[0]!.c);
    rec("25 reconciler never creates new mt5_commands rows (no auto-open/close)",
      u1CmdCountAfter === cmd4CountSeed && cmd4CountSeed === u1CmdCountBefore + 1,
      `before=${u1CmdCountBefore} seed=${cmd4CountSeed} after=${u1CmdCountAfter}`);

    // ── 26. Reconciler only records broker-reported results (no fabrication) ──
    const cmd4After = (await db.select().from(mt5CommandsTable)
      .where(eq(mt5CommandsTable.id, cmd4!.id)).limit(1))[0]!;
    rec("26 reconciler stores ONLY the fields the broker reported (verbatim)",
      cmd4After.fillPrice === 1.10500
      && cmd4After.mt5OrderTicket === sharedOrderTicket
      && cmd4After.mt5PositionTicket === sharedTicket
      && cmd4After.filledLotSize === 0.10
      && cmd4After.status === "completed",
      `fill=${cmd4After.fillPrice} ord=${cmd4After.mt5OrderTicket} pos=${cmd4After.mt5PositionTicket}`);

    // ── 27. No secrets exposed in reconcile outcome objects ──
    const leakAll = [
      leakedSecrets(out1), leakedSecrets(out2), leakedSecrets(out1Dup),
    ].flat();
    rec("27 reconciler outcomes never expose secrets (apiKeyHash, tokens, etc.)",
      leakAll.length === 0,
      leakAll.length ? `leaked: ${leakAll.join(",")}` : "none");

    // ── 28. PAPER_ONLY hard-lock still intact after reconciliation ──
    const [globalAfter] = await db.select().from(globalTradingSettingsTable).limit(1);
    rec("28 PAPER_ONLY hard-lock unchanged by reconciler (live still locked)",
      globalAfter?.liveEnabled === globalBefore.liveEnabled
      && globalAfter?.emergencyKillSwitch === globalBefore.emergencyKillSwitch
      && globalAfter?.platformMode === globalBefore.platformMode,
      `live=${globalAfter?.liveEnabled} kill=${globalAfter?.emergencyKillSwitch}`);

    // ── 29. placeLiveOrderGuarded never returns ok:true (live execution layer locked) ──
    // NOTE: the exact rejection reason depends on which gate trips first for
    // a given seed. With these brand-new users, the earliest gate to reject
    // is USER_TRADING_DISABLED / USER_OWNED_LIVE_REQUIRES_VERIFIED_LIVE_ACCOUNT.
    // The literal "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED" is the LAST-resort
    // return after all 10 prior gates pass, and is also enforced statically
    // by the live-trading-readiness-lock CI guard (`scripts/src/ci/`). The
    // invariant we exercise here is simply: NO live placement attempt ever
    // returns ok:true, regardless of seed.
    let liveResult: { ok?: boolean; reason?: string } = {};
    let placeThrew = false;
    try {
      liveResult = await placeLiveOrderGuarded({
        userId: u1!.id, symbol: "EURUSD", side: "BUY", lotSize: 0.01,
      } as never);
    } catch {
      placeThrew = true;
    }
    const neverOk = placeThrew || liveResult.ok === false;
    // Source-level proof of the BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED literal.
    const orderGuardSrc = (await import("node:fs")).readFileSync(
      (await import("node:path")).resolve(import.meta.dirname, "../lib/adminTrading/orderGuard.ts"),
      "utf8");
    const hasGuardLiteral =
      /BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED/.test(orderGuardSrc)
      && /return\s+BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED/.test(orderGuardSrc);
    rec("29 placeLiveOrderGuarded never returns ok:true and source still pins BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED",
      neverOk && hasGuardLiteral,
      `neverOk=${neverOk} threw=${placeThrew} reasonHead=${(liveResult.reason ?? "").slice(0, 80)} hasLiteral=${hasGuardLiteral}`);

    // ── 30. Composite unique index live_positions_user_broker_position_uq exists ──
    const idxQ = await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname='public' AND tablename='live_positions'
    `);
    const idxRows = (idxQ as unknown as { rows?: Array<{ indexname: string; indexdef: string }> }).rows
                  ?? (idxQ as unknown as Array<{ indexname: string; indexdef: string }>);
    const hasComposite = idxRows.some((r) =>
      r.indexname === "live_positions_user_broker_position_uq"
      && /\(user_id, broker_position_id\)/.test(r.indexdef)
      && /NULLS NOT DISTINCT/i.test(r.indexdef));
    const oldGlobalGone = !idxRows.some((r) =>
      r.indexname === "live_positions_broker_position_id_uq");
    rec("30 composite unique index (user_id, broker_position_id) present; old global index dropped",
      hasComposite && oldGlobalGone,
      `composite=${hasComposite} oldGone=${oldGlobalGone}`);

  } finally {
    // ── Cleanup in reverse FK order ──
    try {
      // Capture all notifications generated for these users during the run.
      const notifs = await db.select({ id: notificationsTable.id })
        .from(notificationsTable)
        .where(inArray(notificationsTable.userId, createdUserIds));
      for (const n of notifs) createdNotifIds.push(n.id);

      if (createdNotifIds.length)
        await db.delete(notificationsTable).where(inArray(notificationsTable.id, createdNotifIds));
      if (createdArIds.length)
        await db.delete(tradeActionRequestsTable).where(inArray(tradeActionRequestsTable.id, createdArIds));
      if (createdLpIds.length)
        await db.delete(livePositionsTable).where(inArray(livePositionsTable.id, createdLpIds));
      if (createdCmdIds.length)
        await db.delete(mt5CommandsTable).where(inArray(mt5CommandsTable.id, createdCmdIds));
      if (createdConnIds.length)
        await db.delete(mt5ConnectionTable).where(inArray(mt5ConnectionTable.id, createdConnIds));
      if (createdUserIds.length)
        await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
      // Restore global settings snapshot.
      await db.update(globalTradingSettingsTable).set({
        platformMode: globalBefore.platformMode,
        liveEnabled: globalBefore.liveEnabled,
        emergencyKillSwitch: globalBefore.emergencyKillSwitch,
      } as never).where(eq(globalTradingSettingsTable.id, globalBefore.id));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("cleanup_failed", e);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  // eslint-disable-next-line no-console
  console.log(`\nUX9 multi-user seed: ${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ""}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("ux9_multi_user_seed_fatal", e);
  process.exit(1);
});
