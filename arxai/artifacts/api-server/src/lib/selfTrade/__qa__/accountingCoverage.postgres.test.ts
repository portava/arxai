// Actual read services against a disposable database; no broker or order paths.
import { after, before, beforeEach, it, mock } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { eq, getTableColumns, getTableName, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
const destination = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
assert.equal(process.env.ARX_FLEET_ACCOUNTING_PG, "1");
assert.equal(destination.pathname, "/arx_fleet_accounting_test");
assert.match(
  destination.searchParams.get("host") ?? "",
  /\/arx-fleet-accounting-[^/]+\/socket$/,
);
assert.equal(destination.username, "arx_qa");
mock.method(globalThis, "fetch", async () => {
  throw new Error("Unexpected external request");
});
mock.module("../../readiness/traderReadiness.js", {
  namedExports: {
    evaluateReadiness: async () => {
      throw new Error("Offline unrelated source");
    },
  },
});
mock.module("../../marketScanner.js", {
  namedExports: {
    scanSymbolTimeframe: async () => {
      throw new Error("Unexpected market read");
    },
  },
});
mock.module("../../news/newsIntelligenceService.js", {
  namedExports: {
    getNewsIntelligence: async () => {
      throw new Error("Unexpected news read");
    },
  },
});
mock.module("../../alerts/alertManager.js", {
  namedExports: { getUnreadCount: async () => 0 },
});
mock.module("../../../brain/timing/marketTimingBrainService.js", {
  namedExports: {
    computeTimingRead: async () => {
      throw new Error("Unexpected timing read");
    },
  },
});
mock.module("../../data/chart/chartIntelligence.js", {
  namedExports: { getCachedIntelligenceContext: () => undefined },
});
mock.module("../../data/chart/chartHandshake.js", {
  namedExports: { buildChartHandshake: () => undefined },
});
mock.module("../../security/events.js", {
  namedExports: {
    mirrorCriticalEvent: async () => undefined,
    recordSecurityEvent: async () => undefined,
  },
});
mock.module("../../security/handshake.js", {
  namedExports: {
    enforceSensitiveAction: async () => {
      throw new Error("Unexpected mutation");
    },
  },
});
const {
  db,
  pool,
  selfTradeAgentsTable: agents,
  selfTradeAgentLedgerTable: ledgers,
  selfTradeLedgerEntriesTable: entries,
  selfTradeAgentSettingsTable: settings,
  selfTradeAgentExecutionsTable: executions,
} = await import("@workspace/db");
const { readAccountingRows, projectAccounting, combineAccounting } =
  await import("../accountingCoverage.js");
const { computeFleetHealth } = await import("../selfTradeSupervisor.js");
const { getFleetOverview, getAgentById } = await import("../service.js");
const { buildAaciSnapshot } = await import("../../aaci/snapshotService.js");
const tables = [agents, ledgers, settings, executions, entries];
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
  await pool.query(
    "CREATE UNIQUE INDEX qa_agent_ledger ON self_trade_agent_ledger(agent_id)",
  );
  await pool.query(
    "CREATE INDEX qa_entry_agent ON self_trade_ledger_entries(agent_id)",
  );
  await pool.query(
    "CREATE INDEX qa_execution_agent ON self_trade_agent_executions(agent_id)",
  );
  await pool.query(
    "CREATE INDEX qa_agent_owner ON self_trade_agents(owner_type,owner_id)",
  );
});
after(async () => {
  await pool.end();
});
const now = new Date("2026-10-26T12:00:00.000Z");
async function addAgent(
  id = 1,
  ownerId = 1,
  withLedger = true,
  ownerType = "USER",
) {
  await db.insert(agents).values({
    id,
    agentKey: `agent-${id}`,
    name: `Agent ${id}`,
    profileTemplate: "ALPHA",
    ownerType,
    ownerId: ownerType === "USER" ? ownerId : null,
    createdByUserId: ownerId,
    status: "ACTIVE",
  });
  if (withLedger)
    await db
      .insert(ledgers)
      .values({ agentId: id, allocatedFunds: 1000, availableFunds: 1000 });
  await db.insert(settings).values({ agentId: id, maxDailyLossUsd: 100 });
}
async function close(
  pnl: number | null,
  options: {
    agentId?: number;
    at?: Date | null;
    managementState?: Record<string, unknown>;
    status?: string;
  } = {},
) {
  const id = options.agentId ?? 1;
  const [execution] = await db
    .insert(executions)
    .values({
      agentId: id,
      agentKey: `agent-${id}`,
      symbol: "EURUSD",
      side: "BUY",
      idempotencyKey: `offline-${crypto.randomUUID()}`,
      status: options.status ?? "CLOSED",
      realizedPnl: pnl,
      closedAt: options.at === undefined ? now : options.at,
      managementState: options.managementState ?? {},
    })
    .returning();
  if (
    pnl != null &&
    Number.isFinite(pnl) &&
    !Object.hasOwn(options.managementState ?? {}, "closeAccounting") &&
    (options.status ?? "CLOSED") === "CLOSED"
  )
    await db.insert(entries).values({
      agentId: id,
      entryType: "REALIZED_PNL",
      refType: "EXECUTION",
      refId: execution.id,
      amount: Math.round((pnl + Number.EPSILON) * 100) / 100,
    });
}
async function coverage(id = 1) {
  return projectAccounting(
    (await readAccountingRows([id], undefined, now))[0],
    now,
  );
}
beforeEach(async () => {
  await pool.query(
    `TRUNCATE ${tables.map((t) => quote(getTableName(t))).join(",")} RESTART IDENTITY`,
  );
  await addAgent();
});
it("known zero remains recorded zero, without inferring a broker balance", async () => {
  await close(0);
  const c = await coverage();
  assert.equal(c.status, "RECORDED");
  assert.equal(c.recordedTrades, 1);
  assert.equal(c.unknownTrades, 0);
  assert.equal(c.dailyLossUsed, 0);
  assert.equal(c.recordedRealizedPnl, 0);
  assert.match(c.notes.join(" "), /does not verify broker/);
});
it("null close P&L keeps the recorded subtotal separate from unknown totals", async () => {
  await close(null);
  await close(25);
  await db
    .update(ledgers)
    .set({ realizedPnl: 25 })
    .where(eq(ledgers.agentId, 1));
  const c = await coverage();
  assert.equal(c.status, "INCOMPLETE");
  assert.equal(c.recordedTrades, 1);
  assert.equal(c.closedTrades, 2);
  assert.equal(c.unknownTrades, 1);
  assert.equal(c.recordedRealizedPnl, 25);
  assert.equal(c.dailyRecordedPnl, 25);
  assert.equal(c.dailyLossUsed, null);
  const fleet = await computeFleetHealth({ userId: 1 }, now);
  assert.equal(fleet.agents[0].band, "UNKNOWN");
});
for (const pnl of [NaN, Infinity, -Infinity])
  it(`non-finite PostgreSQL P&L ${pnl} is unknown`, async () => {
    await close(pnl);
    const c = await coverage();
    assert.equal(c.status, "INCOMPLETE");
    assert.equal(c.recordedTrades, 0);
    assert.equal(c.dailyLossUsed, null);
  });
