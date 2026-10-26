// Real PostgreSQL transactions against runner-created tables. No broker/network
// adapter is imported. The test rejects non-disposable database destinations.
import { after, before, beforeEach, it, mock } from "node:test";
import assert from "node:assert/strict";
import { getTableColumns, getTableName, eq, sql, SQL } from "drizzle-orm";
import { PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
const destination = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
assert.equal(
  process.env.ARX_ENTRY_CAPACITY_PG,
  "1",
  "Use the disposable PostgreSQL runner",
);
assert.equal(destination.pathname, "/arx_entry_capacity_test");
assert.match(
  destination.searchParams.get("host") ?? "",
  /\/arx-entry-capacity-[^/]+\/socket$/,
);
assert.equal(destination.username, "arx_qa");
const database = await import("@workspace/db");
const {
  db,
  pool,
  selfTradeAgentsTable: agents,
  selfTradeAgentSettingsTable: settings,
  selfTradeAgentLedgerTable: ledger,
  selfTradeDecisionsTable: decisions,
  selfTradeAgentExecutionsTable: executions,
  selfTradeAuditLogTable: audit,
  selfTradeLedgerEntriesTable: entries,
  selfTradeAllocationsTable: allocations,
} = database;
mock.module("../../security/events.js", {
  namedExports: { mirrorCriticalEvent: async () => undefined },
});
mock.module("../../security/handshake.js", {
  namedExports: { enforceSensitiveAction: async () => ({ ok: true }) },
});
let submitBehavior: "accepted" | "throw" | "refused" | "unknown" = "accepted";
let submissions = 0;
let dispatchRequests = 0;
let submittedPrepareOnly: boolean | undefined;
mock.module("../../tradeEngine/pipeline.js", {
  namedExports: {
    submitInstantTrade: async (args: { intent: { prepareOnly?: boolean } }) => {
      submittedPrepareOnly = args.intent.prepareOnly;
      if (!args.intent.prepareOnly) dispatchRequests++;
      submissions++;
      if (submitBehavior === "throw")
        throw new Error("simulated crash after pipeline invocation");
      if (submitBehavior === "refused")
        return { ok: false, error: "PRE_DRAFT_REFUSAL" };
      if (submitBehavior === "unknown")
        return { ok: false, error: "OUTCOME_UNKNOWN", commandId: "qa-command" };
      return { ok: true, commandId: "qa-command" };
    },
  },
});
mock.module("../executionGate.js", {
  namedExports: {
    evaluateAgentExecution: async (request: {
      decision: { thesis: unknown; outcome: string };
    }) => ({
      verdict: {
        permitted: true,
        action:
          request.decision.outcome === "PREPARE_ONLY"
            ? "PREPARE_ONLY"
            : "EXECUTE",
      },
      thesis: request.decision.thesis,
      executingUserId: 9,
      sizeMultiplier: 1,
    }),
  },
});
mock.module("../killSwitchGate.js", {
  namedExports: { assertAgentNotKilled: async () => ({ killed: false }) },
});
mock.module("../../data/marketDataRouter.js", {
  namedExports: {
    routeQuote: async () => {
      throw new Error("No market-data access in test");
    },
  },
});
mock.module("../../mt5/contractSize.js", {
  namedExports: {
    FX_STANDARD_LOT_UNITS: 100000,
    isForexPair: () => true,
    resolveContractSize: async () => ({
      contractSize: 100000,
      profitCurrency: "USD",
    }),
    resolveQuoteToAccountFx: () => ({ factor: 1 }),
  },
});
mock.module("../../live/accountCurrency.js", {
  namedExports: { getAccountCurrency: async () => "USD" },
});
mock.module("../../aaci/executionAdvisory.js", {
  namedExports: {
    evaluateAaciExecutionAdvisory: async () => ({
      advisory: {
        proceed: true,
        downgradeToPrepareOnly: false,
        sizeMultiplier: 1,
      },
    }),
  },
});
const { reserveAgentEntry } = await import("../entryReservation.js");
const { executeAgentDecision } = await import("../agentExecutor.js");
const { fundAgent, defundAgent, applyRealizedFromFills } =
  await import("../agentLedger.js");
const Pool = pool.constructor as new (config: {
  connectionString?: string;
}) => typeof pool;
const { configureAgent, setAgentStatus } = await import("../service.js");
const tables = [
  agents,
  settings,
  ledger,
  decisions,
  executions,
  audit,
  entries,
  allocations,
];
const dialect = new PgDialect();
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
function defaultValue(value: unknown): string {
  if (value instanceof SQL) {
    const query = dialect.sqlToQuery(value);
    assert.equal(query.params.length, 0);
    return query.sql;
  }
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return `'${(typeof value === "string" ? value : JSON.stringify(value)).replaceAll("'", "''")}'`;
}
async function createTable(table: PgTable) {
  const definitions = Object.values(getTableColumns(table)).map(
    (c) =>
      `${quote(c.name)} ${c.getSQLType()}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? ` DEFAULT ${defaultValue(c.default)}` : ""}${c.primary ? " PRIMARY KEY" : ""}`,
  );
  await pool.query(
    `CREATE TABLE ${quote(getTableName(table))} (${definitions.join(",")})`,
  );
}
const now = new Date("2026-10-26T12:00:00Z");
let agent: typeof agents.$inferSelect;
let config: typeof settings.$inferSelect;
let balance: typeof ledger.$inferSelect;
async function decision() {
  return (
    await db
      .insert(decisions)
      .values({
        agentId: agent.id,
        agentKey: agent.agentKey,
        cycleId: crypto.randomUUID(),
        symbol: "EURUSD",
        timeframe: "M5",
        side: "BUY",
        outcome: "APPROVED",
        setupType: "TEST",
        plannedAction: "EXECUTE",
        reason: "isolated test",
        thesis: {
          side: "BUY",
          entryZone: { from: 1.1, to: 1.1 },
          stopLoss: 1.09,
          takeProfits: [{ from: 1.12 }],
        },
        setupExpiresAt: new Date("2026-10-30T00:00:00Z"),
        evaluatedAt: now,
      })
      .returning()
  )[0];
}
async function input() {
  return {
    agent,
    settings: config,
    ledger: balance,
    decision: await decision(),
    executingUserId: 9,
    side: "BUY" as const,
    volume: 0.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    now,
  };
}
async function configure(patch: Partial<typeof settings.$inferInsert>) {
  [config] = await db
    .update(settings)
    .set(patch)
    .where(eq(settings.agentId, agent.id))
    .returning();
}
async function reserve() {
  return reserveAgentEntry(await input());
}
const actor = { actorUserId: 9, actorRole: "admin", reason: "isolated test" };
before(async () => {
  mock.timers.enable({ apis: ["Date"], now: now.getTime() });
  for (const table of tables) await createTable(table);
  await pool.query(
    "CREATE UNIQUE INDEX test_agent_key ON self_trade_agents(agent_key)",
  );
  await pool.query(
    "CREATE UNIQUE INDEX test_agent_settings ON self_trade_agent_settings(agent_id)",
  );
  await pool.query(
    "CREATE UNIQUE INDEX test_agent_ledger ON self_trade_agent_ledger(agent_id)",
  );
  await pool.query(
    "CREATE UNIQUE INDEX self_trade_agent_executions_idem_active_uq ON self_trade_agent_executions(agent_id,idempotency_key) WHERE status IN ('PENDING_TICKET','DISPATCHED','FILLED')",
  );
});
beforeEach(async () => {
  submissions = 0;
  dispatchRequests = 0;
  submittedPrepareOnly = undefined;
  submitBehavior = "accepted";
  await pool.query(
    `TRUNCATE ${tables.map((t) => quote(getTableName(t))).join(",")} RESTART IDENTITY`,
  );
  [agent] = await db
    .insert(agents)
    .values({
      agentKey: "alpha",
      name: "QA alpha",
      profileTemplate: "ALPHA",
      ownerType: "USER",
      ownerId: 9,
      createdByUserId: 10,
      status: "ACTIVE",
      mode: "LIVE",
      autonomyLevel: 3,
    })
    .returning();
  [config] = await db
    .insert(settings)
    .values({
      agentId: agent.id,
      maxLotPerTrade: 1,
      maxConcurrentPositions: 1,
      baseMaxTrades: 5,
    })
    .returning();
  [balance] = await db
    .insert(ledger)
    .values({ agentId: agent.id, allocatedFunds: 1000, availableFunds: 1000 })
    .returning();
});
after(async () => {
  mock.timers.reset();
  await pool.end();
});
it("24 concurrent distinct decisions admit exactly one position slot", async () => {
  const inputs = await Promise.all(Array.from({ length: 24 }, input));
  const results = await Promise.all(inputs.map((i) => reserveAgentEntry(i)));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal((await db.select().from(executions)).length, 1);
  assert.equal((await db.select().from(audit)).length, 1);
  assert.ok(
    results
      .filter((r) => !r.ok)
      .every((r) => r.reason === "AGENT_ENTRY_CAPACITY_REACHED"),
  );
});
it("daily cap reserves pending entries even with unlimited concurrent positions", async () => {
  await configure({ maxConcurrentPositions: 0, baseMaxTrades: 2 });
  const results = await Promise.all(
    (await Promise.all(Array.from({ length: 12 }, input))).map((i) =>
      reserveAgentEntry(i),
    ),
  );
  assert.equal(results.filter((r) => r.ok).length, 2);
  assert.ok(
    results
      .filter((r) => !r.ok)
      .every((r) => r.reason === "AGENT_DAILY_ENTRY_CAPACITY_REACHED"),
  );
});
it("same decision is never replayed after any terminal result", async () => {
  await configure({ maxConcurrentPositions: 0, baseMaxTrades: 100 });
  for (const status of ["CLOSED", "BLOCKED", "REJECTED", "EXPIRED"]) {
    const request = await input();
    const first = await reserveAgentEntry(request);
    assert.ok(first.ok);
    await db
      .update(executions)
      .set({ status })
      .where(eq(executions.id, first.execution.id));
    const retry = await reserveAgentEntry(request);
    assert.equal(retry.ok, false);
    if (!retry.ok) assert.equal(retry.duplicate, true);
  }
});
it("confirmed cancellation/rejection frees capacity for a NEW decision only", async () => {
  for (const status of ["BLOCKED", "REJECTED", "EXPIRED"]) {
    const request = await input();
    const result = await reserveAgentEntry(request);
    assert.ok(result.ok);
    await db
      .update(executions)
      .set({ status })
      .where(eq(executions.id, result.execution.id));
    assert.equal((await reserveAgentEntry(request)).ok, false);
  }
  assert.equal((await reserve()).ok, true);
});
it("unknown pending/dispatch survives new process connections and midnight without lease expiry", async () => {
  await configure({ maxConcurrentPositions: 0, baseMaxTrades: 1 });
  const first = await reserve();
  assert.ok(first.ok);
  for (const status of ["PENDING_TICKET", "DISPATCHED"]) {
    await db
      .update(executions)
      .set({
        status,
        commandId: status === "DISPATCHED" ? "unknown-command" : null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })
      .where(eq(executions.id, first.execution.id));
    const restartedPool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
    try {
      const result = await reserveAgentEntry(
        { ...(await input()), now: new Date("2026-10-27T00:00:01Z") },
        drizzle(restartedPool) as typeof db,
      );
      assert.equal(result.ok, false);
      if (!result.ok)
        assert.equal(result.reason, "AGENT_DAILY_ENTRY_CAPACITY_REACHED");
    } finally {
      await restartedPool.end();
    }
  }
});
it("UTC rollover releases yesterday's filled daily quota, not pending capacity", async () => {
  await configure({ maxConcurrentPositions: 0, baseMaxTrades: 1 });
  const first = await reserve();
  assert.ok(first.ok);
  await db
    .update(executions)
    .set({ status: "CLOSED", filledAt: new Date("2026-10-26T23:59:59Z") })
    .where(eq(executions.id, first.execution.id));
  const next = await input();
  assert.equal(
    (
      await reserveAgentEntry({
        ...next,
        now: new Date("2026-10-26T23:59:59.999Z"),
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await reserveAgentEntry({
        ...next,
        now: new Date("2026-10-27T00:00:00Z"),
      })
    ).ok,
    true,
  );
});
it("a confirmed fill without a live snapshot still occupies concurrent capacity", async () => {
  const first = await reserve();
  assert.ok(first.ok);
  await db
    .update(executions)
    .set({ status: "FILLED", filledAt: now, brokerTicket: "missing-snapshot" })
    .where(eq(executions.id, first.execution.id));
  assert.equal((await reserve()).ok, false);
});
it("rejects stale settings, funding and owner snapshots; orphan USER cannot fall back to creator", async () => {
  const request = await input();
  await db
    .update(settings)
    .set({ riskPerTradePct: 2 })
    .where(eq(settings.agentId, agent.id));
  assert.deepEqual(await reserveAgentEntry(request), {
    ok: false,
    reason: "ENTRY_CONTEXT_CHANGED",
  });
  await db
    .update(settings)
    .set({ riskPerTradePct: config.riskPerTradePct })
    .where(eq(settings.agentId, agent.id));
  await db
    .update(ledger)
    .set({ availableFunds: 999 })
    .where(eq(ledger.agentId, agent.id));
  assert.deepEqual(await reserveAgentEntry(request), {
    ok: false,
    reason: "ENTRY_CONTEXT_CHANGED",
  });
  await db
    .update(agents)
    .set({ ownerId: null, createdByUserId: 9 })
    .where(eq(agents.id, agent.id));
  assert.deepEqual(await reserveAgentEntry(request), {
    ok: false,
    reason: "ENTRY_OWNER_CHANGED",
  });
  assert.equal((await db.select().from(executions)).length, 0);
});
it("rejects cross-agent/side/protection substitutions and expired decisions", async () => {
  const request = await input();
  assert.equal(
    (await reserveAgentEntry({ ...request, executingUserId: 99 })).ok,
    false,
  );
  assert.equal(
    (await reserveAgentEntry({ ...request, side: "SELL" })).ok,
    false,
  );
  assert.equal(
    (await reserveAgentEntry({ ...request, stopLoss: 1.01 })).ok,
    false,
  );
  assert.equal((await reserveAgentEntry({ ...request, volume: 2 })).ok, false);
  assert.equal(
    (
      await reserveAgentEntry({
        ...request,
        now: new Date("2026-11-01T00:00:00Z"),
      })
    ).ok,
    false,
  );
  const [foreign] = await db
    .update(decisions)
    .set({ agentId: 999 })
    .where(eq(decisions.id, request.decision.id))
    .returning();
  assert.equal(
    (await reserveAgentEntry({ ...request, decision: foreign })).ok,
    false,
  );
  assert.equal((await db.select().from(executions)).length, 0);
});
it("audit failure rolls back reservation and permits a clean retry", async () => {
  const request = await input();
  await pool.query(
    "ALTER TABLE self_trade_audit_log ADD CONSTRAINT qa_audit_failure CHECK (event_type <> 'ENTRY_CAPACITY_RESERVED')",
  );
  await assert.rejects(reserveAgentEntry(request));
  assert.equal((await db.select().from(executions)).length, 0);
  await pool.query(
    "ALTER TABLE self_trade_audit_log DROP CONSTRAINT qa_audit_failure",
  );
  assert.equal((await reserveAgentEntry(request)).ok, true);
});
it("a disconnected uncommitted client releases its lock without leaving a phantom reservation", async () => {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(
    "SELECT id FROM self_trade_agents WHERE id=$1 FOR UPDATE",
    [agent.id],
  );
  await client.query(
    "INSERT INTO self_trade_agent_executions(agent_id,agent_key,symbol,side,idempotency_key) VALUES($1,'alpha','EURUSD','BUY','crash-before-commit')",
    [agent.id],
  );
  client.release(true);
  const result = await reserve();
  assert.ok(result.ok);
  assert.equal((await db.select().from(executions)).length, 1);
});
it("funding and admission serialize without deadlock or lost capital", async () => {
  const request = await input();
  const results = await Promise.all([
    reserveAgentEntry(request),
    fundAgent({ ...actor, agentId: agent.id, amount: 100 }),
  ]);
  assert.equal(results[1].ok, true);
  const [current] = await db.select().from(ledger);
  assert.equal(current.availableFunds, 1100);
  // Either admission linearizes first, or rejects its stale sizing snapshot.
  if (!results[0].ok) assert.equal(results[0].reason, "ENTRY_CONTEXT_CHANGED");
});
it("withdrawal cannot drain capital behind a committed reservation", async () => {
  const request = await input();
  const [reservation, withdrawal] = await Promise.all([
    reserveAgentEntry(request),
    defundAgent({ ...actor, agentId: agent.id, amount: 1000 }),
  ]);
  assert.equal(Number(reservation.ok) + Number(withdrawal.ok), 1);
  const [current] = await db.select().from(ledger);
  assert.equal(current.availableFunds, reservation.ok ? 1000 : 0);
  if (reservation.ok)
    assert.equal(withdrawal.error, "ACTIVE_EXECUTIONS_PRESENT");
});
it("concurrent funding and realized posting preserve totals and post each execution once", async () => {
  const first = await reserve();
  assert.ok(first.ok);
  await db
    .update(executions)
    .set({ status: "CLOSED", filledAt: now, realizedPnl: 10 })
    .where(eq(executions.id, first.execution.id));
  await Promise.all([
    applyRealizedFromFills(agent.id),
    applyRealizedFromFills(agent.id),
    fundAgent({ ...actor, agentId: agent.id, amount: 100 }),
    fundAgent({ ...actor, agentId: agent.id, amount: 100 }),
  ]);
  const [current] = await db.select().from(ledger);
  assert.equal(current.availableFunds, 1210);
  assert.equal(current.realizedPnl, 10);
  assert.equal(
    (await db.select().from(entries)).filter(
      (e) => e.entryType === "REALIZED_PNL",
    ).length,
    1,
  );
});
it("a setting transaction holding the agent lock wins before stale admission rechecks", async () => {
  const request = await input();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT id FROM self_trade_agents WHERE id=$1 FOR UPDATE",
      [agent.id],
    );
    await client.query(
      "UPDATE self_trade_agent_settings SET max_concurrent_positions=2 WHERE agent_id=$1",
      [agent.id],
    );
    const attempted = reserveAgentEntry(request);
    await client.query("COMMIT");
    assert.deepEqual(await attempted, {
      ok: false,
      reason: "ENTRY_CONTEXT_CHANGED",
    });
  } finally {
    client.release();
  }
});

async function executeInput() {
  return {
    ...(await input()),
    fleet: {
      governor: { status: "ALLOW", hardBlocks: [] },
      handshake: { ready: true, degraded: [], blocked: [] },
    },
  } as Parameters<typeof executeAgentDecision>[0];
}
it("actual executor suppresses a second distinct entry before touching the venue", async () => {
  const results = await Promise.all([
    executeAgentDecision(await executeInput()),
    executeAgentDecision(await executeInput()),
  ]);
  assert.equal(submissions, 1);
  assert.equal(results.filter((r) => r.status === "DISPATCHED").length, 1);
  const [row] = await db.select().from(executions);
  assert.equal(row.status, "DISPATCHED");
  assert.equal(row.commandId, "qa-command");
});
it("actual executor keeps unknown linked outcomes pending and prevents retry", async () => {
  submitBehavior = "unknown";
  await executeAgentDecision(await executeInput());
  const [row] = await db.select().from(executions);
  assert.equal(row.status, "PENDING_TICKET");
  assert.equal(row.commandId, "qa-command");
  await executeAgentDecision(await executeInput());
  assert.equal(submissions, 1);
});
it("actual executor retains an unlinked reservation after a crash at submission", async () => {
  submitBehavior = "throw";
  const request = await executeInput();
  await assert.rejects(executeAgentDecision(request), /simulated crash/);
  const [row] = await db.select().from(executions);
  assert.equal(row.status, "PENDING_TICKET");
  assert.equal(row.commandId, null);
  submitBehavior = "accepted";
  await executeAgentDecision(request);
  await executeAgentDecision(await executeInput());
  assert.equal(submissions, 1);
});
it("actual executor preserves reservation on command-link write loss after acceptance", async () => {
  await pool.query(
    "ALTER TABLE self_trade_agent_executions ADD CONSTRAINT qa_lost_link CHECK (command_id IS NULL)",
  );
  try {
    await assert.rejects(executeAgentDecision(await executeInput()));
    const [row] = await db.select().from(executions);
    assert.equal(row.status, "PENDING_TICKET");
    assert.equal(row.commandId, null);
    await executeAgentDecision(await executeInput());
    assert.equal(submissions, 1);
  } finally {
    await pool.query(
      "ALTER TABLE self_trade_agent_executions DROP CONSTRAINT qa_lost_link",
    );
  }
});
it("actual executor releases only a proven pre-draft refusal; old decision stays consumed", async () => {
  submitBehavior = "refused";
  const request = await executeInput();
  await executeAgentDecision(request);
  const [row] = await db.select().from(executions);
  assert.equal(row.status, "BLOCKED");
  assert.equal(
    (await executeAgentDecision(request)).status,
    "SKIPPED_DUPLICATE",
  );
  submitBehavior = "accepted";
  assert.equal(
    (await executeAgentDecision(await executeInput())).status,
    "DISPATCHED",
  );
  assert.equal(submissions, 2);
});
it("reservation database failure is never mislabeled as a duplicate", async () => {
  await pool.query(
    "ALTER TABLE self_trade_audit_log ADD CONSTRAINT qa_audit_failure CHECK (event_type <> 'ENTRY_CAPACITY_RESERVED')",
  );
  try {
    const result = await executeAgentDecision(await executeInput());
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.blockReason, "ENTRY_RESERVATION_UNAVAILABLE");
    assert.equal(submissions, 0);
    assert.equal((await db.select().from(executions)).length, 0);
  } finally {
    await pool.query(
      "ALTER TABLE self_trade_audit_log DROP CONSTRAINT qa_audit_failure",
    );
  }
});

