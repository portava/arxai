// Actual result handler + shared event writer + security hash chain. Disposable DB only.
import { after, before, beforeEach, it, mock } from "node:test";
import assert from "node:assert/strict";
import { eq, getTableColumns, getTableName, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
const destination = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
assert.equal(process.env.ARX_RESULT_EVIDENCE_PG, "1");
assert.equal(destination.pathname, "/arx_result_evidence_test");
assert.match(
  destination.searchParams.get("host") ?? "",
  /\/arx-result-evidence-[^/]+\/socket$/,
);
assert.equal(destination.username, "arx_qa");
const {
  db,
  pool,
  arxLiveCommandsTable: commands,
  executionEventsTable: events,
  securityEventsTable: security,
  liveTradingAuditTable: audit,
} = await import("@workspace/db");
process.env.SESSION_SECRET = "synthetic-offline-result-evidence";
mock.method(globalThis, "fetch", async () => {
  throw new Error("Unexpected external request");
});
let fulfillCalls = 0;
const fulfilled = new Set<string>();
mock.module("../../concurrency/exposureReservation.js", {
  namedExports: {
    fulfillReservationByCommandId: async (commandId: string) => {
      if (!fulfilled.has(commandId)) {
        fulfillCalls++;
        fulfilled.add(commandId);
      }
    },
    releaseReservationByCommandId: async () => undefined,
  },
});
const { recordLiveCommandResult } = await import("../liveCommandPipeline.js");
const { appendExecutionEvidence, executionReportFingerprint } =
  await import("../executionEvidence.js");
const { appendExecutionEvidence: reconcilerAppend } =
  await import("../unknownReconciler.js");
const { verifySecurityEventChain } = await import("../../security/events.js");
const tables = [commands, events, security, audit];
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
    "CREATE UNIQUE INDEX qa_command_identity ON arx_live_commands(command_id)",
  );
  await pool.query(
    "CREATE UNIQUE INDEX execution_events_command_seq_uq ON execution_events(command_id,sequence_no)",
  );
  await pool.query(
    "CREATE UNIQUE INDEX qa_security_identity ON security_events(security_event_id)",
  );
});
after(async () => {
  await pool.end();
});
let command: typeof commands.$inferSelect;
async function resetFixture() {
  fulfillCalls = 0;
  fulfilled.clear();
  await pool.query(
    `TRUNCATE ${tables.map((t) => quote(getTableName(t))).join(",")} RESTART IDENTITY`,
  );
  [command] = await db
    .insert(commands)
    .values({
      commandId: "qa-command",
      userId: 9,
      bridgeConnectionId: 1,
      commandType: "MODIFY_LIVE_SLTP",
      symbol: "EURUSD.a",
      side: "BUY",
      orderType: "MODIFY",
      requestedVolume: 0.1,
      status: "SENT_TO_MT5_LIVE",
      accountLogin: "A",
      brokerServer: "Company",
      payload: { brokerTicket: "123" },
    })
    .returning();
}
beforeEach(resetFixture);
const report = () => ({
  userId: 9,
  commandId: "qa-command",
  reportingBridgeConnectionId: 1,
  outcome: "LIVE_FILLED" as const,
  brokerTicket: "123",
  executedVolume: 0.1,
  fillPrice: 1.11,
  reportedExecutionIdentity: [{ field: "accountLogin", value: "A" }],
});
async function snapshot() {
  return {
    command: (await db.select().from(commands))[0],
    events: await db.select().from(events),
    security: await db.select().from(security),
    audit: await db.select().from(audit),
  };
}
async function assertChain(count: number) {
  const checked = await verifySecurityEventChain();
  assert.equal(checked.valid, true, JSON.stringify(checked));
  assert.equal(checked.checked, count);
  assert.equal(checked.unknownCount, 0);
  const observed = await snapshot();
  const fingerprints = observed.events
    .map((e) => e.payload as Record<string, unknown>)
    .filter((p) => typeof p.reportFingerprint === "string");
  for (const p of fingerprints) {
    const recognized = Object.fromEntries(
      [
        "reportedOutcome",
        "brokerTicket",
        "fillPrice",
        "executedVolume",
        "mt5Retcode",
        "brokerMessage",
        "eaReason",
        "reportingBridgeConnectionId",
        "reportedExecutionIdentity",
      ].map((key) => [key, p[key]]),
    );
    assert.equal(executionReportFingerprint(recognized), p.reportFingerprint);
  }
  assert.deepEqual(
    observed.security
      .map((e) => (e.metadata as Record<string, unknown>).reportFingerprint)
      .sort(),
    fingerprints.map((p) => p.reportFingerprint).sort(),
  );
}
it("twenty identical simultaneous reports commit one receipt, one audit chain row and one application", async () => {
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => recordLiveCommandResult(report())),
  );
  assert.ok(responses.every((r) => r.ok));
  const state = await snapshot();
  assert.equal(state.command.status, "LIVE_FILLED");
  assert.equal(state.command.duplicateResultCount, 0);
  assert.equal(state.events.length, 1);
  assert.equal(state.audit.length, 1);
  assert.equal(fulfillCalls, 1);
  await assertChain(1);
  await recordLiveCommandResult(report());
  assert.deepEqual(await snapshot(), state);
  assert.equal(fulfillCalls, 1);
});
it("all distinct simultaneous contradictions are retained without overwriting the accepted fill", async () => {
  await recordLiveCommandResult(report());
  const accepted = (await snapshot()).command;
  const responses = await Promise.all(
    Array.from({ length: 24 }, (_, i) =>
      recordLiveCommandResult({
        ...report(),
        outcome: "LIVE_REJECTED",
        mt5Retcode: 10000 + i,
        brokerMessage: `contradiction-${i}`,
      }),
    ),
  );
  assert.ok(responses.every((r) => r.ok));
  const state = await snapshot();
  assert.equal(state.command.status, accepted.status);
  assert.equal(state.command.fillPrice, accepted.fillPrice);
  assert.equal(state.command.filledAt!.getTime(), accepted.filledAt!.getTime());
  assert.equal(state.command.duplicateResultCount, 24);
  assert.equal(state.events.length, 25);
  assert.equal(fulfillCalls, 1);
  assert.deepEqual(
    state.events.map((e) => e.sequenceNo).sort((a, b) => a - b),
    Array.from({ length: 25 }, (_, i) => i + 1),
  );
  assert.equal(
    state.events.filter((e) => (e.payload as any).applied === true).length,
    1,
  );
  assert.equal(
    new Set(state.events.map((e) => (e.payload as any).reportFingerprint)).size,
    25,
  );
  await assertChain(25);
});
it("shared reconciler appends and reports serialize without lost event numbers", async () => {
  await Promise.all(
    Array.from({ length: 24 }, (_, i) =>
      i % 2
        ? reconcilerAppend({
            commandRowId: command.id,
            source: "arx",
            eventType: "TEST_OBSERVATION",
            payload: { i },
          })
        : recordLiveCommandResult({ ...report(), fillPrice: 1 + i / 100 }),
    ),
  );
  const state = await snapshot();
  assert.equal(state.events.length, 24);
  assert.equal(state.command.duplicateResultCount, 11);
  await assertChain(12);
  assert.deepEqual(
    state.events.map((e) => e.sequenceNo).sort((a, b) => a - b),
    Array.from({ length: 24 }, (_, i) => i + 1),
  );
});
for (const table of [
  "execution_events",
  "security_events",
  "live_trading_audit",
]) {
  it(`failure persisting ${table} rolls back result, receipt and audit; retry succeeds`, async () => {
    await pool.query(
      `CREATE FUNCTION qa_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'qa persistence failure'; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER qa_fault BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION qa_refuse()`,
    );
    try {
      await assert.rejects(recordLiveCommandResult(report()));
      const state = await snapshot();
      assert.equal(state.command.status, "SENT_TO_MT5_LIVE");
      assert.equal(state.events.length, 0);
      assert.equal(state.security.length, 0);
      assert.equal(state.audit.length, 0);
      assert.equal(fulfillCalls, 0);
    } finally {
      await pool.query(`DROP TRIGGER qa_fault ON ${table}`);
      await pool.query("DROP FUNCTION qa_refuse()");
    }
    assert.equal((await recordLiveCommandResult(report())).ok, true);
    await assertChain(1);
  });
}
it("failure retaining a contradiction cannot increment its counter or claim durable receipt", async () => {
  await recordLiveCommandResult(report());
  const before = await snapshot();
  await pool.query(
    "CREATE FUNCTION qa_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'qa persistence failure'; END $$",
  );
  await pool.query(
    "CREATE TRIGGER qa_fault BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION qa_refuse()",
  );
  try {
    await assert.rejects(
      recordLiveCommandResult({ ...report(), fillPrice: 2 }),
    );
    assert.deepEqual(await snapshot(), before);
  } finally {
    await pool.query("DROP TRIGGER qa_fault ON security_events");
    await pool.query("DROP FUNCTION qa_refuse()");
  }
  await recordLiveCommandResult({ ...report(), fillPrice: 2 });
  assert.equal((await snapshot()).events.length, 2);
  await assertChain(2);
});
it("ACK then fill and partial then full apply the legal next state, while exact retries stay inert", async () => {
  await recordLiveCommandResult({
    ...report(),
    outcome: "LIVE_ACKNOWLEDGED",
    brokerTicket: null,
    executedVolume: null,
    fillPrice: null,
  });
  assert.equal((await snapshot()).command.status, "LIVE_ACKNOWLEDGED");
  await recordLiveCommandResult({ ...report(), executedVolume: 0.04 });
  assert.equal((await snapshot()).command.status, "LIVE_PARTIALLY_FILLED");
  await recordLiveCommandResult({ ...report(), executedVolume: 0.04 });
  assert.equal((await snapshot()).events.length, 2);
  assert.equal(fulfillCalls, 0);
  await recordLiveCommandResult(report());
  assert.equal((await snapshot()).command.status, "LIVE_FILLED");
  assert.equal(fulfillCalls, 1);
  await assertChain(3);
});
it("a late acknowledgement or incompatible partial rejection is retained without regressing exposure", async () => {
  await recordLiveCommandResult({ ...report(), executedVolume: 0.04 });
  await recordLiveCommandResult({
    ...report(),
    outcome: "LIVE_ACKNOWLEDGED",
    brokerTicket: null,
    executedVolume: null,
  });
  await recordLiveCommandResult({
    ...report(),
    outcome: "LIVE_REJECTED",
    brokerTicket: null,
  });
  const state = await snapshot();
  assert.equal(state.command.status, "LIVE_PARTIALLY_FILLED");
  assert.equal(state.command.executedVolume, 0.04);
  assert.equal(state.events.length, 3);
  assert.equal(fulfillCalls, 0);
  await assertChain(3);
});
it("unknown results remain held and preserve later contradictory evidence", async () => {
  await db
    .update(commands)
    .set({ status: "LIVE_UNKNOWN" })
    .where(eq(commands.id, command.id));
  const response = await recordLiveCommandResult(report());
  assert.equal(response.reason, "RESULT_RETAINED_FOR_RECONCILIATION");
  const state = await snapshot();
  assert.equal(state.command.status, "LIVE_UNKNOWN");
  assert.equal((state.events[0].payload as any).applied, false);
  assert.equal(fulfillCalls, 0);
  await assertChain(1);
});
it("foreign owner/bridge and pre-dispatch reports cannot create evidence or change state", async () => {
  assert.equal(
    (await recordLiveCommandResult({ ...report(), userId: 88 })).ok,
    false,
  );
  assert.equal(
    (
      await recordLiveCommandResult({
        ...report(),
        reportingBridgeConnectionId: 2,
      })
    ).reason,
    "BRIDGE_BINDING_MISMATCH",
  );
  await db
    .update(commands)
    .set({ status: "LIVE_APPROVED" })
    .where(eq(commands.id, command.id));
  assert.equal((await recordLiveCommandResult(report())).reason, "BAD_STATE");
  const state = await snapshot();
  assert.equal(state.events.length, 0);
  assert.equal(state.security.length, 0);
});
it("shared appender refuses missing anchors and malformed evidence without fabricating a row", async () => {
  await assert.rejects(
    appendExecutionEvidence({
      commandRowId: 999,
      source: "ea",
      eventType: "X",
    }),
    /EVENT_COMMAND_NOT_FOUND/,
  );
  await assert.rejects(
    appendExecutionEvidence({
      commandRowId: command.id,
      source: "ea",
      eventType: "X",
      payload: { price: NaN },
    }),
    /EVIDENCE_NUMBER_INVALID/,
  );
  assert.equal((await snapshot()).events.length, 0);
  assert.equal(
    executionReportFingerprint({ a: 1, b: 2 }),
    executionReportFingerprint({ b: 2, a: 1 }),
  );
});