for (const marker of [null, {}, { reason: "CLOSE_PNL_UNRESOLVED" }])
  it(`an existing hold marker ${JSON.stringify(marker)} never looks complete`, async () => {
    await close(-5, { managementState: { closeAccounting: marker } });
    const c = await coverage();
    assert.equal(c.status, "INCOMPLETE");
    assert.equal(c.unresolvedAccounting, 1);
    assert.equal(c.recordedTrades, 0);
    assert.equal(c.dailyRecordedPnl, 0);
  });
it("an unresolved hold survives status changes and former ownership", async () => {
  await close(null, {
    status: "FILLED",
    managementState: { closeAccounting: { previousOwnerId: 88 } },
  });
  const c = await coverage();
  assert.equal(c.closedTrades, 0);
  assert.equal(c.unresolvedAccounting, 1);
  assert.equal(c.dailyLossUsed, null);
});
it("daily loss uses UTC day boundaries and net outcomes, not all-time ledger loss", async () => {
  await close(-500, { at: new Date("2026-10-25T23:59:59.999Z") });
  await close(-60, { at: new Date("2026-10-26T00:00:00Z") });
  await close(10);
  await db
    .update(ledgers)
    .set({ realizedPnl: -550 })
    .where(eq(ledgers.agentId, 1));
  const fleet = await computeFleetHealth({ userId: 1 }, now);
  const a = fleet.agents[0];
  assert.equal(a.dailyLossUsed, 50);
  assert.equal(a.realizedPnl, -550);
  assert.equal(a.band, "WATCH");
  assert.equal(a.accounting.dayStart, "2026-10-26T00:00:00.000Z");
});
it("yesterday's loss cannot become today's risk band", async () => {
  await close(-500, { at: new Date("2026-10-25T20:00:00Z") });
  await db
    .update(ledgers)
    .set({ realizedPnl: -500 })
    .where(eq(ledgers.agentId, 1));
  const a = (await computeFleetHealth({ userId: 1 }, now)).agents[0];
  assert.equal(a.dailyLossUsed, 0);
  assert.equal(a.band, "HEALTHY");
});
for (const at of [null, new Date("2026-10-26T12:00:00.001Z")])
  it(`missing/future close time ${at} withholds daily loss`, async () => {
    await close(-10, { at });
    const c = await coverage();
    assert.equal(c.status, "INCOMPLETE");
    assert.equal(c.unknownCloseTime, 1);
    assert.equal(c.dailyLossUsed, null);
  });
