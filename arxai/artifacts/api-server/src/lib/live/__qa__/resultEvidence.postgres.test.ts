import { readFileSync } from "node:fs";
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
  arxDispatchExposureReservationsTable: reservations,
  resultSettlementJobsTable: settlementJobs,
} = await import("@workspace/db");
process.env.SESSION_SECRET = "synthetic-offline-result-evidence";
mock.method(globalThis, "fetch", async () => {
  throw new Error("Unexpected external request");
});
async function fulfillCalls() {
  return Number((await pool.query("select count(*) from arx_dispatch_exposure_reservations where status='FULFILLED'")).rows[0].count);
}
const { recordLiveCommandResult } = await import("../liveCommandPipeline.js");
const { appendExecutionEvidence, executionReportFingerprint } =
  await import("../executionEvidence.js");
const { appendExecutionEvidence: reconcilerAppend } =
  await import("../unknownReconciler.js");
const { verifySecurityEventChain } = await import("../../security/events.js");
const tables = [commands, events, security, audit, reservations, settlementJobs];
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
  const migration = readFileSync(new URL("../../../../../../lib/db/migrations/2026-10-26_result_settlement_outbox.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(migration); // additive migration is repeatable
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
  await db.insert(reservations).values({userId:9,commandId:command.commandId,symbol:command.symbol,lotSize:0.1,status:"RESERVED"});

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
  assert.equal(await fulfillCalls(), 1);
  await assertChain(1);
  await recordLiveCommandResult(report());
  assert.deepEqual(await snapshot(), state);
  assert.equal(await fulfillCalls(), 1);
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
  assert.equal(await fulfillCalls(), 1);
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
      assert.equal(await fulfillCalls(), 0);
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
  assert.equal(await fulfillCalls(), 0);
  await recordLiveCommandResult(report());
  assert.equal((await snapshot()).command.status, "LIVE_FILLED");
  assert.equal(await fulfillCalls(), 1);
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
  assert.equal(await fulfillCalls(), 0);
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
  assert.equal(await fulfillCalls(), 0);
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
  assert.equal(await fulfillCalls(), 1);
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

it(
  "profile actual32-report durability phases",
  { skip: !process.env.ARX_RESULT_PROFILE_OUTPUT },
  async () => {
    const { profileResultEvidence } =
      await import("./resultEvidence.profile.js");
    await profileResultEvidence(resetFixture, report);
  },
);

it("bounded per-command scheduling refuses overload without a receipt and drains after commit", async () => {
  const { resultReceiptScheduler } =
    await import("../resultReceiptScheduler.js");
  const writer = await pool.connect();
  await writer.query("BEGIN");
  await writer.query(
    "SELECT id FROM arx_live_commands WHERE id=$1 FOR UPDATE",
    [command.id],
  );
  const reports = Array.from({ length: 64 }, (_, i) =>
    recordLiveCommandResult({ ...report(), brokerMessage: `queued-${i}` }),
  );
  try {
    await waitForWaiter();
    const refused = await recordLiveCommandResult({
      ...report(),
      brokerMessage: "overloaded",
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.receiptPersisted, false);
    assert.equal(refused.reason, "LIVE_RESULT_RECEIPT_CAPACITY");
    assert.equal((await snapshot()).events.length, 0);
    await writer.query("COMMIT");
    assert.ok(
      (await Promise.all(reports)).every((r) => r.ok && r.receiptPersisted),
    );
    await assertChain(64);
    assert.equal((await snapshot()).command.duplicateResultCount, 63);
    assert.deepEqual(resultReceiptScheduler.snapshot, {
      keys: 0,
      pending: 0,
      bytes: 0,
    });
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
  }
});
it("a blocked command does not occupy the pool needed by independent commands or owners", async () => {
  const writer = await pool.connect();
  await writer.query("BEGIN");
  await writer.query(
    "SELECT id FROM arx_live_commands WHERE id=$1 FOR UPDATE",
    [command.id],
  );
  const reports = Array.from({ length: 32 }, (_, i) =>
    recordLiveCommandResult({ ...report(), brokerMessage: `held-${i}` }),
  );
  try {
    await waitForWaiter();
    for (const [userId, commandId] of [
      [9, "qa-second"],
      [88, "qa-other-owner"],
    ] as const) {
      await db.insert(commands).values({
        commandId,
        userId,
        bridgeConnectionId: 1,
        commandType: "MODIFY_LIVE_SLTP",
        symbol: "EURUSD.a",
        side: "BUY",
        orderType: "MODIFY",
        requestedVolume: 0.1,
        status: "SENT_TO_MT5_LIVE",
      });
      const reply = await recordLiveCommandResult({
        ...report(),
        userId,
        commandId,
      });
      assert.ok(reply.ok && reply.receiptPersisted);
    }
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM execution_events"))
        .rows[0].n,
      2,
    );
    await writer.query("COMMIT");
    await Promise.all(reports);
    await assertChain(34);
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
  }
});
it("separate server processes with independent queues preserve one outcome and every report", async () => {
  const { fork } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const workers = Array.from({ length: 2 }, (_, worker) => {
    const child = fork(
      fileURLToPath(new URL("./resultEvidence.worker.ts", import.meta.url)),
      [],
      {
        execArgv: ["--import", "tsx", "--experimental-test-module-mocks"],
        env: { ...process.env },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.on("message", (m: any) => {
        if (m.ready) resolve();
        if (m.error) reject(new Error(m.error));
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`worker exited before ready: ${code}`)),
      );
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`worker exit${code}: ${stderr}`)),
      );
      child.once("error", reject);
    });
    return { child, ready, exited, worker };
  });
  try {
    await Promise.all(workers.map((w) => w.ready));
    workers.forEach((w) => w.child.send({ worker: w.worker }));
    await Promise.all(workers.map((w) => w.exited));
    await assertChain(24);
    const state = await snapshot();
    assert.equal(state.command.duplicateResultCount, 23);
    assert.equal(
      state.events.filter((e) => (e.payload as any).applied === true).length,
      1,
    );
  } finally {
    workers.forEach((w) => {
      if (w.child.exitCode === null) w.child.kill();
    });
  }
});

