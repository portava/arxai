// Run only via the disposable Unix-socket PostgreSQL runner. All venue delivery
// is an in-process fixture; no account, provider or order endpoint is contacted.
import { after, before, beforeEach, it, mock } from "node:test";
import assert from "node:assert/strict";
import { eq, getTableColumns, getTableName, SQL } from "drizzle-orm";
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
  selfTradeDecisionsTable: decisions,
  selfTradeAuditLogTable: selfAudit,
  userOneClickSettingsTable: settings,
  oneClickAuditTable: instantAudit,
  liveTradingAuditTable: audit,
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
mock.module("../../security/events.js", {
  namedExports: {
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
const { createLiveOpsDraft, buildBridgedMt5CommandPayload } =
  await import("../../live/liveCommandPipeline.js");
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
const tables = [
  bridges,
  commands,
  positions,
  executions,
  settings,
  audit,
  instantAudit,
  agents,
  decisions,
  selfAudit,
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
    const columns = Object.values(getTableColumns(table)).map(
      (c) =>
        `${quote(c.name)} ${c.getSQLType()}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? ` DEFAULT ${value(c.default)}` : ""}${c.primary ? " PRIMARY KEY" : ""}`,
    );
    await pool.query(
      `CREATE TABLE ${quote(getTableName(table))} (${columns.join(",")})`,
    );
  }
  // Intentionally allow two ledger rows with a reused ticket to exercise the
  // future composite-identity world as well as today's overwritten-row failure.
  // This fixture does NOT assert that the production user+ticket index is fixed.
  await pool.query(
    "CREATE UNIQUE INDEX qa_command_identity ON arx_live_commands(command_id)",
  );
});
after(async () => {
  await pool.end();
});
const reference = { executionId: 1, positionRowId: 1, claimId: "claim-1" };
beforeEach(async () => {
  deliveries = 0;
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
  await db
    .insert(commands)
    .values({
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
  await db
    .insert(executions)
    .values({
      id: 1,
      agentId: 4,
      agentKey: "agent",
      decisionId: 7,
      executingUserId: 9,
      symbol: "EURUSD",
      side: "BUY",
      intendedVolume: 0.1,
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
  await db
    .insert(positions)
    .values({
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
  await db
    .insert(agents)
    .values({
      id: 4,
      agentKey: "agent",
      name: "Offline fixture",
      profileTemplate: "ALPHA",
      ownerType: "USER",
      ownerId: 9,
      autonomyLevel: 3,
    });
  await db
    .insert(decisions)
    .values({
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
});
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
  await db
    .insert(positions)
    .values({
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
      await tx
        .insert(commands)
        .values({
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
