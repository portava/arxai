// Run only via the disposable Unix-socket PostgreSQL runner. All venue delivery
// is an in-process fixture; no account, provider or order endpoint is contacted.
import { after, before, beforeEach, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  sql,
  getTableColumns,
  getTableName,
  SQL,
} from "drizzle-orm";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { PgDialect, type PgTable } from "drizzle-orm/pg-core";
const destination = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
assert.equal(process.env.ARX_MANAGEMENT_TARGET_PG, "1");
assert.equal(destination.pathname, "/arx_management_target_test");
assert.match(
  destination.searchParams.get("host") ?? "",
  /\/arx-management-target-[^/]+\/socket$/,
);
assert.equal(destination.username, "arx_qa");
const database = await import("@workspace/db");
const {
  db,
  pool,
  arxLiveCommandsTable: commands,
  arxLivePositionsTable: positions,
  mt5ConnectionTable: bridges,
  selfTradeAgentExecutionsTable: executions,
  selfTradeAgentsTable: agents,
  selfTradeAgentSettingsTable: agentSettings,
  selfTradeDecisionsTable: decisions,
  selfTradeAuditLogTable: selfAudit,
  userOneClickSettingsTable: settings,
  oneClickAuditTable: instantAudit,
  liveTradingAuditTable: audit,
  executionEventsTable: executionEvents,
  securityEventsTable: securityEvents,
  selfTradeAgentLedgerTable: agentLedger,
  selfTradeLedgerEntriesTable: ledgerEntries,
  arxSymbolSpecsTable: specs,
  userSlotAllocationTable: allocations,
  arxDispatchExposureReservationsTable: reservations,
  resultSettlementJobsTable: settlementJobs,
  mt5CommandsTable: mailbox,
  symbolsTable: symbolRegistry,
} = database;
process.env.SESSION_SECRET = "synthetic-offline-management-signing-material";
mock.method(globalThis, "fetch", async () => {
  throw new Error("Unexpected external request");
});
const realArming = await import("../../live/liveArming.js");
mock.module("../../live/liveArming.js", {
  namedExports: {
    ...realArming,
    getMyArming: async () => ({
      isArmed: true,
      killSwitchEngaged: false,
      accountNumberConfirmed: "A",
    }),
  },
});
const realSecurityEvents = await import("../../security/events.js");
mock.module("../../security/events.js", {
  namedExports: {
    ...realSecurityEvents,
    mirrorCriticalEvent: async () => undefined,
    recordSecurityEvent: async () => undefined,
  },
});
mock.module("../../security/handshake.js", {
  namedExports: { enforceSensitiveAction: async () => ({ ok: true }) },
});
const realAccess = await import("../../mt5/userMasterLiveAccessGate.js");
mock.module("../../mt5/userMasterLiveAccessGate.js", {
  namedExports: {
    ...realAccess,
    loadAndEvaluateUserMasterLiveAccessGate: async () => ({
      decision: "ALLOWED",
    }),
  },
});
mock.module("../../concurrency/rateLimit.js", {
  namedExports: {
    tryConsumeToken: () => true,
    checkSymbolCooldown: () => true,
  },
});
mock.module("../../joinRequests/notifyAdmins.js", {
  namedExports: { listAdminUserIds: async () => [] },
});
mock.module("../../notificationService.js", {
  namedExports: { createNotification: async () => undefined },
});
let missionCloseCalls = 0;
mock.module("../../missionExitManager.js", {
  namedExports: {
    recordMissionTradeCloseByBrokerTicket: async () => { missionCloseCalls++; },
  },
});
const {
  resolveManagementTarget,
  createManagementDraft,
  ManagementTargetError,
  boundManagementTransportSymbol,
  managementTargetFromCommand,
  isAgentManagementCommand,
  MANAGEMENT_TARGET_SOURCE,
} = await import("../managementTarget.js");
const { claimLiveCommandForConfirm, claimLiveCommandForDispatch } =
  await import("../../live/liveCommandCas.js");
const {
  createLiveOpsDraft,
  buildBridgedMt5CommandPayload,
  readLiveModifyRiskPosition,
  reconcileBoundManagementClose,
  reconcileGhostClosedPositions,
  recordLiveCommandResult,
  pickupNextLiveCommand,
} = await import("../../live/liveCommandPipeline.js");
let deliveries = 0;
mock.module("../../tradeEngine/pipeline.js", {
  namedExports: {
    submitInstantTrade: async (args: Parameters<typeof executeInstant>[0]) =>
      executeInstant(args),
    draftTrade: async (
      _mode: unknown,
      input: Parameters<typeof createLiveOpsDraft>[0],
    ) => createLiveOpsDraft(input),
    confirmTrade: async (_mode: unknown, input: { commandId: string }) => ({
      ok: !!(await claimLiveCommandForConfirm(input.commandId, {
        status: "LIVE_APPROVED",
      })),
    }),
    dispatchTrade: async (_mode: unknown, input: { commandId: string }) => {
      const [current] = await db
        .select()
        .from(commands)
        .where(eq(commands.commandId, input.commandId));
      const claimed = await claimLiveCommandForDispatch(
        input.commandId,
        {
          status: "SENT_TO_MT5_LIVE",
          bridgeConnectionId: current!.bridgeConnectionId,
          accountLogin: current!.accountLogin,
          brokerServer: current!.brokerServer,
        },
        current,
      );
      if (claimed) deliveries++;
      return { ok: !!claimed };
    },
  },
});
const { executeInstant } = await import("../../live/instantTrade.js");
const { verifyCommandIntegrityForDispatch } =
  await import("../../security/commandIntegrity.js");
const { manageAgentPositions } = await import("../livePositionManager.js");
const { guardianInstantManage } =
  await import("../../positionGuardian/manage.js");
const { livePositionWriter } = await import("../../positions/ledger.js");
const { updateConnection } = await import("../../brokerHub/connections.js");
const { reportedManagementIdentity } =
  await import("../managementConsumers.js");
const { reconcileAgentExecutions } = await import("../agentReconciliation.js");
const { applyRealizedFromFills, defundAgent } =
  await import("../agentLedger.js");