it("a cancelled active result releases its queued follower without accepting the cancelled report", async () => {
  const { resultReceiptScheduler } =
    await import("../resultReceiptScheduler.js");
  const writer = await pool.connect();
  await writer.query("BEGIN");
  await writer.query(
    "SELECT id FROM arx_live_commands WHERE id=$1 FOR UPDATE",
    [command.id],
  );
  const first = recordLiveCommandResult({
    ...report(),
    brokerMessage: "cancel-me",
  });
  const observed = first.catch((error) => error);
  const next = recordLiveCommandResult({
    ...report(),
    brokerMessage: "keep-me",
  });
  try {
    const pid = await waitForWaiter();
    await pool.query("SELECT pg_cancel_backend($1)", [pid]);
    assert.ok((await observed) instanceof Error);
    await writer.query("COMMIT");
    assert.ok((await next).receiptPersisted);
    await assertChain(1);
    const state = await snapshot();
    assert.equal((state.events[0].payload as any).brokerMessage, "keep-me");
    assert.deepEqual(resultReceiptScheduler.snapshot, {
      keys: 0,
      pending: 0,
      bytes: 0,
    });
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
  }
});

const outbox = await import("../resultSettlementOutbox.js");
async function jobs() { return (await pool.query("select * from result_settlement_jobs order by id")).rows; }
async function dueJobs() { await pool.query("update result_settlement_jobs set due_at=clock_timestamp() where status='RETRY'"); }
it("outbox insertion failure rolls receipt, audit and outcome back atomically", async () => {
  await pool.query("CREATE FUNCTION qa_outbox_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'qa outbox unavailable'; END $$");
  await pool.query("CREATE TRIGGER qa_outbox_fault BEFORE INSERT ON result_settlement_jobs FOR EACH ROW EXECUTE FUNCTION qa_outbox_fault()");
  try {
    await assert.rejects(recordLiveCommandResult(report()));
    const state = await snapshot();
    assert.equal(state.events.length,0);
    assert.equal((await db.select().from(commands))[0].status,"SENT_TO_MT5_LIVE");
    assert.equal((await jobs()).length,0);
  } finally { await pool.query("DROP TRIGGER qa_outbox_fault ON result_settlement_jobs; DROP FUNCTION qa_outbox_fault()"); }
});
it("post-receipt crash leaves recoverable intent; worker can finish without another report", async () => {
  await pool.query("CREATE FUNCTION qa_claim_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='LEASED' THEN RAISE EXCEPTION 'qa process stops before lease'; END IF; RETURN NEW; END $$");
  await pool.query("CREATE TRIGGER qa_claim_fault BEFORE UPDATE ON result_settlement_jobs FOR EACH ROW EXECUTE FUNCTION qa_claim_fault()");
  try { await assert.rejects(recordLiveCommandResult(report())); }
  finally { await pool.query("DROP TRIGGER qa_claim_fault ON result_settlement_jobs; DROP FUNCTION qa_claim_fault()"); }
  assert.equal((await snapshot()).events.length,1);
  assert.equal((await jobs())[0].status,"PENDING");
  assert.equal(await fulfillCalls(),0);
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const restarted = spawnSync(process.execPath,["--import","tsx",fileURLToPath(new URL("./settlementWorkerChild.mjs",import.meta.url))],{
    env:{HOME:process.env.HOME,PATH:process.env.PATH,DATABASE_URL:process.env.DATABASE_URL,NODE_ENV:"test",SESSION_SECRET:"synthetic-offline-result-evidence",ESBUILD_BINARY_PATH:process.env.ESBUILD_BINARY_PATH},
    encoding:"utf8",timeout:20_000});
  assert.equal(restarted.status,0,restarted.stderr);
  assert.equal((await jobs())[0].status,"DONE");
  assert.equal(await fulfillCalls(),1);
  const attempts=(await jobs())[0].attempts;
  await recordLiveCommandResult(report());
  assert.equal((await jobs())[0].attempts,attempts,"duplicate does not consume execution budget");
});
it("lease commit survives restart, expired owner cannot finish a replacement lease", async () => {
  await recordLiveCommandResult({...report(),outcome:"LIVE_UNKNOWN",brokerTicket:null,executedVolume:null});
  await pool.query("update result_settlement_jobs set status='PENDING'");
  const first=(await outbox.claimResultSettlement())!;
  assert.ok(first);
  assert.equal((await jobs())[0].status,"LEASED");
  assert.equal(await outbox.claimResultSettlement(),null);
  await pool.query("update result_settlement_jobs set lease_until=clock_timestamp()-interval '1 second'");
  const next=(await outbox.claimResultSettlement())!;
  assert.notEqual(next.lease_token,first.lease_token);
  assert.equal(await outbox.finishResultSettlement(first,{status:"DONE"}),false);
  const stale=await outbox.runClaimedSettlement(first);
  assert.equal(stale.saved,false);
  await outbox.runClaimedSettlement(next);
  assert.equal((await jobs())[0].status,"HELD");
  assert.equal((await jobs())[0].reason,"OUTCOME_UNCONFIRMED");
});
it("new accepted generation fences old partial intent before side effects and completion", async () => {
  await recordLiveCommandResult({...report(),executedVolume:0.04});
  await pool.query("update result_settlement_jobs set status='PENDING'");
  const old=(await outbox.claimResultSettlement())!;
  await recordLiveCommandResult(report());
  const current=(await jobs())[0];
  assert.equal(current.generation,2);
  assert.equal(current.status,"DONE");
  assert.equal((await outbox.runClaimedSettlement(old)).saved,false);
  assert.equal(await outbox.finishResultSettlement(old,{status:"HELD",reason:"old"}),false);
  assert.equal((await jobs())[0].status,"DONE");
  assert.equal(await fulfillCalls(),1);
});
it("retry budget is bounded, backoff is positive, HELD never ages into done", async () => {
  await pool.query("CREATE FUNCTION qa_exposure_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'qa transient fault'; END $$");
  await pool.query("CREATE TRIGGER qa_exposure_fault BEFORE UPDATE ON arx_dispatch_exposure_reservations FOR EACH ROW EXECUTE FUNCTION qa_exposure_fault()");
  try {
    const reply=await recordLiveCommandResult(report());
    assert.equal(reply.receiptPersisted,true);
    assert.equal(reply.settlementRecovery?.pending,true);
    assert.equal(reply.settlementRecovery?.workerEnabled,false);
    assert.equal((await jobs())[0].attempts,1);
    assert.ok(new Date((await jobs())[0].due_at).getTime()>Date.now());
    await recordLiveCommandResult(report());
    assert.equal((await jobs())[0].attempts,1);
    for(let i=1;i<8;i++) { await dueJobs(); await outbox.runResultSettlementPass(); }
    assert.equal((await jobs())[0].status,"HELD");
    assert.equal((await jobs())[0].reason,"RETRY_BUDGET_EXHAUSTED");
  } finally { await pool.query("DROP TRIGGER qa_exposure_fault ON arx_dispatch_exposure_reservations; DROP FUNCTION qa_exposure_fault()"); }
  await pool.query("update result_settlement_jobs set due_at=clock_timestamp()-interval '10 years'");
  await outbox.runResultSettlementPass(); await recordLiveCommandResult(report());
  assert.equal((await jobs())[0].status,"HELD");
  assert.equal(await fulfillCalls(),0);
});
it("foreign reservation ownership holds without modifying either owner's exposure", async () => {
  await pool.query("update arx_dispatch_exposure_reservations set user_id=88");
  const result=await recordLiveCommandResult(report());
  assert.equal(result.receiptPersisted,true);
  assert.equal((await jobs())[0].reason,"RESERVATION_OWNER_MISMATCH");
  assert.equal((await pool.query("select status from arx_dispatch_exposure_reservations")).rows[0].status,"RESERVED");
});
it("pre-upgrade duplicate is held durably, not silently backfilled or processed", async () => {
  const args: Parameters<typeof recordLiveCommandResult>[0]=report();
  const evidence={reportedOutcome:args.outcome,brokerTicket:args.brokerTicket??null,fillPrice:args.fillPrice??null,
    executedVolume:args.executedVolume??null,mt5Retcode:args.mt5Retcode??null,brokerMessage:args.brokerMessage??null,
    eaReason:null,reportingBridgeConnectionId:args.reportingBridgeConnectionId,reportedExecutionIdentity:args.reportedExecutionIdentity};
  await db.update(commands).set({status:"LIVE_FILLED",brokerTicket:args.brokerTicket,executedVolume:args.executedVolume}).where(eq(commands.id,command.id));
  await appendExecutionEvidence({commandRowId:command.id,source:"ea",eventType:"RESULT_LIVE_FILLED",payload:{...evidence,applied:true,finalStatus:"LIVE_FILLED",reportFingerprint:executionReportFingerprint(evidence)}});
  const reply=await recordLiveCommandResult(args);
  assert.equal(reply.receiptPersisted,true);
  assert.equal((await jobs())[0].reason,"LEGACY_RECEIPT_REQUIRES_REVIEW");
  await outbox.runResultSettlementPass();
  assert.equal(await fulfillCalls(),0);
});
it("schema allowlist refuses arbitrary work and worker is off by default", async () => {
  assert.equal(outbox.settlementWorkerEnabled(undefined),false);
  assert.equal(outbox.settlementWorkerEnabled("1"),false);
  assert.equal(outbox.settlementWorkerEnabled("true"),true);
  await assert.rejects(pool.query("insert into result_settlement_jobs(command_row_id,user_id,consumer,receipt_fingerprint) values($1,9,'BROKER_ORDER',$2)",[command.id,"a".repeat(64)]));
  for(let attempt=1;attempt<=8;attempt++) {
    const delay=outbox.settlementRetryMs(1,1,attempt);
    assert.ok(delay>=800 && delay<=60_000);
  }
});
it("missing outbox migration refuses receipt instead of acknowledging undurable recovery", async()=>{
  await pool.query("ALTER TABLE result_settlement_jobs RENAME TO qa_missing_settlement_jobs");
  try {
    await assert.rejects(recordLiveCommandResult(report()));
    assert.equal((await snapshot()).events.length,0);
    assert.equal((await db.select().from(commands))[0].status,"SENT_TO_MT5_LIVE");
  } finally { await pool.query("ALTER TABLE qa_missing_settlement_jobs RENAME TO result_settlement_jobs"); }
});
it("changed command owner cannot acknowledge a new result while leaving its intent owned by someone else",async()=>{
  await recordLiveCommandResult({...report(),executedVolume:0.04});
  await db.update(commands).set({userId:88}).where(eq(commands.id,command.id));
  await assert.rejects(recordLiveCommandResult({...report(),userId:88}),/SETTLEMENT_JOB_OWNERSHIP_CONFLICT/);
  assert.equal((await db.select().from(commands))[0].status,"LIVE_PARTIALLY_FILLED");
  assert.equal((await snapshot()).events.length,1);
  assert.equal((await jobs())[0].user_id,9);assert.equal((await jobs())[0].generation,1);
});