it("operator-fleet entries bind to their creator; user entries never borrow that identity", async () => {
  [agent] = await db
    .update(agents)
    .set({ ownerType: "OPERATOR_FLEET", ownerId: null, createdByUserId: 9 })
    .where(eq(agents.id, agent.id))
    .returning();
  assert.equal((await reserve()).ok, true);
});
it("real settings writer and admission share a consistent lock order", async () => {
  const request = await input();
  const [reservation, changed] = await Promise.all([
    reserveAgentEntry(request),
    configureAgent(agent.id, { maxConcurrentPositions: 2 }, "isolated test", {
      userId: 9,
      role: "admin",
    }),
  ]);
  assert.equal(changed.ok, true);
  if (!reservation.ok)
    assert.equal(reservation.reason, "ENTRY_CONTEXT_CHANGED");
  const [updated] = await db.select().from(settings);
  assert.equal(updated.maxConcurrentPositions, 2);
});
it("activation racing full withdrawal never leaves an unfunded ACTIVE agent", async () => {
  await db
    .update(agents)
    .set({ status: "FUNDED_IDLE" })
    .where(eq(agents.id, agent.id));
  await Promise.all([
    setAgentStatus(agent.id, "ACTIVE", "isolated test", {
      userId: 9,
      role: "admin",
    }),
    defundAgent({ ...actor, agentId: agent.id, amount: 1000 }),
  ]);
  const [current] = await db.select().from(agents);
  const [funds] = await db.select().from(ledger);
  assert.equal(funds.availableFunds, 0);
  assert.equal(current.status, "UNFUNDED");
});