const tables = [
  bridges,
  commands,
  positions,
  executions,
  settings,
  audit,
  instantAudit,
  agents,
  agentSettings,
  decisions,
  selfAudit,
  executionEvents,
  securityEvents,
  specs,
  allocations,
  agentLedger,
  ledgerEntries,
  reservations,
  settlementJobs,
  mailbox,
  symbolRegistry,
];
const dialect = new PgDialect();
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
function value(v: unknown): string {
  if (v instanceof SQL) {
    const q = dialect.sqlToQuery(v);
    assert.equal(q.params.length, 0);
    return q.sql;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return `'${(typeof v === "string" ? v : JSON.stringify(v)).replaceAll("'", "''")}'`;
}
before(async () => {
  for (const table of tables) {
    if (table === settlementJobs) continue;
    const columns = Object.values(getTableColumns(table)).map(
      (c) =>
        `${quote(c.name)} ${c.getSQLType()}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? ` DEFAULT ${value(c.default)}` : ""}${c.primary ? " PRIMARY KEY" : ""}`,
    );
    await pool.query(
      `CREATE TABLE ${quote(getTableName(table))} (${columns.join(",")})`,
    );
  }
  await pool.query(readFileSync(new URL("../../../../../../lib/db/migrations/2026-10-26_result_settlement_outbox.sql", import.meta.url), "utf8"));
  // Intentionally allow two ledger rows with a reused ticket to exercise the
  // future composite-identity world as well as today's overwritten-row failure.
  // This fixture does NOT assert that the production user+ticket index is fixed.
  await pool.query(
    "CREATE UNIQUE INDEX qa_command_identity ON arx_live_commands(command_id)",
  );
  await pool.query(
    "CREATE UNIQUE INDEX execution_events_command_seq_uq ON execution_events(command_id,sequence_no)",
  );
});
after(async () => {
  await pool.end();
});
const reference = { executionId: 1, positionRowId: 1, claimId: "claim-1" };
async function resetFixture() {
  deliveries = 0;
  missionCloseCalls = 0;
  await pool.query(
    `TRUNCATE ${tables.map((t) => quote(getTableName(t))).join(",")} RESTART IDENTITY`,
  );
  await db.insert(bridges).values([
    {
      id: 1,
      userId: 9,
      accountNumber: "A",
      brokerName: "Venue Company",
      serverName: "Venue-Server-1",
      capabilities: { supportsManagementTargetV1: true },
      apiKeyHash: "fixture-a",
      status: "connected",
      accountType: "live",
      mode: "LIVE",
    },
    {
      id: 2,
      userId: 9,
      accountNumber: "B",
      brokerName: "Venue Company",
      serverName: "Venue-Server-2",
      apiKeyHash: "fixture-b",
      status: "connected",
      accountType: "live",
      mode: "LIVE",
    },
  ]);
  await db.insert(commands).values({
    commandId: "entry-1",
    userId: 9,
    bridgeConnectionId: 1,
    accountLogin: "A",
    brokerServer: "Venue Company",
    commandType: "PLACE_LIVE_MARKET_ORDER",
    status: "LIVE_FILLED",
    symbol: "EURUSD.a",
    side: "BUY",
    orderType: "MARKET_BUY",
    requestedVolume: 0.1,
    executedVolume: 0.1,
    fillPrice: 1.1,
    brokerTicket: "123",
    selfTradeAgentId: 4,
    selfTradeDecisionId: 7,
    payload: {
      selfTradeSymbolBinding: {
        requestedSymbol: "EURUSD",
        brokerSymbol: "EURUSD.a",
      },
      agentOwnership: {
        selfTradeAgentId: 4,
        selfTradeDecisionId: 7,
        selfTradeAgentKey: "agent",
      },
    },
  });
  await db.insert(executions).values({
    id: 1,
    agentId: 4,
    agentKey: "agent",
    decisionId: 7,
    executingUserId: 9,
    symbol: "EURUSD",
    side: "BUY",
    intendedVolume: 0.1,
    mode: "LIVE",
    fillPrice: 1.1,
    commandId: "entry-1",
    status: "FILLED",
    brokerTicket: "123",
    idempotencyKey: "entry",
    managementState: {
      pendingManagement: {
        claimId: "claim-1",
        action: "EXIT",
        stopLoss: null,
        requestedAt: new Date().toISOString(),
      },
    },
  });
  await db.insert(positions).values({
    id: 1,
    userId: 9,
    bridgeConnectionId: 1,
    accountLogin: "A",
    brokerServer: "Venue Company",
    brokerTicket: "123",
    symbol: "EURUSD.a",
    side: "BUY",
    volume: 0.1,
    entryPrice: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    openedAt: new Date(),
    sourceCommandId: "entry-1",
  });
  await db.insert(settings).values({ userId: 9, liveOneClickEnabled: true });
  await db.insert(agents).values({
    id: 4,
    agentKey: "agent",
    name: "Offline fixture",
    profileTemplate: "ALPHA",
    ownerType: "USER",
    ownerId: 9,
    autonomyLevel: 3,
  });
  await db.insert(decisions).values({
    id: 7,
    agentId: 4,
    agentKey: "agent",
    cycleId: "fixture",
    symbol: "EURUSD",
    side: "BUY",
    outcome: "APPROVED",
    plannedAction: "EXECUTE",
    reason: "Offline fixture",
    thesis: { stopLoss: 1.09, takeProfits: [], invalidation: null },
  });
  await pool.query(
    "SELECT setval(pg_get_serial_sequence('self_trade_agent_executions','id'),1,true)",
  );
}
beforeEach(resetFixture);
const target = async () => (await resolveManagementTarget(9, reference)).target;
async function draft(inputTarget?: Awaited<ReturnType<typeof target>>) {
  const targetValue = inputTarget ?? (await target());
  const r = await createLiveOpsDraft({
    userId: 9,
    commandType:
      targetValue.action === "EXIT"
        ? "CLOSE_LIVE_POSITION"
        : "MODIFY_LIVE_SLTP",
    brokerTicket: targetValue.brokerTicket,
    symbol: targetValue.symbol,
    side: targetValue.side,
    volume: targetValue.volume,
    newStopLoss: targetValue.nextStopLoss,
    newTakeProfit:
      targetValue.action === "EXIT" ? null : targetValue.currentTakeProfit,
    managementTarget: targetValue,
    sourcePage: MANAGEMENT_TARGET_SOURCE,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as Extract<typeof r, { ok: true }>).command;
}
async function approved() {
  const row = await draft();
  return (await claimLiveCommandForConfirm(
    row.commandId,
    { status: "LIVE_APPROVED" },
    row,
  ))!;
}
async function send(row: Awaited<ReturnType<typeof approved>>) {
  return claimLiveCommandForDispatch(
    row.commandId,
    {
      status: "SENT_TO_MT5_LIVE",
      bridgeConnectionId: row.bridgeConnectionId,
      accountLogin: row.accountLogin,
      brokerServer: row.brokerServer,
    },
    row,
  );
}
function denied(promise: Promise<unknown>, reason: string) {
  return assert.rejects(
    promise,
    (e: unknown) => e instanceof ManagementTargetError && e.reason === reason,
  );
}

it("reused ticket on another account cannot replace the exact selected position", async () => {
  await db.insert(positions).values({
    id: 2,
    userId: 9,
    bridgeConnectionId: 2,
    accountLogin: "B",
    brokerServer: "Venue Company",
    brokerTicket: "123",
    symbol: "EURUSD.a",
    side: "BUY",
    volume: 0.1,
    entryPrice: 1.1,
    openedAt: new Date(),
    sourceCommandId: "entry-1",
  });
  assert.equal((await target()).accountLogin, "A");
  await denied(
    resolveManagementTarget(9, { ...reference, positionRowId: 2 }),
    "MANAGEMENT_POSITION_IDENTITY_CHANGED",
  );
});
it("no other user, execution, source entry or unknown legacy identity can supply a target", async () => {
  await denied(
    resolveManagementTarget(8, reference),
    "MANAGEMENT_ENTRY_IDENTITY_UNVERIFIED",
  );
  await denied(
    resolveManagementTarget(9, { ...reference, executionId: 2 }),
    "MANAGEMENT_ENTRY_IDENTITY_UNVERIFIED",
  );
  await livePositionWriter.update(
    { sourceCommandId: null },
    eq(positions.id, 1),
  );
  await denied(target(), "MANAGEMENT_POSITION_IDENTITY_CHANGED");
  await livePositionWriter.update(
    { sourceCommandId: "entry-1" },
    eq(positions.id, 1),
  );
  await updateConnection(1, { serverName: null });
  await denied(target(), "MANAGEMENT_BRIDGE_IDENTITY_CHANGED");
});
it("same ticket row overwritten after selection refuses before a command is inserted", async () => {
  const t = await target();
  await livePositionWriter.update(
    { bridgeConnectionId: 2, accountLogin: "B" },
    eq(positions.id, 1),
  );
  const r = await createLiveOpsDraft({
    userId: 9,
    commandType: "CLOSE_LIVE_POSITION",
    brokerTicket: "123",
    symbol: "EURUSD.a",
    side: "BUY",
    volume: 0.1,
    managementTarget: t,
  });
  assert.deepEqual(r, {
    ok: false,
    reason: "MANAGEMENT_POSITION_IDENTITY_CHANGED",
  });
  assert.equal((await db.select().from(commands)).length, 1);
});
it("concurrent draft attempts link one command and reject the duplicate", async () => {
  const t = await target();
  const input = {
    userId: 9,
    commandType: "CLOSE_LIVE_POSITION" as const,
    brokerTicket: "123",
    symbol: "EURUSD.a",
    side: "BUY" as const,
    volume: 0.1,
    managementTarget: t,
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => createLiveOpsDraft(input)),
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(
    results.filter(
      (r) => !r.ok && r.reason === "MANAGEMENT_CLAIM_ALREADY_LINKED",
    ).length,
    7,
  );
  assert.equal((await db.select().from(commands)).length, 2);
  const [e] = await db.select().from(executions);
  assert.ok((e!.managementState as any).pendingManagement.commandId);
});
it("draft insert and command link roll back together if creation fails", async () => {
  const t = await target();
  await assert.rejects(
    createManagementDraft(t, async (tx) => {
      await tx.insert(commands).values({
        commandId: "crash",
        userId: 9,
        commandType: "CLOSE_LIVE_POSITION",
        symbol: "EURUSD.a",
        side: "BUY",
        orderType: "CLOSE",
        requestedVolume: 0.1,
      });
      throw new Error("crash before linkage");
    }),
    /crash before linkage/,
  );
  assert.equal((await db.select().from(commands)).length, 1);
  assert.equal(
    (await db.select().from(executions))[0]!.managementState &&
      (await target()).claimId,
    "claim-1",
  );
  await draft(t);
});
it("restarted retry after committed draft cannot create another command", async () => {
  const t = await target();
  const first = await draft(t);
  await denied(
    createManagementDraft(t, async () => {
      throw new Error("must not create");
    }),
    "MANAGEMENT_CLAIM_ALREADY_LINKED",
  );
  assert.equal(
    (await db.select().from(executions))[0]!.managementState &&
      ((await db.select().from(executions))[0]!.managementState as any)
        .pendingManagement.commandId,
    first.commandId,
  );
});
for (const patch of [
  { accountNumber: "B" },
  { serverName: "Other-Server" },
  { brokerName: "Other Company" },
  { userId: 8 },
  { tokenRevokedAt: new Date() },
]) {
  it(`final claim refuses changed connection identity ${JSON.stringify(patch)}`, async () => {
    const row = await approved();
    await updateConnection(1, patch);
    await denied(send(row), "MANAGEMENT_BRIDGE_IDENTITY_CHANGED");
    assert.equal(
      (
        await db
          .select()
          .from(commands)
          .where(eq(commands.commandId, row.commandId))
      )[0]!.status,
      "LIVE_APPROVED",
    );
  });
}
it("final claim refuses changed position geometry and never closes another account's ticket", async () => {
  const row = await approved();
  await livePositionWriter.update(
    { accountLogin: "B", bridgeConnectionId: 2 },
    eq(positions.id, 1),
  );
  await denied(send(row), "MANAGEMENT_POSITION_IDENTITY_CHANGED");
});
it("final claim refuses an explicitly retargeted patch, including identity deletion", async () => {
  const row = await approved();
  await denied(
    claimLiveCommandForDispatch(
      row.commandId,
      { status: "SENT_TO_MT5_LIVE", accountLogin: "B" },
      row,
    ),
    "MANAGEMENT_DISPATCH_RETARGETED",
  );
  await denied(
    claimLiveCommandForDispatch(
      row.commandId,
      { status: "SENT_TO_MT5_LIVE", bridgeConnectionId: null },
      row,
    ),
    "MANAGEMENT_DISPATCH_RETARGETED",
  );
});
it("duplicate final claims have one winner and one delivery opportunity", async () => {
  const row = await approved();
  const results = await Promise.all(Array.from({ length: 8 }, () => send(row)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(
    (
      await db
        .select()
        .from(commands)
        .where(eq(commands.commandId, row.commandId))
    )[0]!.status,
    "SENT_TO_MT5_LIVE",
  );
});
it("corrupt partial attribution cannot fall back to ordinary manual CAS", async () => {
  const row = await approved();
  await db
    .update(commands)
    .set({
      payload: {},
      selfTradeAgentId: null,
      selfTradeDecisionId: null,
      actorType: "USER",
    })
    .where(eq(commands.commandId, row.commandId));
  const [broken] = await db
    .select()
    .from(commands)
    .where(eq(commands.commandId, row.commandId));
  assert.equal(isAgentManagementCommand(broken!), true);
  await denied(send(broken!), "MANAGEMENT_TARGET_REQUIRED");
});
it("manual protective command remains on the existing unbound CAS path", async () => {
  const r = await createLiveOpsDraft({
    userId: 9,
    commandType: "CLOSE_LIVE_POSITION",
    brokerTicket: "manual",
    symbol: "EURUSD.a",
    side: "BUY",
    volume: 0.1,
    sourcePage: "INSTANT_CLOSE",
  });
  assert.equal(r.ok, true);
  const row = (r as Extract<typeof r, { ok: true }>).command;
  assert.equal(managementTargetFromCommand(row), null);
  assert.ok(
    await claimLiveCommandForConfirm(
      row.commandId,
      { status: "LIVE_APPROVED" },
      row,
    ),
  );
  assert.ok(
    await claimLiveCommandForDispatch(row.commandId, {
      status: "SENT_TO_MT5_LIVE",
    }),
  );
});
it("both transport payloads retain exact native symbol, ticket and server target", async () => {
  const row = await approved();
  assert.equal(boundManagementTransportSymbol(row), "EURUSD.a");
  assert.deepEqual(
    buildBridgedMt5CommandPayload({
      ...row,
      payload: row.payload as Record<string, unknown>,
    }).managementTargetV1,
    managementTargetFromCommand(row),
  );
  assert.equal(
    buildBridgedMt5CommandPayload({
      ...row,
      payload: row.payload as Record<string, unknown>,
    }).positionTicket,
    "123",
  );
  assert.deepEqual(
    (row.payload as any).managementTargetV1,
    managementTargetFromCommand(row),
  );
  assert.throws(
    () => boundManagementTransportSymbol({ ...row, symbol: "EURUSD" }),
    /MANAGEMENT_TRANSPORT_TARGET_MISMATCH/,
  );
  assert.throws(
    () =>
      buildBridgedMt5CommandPayload({
        ...row,
        payload: row.payload as Record<string, unknown>,
        brokerTicket: "999",
      }),
    /MANAGEMENT_TRANSPORT_TARGET_MISMATCH/,
  );
});
for (const action of ["CLOSE", "MODIFY_SL_TP"] as const) {
  it(`actual Guardian→instant→OPS draft→claim preserves target for ${action}`, async () => {
    if (action === "MODIFY_SL_TP")
      await db
        .update(executions)
        .set({
          managementState: {
            pendingManagement: {
              claimId: "claim-1",
              action: "TIGHTEN_SL",
              stopLoss: 1.095,
              requestedAt: new Date().toISOString(),
            },
          },
        })
        .where(eq(executions.id, 1));
    const result = await guardianInstantManage({
      ruleId: "self-trade-manage",
      position: { side: "BUY", stopLoss: 1.09, takeProfit: 1.12 },
      userId: 9,
      intent: {
        source: "self_trade",
        accountMode: "live",
        action,
        positionId: "123",
        selfTradeAgentId: 4,
        selfTradeDecisionId: 7,
        selfTradeManagement: reference,
        ...(action === "MODIFY_SL_TP" ? { newStopLoss: 1.095 } : {}),
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(deliveries, 1);
    const [row] = await db
      .select()
      .from(commands)
      .where(eq(commands.commandId, result.commandId!));
    assert.equal(row!.accountLogin, "A");
    assert.equal(row!.symbol, "EURUSD.a");
    assert.equal((row!.payload as any).managementTargetV1.positionRowId, 1);
  });
}
it("browser-style self_trade source without a server reference refuses before draft", async () => {
  const result = await executeInstant({
    userId: 9,
    intent: {
      source: "self_trade",
      accountMode: "live",
      action: "CLOSE",
      positionId: "123",
    },
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, "MANAGEMENT_TARGET_REQUIRED");
  assert.equal((await db.select().from(commands)).length, 1);
  assert.equal(deliveries, 0);
});
it("forged target/account and claim values cannot replace reconstructed facts", async () => {
  const t = await target();
  await denied(
    createManagementDraft({ ...t, accountLogin: "B" }, async () => {
      throw new Error("must not create");
    }),
    "MANAGEMENT_BRIDGE_IDENTITY_CHANGED",
  );
  await denied(
    resolveManagementTarget(9, { ...reference, claimId: "other" }),
    "MANAGEMENT_CLAIM_MISMATCH",
  );
});

// Barrier fixture: the competing writer holds a real row lock, proving claim
// sees its committed identity instead of a pre-wait snapshot or fake SQL seam.
it("account change committed while final claim waits is refused", async () => {
  const row = await approved();
  const writer = await pool.connect();
  await writer.query("BEGIN");
  await writer.query("SELECT id FROM mt5_connection WHERE id=1 FOR UPDATE");
  let settled = false;
  const claim = send(row).finally(() => {
    settled = true;
  });
  const observed = claim.catch((e) => e);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(settled, false);
  await writer.query("UPDATE mt5_connection SET account_number='B' WHERE id=1");
  await writer.query("COMMIT");
  writer.release();
  const result = await observed;
  assert.ok(result instanceof ManagementTargetError);
  assert.equal(result.reason, "MANAGEMENT_BRIDGE_IDENTITY_CHANGED");
});
it("position replacement committed while final claim waits is refused", async () => {
  const row = await approved();
  const writer = await pool.connect();
  await writer.query("BEGIN");
  await writer.query("SELECT id FROM arx_live_positions WHERE id=1 FOR UPDATE");
  let settled = false;
  const claim = send(row).finally(() => {
    settled = true;
  });
  const observed = claim.catch((e) => e);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(settled, false);
  await writer.query(
    "UPDATE arx_live_positions SET bridge_connection_id=2, account_login='B' WHERE id=1",
  );
  await writer.query("COMMIT");
  writer.release();
  const result = await observed;
  assert.ok(result instanceof ManagementTargetError);
  assert.equal(result.reason, "MANAGEMENT_POSITION_IDENTITY_CHANGED");
});
it("losing stale caller cannot regress an already-sent winner after account changes", async () => {
  const row = await approved();
  assert.ok(await send(row));
  await updateConnection(1, { accountNumber: "B" });
  await denied(send(row), "MANAGEMENT_BRIDGE_IDENTITY_CHANGED");
  assert.equal(
    (
      await db
        .select()
        .from(commands)
        .where(eq(commands.commandId, row.commandId))
    )[0]!.status,
    "SENT_TO_MT5_LIVE",
  );
});

it("signed native-symbol management target passes existing integrity and tampering fails", async () => {
  const row = await approved();
  assert.equal((await verifyCommandIntegrityForDispatch(row)).ok, true);
  const altered = {
    ...row,
    payload: {
      ...(row.payload as Record<string, unknown>),
      managementTargetV1: {
        ...managementTargetFromCommand(row)!,
        accountLogin: "B",
      },
    },
  };
  assert.equal((await verifyCommandIntegrityForDispatch(altered)).ok, false);
});
it("actual manager holds a failed identity resolution without a ghost command link", async () => {
  await db
    .update(executions)
    .set({ managementState: {}, slPrice: 1.09 })
    .where(eq(executions.id, 1));
  await livePositionWriter.update({ currentPrice: 1.112 }, eq(positions.id, 1));
  await updateConnection(1, { serverName: null });
  const [agent] = await db.select().from(agents);
  const result = await manageAgentPositions(agent!);
  assert.equal(result.held, 1);
  assert.equal(deliveries, 0);
  assert.deepEqual(
    (await db.select().from(executions))[0]!.managementState,
    {},
  );
  assert.equal((await db.select().from(commands)).length, 1);
});
it("actual manager preserves the atomically linked command and holds the next cycle", async () => {
  await db
    .update(executions)
    .set({ managementState: {}, slPrice: 1.09 })
    .where(eq(executions.id, 1));
  await livePositionWriter.update({ currentPrice: 1.112 }, eq(positions.id, 1));
  const [agent] = await db.select().from(agents);
  await manageAgentPositions(agent!);
  const memory = (await db.select().from(executions))[0]!
    .managementState as any;
  assert.ok(memory.pendingManagement.commandId);
  assert.equal(deliveries, 1);
  assert.equal(
    (
      await db
        .select()
        .from(commands)
        .where(eq(commands.commandId, memory.pendingManagement.commandId))
    )[0]!.status,
    "SENT_TO_MT5_LIVE",
  );
  await manageAgentPositions(agent!);
  assert.equal(deliveries, 1);
});
it("serverName change committed while final claim waits is refused", async () => {
  const row = await approved();
  const writer = await pool.connect();
  await writer.query("BEGIN");
  await writer.query("SELECT id FROM mt5_connection WHERE id=1 FOR UPDATE");
  let settled = false;
  const claim = send(row).finally(() => {
    settled = true;
  });
  const observed = claim.catch((e) => e);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(settled, false);
  await writer.query(
    "UPDATE mt5_connection SET server_name='Other-Server' WHERE id=1",
  );
  await writer.query("COMMIT");
  writer.release();
  const result = await observed;
  assert.ok(result instanceof ManagementTargetError);
  assert.equal(result.reason, "MANAGEMENT_BRIDGE_IDENTITY_CHANGED");
});
it("bridge writer cannot change identity before an already-running final claim commits", async () => {
  const row = await approved();
  const blocker = await pool.connect();
  await blocker.query("BEGIN");
  await blocker.query(
    "SELECT id FROM arx_live_commands WHERE command_id=$1 FOR UPDATE",
    [row.commandId],
  );
  const claim = send(row);
  await new Promise((resolve) => setTimeout(resolve, 50));
  let writerFinished = false;
  const writer = updateConnection(1, { accountNumber: "B" }).then(() => {
    writerFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(writerFinished, false);
  await blocker.query("COMMIT");
  blocker.release();
  assert.ok(await claim);
  await writer;
  assert.equal(
    (
      await db
        .select()
        .from(commands)
        .where(eq(commands.commandId, row.commandId))
    )[0]!.accountLogin,
    "A",
  );
  // Switch AFTER the claim is explicitly outside this server guarantee. An
  // upgraded EA must still enforce account/session identity before mutation.
});
it("changed pending claim command linkage and already-expired dispatch are refused", async () => {
  const row = await approved();
  await denied(
    claimLiveCommandForDispatch(
      row.commandId,
      { status: "SENT_TO_MT5_LIVE", expiresAt: new Date(0) },
      row,
    ),
    "MANAGEMENT_COMMAND_EXPIRED",
  );
  const [execution] = await db.select().from(executions);
  const memory = execution!.managementState as any;
  await db
    .update(executions)
    .set({
      managementState: {
        ...memory,
        pendingManagement: {
          ...memory.pendingManagement,
          commandId: "another",
        },
      },
    })
    .where(eq(executions.id, 1));
  await denied(send(row), "MANAGEMENT_COMMAND_CHANGED");
});

async function otherAccountRow(id = 2) {
  const [original] = await db
    .select()
    .from(positions)
    .where(eq(positions.id, 1));
  await db.insert(positions).values({
    ...original!,
    id,
    bridgeConnectionId: 2,
    accountLogin: "B",
    sourceCommandId: "other-entry",
    stopLoss: 1.08,
  });
  return (await db.select().from(positions).where(eq(positions.id, id)))[0]!;
}
async function recordedClose(
  row?: Awaited<ReturnType<typeof send>>,
  identity: ReturnType<typeof reportedManagementIdentity> = [],
) {
  row ??= await send(await approved());
  assert.ok(row);
  const result = await recordLiveCommandResult({
    userId: 9,
    commandId: row.commandId,
    outcome: "LIVE_FILLED",
    reportingBridgeConnectionId: 1,
    brokerTicket: "123",
    executedVolume: 0.1,
    fillPrice: 1.11,
    reportedExecutionIdentity: identity,
  });
  assert.equal(result.ok, true);
  return result.command!;
}
async function waitForBlockedRowLock(writer: {
  query: (query: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
}) {
  const started = performance.now();
  while (performance.now() - started < 2000) {
    const r = await writer.query(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))) AS waiting",
    );
    if (r.rows[0].waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Expected a real PostgreSQL row-lock waiter");
}
async function ledgerRows() {
  return db.select().from(positions).orderBy(positions.id);
}
async function prepareModify() {
  await db
    .update(executions)
    .set({
      managementState: {
        pendingManagement: {
          claimId: "claim-1",
          action: "TIGHTEN_SL",
          stopLoss: 1.095,
          requestedAt: new Date().toISOString(),
        },
      },
    })
    .where(eq(executions.id, 1));
  return approved();
}

it("automatic MODIFY governor context uses the exact row despite a reused ticket", async () => {
  const row = await prepareModify();
  await otherAccountRow();
  // Force the foreign row to be the first heap match for the old LIMIT 1 query.
  await db
    .update(positions)
    .set({ currentPrice: 1.101 })
    .where(eq(positions.id, 1));
  const riskPosition = await readLiveModifyRiskPosition(row);
  assert.deepEqual(riskPosition, { entryPrice: 1.1, stopLoss: 1.09 });
  const { evaluatePreTradeRisk, resolveEffectiveLimits } =
    await import("../../riskGovernor/preTrade.js");
  const now = new Date();
  const verdict = evaluatePreTradeRisk(
    {
      userId: 9,
      venue: "LIVE",
      origin: "automation",
      action: "MODIFY",
      symbol: row.symbol,
      side: "BUY",
      lots: 0.1,
      stopLoss: 1.085,
      takeProfit: null,
      position: riskPosition,
    },
    {
      now,
      limits: resolveEffectiveLimits({}),
      account: {
        equity: 10000,
        freeMargin: 9000,
        leverage: 100,
        currency: "USD",
        source: "fixture",
      },
      instruments: {},
      quote: null,
      positions: [],
      inFlight: [],
      broker: { status: "CONNECTED", lastSeenAt: now, detail: "fixture" },
      daily: { realizedPnl: 0, floatingPnl: 0 },
    },
  );
  assert.ok(
    verdict.blockedBy.includes("stop_loss_required"),
    "actual target's stop cannot be widened using the other account's weaker stop",
  );
});
it("risk context refuses an overwritten row and corrupted attribution without ticket fallback", async () => {
  const row = await prepareModify();
  await otherAccountRow();
  await db
    .update(positions)
    .set({ accountLogin: "B", bridgeConnectionId: 2 })
    .where(eq(positions.id, 1));
  await assert.rejects(
    readLiveModifyRiskPosition(row),
    /MANAGEMENT_POSITION_IDENTITY_CHANGED/,
  );
  await assert.rejects(
    readLiveModifyRiskPosition({ ...row, selfTradeAgentId: null }),
    /MANAGEMENT_COMMAND_CHANGED/,
  );
});
it("manual MODIFY retains its existing lookup", async () => {
  const row = await prepareModify();
  const manual = {
    ...row,
    source: null,
    sourcePage: "LIVE_POSITION_OPS",
    actorType: "USER",
    selfTradeAgentId: null,
    selfTradeDecisionId: null,
    payload: { brokerTicket: "123" },
  };
  assert.deepEqual(await readLiveModifyRiskPosition(manual), {
    entryPrice: 1.1,
    stopLoss: 1.09,
  });
});
it("actual result application closes only its exact target and duplicate result is harmless", async () => {
  const other = await otherAccountRow();
  const command = await recordedClose();
  const rows = await ledgerRows();
  assert.ok(rows[0]!.closedAt);
  assert.deepEqual(rows[1], other);
  await recordedClose(command);
  assert.deepEqual(await ledgerRows(), rows);
  assert.equal(await reconcileGhostClosedPositions(9), 0);
  assert.deepEqual((await ledgerRows())[1], other);
});
it("overwritten target after dispatch is held and snapshot ghost repair cannot close its replacement", async () => {
  const sent = await send(await approved());
  await db
    .update(positions)
    .set({
      bridgeConnectionId: 2,
      accountLogin: "B",
      sourceCommandId: "other-entry",
    })
    .where(eq(positions.id, 1));
  const before = await ledgerRows();
  const command = await recordedClose(sent);
  assert.equal(
    command.status,
    "LIVE_FILLED",
    "reported receipt is retained, not rewritten as a refusal",
  );
  assert.deepEqual(await ledgerRows(), before);
  assert.equal(await reconcileGhostClosedPositions(9), 0);
  assert.deepEqual(await ledgerRows(), before);
  assert.ok(
    (await db.select().from(executionEvents)).some(
      (e) => e.eventType === "MANAGEMENT_LEDGER_APPLICATION_HELD",
    ),
  );
});
for (const evidence of [
  { accountLogin: "B" },
  { accountServer: "Other-Server" },
  { resolvedBrokerSymbol: "GBPUSD.a" },
  { positionTicket: "999" },
  { accountLogin: "A", executionIdentity: { accountNumber: "B" } },
])
  it(`explicit result identity disagreement is retained and cannot be bypassed by ghost repair: ${JSON.stringify(evidence)}`, async () => {
    const sent = await send(await approved());
    const before = await ledgerRows();
    await recordedClose(sent, reportedManagementIdentity(evidence));
    assert.deepEqual(await ledgerRows(), before);
    assert.equal(await reconcileGhostClosedPositions(9), 0);
    assert.deepEqual(await ledgerRows(), before);
  });
it("legacy absent terminal identity is not fabricated from the switched current bridge", async () => {
  const sent = await send(await approved());
  await updateConnection(1, { accountNumber: "B", serverName: "Other-Server" });
  await recordedClose(sent);
  assert.ok((await ledgerRows())[0]!.closedAt);
  const applied = (await db.select().from(executionEvents)).find(
    (e) => e.eventType === "RESULT_LIVE_FILLED",
  )!;
  assert.deepEqual((applied.payload as any).reportedExecutionIdentity, []);
});
for (const volume of [null, 0, 0.05, 0.2])
  it(`uncertain/partial/oversized close evidence ${volume} cannot close or shrink any automatic target`, async () => {
    const sent = await send(await approved());
    await otherAccountRow();
    const before = await ledgerRows();
    const r = await recordLiveCommandResult({
      userId: 9,
      commandId: sent!.commandId,
      outcome: "LIVE_FILLED",
      reportingBridgeConnectionId: 1,
      brokerTicket: "123",
      executedVolume: volume,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(await ledgerRows(), before);
    await reconcileGhostClosedPositions(9);
    assert.deepEqual(await ledgerRows(), before);
  });
it("result reconciliation waiting on a row observes the committed account replacement", async () => {
  const sent = await send(await approved());
  const writer = await pool.connect();
  await writer.query("BEGIN");
  await writer.query("SELECT id FROM arx_live_positions WHERE id=1 FOR UPDATE");
  let completed = false;
  const pending = recordedClose(sent).finally(() => {
    completed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(completed, false);
  await writer.query(
    "UPDATE arx_live_positions SET account_login='B', bridge_connection_id=2, source_command_id='other-entry' WHERE id=1",
  );
  await writer.query("COMMIT");
  writer.release();
  await pending;
  const before = await ledgerRows();
  assert.equal(before[0]!.closedAt, null);
  await reconcileGhostClosedPositions(9);
  assert.deepEqual(await ledgerRows(), before);
});
it("ghost repair rechecks changed row identity while waiting and never writes its replacement", async () => {
  const command = await recordedClose();
  await db.update(positions).set({ closedAt: null }).where(eq(positions.id, 1));
  const writer = await pool.connect();
  await writer.query("BEGIN");
  await writer.query("SELECT id FROM arx_live_positions WHERE id=1 FOR UPDATE");
  const repairing = reconcileGhostClosedPositions(9);
  await new Promise((resolve) => setTimeout(resolve, 40));
  await writer.query(
    "UPDATE arx_live_positions SET source_command_id='other-entry' WHERE id=1",
  );
  await writer.query("COMMIT");
  writer.release();
  assert.equal(await repairing, 0);
  assert.equal((await ledgerRows())[0]!.closedAt, null);
  assert.equal(
    (await reconcileBoundManagementClose(command)).closedRows.length,
    0,
  );
});
it("concurrent result receipt and ghost repair have one exact ledger update", async () => {
  const command = await recordedClose();
  await db.update(positions).set({ closedAt: null }).where(eq(positions.id, 1));
  await otherAccountRow();
  const beforeOther = (await ledgerRows())[1];
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      i % 2
        ? reconcileGhostClosedPositions(9)
        : reconcileBoundManagementClose(command).then(
            (r) => r.closedRows.length,
          ),
    ),
  );
  assert.equal(
    results.reduce((a, b) => a + b, 0),
    1,
  );
  assert.deepEqual((await ledgerRows())[1], beforeOther);
});
it("tampered historical target and removed attribution never enter legacy ghost matching", async () => {
  const command = await recordedClose();
  await db.update(positions).set({ closedAt: null }).where(eq(positions.id, 1));
  const targetValue = managementTargetFromCommand(command)!;
  await db
    .update(commands)
    .set({
      selfTradeAgentId: null,
      payload: {
        ...(command.payload as object),
        managementTargetV1: { ...targetValue, positionRowId: 2 },
      },
    })
    .where(eq(commands.commandId, command.commandId));
  await otherAccountRow();
  const before = await ledgerRows();
  assert.equal(await reconcileGhostClosedPositions(9), 0);
  assert.deepEqual(await ledgerRows(), before);
});
it("manual partial close reconciliation preserves its prior behavior", async () => {
  const manual = await createLiveOpsDraft({
    userId: 9,
    commandType: "CLOSE_LIVE_POSITION",
    brokerTicket: "123",
    symbol: "EURUSD.a",
    side: "BUY",
    volume: 0.05,
    sourcePage: "LIVE_POSITION_OPS",
  });
  assert.equal(manual.ok, true);
  if (!manual.ok) return;
  await db
    .update(commands)
    .set({ status: "SENT_TO_MT5_LIVE" })
    .where(eq(commands.commandId, manual.command.commandId));
  const result = await recordLiveCommandResult({
    userId: 9,
    commandId: manual.command.commandId,
    outcome: "LIVE_FILLED",
    reportingBridgeConnectionId: 1,
    brokerTicket: "123",
    executedVolume: 0.05,
  });
  assert.equal(result.ok, true);
  assert.equal((await ledgerRows())[0]!.volume, 0.05);
  assert.equal((await ledgerRows())[0]!.closedAt, null);
});

for (const [label, identity, expectedClosed] of [
  ["explicit conflict", reportedManagementIdentity({ accountLogin: "B" }), 0],
  [
    "valid match",
    reportedManagementIdentity({
      accountLogin: "A",
      serverName: "Venue-Server-1",
      resolvedBrokerSymbol: "EURUSD.a",
      positionTicket: "123",
    }),
    1,
  ],
  ["missing terminal identity", [], 1],
  ["explicit zero account", reportedManagementIdentity({ accountLogin: 0 }), 0],
  [
    "nested symbol conflict",
    reportedManagementIdentity({ executionIdentity: { symbol: "GBPUSD.a" } }),
    0,
  ],
] as const)
  it(`actual agent close settlement: ${label}, concurrent sweeps settle at most once`, async () => {
    await otherAccountRow();
    const sent = (await send(await approved()))!;
    await recordedClose(sent, [...identity]);
    const beforeOther = (await ledgerRows())[1];
    const results = await Promise.all(
      Array.from({ length: 4 }, () => reconcileAgentExecutions(4)),
    );
    assert.equal(
      results.reduce((n, r) => n + r.closed, 0),
      expectedClosed,
    );
    const [execution] = await db
      .select()
      .from(executions)
      .where(eq(executions.id, 1));
    assert.equal(execution!.status, expectedClosed ? "CLOSED" : "FILLED");
    assert.equal(execution!.realizedPnl, null);
    if (expectedClosed)
      assert.equal(
        (execution!.managementState as { closeAccounting: { status: string } })
          .closeAccounting.status,
        "UNVERIFIED",
      );
    assert.equal((await applyRealizedFromFills(4)).posted, 0);
    assert.deepEqual((await ledgerRows())[1], beforeOther);
    await recordedClose(
      sent,
      reportedManagementIdentity({ accountLogin: "A" }),
    );
    assert.equal(
      (await reconcileAgentExecutions(4)).closed,
      0,
      "duplicate cannot replace the accepted receipt",
    );
  });
it("agent settlement holds a missing durable receipt", async () => {
  const command = await recordedClose();
  await db
    .delete(executionEvents)
    .where(eq(executionEvents.commandId, command.id));
  assert.equal((await reconcileAgentExecutions(4)).closed, 0);
  const [execution] = await db
    .select()
    .from(executions)
    .where(eq(executions.id, 1));
  assert.equal(execution!.status, "FILLED");
});
it("manual full close still closes its original ledger row", async () => {
  const result = await createLiveOpsDraft({
    userId: 9,
    commandType: "CLOSE_LIVE_POSITION",
    brokerTicket: "123",
    symbol: "EURUSD.a",
    side: "BUY",
    volume: 0.1,
    sourcePage: "LIVE_POSITION_OPS",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  await db
    .update(commands)
    .set({ status: "SENT_TO_MT5_LIVE" })
    .where(eq(commands.commandId, result.command.commandId));
  await recordedClose(result.command);
  assert.ok((await ledgerRows())[0]!.closedAt);
});

it("concurrent conflicting result reports preserve the accepted identity decision for settlement", async () => {
  await otherAccountRow();
  const sent = (await send(await approved()))!;
  await Promise.all([
    recordedClose(sent, reportedManagementIdentity({ accountLogin: "B" })),
    recordedClose(sent, reportedManagementIdentity({ accountLogin: "A" })),
  ]);
  const applied = await db
    .select()
    .from(executionEvents)
    .where(eq(executionEvents.eventType, "RESULT_LIVE_FILLED"));
  assert.equal(applied.length, 1);
  const identity = (
    applied[0]!.payload as {
      reportedExecutionIdentity: Array<{ value: string }>;
    }
  ).reportedExecutionIdentity;
  const conflict = identity[0]!.value === "B";
  const results = await Promise.all([
    reconcileAgentExecutions(4),
    reconcileAgentExecutions(4),
  ]);
  assert.equal(
    results.reduce((n, r) => n + r.closed, 0),
    conflict ? 0 : 1,
  );
  const rows = await ledgerRows();
  assert.equal(Boolean(rows[0]!.closedAt), !conflict);
  assert.equal(rows[1]!.closedAt, null);
});
it("agent settlement waiting on a reused row refuses its replacement", async () => {
  const command = await recordedClose();
  const writer = await pool.connect();
  await writer.query("BEGIN");
  await writer.query(
    "UPDATE arx_live_positions SET account_login='B',bridge_connection_id=2 WHERE id=1",
  );
  let completed = false;
  const pending = reconcileAgentExecutions(4).finally(() => {
    completed = true;
  });
  await waitForBlockedRowLock(writer);
  assert.equal(completed, false);
  await writer.query("COMMIT");
  writer.release();
  assert.equal((await pending).closed, 0);
  const [execution] = await db
    .select()
    .from(executions)
    .where(eq(executions.id, 1));
  assert.equal(execution!.status, "FILLED");
  assert.equal(execution!.realizedPnl, null);
  assert.equal(
    (await reconcileBoundManagementClose(command)).heldReason,
    "MANAGEMENT_RESULT_TARGET_CHANGED",
  );
});

it("same native symbol on a changed current account cannot certify historical agent profit", async () => {
  await db.insert(specs).values({
    userId: 9,
    bridgeConnectionId: 1,
    symbol: "EURUSD.a",
    contractSize: 100000,
    profitCurrency: "USD",
  });
  await db.insert(allocations).values({ userId: 9, accountCurrency: "USD" });
  await db.insert(agentLedger).values([
    { agentId: 4, availableFunds: 250, realizedPnl: 0 },
    { agentId: 5, availableFunds: 900, realizedPnl: 0 },
  ]);
  const command = await recordedClose();
  await db
    .update(specs)
    .set({ bridgeConnectionId: 2, contractSize: 200000, profitCurrency: "USD" })
    .where(eq(specs.userId, 9));
  await db
    .update(allocations)
    .set({ accountCurrency: "EUR" })
    .where(eq(allocations.userId, 9));
  await updateConnection(1, {
    accountNumber: "B",
    serverName: "Venue-Server-2",
  });
  assert.equal((await reconcileAgentExecutions(4)).closed, 1);
  const [execution] = await db
    .select()
    .from(executions)
    .where(eq(executions.id, 1));
  assert.equal(execution!.realizedPnl, null);
  const accounting = (
    execution!.managementState as {
      closeAccounting: { reason: string; symbol: string };
    }
  ).closeAccounting;
  assert.equal(accounting.reason, "HISTORICAL_ACCOUNTING_EVIDENCE_MISSING");
  assert.equal(accounting.symbol, "EURUSD.a");
  const { managementNote } = await import("../executionLifecycle.js");
  assert.match(managementNote(execution!)!, /profit remains unverified/);
  const before = await db
    .select()
    .from(agentLedger)
    .orderBy(agentLedger.agentId);
  const posted = await Promise.all([
    applyRealizedFromFills(4),
    applyRealizedFromFills(4),
  ]);
  assert.equal(
    posted.reduce((n, r) => n + r.posted, 0),
    0,
  );
  assert.deepEqual(
    await db.select().from(agentLedger).orderBy(agentLedger.agentId),
    before,
  );
  assert.equal((await db.select().from(ledgerEntries)).length, 0);
  const withdrawal = await defundAgent({
    agentId: 4,
    amount: 100,
    actorUserId: 9,
    actorRole: "admin",
    reason: "Offline hold test",
  });
  assert.equal(withdrawal.ok, false);
  if (!withdrawal.ok) assert.equal(withdrawal.error, "ACCOUNTING_UNRESOLVED");
  assert.deepEqual(
    await db.select().from(agentLedger).orderBy(agentLedger.agentId),
    before,
  );
  assert.equal((await reconcileBoundManagementClose(command)).heldReason, null);
});
it("settlement revalidates locked entry identity after a concurrent entry snapshot replacement", async () => {
  await recordedClose();
  const writer = await pool.connect();
  await writer.query("BEGIN");
  await writer.query(
    "UPDATE arx_live_commands SET symbol='GBPUSD.a' WHERE command_id='entry-1'",
  );
  const pending = reconcileAgentExecutions(4);
  await waitForBlockedRowLock(writer);
  await writer.query("COMMIT");
  writer.release();
  assert.equal((await pending).closed, 0);
  const [execution] = await db
    .select()
    .from(executions)
    .where(eq(executions.id, 1));
  assert.equal(execution!.status, "FILLED");
  assert.equal(execution!.realizedPnl, null);
  assert.equal((await applyRealizedFromFills(4)).posted, 0);
});

it("a close holding the agent lock publishes its accounting hold before waiting admission can reserve", async () => {
  const sent = (await send(await approved()))!;
  await db
    .update(agents)
    .set({ status: "ACTIVE", mode: "LIVE" })
    .where(eq(agents.id, 4));
  await db.insert(agentSettings).values({
    agentId: 4,
    maxConcurrentPositions: 0,
    baseMaxTrades: 100,
    maxLotPerTrade: 1,
  });
  await db
    .insert(agentLedger)
    .values({ agentId: 4, allocatedFunds: 1000, availableFunds: 1000 });
  await db.insert(decisions).values({
    id: 8,
    agentId: 4,
    agentKey: "agent",
    cycleId: "next",
    symbol: "EURUSD",
    side: "BUY",
    outcome: "APPROVED",
    plannedAction: "EXECUTE",
    reason: "Offline",
    thesis: { stopLoss: 1.09, takeProfits: [] },
  });
  const [agent] = await db.select().from(agents).where(eq(agents.id, 4));
  const [settings] = await db
    .select()
    .from(agentSettings)
    .where(eq(agentSettings.agentId, 4));
  const [ledger] = await db
    .select()
    .from(agentLedger)
    .where(eq(agentLedger.agentId, 4));
  const [decision] = await db
    .select()
    .from(decisions)
    .where(eq(decisions.id, 8));
  const writer = await pool.connect();
  await writer.query("BEGIN");
  await writer.query("SELECT id FROM arx_live_positions WHERE id=1 FOR UPDATE");
  const close = recordedClose(sent);
  await waitForBlockedRowLock(writer);
  const { reserveAgentEntry } = await import("../entryReservation.js");
  let admitted = false;
  const reservation = reserveAgentEntry({
    agent: agent!,
    settings: settings!,
    ledger: ledger!,
    decision: decision!,
    executingUserId: 9,
    side: "BUY",
    volume: 0.1,
    stopLoss: 1.09,
    takeProfit: null,
  }).finally(() => {
    admitted = true;
  });
  const started = performance.now();
  while (performance.now() - started < 2000) {
    const waiting = await writer.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%self_trade_agents%for update%'",
    );
    if (waiting.rows.length) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(admitted, false);
  await writer.query("COMMIT");
  writer.release();
  await close;
  const result = await reservation;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "ENTRY_ACCOUNTING_UNRESOLVED");
  assert.equal((await db.select().from(executions)).length, 1);
  await updateConnection(1, { accountNumber: "B" });
  assert.equal(
    (
      await reserveAgentEntry({
        agent: agent!,
        settings: settings!,
        ledger: ledger!,
        decision: decision!,
        executingUserId: 9,
        side: "BUY",
        volume: 0.1,
        stopLoss: 1.09,
        takeProfit: null,
      })
    ).ok,
    false,
    "mutable account switch cannot release agent accounting hold",
  );
  const manual = await createLiveOpsDraft({
    userId: 9,
    commandType: "CLOSE_LIVE_POSITION",
    brokerTicket: "456",
    symbol: "EURUSD.a",
    side: "BUY",
    volume: 0.1,
    sourcePage: "LIVE_POSITION_OPS",
  });
  assert.equal(
    manual.ok,
    true,
    "manual protective draft is not governed by agent accounting hold",
  );
});

it("a loss-shaped close stays unknown and holds continuation rather than becoming zero profit", async () => {
  const sent = (await send(await approved()))!;
  await recordLiveCommandResult({
    userId: 9,
    commandId: sent.commandId,
    outcome: "LIVE_FILLED",
    reportingBridgeConnectionId: 1,
    brokerTicket: "123",
    executedVolume: 0.1,
    fillPrice: 1.08,
  });
  assert.equal((await reconcileAgentExecutions(4)).closed, 1);
  const [execution] = await db
    .select()
    .from(executions)
    .where(eq(executions.id, 1));
  assert.equal(execution!.realizedPnl, null);
  const { hasUnresolvedAgentAccounting } = await import("../accountingHold.js");
  assert.equal(await hasUnresolvedAgentAccounting(db, 4), true);
  assert.equal((await applyRealizedFromFills(4)).posted, 0);
});

// Opt-in: no provider or broker timing is inferred from the local benchmark.
it(
  "controlled previous/current server consumer latency",
  { skip: !process.env.ARX_MANAGEMENT_BENCHMARK_OUTPUT },
  async () => {
    const { runManagementConsumerBenchmark } =
      await import("./managementConsumers.benchmark.js");
    await runManagementConsumerBenchmark({
      prepareModify,
      resetFixture,
      send,
      approved,
    });
  },
);

async function manualProgressFixture(positionVolume = 0.2) {
  await db
    .update(positions)
    .set({ volume: positionVolume })
    .where(eq(positions.id, 1));
  const r = await createLiveOpsDraft({
    userId: 9,
    commandType: "CLOSE_LIVE_POSITION",
    brokerTicket: "123",
    symbol: "EURUSD.a",
    side: "BUY",
    volume: 0.1,
    sourcePage: "LIVE_POSITION_OPS",
  });
  assert.ok(r.ok);
  await db
    .update(commands)
    .set({ status: "SENT_TO_MT5_LIVE" })
    .where(eq(commands.id, r.command.id));
  return {
    userId: 9,
    commandId: r.command.commandId,
    outcome: "LIVE_FILLED" as const,
    reportingBridgeConnectionId: 1,
    brokerTicket: "123",
    executedVolume: 0.1,
    fillPrice: 1.11,
  };
}
it("manual ACK/partial/full cumulative reports, changed messages and reordered identities never double-shrink", async () => {
  const input = await manualProgressFixture();
  await recordLiveCommandResult({
    ...input,
    outcome: "LIVE_ACKNOWLEDGED",
    executedVolume: null,
    brokerTicket: null,
  });
  await recordLiveCommandResult({ ...input, executedVolume: 0.04 });
  assert.equal((await ledgerRows())[0].volume, 0.16);
  await recordLiveCommandResult({
    ...input,
    executedVolume: 0.04,
    brokerMessage: "repeated fill evidence",
  });
  assert.equal((await ledgerRows())[0].volume, 0.16);
  const identity = reportedManagementIdentity({
    accountLogin: "A",
    serverName: "Venue-Server-1",
  });
  await recordLiveCommandResult({
    ...input,
    reportedExecutionIdentity: identity,
  });
  assert.equal((await ledgerRows())[0].volume, 0.1);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      recordLiveCommandResult({
        ...input,
        brokerMessage: `retry-${i}`,
        reportedExecutionIdentity: [...identity].reverse(),
      }),
    ),
  );
  assert.equal((await ledgerRows())[0].volume, 0.1);
  assert.equal((await ledgerRows())[0].closedAt, null);
  assert.equal(await reconcileGhostClosedPositions(9), 0);
  assert.equal((await ledgerRows())[0].volume, 0.1);
  const marks = await pool.query(
    "SELECT payload FROM execution_events WHERE event_type='POSITION_RESULT_APPLIED'",
  );
  assert.equal(marks.rows.length, 2);
});
it("pre-upgrade partial without an application marker holds the first new full report", async () => {
  const input = await manualProgressFixture();
  await db
    .update(commands)
    .set({ status: "LIVE_PARTIALLY_FILLED", executedVolume: 0.04 })
    .where(eq(commands.commandId, input.commandId));
  await db.update(positions).set({ volume: 0.16 }).where(eq(positions.id, 1));
  const result = await recordLiveCommandResult(input);
  assert.equal(result.receiptPersisted, true);
  assert.equal(result.positionSettlement, "HELD");
  assert.equal(
    result.positionSettlementReason,
    "LEGACY_PARTIAL_APPLICATION_UNKNOWN",
  );
  assert.equal((await ledgerRows())[0].volume, 0.16);
  assert.equal(await reconcileGhostClosedPositions(9), 0);
  assert.equal((await ledgerRows())[0].closedAt, null);
});
for (const recovery of ["exact retry", "snapshot repair", "outbox worker"] as const)
  it(`manual position application and marker rollback together; ${recovery} applies once`, async () => {
    const input = await manualProgressFixture();
    await pool.query(
      "CREATE FUNCTION qa_marker_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='POSITION_RESULT_APPLIED' THEN RAISE EXCEPTION 'qa marker write failure'; END IF; RETURN NEW; END $$",
    );
    await pool.query(
      "CREATE TRIGGER qa_marker_fault BEFORE INSERT ON execution_events FOR EACH ROW EXECUTE FUNCTION qa_marker_fault()",
    );
    try {
      assert.equal((await recordLiveCommandResult(input)).positionSettlement, "PENDING");
      assert.equal((await ledgerRows())[0].volume, 0.2);
      assert.equal(
        (
          await db
            .select()
            .from(commands)
            .where(eq(commands.commandId, input.commandId))
        )[0].status,
        "LIVE_FILLED",
      );
    } finally {
      await pool.query("DROP TRIGGER qa_marker_fault ON execution_events");
      await pool.query("DROP FUNCTION qa_marker_fault()");
    }
    if (recovery === "exact retry") {
      await pool.query("update result_settlement_jobs set due_at=clock_timestamp() where status='RETRY'");
      const reply = await recordLiveCommandResult(input);
      assert.equal(reply.receiptPersisted, true);
      assert.equal(reply.positionSettlement, "APPLIED");
    } else if (recovery === "outbox worker") {
      await pool.query("update result_settlement_jobs set due_at=clock_timestamp() where status='RETRY'");
      await (await import("../../live/resultSettlementOutbox.js")).runResultSettlementPass();
    } else await reconcileGhostClosedPositions(9);
    assert.equal((await ledgerRows())[0].volume, 0.1);
    await recordLiveCommandResult(input);
    assert.equal((await ledgerRows())[0].volume, 0.1);
    assert.equal(
      (
        await pool.query(
          "SELECT id FROM execution_events WHERE event_type='RESULT_LIVE_FILLED'",
        )
      ).rows.length,
      1,
    );
  });
for (const recovery of ["exact retry", "snapshot repair", "outbox worker"] as const)
  it(`bound post-commit consumer failure is repaired by ${recovery} without changing another account`, async () => {
    await otherAccountRow();
    const beforeOther = (await ledgerRows())[1];
    const sent = (await send(await approved()))!;
    const input = {
      userId: 9,
      commandId: sent.commandId,
      outcome: "LIVE_FILLED" as const,
      reportingBridgeConnectionId: 1,
      brokerTicket: "123",
      executedVolume: 0.1,
      fillPrice: 1.11,
    };
    await pool.query(
      "CREATE FUNCTION qa_position_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'qa post-commit position failure'; END $$",
    );
    await pool.query(
      "CREATE TRIGGER qa_position_fault BEFORE UPDATE ON arx_live_positions FOR EACH ROW EXECUTE FUNCTION qa_position_fault()",
    );
    await pool.query(
      "CREATE FUNCTION qa_held_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='MANAGEMENT_LEDGER_APPLICATION_HELD' THEN RAISE EXCEPTION 'qa held event failure'; END IF; RETURN NEW; END $$",
    );
    await pool.query(
      "CREATE TRIGGER qa_held_fault BEFORE INSERT ON execution_events FOR EACH ROW EXECUTE FUNCTION qa_held_fault()",
    );
    try {
      assert.equal((await recordLiveCommandResult(input)).positionSettlement, "PENDING");
      assert.equal((await ledgerRows())[0].closedAt, null);
      assert.equal(
        (await db.select().from(commands).where(eq(commands.id, sent.id)))[0]
          .status,
        "LIVE_FILLED",
      );
    } finally {
      await pool.query("DROP TRIGGER qa_position_fault ON arx_live_positions");
      await pool.query("DROP FUNCTION qa_position_fault()");
      await pool.query("DROP TRIGGER qa_held_fault ON execution_events");
      await pool.query("DROP FUNCTION qa_held_fault()");
    }
    if (recovery === "exact retry") {
      await pool.query("update result_settlement_jobs set due_at=clock_timestamp() where status='RETRY'");
      const reply = await recordLiveCommandResult(input);
      assert.equal(reply.receiptPersisted, true);
      assert.equal(reply.positionSettlement, "APPLIED");
    } else if (recovery === "outbox worker") {
      await pool.query("update result_settlement_jobs set due_at=clock_timestamp() where status='RETRY'");
      await (await import("../../live/resultSettlementOutbox.js")).runResultSettlementPass();
    } else assert.equal(await reconcileGhostClosedPositions(9), 1);
    assert.ok((await ledgerRows())[0].closedAt);
    assert.deepEqual((await ledgerRows())[1], beforeOther);
    assert.equal(
      (
        await pool.query(
          "SELECT id FROM execution_events WHERE command_id=$1 AND event_type='RESULT_LIVE_FILLED'",
          [sent.id],
        )
      ).rows.length,
      1,
    );
  });

// Actual snapshot handler body with real database/ledger/repair; only bridge
// authentication and advisory notifications/guardian scheduling are controlled.
async function ingestActualSnapshot(volume: number) {
  const source = readFileSync(
    new URL("../../../routes/mt5Live.ts", import.meta.url),
    "utf8",
  );
  const tree = ts.createSourceFile(
    "mt5Live.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = [
    "snapNumOrNull",
    "snapNonZeroOrNull",
    "parseMt5Time",
    "handleLivePositionsSnapshot",
  ];
  const nodes = tree.statements.filter(
    (n) => ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? ""),
  );
  assert.equal(nodes.length, names.length);
  const compiled = ts.transpileModule(
    nodes.map((n) => n.getText(tree)).join("\n"),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
      transformers: {
        before: [
          (context) => (root) => {
            const replace = (n: ts.Node): ts.VisitResult<ts.Node> =>
              ts.isCallExpression(n) &&
              n.expression.kind === ts.SyntaxKind.ImportKeyword
                ? ts.factory.updateCallExpression(
                    n,
                    ts.factory.createIdentifier("loadModule"),
                    undefined,
                    n.arguments,
                  )
                : ts.visitEachChild(n, replace, context);
            return ts.visitNode(root, replace) as ts.SourceFile;
          },
        ],
      },
    },
  ).outputText;
  const { livePositionLedger, livePositionColumns } =
    await import("../../positions/ledger.js");
  const dependencies = {
    db,
    arxLiveCommandsTable: commands,
    and,
    eq,
    isNull,
    inArray,
    sql,
    livePositionLedger,
    livePositionWriter,
    livePositionColumns,
    reconcileGhostClosedPositions,
    requireLiveBridge: (req: any) => req.connection,
    updateConnection: (id: number, values: any) =>
      db.update(bridges).set(values).where(eq(bridges.id, id)),
    brokerAbsenceAutoReconcilePolicy: { enabled: false },
    emitLiveAccountChanged: () => {},
    scheduleGuardian: () => {},
    LIVE_SAFETY_ENVELOPE: {},
    loadModule: async () => ({ recomputeMasterPool: async () => {} }),
  };
  const handler = new Function(
    ...Object.keys(dependencies),
    compiled + ";return handleLivePositionsSnapshot;",
  )(...Object.values(dependencies));
  const [conn] = await db.select().from(bridges).where(eq(bridges.id, 1));
  let reply: any;
  await handler(
    {
      connection: conn,
      body: {
        positions: [
          {
            ticket: "123",
            symbol: "EURUSD.a",
            side: "BUY",
            volume,
            entryPrice: 1.1,
            currentPrice: 1.11,
          },
        ],
      },
      log: { warn() {} },
    },
    {
      json(body: any) {
        reply = body;
      },
    },
  );
  assert.equal(reply.ok, true);
  assert.equal(reply.upserts, 1);
}
it("actual snapshot before first manual result cannot double-subtract broker-applied volume", async () => {
  const input = await manualProgressFixture();
  await ingestActualSnapshot(0.16);
  const result = await recordLiveCommandResult({
    ...input,
    executedVolume: 0.04,
  });
  assert.equal(result.positionSettlement, "HELD");
  assert.equal(
    result.positionSettlementReason,
    "MANUAL_CLOSE_POSITION_REVISION_CHANGED",
  );
  assert.equal((await ledgerRows())[0].volume, 0.16);
  assert.equal(
    (
      await pool.query(
        "SELECT id FROM execution_events WHERE event_type='POSITION_RESULT_APPLIED'",
      )
    ).rows.length,
    0,
  );
});
it("actual snapshot between partial and full reports invalidates the next delta", async () => {
  const input = await manualProgressFixture();
  await recordLiveCommandResult({ ...input, executedVolume: 0.04 });
  assert.equal((await ledgerRows())[0].volume, 0.16);
  await ingestActualSnapshot(0.1);
  const result = await recordLiveCommandResult(input);
  assert.equal(result.positionSettlement, "HELD");
  assert.equal(
    result.positionSettlementReason,
    "MANUAL_CLOSE_POSITION_REVISION_CHANGED",
  );
  assert.equal((await ledgerRows())[0].volume, 0.1);
  await reconcileGhostClosedPositions(9);
  assert.equal((await ledgerRows())[0].volume, 0.1);
  assert.equal((await ledgerRows())[0].closedAt, null);
});
for (const volume of [0.3, -0.1, 0])
  it(`malformed cumulative close volume ${volume} never closes or shrinks the row`, async () => {
    const input = await manualProgressFixture();
    const result = await recordLiveCommandResult({
      ...input,
      executedVolume: volume,
    });
    assert.equal(result.positionSettlement, "HELD");
    assert.equal(
      result.positionSettlementReason,
      "MANUAL_CLOSE_VOLUME_UNVERIFIED",
    );
    assert.equal((await ledgerRows())[0].volume, 0.2);
    assert.equal((await ledgerRows())[0].closedAt, null);
  });
it("a same-volume snapshot still invalidates the local revision witness", async () => {
  const input = await manualProgressFixture();
  await ingestActualSnapshot(0.2);
  const result = await recordLiveCommandResult(input);
  assert.equal(
    result.positionSettlementReason,
    "MANUAL_CLOSE_POSITION_REVISION_CHANGED",
  );
  assert.equal((await ledgerRows())[0].volume, 0.2);
});
it("tampered manual basis is held and cannot select another position row", async () => {
  const input = await manualProgressFixture();
  const [row] = await db
    .select()
    .from(commands)
    .where(eq(commands.commandId, input.commandId));
  const payload = row.payload as Record<string, any>;
  await db
    .update(commands)
    .set({
      payload: {
        ...payload,
        manualClosePositionBasisV1: {
          ...payload.manualClosePositionBasisV1,
          volume: 0.4,
        },
      },
    })
    .where(eq(commands.id, row.id));
  const result = await recordLiveCommandResult(input);
  assert.equal(
    result.positionSettlementReason,
    "MANUAL_CLOSE_SIGNATURE_INVALID",
  );
  assert.equal((await ledgerRows())[0].volume, 0.2);
});

it(
  "controlled old/current manual receipt and position recovery latency",
  { skip: !process.env.ARX_MANUAL_RESULT_BENCHMARK_OUTPUT },
  async () => {
    const { runManualResultRecoveryBenchmark } =
      await import("./manualResultRecovery.benchmark.js");
    await runManualResultRecoveryBenchmark(async () => {
      await resetFixture();
      return manualProgressFixture(0.1);
    });
  },
);

it("a reported different ticket cannot mutate the manual target position", async () => {
  const input = await manualProgressFixture();
  const result = await recordLiveCommandResult({
    ...input,
    brokerTicket: "other-ticket",
  });
  assert.equal(
    result.positionSettlementReason,
    "MANUAL_CLOSE_RECEIPT_MISMATCH",
  );
  assert.equal((await ledgerRows())[0].volume, 0.2);
});
it("snapshot recovery refuses mutable command volume that disagrees with its accepted receipt", async () => {
  const input = await manualProgressFixture();
  await recordLiveCommandResult(input);
  assert.equal((await ledgerRows())[0].volume, 0.1);
  await db
    .update(commands)
    .set({ executedVolume: 0.05 })
    .where(eq(commands.commandId, input.commandId));
  const result = await recordLiveCommandResult(input);
  assert.equal(
    result.positionSettlementReason,
    "MANUAL_CLOSE_RECEIPT_MISMATCH",
  );
  await reconcileGhostClosedPositions(9);
  assert.equal((await ledgerRows())[0].volume, 0.1);
});

it("snapshot repair never applies an old manual basis to a new row reusing the ticket",async()=>{
  const input=await manualProgressFixture(0.1);
  await recordLiveCommandResult(input);
  await otherAccountRow();
  await db.update(positions).set({closedAt:null,volume:0.2}).where(eq(positions.id,2));
  const before=(await ledgerRows())[1];
  assert.equal(await reconcileGhostClosedPositions(9),0);
  assert.deepEqual((await ledgerRows())[1],before);
});

const settlementOutbox = await import("../../live/resultSettlementOutbox.js");
async function deferReceiptConsumers(input: Parameters<typeof recordLiveCommandResult>[0]) {
  await pool.query("CREATE FUNCTION qa_defer_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='LEASED' THEN RAISE EXCEPTION 'qa crash before claim'; END IF; RETURN NEW; END $$");
  await pool.query("CREATE TRIGGER qa_defer_claim BEFORE UPDATE ON result_settlement_jobs FOR EACH ROW EXECUTE FUNCTION qa_defer_claim()");
  try { await assert.rejects(recordLiveCommandResult(input)); }
  finally { await pool.query("DROP TRIGGER qa_defer_claim ON result_settlement_jobs; DROP FUNCTION qa_defer_claim()"); }
}
async function claimPositionJob() {
  for(let i=0;i<3;i++) {
    const job=await settlementOutbox.claimResultSettlement();
    assert.ok(job);
    if(job.consumer!=="EXPOSURE_RESERVATION") return job;
    await settlementOutbox.runClaimedSettlement(job);
  }
  throw new Error("No position job");
}
it("position commit before worker finish is recovered once, with no Mission callback replay", async () => {
  const input=await manualProgressFixture(0.1);
  await deferReceiptConsumers(input);
  const job=await claimPositionJob();
  await pool.query("CREATE FUNCTION qa_finish_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='DONE' THEN RAISE EXCEPTION 'qa crash after application'; END IF; RETURN NEW; END $$");
  await pool.query("CREATE TRIGGER qa_finish_fault BEFORE UPDATE ON result_settlement_jobs FOR EACH ROW EXECUTE FUNCTION qa_finish_fault()");
  try {
    const outcome=await settlementOutbox.runClaimedSettlement(job);
    assert.equal(outcome.saved,false);
    assert.ok((await ledgerRows())[0].closedAt);
    assert.equal((await pool.query("select count(*) from execution_events where event_type='POSITION_RESULT_APPLIED'")).rows[0].count,"1");
  } finally { await pool.query("DROP TRIGGER qa_finish_fault ON result_settlement_jobs; DROP FUNCTION qa_finish_fault()"); }
  await pool.query("update result_settlement_jobs set due_at=clock_timestamp() where status='RETRY'");
  await settlementOutbox.runResultSettlementPass();
  assert.equal((await pool.query("select status from result_settlement_jobs where consumer='MANUAL_CLOSE_POSITION'")).rows[0].status,"DONE");
  assert.equal(missionCloseCalls,0,"server recovery must not replay advisory callback");
  assert.equal((await pool.query("select count(*) from execution_events where event_type='POSITION_RESULT_APPLIED'")).rows[0].count,"1");
});
for (const reusedTicket of [false,true]) it(`leased manual recovery holds snapshot revision changes (reused other-account ticket: ${reusedTicket})`, async () => {
  if(reusedTicket) await otherAccountRow();
  const beforeOther=(await ledgerRows())[1];
  const input=await manualProgressFixture();
  await deferReceiptConsumers(input);
  const job=await claimPositionJob();
  await db.update(positions).set({volume:0.16,lastSyncedAt:new Date()}).where(eq(positions.id,1));
  const result=await settlementOutbox.runClaimedSettlement(job);
  if(reusedTicket) assert.ok(["MANUAL_CLOSE_POSITION_REVISION_CHANGED","MANUAL_CLOSE_POSITION_BASIS_UNAVAILABLE"].includes(result.heldReason ?? ""),"legacy ticket-only selection may fail at exact row identity first; either must hold");
  else assert.equal(result.heldReason,"MANUAL_CLOSE_POSITION_REVISION_CHANGED");
  assert.equal((await ledgerRows())[0].volume,0.16);
  assert.deepEqual((await ledgerRows())[1],beforeOther);
  await settlementOutbox.runResultSettlementPass();
  assert.equal((await ledgerRows())[0].volume,0.16);
});
it("partial worker waiting for position lock loses to a newer full receipt generation without shrinking twice", async () => {
  const input=await manualProgressFixture();
  await deferReceiptConsumers({...input,executedVolume:0.04});
  const old=await claimPositionJob();
  const blocker=await pool.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT id FROM arx_live_positions WHERE id=1 FOR UPDATE");
  const oldWork=settlementOutbox.runClaimedSettlement(old);
  const full=recordLiveCommandResult(input);
  try {
    let ready=false;
    for(let i=0;i<100;i++) {
      const result=await pool.query("select generation from result_settlement_jobs where consumer='MANUAL_CLOSE_POSITION'");
      if(result.rows[0]?.generation===2) { ready=true;break; }
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(ready,true,"full receipt/generation must commit while position consumer is blocked");
  } finally { await blocker.query("COMMIT");blocker.release(); }
  assert.equal((await oldWork).saved,false);
  await full;
  await settlementOutbox.runResultSettlementPass();
  assert.equal((await ledgerRows())[0].volume,0.1);
  assert.equal((await pool.query("select count(*) from execution_events where event_type='POSITION_RESULT_APPLIED'")).rows[0].count,"1");
  const row=(await pool.query("select * from result_settlement_jobs where consumer='MANUAL_CLOSE_POSITION'")).rows[0];
  assert.equal(row.generation,2);assert.equal(row.completed_generation,2);assert.equal(row.status,"DONE");
});
it("lease expiring after committed position application cannot certify DONE; replacement recovery is idempotent",async()=>{
  const input=await manualProgressFixture(0.1);
  await deferReceiptConsumers(input);
  const claim=await claimPositionJob();
  const [command]=await db.select().from(commands).where(eq(commands.commandId,input.commandId));
  const {reconcileManualResultPosition}=await import("../../live/liveCommandPipeline.js");
  const applied=await reconcileManualResultPosition(command,new Date(),claim);
  assert.equal(applied.closedRows.length,1);
  await pool.query("update result_settlement_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[claim.id]);
  assert.equal(await settlementOutbox.finishResultSettlement(claim,{status:"DONE"}),false,"stale completion cannot claim success");
  assert.equal((await pool.query("select status from result_settlement_jobs where id=$1",[claim.id])).rows[0].status,"LEASED");
  const replacement=(await settlementOutbox.claimResultSettlement())!;
  assert.notEqual(replacement.lease_token,claim.lease_token);
  assert.equal((await settlementOutbox.runClaimedSettlement(replacement)).saved,true);
  assert.equal((await pool.query("select status from result_settlement_jobs where id=$1",[claim.id])).rows[0].status,"DONE");
  assert.equal((await pool.query("select count(*) from execution_events where event_type='POSITION_RESULT_APPLIED'")).rows[0].count,"1");
  assert.equal(missionCloseCalls,0);
});

// Terminal target protocol: real route handlers, SQL predicates and final CAS.
const { default: mt5Router } = await import("../../../routes/mt5.js");
const { default: mt5LiveRouter } = await import("../../../routes/mt5Live.js");
async function pollRoute(legacy: boolean, header?: string) {
  const route = (legacy ? mt5Router : mt5LiveRouter).stack.find((layer: any) =>
    layer.route?.path === (legacy ? "/mt5/commands" : "/mt5/live-commands-poll"))!.route!;
  const [connection] = await db.select().from(bridges).where(eq(bridges.id, 1));
  let body: any; let status = 200;
  const response: any = { json: (value: unknown) => { body = value; return response; },
    status: (value: number) => { status = value; return response; },
    type: () => response, send: (value: string) => { body = JSON.parse(value); return response; } };
  await route.stack.at(-1)!.handle({ mt5Connection: connection,
    get: (key: string) => key === "x-arx-management-target" ? header : undefined,
    log: { info() {}, warn() {}, error() {} }, body: {}, headers: {},
  } as any, response, () => {});
  assert.equal(status, 200, JSON.stringify(body));
  return body;
}
async function queuedManagement() {
  const row = await approved(); await send(row);
  return row;
}
async function mirror(row: Awaited<ReturnType<typeof approved>>, payload = buildBridgedMt5CommandPayload({ ...row, payload: row.payload as Record<string, unknown> | null })) {
  return (await db.insert(mailbox).values({ userId: (row.payload as any).managementTargetV1?.bridgeOwnerUserId ?? 9, requestedByUserId: row.userId, mt5ConnectionId: 1,
    action: row.commandType === "MODIFY_LIVE_SLTP" ? "MODIFY_POSITION" : "CLOSE_POSITION", symbol: row.symbol, lot: row.requestedVolume, sl: row.stopLoss, tp: row.takeProfit,
    status: "PENDING", payload }).returning())[0]!;
}
it("missing or nonboolean capability refuses automatic confirmation and never promotes it", async () => {
  const row = await draft();
  for (const capabilities of [null, {}, { supportsManagementTargetV1: false }, { supportsManagementTargetV1: "true" }]) {
    await updateConnection(1, { capabilities });
    await denied(claimLiveCommandForConfirm(row.commandId, { status: "LIVE_APPROVED" }, row), "MANAGEMENT_TERMINAL_UPGRADE_REQUIRED");
  }
  assert.equal((await db.select().from(commands).where(eq(commands.commandId,row.commandId)))[0]!.status,row.status);
});
it("capability removal after confirmation refuses final automatic dispatch", async () => {
  const row = await approved(); await updateConnection(1, { capabilities: {} });
  await denied(send(row), "MANAGEMENT_TERMINAL_UPGRADE_REQUIRED");
});
it("actual live poll requires both current capability and per-request protocol header", async () => {
  const row = await queuedManagement();
  assert.equal((await pollRoute(false)).command,null);
  assert.equal((await pollRoute(false,"true")).command,null);
  await updateConnection(1,{ capabilities: {} });
  assert.equal((await pollRoute(false,"1")).command,null);
  assert.equal((await db.select().from(commands).where(eq(commands.commandId,row.commandId)))[0]!.pickedByEaAt,null);
  await updateConnection(1,{ capabilities: { supportsManagementTargetV1: true } });
  assert.equal((await pollRoute(false,"1")).command.commandId,row.commandId);
  assert.equal((await pollRoute(false,"1")).command,null);
});
it("old live poll skips automatic work and still delivers later manual protection", async () => {
  await queuedManagement();
  await db.insert(commands).values({ commandId:"manual-protect",userId:9,bridgeConnectionId:1,
    commandType:"CLOSE_LIVE_POSITION",symbol:"EURUSD.a",side:"BUY",orderType:"CLOSE",
    requestedVolume:.1,status:"SENT_TO_MT5_LIVE",payload:{brokerTicket:"123"} });
  assert.equal((await pollRoute(false)).command.commandId,"manual-protect");
});
it("actual legacy mailbox withholds automation without marking it delivered; manual protection is unaffected", async () => {
  const row = await queuedManagement(); const bound = await mirror(row);
  await db.insert(mailbox).values({userId:9,mt5ConnectionId:1,action:"CLOSE_POSITION",symbol:"EURUSD.a",status:"PENDING",payload:{positionTicket:"123"}});
  const first = await pollRoute(true);
  assert.equal(first.commands.length,1);assert.notEqual(first.commands[0].id,bound.id);
  assert.equal((await db.select().from(mailbox).where(eq(mailbox.id,bound.id)))[0]!.status,"PENDING");
  await updateConnection(1,{ capabilities: {} });
  assert.deepEqual((await pollRoute(true,"1")).commands,[]);
  await updateConnection(1,{ capabilities:{supportsManagementTargetV1:true} });
  const results = await Promise.all([pollRoute(true,"1"),pollRoute(true,"1")]);
  assert.equal(results.flatMap(r=>r.commands).length,1);
});
it("partial attribution and null target cannot downgrade automatic mailbox work to manual", async () => {
  const row = await queuedManagement();
  for (const payload of [{liveCommandId:row.commandId}, {managementTargetV1:null}, {agentOwnership:{}}]) await mirror(row,payload);
  assert.deepEqual((await pollRoute(true)).commands,[]);
  assert.deepEqual((await pollRoute(true,"1")).commands,[]);
  await db.update(commands).set({payload:{managementTargetV1:null}}).where(eq(commands.commandId,row.commandId));
  assert.equal((await pollRoute(false,"1")).command,null);
});

it("oversized mailbox rows stay pending without starving later manual protection", async () => {
  const oversized = await db.insert(mailbox).values(Array.from({length:51},()=>({
    userId:9,mt5ConnectionId:1,action:"CLOSE_POSITION",symbol:"EURUSD.a",status:"PENDING",
    payload:{positionTicket:"123",comment:"x".repeat(66_000)} }))).returning();
  const [manual] = await db.insert(mailbox).values({userId:9,mt5ConnectionId:1,action:"CLOSE_POSITION",symbol:"EURUSD.a",status:"PENDING",payload:{positionTicket:"123"}}).returning();
  const result = await pollRoute(true,"1");
  assert.deepEqual(result.commands.map((c: any)=>c.id),[manual!.id]);
  assert.ok(JSON.stringify(result).length<=65_536);
  assert.ok((await db.select().from(mailbox).where(inArray(mailbox.id,oversized.map(r=>r.id)))).every(r=>r.status==="PENDING"));
});
it("a legitimate multi-command response fits parser capacity before any delivery commits", async () => {
  await db.insert(mailbox).values(Array.from({length:5},()=>({userId:9,mt5ConnectionId:1,action:"CLOSE_POSITION",symbol:"EURUSD.a",status:"PENDING",payload:{positionTicket:"123",comment:"x".repeat(25_000)}})));
  const first = await pollRoute(true,"1");
  assert.equal(first.commands.length,2);assert.ok(JSON.stringify(first).length<=65_536);
  const rows=await db.select().from(mailbox);
  assert.equal(rows.filter(r=>r.status==="DELIVERED").length,2);
  assert.equal(rows.filter(r=>r.status==="PENDING").length,3);
  const second = await pollRoute(true,"1");assert.equal(second.commands.length,2);
});

it("oversized live row remains unpicked while later manual protection is delivered", async () => {
  await db.insert(commands).values([
    {commandId:"large-live",userId:9,bridgeConnectionId:1,commandType:"CLOSE_LIVE_POSITION",symbol:"EURUSD.a",side:"BUY",orderType:"CLOSE",requestedVolume:.1,status:"SENT_TO_MT5_LIVE",payload:{brokerTicket:"123",comment:"x".repeat(66_000)}},
    {commandId:"normal-live",userId:9,bridgeConnectionId:1,commandType:"CLOSE_LIVE_POSITION",symbol:"EURUSD.a",side:"BUY",orderType:"CLOSE",requestedVolume:.1,status:"SENT_TO_MT5_LIVE",payload:{brokerTicket:"123"}},
  ]);
  const result = await pollRoute(false);
  assert.equal(result.command.commandId,"normal-live");assert.ok(JSON.stringify(result).length<=65_536);
  assert.equal((await db.select().from(commands).where(eq(commands.commandId,"large-live")))[0]!.pickedByEaAt,null);
});
it("unexpected live serialization growth or failure never consumes the pickup claim", async () => {
  const row = await queuedManagement();
  const args={userId:9,bridgeConnectionId:1,bridgeAccountType:"live",managementTargetSupported:true};
  const refused=await pickupNextLiveCommand({...args,prepareResponse:async()=>"x".repeat(65_537)});
  assert.equal(refused.refusalReason,"MT5_COMMAND_ENVELOPE_TOO_LARGE");
  await assert.rejects(pickupNextLiveCommand({...args,prepareResponse:async()=>{throw new Error("serializer failed");}}),/serializer failed/);
  assert.equal((await db.select().from(commands).where(eq(commands.commandId,row.commandId)))[0]!.pickedByEaAt,null);
  assert.equal((await pollRoute(false,"1")).command.commandId,row.commandId);
});

it("actual concurrent cold-map manual polls complete with a one-connection pool", async () => {
  await db.insert(symbolRegistry).values({symbol:"INTERNAL",brokerSymbol:"Exact.Native",displayName:"Fixture",marketType:"forex"});
  await db.insert(commands).values([1,2].map(n=>({commandId:`cold-manual-${n}`,userId:9,bridgeConnectionId:1,
    commandType:"CLOSE_LIVE_POSITION",symbol:"INTERNAL",side:"BUY",orderType:"CLOSE",requestedVolume:.1,
    status:"SENT_TO_MT5_LIVE",payload:{brokerTicket:"123"}})));
  // The child enforces the poll deadline itself (the property); this timeout is
  // liveness only and must cover a cold ~360-module tsx bootstrap on a slow
  // host (6-10 s measured on a loaded 4-vCPU VM) while staying well inside the
  // runner's 120 s suite budget.
  const result=spawnSync(process.execPath,["--import","tsx",fileURLToPath(new URL("./terminalPollSingleConnection.ts",import.meta.url))],
    {env:process.env,encoding:"utf8",timeout:45_000});
  assert.equal(result.status,0,`${result.error ?? ""} ${result.stdout} ${result.stderr}`);
  const report=result.stdout.split("\n").map(line=>{try{return JSON.parse(line);}catch{return null;}})
    .find(v=>v?.terminalPollSingleConnection)?.terminalPollSingleConnection;
  assert.ok(report,`child reported no poll timing: ${result.stdout} ${result.stderr}`);
  assert.ok(Number.isFinite(report.pollsMs)&&report.pollsMs>=0&&report.pollsMs<report.pollDeadlineMs,
    `polls took ${report.pollsMs} ms over a one-connection pool (deadline ${report.pollDeadlineMs} ms, bootstrap ${report.bootstrapMs} ms)`);
});
it("actual precision-rich automatic mirror survives float4 storage through mailbox poll and extracted EA", async () => {
  await updateConnection(1,{accountNumber:"100"});
  await db.update(commands).set({accountLogin:"100",brokerTicket:"42",requestedVolume:.02,executedVolume:.02}).where(eq(commands.commandId,"entry-1"));
  await db.update(positions).set({accountLogin:"100",brokerTicket:"42",volume:.02,stopLoss:1.1,takeProfit:1.3}).where(eq(positions.id,1));
  await db.update(executions).set({brokerTicket:"42",intendedVolume:.02,managementState:{pendingManagement:{
    claimId:"claim-1",action:"TIGHTEN_SL",stopLoss:1.123456789,requestedAt:new Date().toISOString(),
  }}}).where(eq(executions.id,1));
  const row=await approved();await send(row);const stored=await mirror(row);
  assert.notEqual(stored.sl,1.123456789,"control: legacy real column actually rounds this value");
  const response=await pollRoute(true,"1");
  assert.equal(response.commands.length,1);
  assert.equal(response.commands[0].sl,1.123456789);
  assert.equal(response.commands[0].tp,1.3);
  assert.equal(response.commands[0].lot,.02);
  const folder=mkdtempSync(join(tmpdir(),"arx-target-wire-"));
  try {
    const path=join(folder,"wire.json");writeFileSync(path,JSON.stringify(response));
    const runner=fileURLToPath(new URL("../../../../../../mt5-bridge/tests/run_management_target.py",import.meta.url));
    const result=spawnSync("python3",[runner,"--wire-file",path],{encoding:"utf8",timeout:15000});
    assert.equal(result.status,0,`${result.error ?? ""} ${result.stdout} ${result.stderr}`);
  } finally {rmSync(folder,{recursive:true,force:true});}
});
it("forged target or changed authoritative signature stays pending while later manual work is delivered", async () => {
  const row=await queuedManagement();const bound=await mirror(row);
  const original=bound.payload as Record<string,unknown>;
  await db.update(mailbox).set({payload:{...original,managementTargetV1:{...(original.managementTargetV1 as object),accountLogin:"B"}}}).where(eq(mailbox.id,bound.id));
  assert.equal((await pollRoute(true,"1")).commands.length,0);
  await db.update(mailbox).set({payload:original}).where(eq(mailbox.id,bound.id));
  await db.update(commands).set({stopLoss:99}).where(eq(commands.commandId,row.commandId));
  await db.insert(mailbox).values({userId:9,mt5ConnectionId:1,action:"CLOSE_POSITION",symbol:"EURUSD.a",status:"PENDING",payload:{positionTicket:"123"}});
  const result=await pollRoute(true,"1");assert.equal(result.commands.length,1);assert.notEqual(result.commands[0].id,bound.id);
  assert.equal((await db.select().from(mailbox).where(eq(mailbox.id,bound.id)))[0]!.status,"PENDING");
});

it("shared-master mailbox preserves distinct trader and bridge-owner identities", async () => {
  await updateConnection(1,{userId:19});
  const row=await queuedManagement();const bound=await mirror(row);
  assert.equal(bound.userId,19);assert.equal(bound.requestedByUserId,9);
  const response=await pollRoute(true,"1");
  assert.equal(response.commands.length,1);assert.equal(response.commands[0].id,bound.id);
  assert.equal(response.commands[0].payload.liveCommandOwnerUserId,9);
});
for(const corruption of ["trader","targetBridgeOwner","mirrorBridge"]){
  it(`shared-master automatic mirror refuses crossed ${corruption}`,async()=>{
    await updateConnection(1,{userId:19});const row=await queuedManagement();const bound=await mirror(row);
    if(corruption==="trader")await db.update(mailbox).set({requestedByUserId:18}).where(eq(mailbox.id,bound.id));
    if(corruption==="targetBridgeOwner")await db.update(mailbox).set({payload:{...(bound.payload as any),managementTargetV1:{...(bound.payload as any).managementTargetV1,bridgeOwnerUserId:9}}}).where(eq(mailbox.id,bound.id));
    if(corruption==="mirrorBridge")await db.update(mailbox).set({mt5ConnectionId:2}).where(eq(mailbox.id,bound.id));
    assert.equal((await pollRoute(true,"1")).commands.length,0);
    assert.equal((await db.select().from(mailbox).where(eq(mailbox.id,bound.id)))[0]!.status,"PENDING");
  });
}

it("paired actual mailbox route completion and transaction overhead", {skip:!process.env.ARX_TERMINAL_MAILBOX_BENCHMARK}, async()=>{
  const baselineFile=join(process.env.ARX_TERMINAL_BASELINE_ROOT!,"artifacts/api-server/src/routes/mt5.ts");
  const source=readFileSync(baselineFile,"utf8");
  const tree=ts.createSourceFile("mt5.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  let callback:ts.ArrowFunction|undefined;
  function visit(n:ts.Node){if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==="get"&&n.arguments[0]&&ts.isStringLiteral(n.arguments[0])&&n.arguments[0].text==="/mt5/commands")callback=n.arguments.at(-1) as ts.ArrowFunction;ts.forEachChild(n,visit);}visit(tree);
  assert.ok(callback);
  const js=ts.transpileModule(`const handler=${callback.getText(tree)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const baseline=new Function("db","mt5CommandsTable","and","eq","asc","inArray",`${js};return handler;`)(db,mailbox,and,eq,asc,inArray);
  const current=mt5Router.stack.find((l:any)=>l.route?.path==="/mt5/commands")!.route!.stack.at(-1)!.handle;
  const [connection]=await db.select().from(bridges).where(eq(bridges.id,1));
  const measure=async(handler:any)=>{
    let body:any;
    const res:any={json(v:unknown){body=JSON.parse(JSON.stringify(v));return res;},type(){return res;},send(v:string){body=JSON.parse(v);return res;}};
    const t=performance.now();await handler({mt5Connection:connection,get:()=>"1",log:{info(){},warn(){}}},res,()=>{});const elapsed=performance.now()-t;
    assert.equal(body.commands.length,50);assert.equal((await db.select().from(mailbox)).filter(r=>r.status==="DELIVERED").length,50);return elapsed;
  };
  await db.insert(mailbox).values(Array.from({length:50},()=>({userId:9,mt5ConnectionId:1,action:"CLOSE_POSITION",symbol:"EURUSD.a",status:"PENDING",payload:{positionTicket:"123"}})));
  const samples:{baseline:number[],current:number[],currentTransactionUpperBound:number[]}={baseline:[],current:[],currentTransactionUpperBound:[]};
  const original=db.transaction.bind(db);let transactionMs=0;
  const transactionSpy=mock.method(db,"transaction",async(...args:any[])=>{const t=performance.now();try{return await (original as any)(...args);}finally{transactionMs=performance.now()-t;}});
  try {for(let i=0;i<110;i++)for(const name of (i%2?["current","baseline"]:["baseline","current"]) as ["baseline"|"current","baseline"|"current"]){
    await db.update(mailbox).set({status:"PENDING",claimedAt:null,deliveredAt:null});
    const elapsed=await measure(name==="baseline"?baseline:current);
    if(i>=10){samples[name].push(elapsed);if(name==="current")samples.currentTransactionUpperBound.push(transactionMs);}
  }}finally{transactionSpy.mock.restore();}
  const summary=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return{median:sorted[49],p95:sorted[94],p99:sorted[98],max:sorted.at(-1)}};
  writeFileSync(process.env.ARX_TERMINAL_MAILBOX_BENCHMARK!,JSON.stringify({unit:"milliseconds",fixture:"50 ordinary manual protective rows; actual old handler extracted by AST and actual current router share identical db/pool/schema; no broker",completion:"response serialized and DB delivery committed",transactionMetric:"current transaction wall time is an upper bound on its row-lock holding duration",baselineFile,raw:samples,summary:Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,summary(v)]))},null,2));
  assert.ok(summary(samples.current).p95<100,"50-command local completion p95 budget100ms");
});
it("byte prefilter and UTF16 envelope budget remain distinct for Unicode payloads", async()=>{
  const [large]=await db.insert(mailbox).values({userId:9,mt5ConnectionId:1,action:"CLOSE_POSITION",symbol:"EURUSD.a",status:"PENDING",payload:{positionTicket:"123",comment:"😀".repeat(17000)}}).returning();
  await db.insert(mailbox).values(Array.from({length:4},()=>({userId:9,mt5ConnectionId:1,action:"CLOSE_POSITION",symbol:"EURUSD.a",status:"PENDING",payload:{positionTicket:"123",comment:"😀".repeat(9000)}})));
  const response=await pollRoute(true,"1");const body=JSON.stringify(response);
  assert.equal(response.commands.length,3);assert.ok(body.length<=65536);assert.ok(Buffer.byteLength(body)>65536);
  const rows=await db.select().from(mailbox);assert.equal(rows.find(r=>r.id===large!.id)!.status,"PENDING");
  assert.equal(rows.filter(r=>r.status==="PENDING").length,2);
});

// ── Fresh position observation at the final management claim (2026-10-27) ──
for (const [label, offsetMs, reason] of [
  ["stale", -91_000, "MANAGEMENT_OBSERVATION_STALE"],
  ["future-dated", 60_000, "MANAGEMENT_OBSERVATION_FUTURE_DATED"],
] as const)
  it(`final claim refuses a ${label} broker position observation`, async () => {
    const row = await approved();
    await db
      .update(positions)
      .set({ lastSyncedAt: new Date(Date.now() + offsetMs) })
      .where(eq(positions.id, 1));
    await denied(send(row), reason);
    const [current] = await db
      .select()
      .from(commands)
      .where(eq(commands.commandId, row.commandId));
    assert.equal(current!.status, "LIVE_APPROVED");
  });
it("final claim accepts a just-refreshed observation with unchanged geometry", async () => {
  const row = await approved();
  await db
    .update(positions)
    .set({ lastSyncedAt: new Date() })
    .where(eq(positions.id, 1));
  assert.equal((await send(row))?.status, "SENT_TO_MT5_LIVE");
});