async function waitForWaiter() {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const rows = await pool.query(
      "SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database() AND pid<>pg_backend_pid() AND query LIKE '%arx_live_commands%for update%'",
    );
    if (rows.rows[0]) return Number(rows.rows[0].pid);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("result reader did not block on controlled command lock");
}
it("result waiting on a bridge change rechecks binding after obtaining the command lock", async () => {
  const writer = await pool.connect();
  await writer.query("BEGIN");
  await writer.query(
    "UPDATE arx_live_commands SET bridge_connection_id=2 WHERE id=$1",
    [command.id],
  );
  const pending = recordLiveCommandResult(report());
  try {
    await waitForWaiter();
    await writer.query("COMMIT");
    assert.equal((await pending).reason, "BRIDGE_BINDING_MISMATCH");
    assert.equal((await snapshot()).events.length, 0);
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
  }
});
it("result waiting on an UNKNOWN sweep retains evidence without undoing uncertainty", async () => {
  const writer = await pool.connect();
  await writer.query("BEGIN");
  await writer.query(
    "UPDATE arx_live_commands SET status='LIVE_UNKNOWN' WHERE id=$1",
    [command.id],
  );
  const pending = recordLiveCommandResult(report());
  try {
    await waitForWaiter();
    await writer.query("COMMIT");
    assert.equal((await pending).reason, "RESULT_RETAINED_FOR_RECONCILIATION");
    assert.equal((await snapshot()).command.status, "LIVE_UNKNOWN");
    await assertChain(1);
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
  }
});
it("cancelling a blocked result transaction leaves no receipt and a later retry applies once", async () => {
  const writer = await pool.connect();
  await writer.query("BEGIN");
  await writer.query(
    "SELECT id FROM arx_live_commands WHERE id=$1 FOR UPDATE",
    [command.id],
  );
  const pending = recordLiveCommandResult(report());
  const observed = pending.catch((e) => e);
  try {
    const pid = await waitForWaiter();
    await pool.query("SELECT pg_cancel_backend($1)", [pid]);
    assert.ok((await observed) instanceof Error);
    await writer.query("COMMIT");
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
  }
  let state = await snapshot();
  assert.equal(state.command.status, "SENT_TO_MT5_LIVE");
  assert.equal(state.events.length, 0);
  assert.equal(state.security.length, 0);
  await recordLiveCommandResult(report());
  state = await snapshot();
  assert.equal(state.command.status, "LIVE_FILLED");
  assert.equal(fulfillCalls, 1);
  await assertChain(1);
});
it("independent commands keep separate sequences while the existing global hash chain never forks", async () => {
  await db.insert(commands).values(
    Array.from({ length: 15 }, (_, i) => ({
      commandId: `qa-other-${i}`,
      userId: 88,
      bridgeConnectionId: 2,
      commandType: "MODIFY_LIVE_SLTP" as const,
      symbol: "EURUSD.a",
      side: "BUY" as const,
      orderType: "MODIFY",
      requestedVolume: 0.1,
      status: "SENT_TO_MT5_LIVE" as const,
    })),
  );
  await Promise.all([
    recordLiveCommandResult(report()),
    ...Array.from({ length: 15 }, (_, i) =>
      recordLiveCommandResult({
        ...report(),
        commandId: `qa-other-${i}`,
        userId: 88,
        reportingBridgeConnectionId: 2,
      }),
    ),
  ]);
  const state = await snapshot();
  assert.equal(state.events.length, 16);
  assert.ok(state.events.every((e) => e.sequenceNo === 1));
  await assertChain(16);
});
it(
  "controlled old/current result durability and latency",
  { skip: !process.env.ARX_RESULT_BENCHMARK_OUTPUT },
  async () => {
    const { runResultEvidenceBenchmark } =
      await import("./resultEvidence.benchmark.js");
    await runResultEvidenceBenchmark(resetFixture, report);
  },
);