it("PostgreSQL infinite close timestamps are not assigned to a day", async () => {
  await close(-10);
  await pool.query(
    "UPDATE self_trade_agent_executions SET closed_at = '-infinity'",
  );
  const c = await coverage();
  assert.equal(c.unknownCloseTime, 1);
  assert.equal(c.dailyLossUsed, null);
});
it("missing ledger is unavailable rather than funded or zero P&L", async () => {
  await db.delete(ledgers);
  const c = await coverage();
  assert.equal(c.status, "UNAVAILABLE");
  assert.equal(c.missingLedgers, 1);
  assert.equal(c.recordedRealizedPnl, null);
  assert.equal(c.recordedAvailableFunds, null);
  assert.equal(c.dailyLossUsed, null);
  assert.equal(
    (await computeFleetHealth({ userId: 1 }, now)).agents[0].band,
    "UNKNOWN",
  );
});
it("invalid ledger values are unavailable", async () => {
  await db.update(ledgers).set({ availableFunds: NaN });
  const c = await coverage();
  assert.equal(c.status, "UNAVAILABLE");
  assert.equal(c.recordedAvailableFunds, null);
});
it("a numeric close without a posting is incomplete even when the ledger is zero", async () => {
  await close(10);
  await db.delete(entries);
  const c = await coverage();
  assert.equal(c.recordedTrades, 1);
  assert.equal(c.unpostedTrades, 1);
  assert.equal(c.status, "INCOMPLETE");
  assert.equal(c.dailyLossUsed, null);
});
it("duplicate or wrong-amount close postings do not count as reconciled", async () => {
  await close(10);
  const [entry] = await db.select().from(entries);
  await db.insert(entries).values({
    agentId: 1,
    entryType: "REALIZED_PNL",
    refType: "EXECUTION",
    refId: entry.refId,
    amount: 0,
  });
  assert.equal((await coverage()).unpostedTrades, 1);
  await db.delete(entries);
  await db.insert(entries).values({
    agentId: 1,
    entryType: "REALIZED_PNL",
    refType: "EXECUTION",
    refId: entry.refId,
    amount: 9,
  });
  assert.equal((await coverage()).unpostedTrades, 1);
});
it("receipt currency and ledger subtotal must agree", async () => {
  await close(10);
  const c = await coverage();
  assert.equal(c.unreconciledLedgers, 1);
  assert.equal(c.status, "INCOMPLETE");
  await db.update(ledgers).set({ realizedPnl: 10 });
  await db.update(entries).set({ currency: "EUR" });
  const wrongCurrency = await coverage();
  assert.equal(wrongCurrency.unreconciledLedgers, 1);
  assert.equal(wrongCurrency.unpostedTrades, 1);
});
for (const kind of ["orphan", "wrong-reference", "non-closed", "unrelated"])
  it(`unmatched ${kind} posting stays incomplete even when the ledger equals all postings`, async () => {
    await close(10);
    let refId: number | null = 99999;
    let refType: string | null = "EXECUTION";
    if (kind === "wrong-reference") {
      const [e] = await db.select().from(executions);
      refId = e.id;
      refType = "OTHER";
    }
    if (kind === "non-closed") {
      await close(5, { status: "FILLED" });
      const result = await pool.query(
        "SELECT id FROM self_trade_agent_executions WHERE status='FILLED'",
      );
      refId = result.rows[0].id;
    }
    if (kind === "unrelated") {
      refType = null;
      refId = null;
    }
    await db
      .insert(entries)
      .values({
        agentId: 1,
        entryType: "REALIZED_PNL",
        refType,
        refId,
        amount: 5,
      });
    await db.update(ledgers).set({ realizedPnl: 15 });
    const c = await coverage();
    assert.equal(c.unreconciledLedgers, 0);
    assert.equal(c.unpostedTrades, 0);
    assert.equal(c.unmatchedPostings, 1);
    assert.equal(c.status, "INCOMPLETE");
    assert.equal(c.dailyLossUsed, null);
  });