it("withdrawal holding the agent lock prevents a waiting activation from reading stale funds", async () => {
  await db
    .update(agents)
    .set({ status: "FUNDED_IDLE" })
    .where(eq(agents.id, agent.id));
  const barrier = await pool.connect();
  await barrier.query("SELECT pg_advisory_lock(771234)");
  await pool.query(`CREATE FUNCTION qa_pause_defund() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.entry_type = 'DEFUND' THEN PERFORM pg_advisory_xact_lock(771234); END IF; RETURN NEW; END $$`);
  await pool.query(
    "CREATE TRIGGER qa_pause_defund BEFORE INSERT ON self_trade_ledger_entries FOR EACH ROW EXECUTE FUNCTION qa_pause_defund()",
  );
  let withdrawal: ReturnType<typeof defundAgent> | undefined;
  let activation: ReturnType<typeof setAgentStatus> | undefined;
  async function waitFor(query: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await pool.query(query)).rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("expected transaction did not reach lock barrier");
  }
  try {
    withdrawal = defundAgent({ ...actor, agentId: agent.id, amount: 1000 });
    await waitFor(
      "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=771234 AND NOT granted",
    );
    activation = setAgentStatus(agent.id, "ACTIVE", "isolated test", {
      userId: 9,
      role: "admin",
    });
    await waitFor(
      "SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%self_trade_agents%for update%'",
    );
    await barrier.query("SELECT pg_advisory_unlock(771234)");
    assert.equal((await withdrawal).ok, true);
    assert.equal((await activation).ok, false);
    const [current] = await db.select().from(agents);
    assert.equal(current.status, "UNFUNDED");
  } finally {
    await barrier.query("SELECT pg_advisory_unlock_all()");
    await Promise.allSettled([withdrawal, activation].filter(Boolean));
    barrier.release();
    await pool.query(
      "DROP TRIGGER qa_pause_defund ON self_trade_ledger_entries",
    );
    await pool.query("DROP FUNCTION qa_pause_defund()");
  }
});

it("supervisor PREPARE_ONLY at L3 reserves and stages once without automatic dispatch", async () => {
  const request = await executeInput();
  [request.decision] = await db
    .update(decisions)
    .set({ outcome: "PREPARE_ONLY" })
    .where(eq(decisions.id, request.decision.id))
    .returning();
  const first = await executeAgentDecision(request);
  assert.equal(first.status, "PREPARED");
  assert.equal(submittedPrepareOnly, true);
  assert.equal(dispatchRequests, 0);
  assert.equal(
    (await executeAgentDecision(request)).status,
    "SKIPPED_DUPLICATE",
  );
  assert.equal(submissions, 1);
  const [row] = await db.select().from(executions);
  assert.equal(row.status, "PENDING_TICKET");
  assert.equal(row.commandId, "qa-command");
});