it("posting cannot borrow another agent's execution identity", async () => {
  await addAgent(2, 2);
  await close(5, { agentId: 2 });
  const [other] = await db.select().from(executions);
  await db
    .insert(entries)
    .values({
      agentId: 1,
      entryType: "REALIZED_PNL",
      refType: "EXECUTION",
      refId: other.id,
      amount: 5,
    });
  await db
    .update(ledgers)
    .set({ realizedPnl: 5 })
    .where(eq(ledgers.agentId, 1));
  const c = await coverage();
  assert.equal(c.unmatchedPostings, 1);
  assert.equal(c.unreconciledLedgers, 0);
  assert.equal(c.status, "INCOMPLETE");
});
it(
  "optional root-review replay rejects numerically balanced orphan postings",
  { skip: !process.env.ARX_FLEET_ACCOUNTING_BENCHMARK },
  async () => {
    const previous = await import(
      new URL("../.fleet-review-baseline-accounting.ts", import.meta.url).href
    );
    await close(10);
    await db
      .insert(entries)
      .values({
        agentId: 1,
        entryType: "REALIZED_PNL",
        refType: "EXECUTION",
        refId: 99999,
        amount: 5,
      });
    await db.update(ledgers).set({ realizedPnl: 15 });
    const before = previous.projectAccounting(
      (await previous.readAccountingRows([1], undefined, now))[0],
      now,
    );
    const after = await coverage();
    assert.equal(before.status, "RECORDED");
    assert.equal(after.status, "INCOMPLETE");
    assert.equal(after.unmatchedPostings, 1);
    writeFileSync(
      process.env.ARX_FLEET_ACCOUNTING_BENCHMARK!.replace(
        /\.json$/,
        "-review-replay.json",
      ),
      JSON.stringify({ before, after }, null, 2),
    );
  },
);
it("aggregate overflow is unavailable, never Infinity or a zero-loss claim", async () => {
  const c = await coverage();
  const aggregate = combineAccounting(
    [
      { ...c, recordedRealizedPnl: 1e308 },
      { ...c, recordedRealizedPnl: 1e308 },
    ],
    now,
  );
  assert.equal(aggregate.status, "UNAVAILABLE");
  assert.equal(aggregate.recordedRealizedPnl, null);
  assert.equal(aggregate.dailyLossUsed, null);
});
it("mixed agents preserve known subtotals and coverage without summing unknown as zero", async () => {
  await addAgent(2, 1, false);
  await db.update(ledgers).set({ realizedPnl: 20 });
  await close(20);
  const fleet = await computeFleetHealth({ userId: 1 }, now);
  assert.equal(fleet.accounting.status, "UNAVAILABLE");
  assert.equal(fleet.accounting.missingLedgers, 1);
  assert.equal(fleet.accounting.recordedRealizedPnl, 20);
  assert.equal(fleet.accounting.dailyLossUsed, null);
});
it("overview and detail expose coverage and enforce owner scope", async () => {
  await addAgent(2, 2);
  await close(null);
  await db
    .update(ledgers)
    .set({ realizedPnl: 999 })
    .where(eq(ledgers.agentId, 2));
  const scope = { ownerType: "USER" as const, ownerId: 1 };
  const overview = await getFleetOverview(scope);
  const detail = await getAgentById(1, scope);
  assert.equal(overview.totalAgents, 1);
  assert.equal(overview.accounting.unknownTrades, 1);
  assert.equal(overview.accounting.recordedRealizedPnl, 0);
  assert.equal(detail?.accounting.status, "INCOMPLETE");
  assert.equal(await getAgentById(2, scope), null);
});
it("a grouped owner predicate cannot read an unowned requested ID", async () => {
  await addAgent(2, 2);
  const rows = await readAccountingRows([1, 2], eq(agents.ownerId, 1), now);
  assert.deepEqual(
    rows.map((x) => x.agentId),
    [1],
  );
});
it("AACI cannot borrow another user's funded and healthy fleet", async () => {
  await close(null);
  await addAgent(2, 2);
  const own = await buildAaciSnapshot({ userId: 1, role: "USER" });
  const other = await buildAaciSnapshot({ userId: 2, role: "USER" });
  assert.equal(own.selfTradeAgent?.ledgerHealthy, false);
  assert.equal(other.selfTradeAgent?.ledgerHealthy, true);
  const none = await buildAaciSnapshot({ userId: 3, role: "ADMIN" });
  assert.equal(none.selfTradeAgent?.funded, false);
  assert.equal(none.selfTradeAgent?.ledgerHealthy, undefined);
});
it("operator context is explicit and limited to this caller's operator agents", async () => {
  await db.delete(executions);
  await db.delete(ledgers);
  await db.delete(settings);
  await db.delete(agents);
  await addAgent(4, 1, true, "OPERATOR_FLEET");
  await addAgent(5, 2, true, "OPERATOR_FLEET");
  await close(null, { agentId: 5 });
  const defaultContext = await buildAaciSnapshot({ userId: 1, role: "ADMIN" });
  assert.equal(defaultContext.selfTradeAgent?.funded, false);
  const explicit = await buildAaciSnapshot({
    userId: 1,
    role: "ADMIN",
    includeMasterBroker: true,
  });
  assert.equal(explicit.selfTradeAgent?.funded, true);
  assert.equal(explicit.selfTradeAgent?.ledgerHealthy, true);
  const other = await buildAaciSnapshot({
    userId: 2,
    role: "ADMIN",
    includeMasterBroker: true,
  });
  assert.equal(other.selfTradeAgent?.ledgerHealthy, false);
  assert.equal(explicit.bridge.status, "unknown");
  assert.ok(explicit.unavailableSystems?.includes("AccountAnalytics"));
});
it("a failed accounting query leaves AACI unknown and explicitly unavailable", async () => {
  await pool.query(
    "ALTER TABLE self_trade_agent_executions RENAME TO qa_unavailable_executions",
  );
  try {
    const snapshot = await buildAaciSnapshot({ userId: 1, role: "USER" });
    assert.equal(snapshot.selfTradeAgent, undefined);
    assert.ok(snapshot.unavailableSystems?.includes("SelfTradeSupervisor"));
  } finally {
    await pool.query(
      "ALTER TABLE qa_unavailable_executions RENAME TO self_trade_agent_executions",
    );
  }
});
it("read services leave stored balances and accounting holds untouched", async () => {
  await close(null, {
    managementState: { closeAccounting: { reason: "CLOSE_PNL_UNRESOLVED" } },
  });
  const beforeLedger = await db.select().from(ledgers);
  const beforeExecution = await db.select().from(executions);
  await getFleetOverview();
  await getAgentById(1);
  await computeFleetHealth(undefined, now);
  await buildAaciSnapshot({ userId: 1, role: "ADMIN" });
  assert.deepEqual(await db.select().from(ledgers), beforeLedger);
  assert.deepEqual(await db.select().from(executions), beforeExecution);
});
it("overview uses two batch statements regardless of visible fleet size", async () => {
  await addAgent(2);
  await addAgent(3);
  const query = mock.method(pool, "query");
  try {
    await getFleetOverview();
    assert.equal(query.mock.callCount(), 2);
  } finally {
    query.mock.restore();
  }
});
it("producer cent rounding includes negative half-cent outcomes", async () => {
  await close(-0.005);
  const c = await coverage();
  assert.equal(c.unpostedTrades, 0);
  assert.equal(c.unreconciledLedgers, 0);
  assert.equal(c.status, "RECORDED");
});
it(
  "optional baseline replay preserves the false-healthy and owner leakage witnesses",
  { skip: !process.env.ARX_FLEET_ACCOUNTING_BENCHMARK },
  async () => {
    const baselineFleet = await import(
      new URL("../.fleet-baseline-supervisor.ts", import.meta.url).href
    );
    const baselineAaci = await import(
      new URL("../../aaci/.fleet-baseline-aaci.ts", import.meta.url).href
    );
    await close(null);
    const before = await baselineFleet.computeFleetHealth();
    const after = await computeFleetHealth(undefined, now);
    const beforeOtherOwner = await baselineAaci.buildAaciSnapshot({
      userId: 2,
      role: "USER",
    });
    const afterOtherOwner = await buildAaciSnapshot({
      userId: 2,
      role: "USER",
    });
    const replay = {
      missingPnl: {
        beforeBand: before.agents[0].band,
        beforeLoss: before.agents[0].dailyLossUsed,
        afterBand: after.agents[0].band,
        afterLoss: after.agents[0].dailyLossUsed,
      },
      otherOwner: {
        before: beforeOtherOwner.selfTradeAgent,
        after: afterOtherOwner.selfTradeAgent,
      },
    };
    assert.equal(replay.missingPnl.beforeBand, "HEALTHY");
    assert.equal(replay.missingPnl.afterBand, "UNKNOWN");
    assert.equal(replay.missingPnl.beforeLoss, 0);
    assert.equal(replay.missingPnl.afterLoss, null);
    assert.equal(replay.otherOwner.before.funded, true);
    assert.equal(replay.otherOwner.after?.funded, false);
    writeFileSync(
      process.env.ARX_FLEET_ACCOUNTING_BENCHMARK!.replace(
        /\.json$/,
        "-replay.json",
      ),
      JSON.stringify(replay, null, 2),
    );
  },
);
it(
  "optional actual-service completion benchmark with 100 agents and 1000 executions",
  { skip: !process.env.ARX_FLEET_ACCOUNTING_BENCHMARK },
  async () => {
    await db.delete(executions);
    await db.delete(ledgers);
    await db.delete(settings);
    await db.delete(agents);
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    await db.insert(agents).values(
      ids.map((id) => ({
        id,
        agentKey: `agent-${id}`,
        name: `Agent ${id}`,
        profileTemplate: "ALPHA",
        ownerType: "USER",
        ownerId: 1,
        status: "ACTIVE",
      })),
    );
    await db.insert(ledgers).values(
      ids.map((agentId) => ({
        agentId,
        allocatedFunds: 1000,
        availableFunds: 1000,
      })),
    );
    await db
      .insert(settings)
      .values(ids.map((agentId) => ({ agentId, maxDailyLossUsd: 100 })));
    const benchExecutions = await db
      .insert(executions)
      .values(
        Array.from({ length: 1000 }, (_, i) => ({
          agentId: (i % 100) + 1,
          agentKey: `agent-${(i % 100) + 1}`,
          symbol: "EURUSD",
          side: "BUY",
          idempotencyKey: `bench-${i}`,
          status: "CLOSED",
          realizedPnl: 0,
          closedAt: now,
        })),
      )
      .returning();
    await db.insert(entries).values(
      benchExecutions.map((e) => ({
        agentId: e.agentId,
        entryType: "REALIZED_PNL",
        refType: "EXECUTION",
        refId: e.id,
        amount: 0,
      })),
    );
    await pool.query("ANALYZE");
    const baseline = await import(process.env.ARX_FLEET_BASELINE_SERVICE!);
    const scope = { ownerType: "USER" as const, ownerId: 1 };
    const percentile = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        median: sorted[Math.ceil(sorted.length * 0.5) - 1],
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
        p99: sorted[Math.ceil(sorted.length * 0.99) - 1],
      };
    };
    const timings = { before: [] as number[], after: [] as number[] };
    const invocations = { before: [] as number[], after: [] as number[] };
    for (let i = 0; i < 550; i++) {
      for (const key of (i % 2 ? ["before", "after"] : ["after", "before"]) as (
        | "before"
        | "after"
      )[]) {
        const start = performance.now();
        const pending =
          key === "before"
            ? baseline.getFleetOverview(scope)
            : getFleetOverview(scope);
        const invokedAt = performance.now();
        const result = await pending;
        if (i >= 50) {
          timings[key].push(performance.now() - start);
          invocations[key].push(invokedAt - start);
        }
        assert.equal(result.totalAgents, 100);
      }
    }
    const before = percentile(timings.before);
    const after = percentile(timings.after);
    const rows = await readAccountingRows(ids, undefined, now);
    const projection = {
      previousNumericRollup: [] as number[],
      currentCoverageRollup: [] as number[],
    };
    for (let i = 0; i < 550; i++) {
      let start = performance.now();
      const oldTotals = {
        allocated: rows.reduce((n, r) => n + (r.allocatedFunds ?? 0), 0),
        available: rows.reduce((n, r) => n + (r.availableFunds ?? 0), 0),
        pnl: rows.reduce((n, r) => n + (r.realizedPnl ?? 0), 0),
        open: rows.reduce((n, r) => n + (r.openPnl ?? 0), 0),
      };
      const oldMs = performance.now() - start;
      assert.equal(oldTotals.allocated, 100000);
      start = performance.now();
      const projected = combineAccounting(
        rows.map((row) => projectAccounting(row, now)),
        now,
      );
      const newMs = performance.now() - start;
      assert.equal(projected.status, "RECORDED");
      if (i >= 50) {
        projection.previousNumericRollup.push(oldMs);
        projection.currentCoverageRollup.push(newMs);
      }
    }
    const result = {
      scope:
        "Local completed overview read, 100 owned agents / 1000 recorded closes; no network/provider/market latency",
      samples: 500,
      warmups: 50,
      before,
      after,
      addedP95: after.p95 - before.p95,
      invocationOnly: {
        before: percentile(invocations.before),
        after: percentile(invocations.after),
        meaning: "Promise creation only, not completed data availability",
      },
      pureProjection: {
        previousNumericRollup: percentile(projection.previousNumericRollup),
        currentCoverageRollup: percentile(projection.currentCoverageRollup),
        meaning:
          "Prior four scalar sums vs added coverage projection; additional correctness work, not equivalent outputs",
      },
    };
    writeFileSync(
      process.env.ARX_FLEET_ACCOUNTING_BENCHMARK!,
      JSON.stringify(result, null, 2),
    );
    assert.ok(after.p95 < 50, `Completed read p95 ${after.p95}ms exceeds 50ms`);
    assert.ok(
      result.addedP95 < 10,
      `Added p95 ${result.addedP95}ms exceeds 10ms`,
    );
  },
);
