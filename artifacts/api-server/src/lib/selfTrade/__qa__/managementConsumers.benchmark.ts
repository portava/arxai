// Opt-in only, called by the disposable PostgreSQL fixture. Never run against
// application databases. The caller verifies the isolated socket/database.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, pool, type ArxLiveCommand } from "@workspace/db";
import {
  readLiveModifyRiskPosition,
  recordLiveCommandResult,
} from "../../live/liveCommandPipeline.js";
import { reconcileAgentExecutions } from "../agentReconciliation.js";

export async function runManagementConsumerBenchmark({
  prepareModify,
  resetFixture,
  send,
  approved,
}: {
  prepareModify: () => Promise<ArxLiveCommand>;
  resetFixture: () => Promise<void>;
  send: (row: ArxLiveCommand) => Promise<ArxLiveCommand | null>;
  approved: () => Promise<ArxLiveCommand>;
}) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { pathToFileURL } = await import("node:url");
  const root = process.env.ARX_MANAGEMENT_BASELINE_ROOT!;
  assert.ok(root?.startsWith("/Users/areyouok/arx-"));
  const sourcePath = `${root}/artifacts/api-server/src/lib/live/liveCommandPipeline.ts`;
  const source = readFileSync(sourcePath, "utf8");
  const sourceHash = createHash("sha256").update(source).digest("hex");
  assert.equal(
    sourceHash,
    "05b2754b9abe319f896295899d3b1e8b5016e26e647cd5de5d5afbd45a84c5df",
    "baseline source must equal cc8f6727",
  );
  const url = (relative: string) =>
    pathToFileURL(`${root}/artifacts/api-server/src/lib/${relative}`).href;
  mock.module(url("security/events.ts"), {
    namedExports: {
      mirrorCriticalEvent: async () => undefined,
      recordSecurityEvent: async () => undefined,
    },
  });
  mock.module(url("concurrency/exposureReservation.ts"), {
    namedExports: {
      fulfillReservationByCommandId: async () => undefined,
      releaseReservationByCommandId: async () => undefined,
    },
  });
  mock.module(url("missionExitManager.ts"), {
    namedExports: {
      recordMissionTradeCloseByBrokerTicket: async () => undefined,
    },
  });
  const old = await import(pathToFileURL(sourcePath).href);
  const { livePositionLedger, livePositionColumns } =
    await import("../../positions/ledger.js");
  // Exact baseline block, transpiled rather than reimplemented for the benchmark.
  const begin = source.indexOf("    let rgPosition: { entryPrice:");
  const end = source.indexOf(
    "    const risk = await enforcePreTradeRisk",
    begin,
  );
  assert.ok(begin > 0 && end > begin);
  const ts = await import("typescript");
  const js = ts.transpileModule(
    `async function baseline(row: any) { const args = { userId: row.userId }; const rgAction = "MODIFY"; ${source.slice(begin, end)} return rgPosition; }`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    },
  ).outputText;
  const baselineRisk = new Function(
    "livePositionLedger",
    "livePositionColumns",
    "and",
    "eq",
    `${js}; return baseline;`,
  )(
    livePositionLedger,
    livePositionColumns,
    and,
    eq,
  ) as typeof readLiveModifyRiskPosition;
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const p = (q: number) =>
      Number(sorted[Math.ceil(q * sorted.length) - 1]!.toFixed(3));
    return {
      n: sorted.length,
      medianMs: p(0.5),
      p95Ms: p(0.95),
      p99Ms: p(0.99),
      maxMs: p(1),
    };
  };
  const receipt: Record<string, unknown> = {
    measuredAt: new Date().toISOString(),
    baseline: {
      commit: "cc8f67271b2d97e4d4e7cab8928f9980ca27942b",
      sourceHash,
    },
    fixture:
      "disposable PostgreSQL Unix socket; one synthetic EURUSD.a full close; ancillary security mirror/exposure/mission callbacks stubbed identically",
    timing:
      "receipt/ledger are 1ms polling observations of committed DB state; response is actual recordLiveCommandResult resolution. No UI, provider, network, order or broker timing measured",
    acceptance: { localP95TargetMs: 100 },
    runtime: process.version,
    risk: {},
    result: {},
  };
  const modify = await prepareModify();
  for (const fn of [baselineRisk, readLiveModifyRiskPosition])
    for (let i = 0; i < 10; i++) await fn(modify);
  const risk: Record<string, unknown> = {};
  for (const width of [1, 8]) {
    const samples: Record<string, number[]> = { previous: [], current: [] };
    for (let round = 0; round < 40; round++)
      for (const name of round % 2
        ? ["current", "previous"]
        : ["previous", "current"]) {
        const fn =
          name === "previous" ? baselineRisk : readLiveModifyRiskPosition;
        await Promise.all(
          Array.from({ length: width }, async () => {
            const start = performance.now();
            const r = await fn(modify);
            assert.equal(r!.entryPrice, 1.1);
            samples[name]!.push(performance.now() - start);
          }),
        );
      }
    risk[width === 1 ? "sequential" : "concurrent8"] = {
      previous: stats(samples.previous!),
      current: stats(samples.current!),
    };
  }
  receipt.risk = risk;
  await resetFixture();
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
  const resetResult = async () => {
    await pool.query("TRUNCATE execution_events");
    await pool.query(
      "UPDATE arx_live_commands SET status='SENT_TO_MT5_LIVE',executed_volume=NULL,filled_at=NULL WHERE command_id=$1",
      [sent.commandId],
    );
    await pool.query("UPDATE arx_live_positions SET closed_at=NULL WHERE id=1");
    await pool.query(
      "UPDATE self_trade_agent_executions SET management_state=management_state-'closeAccounting' WHERE id=1",
    );
  };
  const resultStats: Record<string, unknown> = {};
  for (const width of [1, 8]) {
    const samples = Object.fromEntries(
      ["previous", "current"].map((n) => [
        n,
        {
          response: [] as number[],
          receipt: [] as number[],
          ledger: [] as number[],
        },
      ]),
    );
    const rounds = width === 1 ? 100 : 30;
    for (let round = -5; round < rounds; round++)
      for (const name of round % 2
        ? ["current", "previous"]
        : ["previous", "current"]) {
        await resetResult();
        const fn =
          name === "previous"
            ? old.recordLiveCommandResult
            : recordLiveCommandResult;
        const start = performance.now();
        let receiptTime: number | null = null,
          ledgerTime: number | null = null;
        const observe = (async () => {
          while (performance.now() - start < 5000) {
            const r = await pool.query(
              "SELECT c.status,p.closed_at FROM arx_live_commands c CROSS JOIN arx_live_positions p WHERE c.command_id=$1 AND p.id=1",
              [sent.commandId],
            );
            const elapsed = performance.now() - start;
            if (r.rows[0].status === "LIVE_FILLED" && receiptTime == null)
              receiptTime = elapsed;
            if (r.rows[0].closed_at) {
              ledgerTime = elapsed;
              return;
            }
            await new Promise((r) => setTimeout(r, 1));
          }
          throw new Error("Ledger completion deadline exceeded");
        })();
        const responses = await Promise.all(
          Array.from({ length: width }, async () => {
            const result = await fn(input);
            assert.equal(result.ok, true);
            return performance.now() - start;
          }),
        );
        await observe;
        const r = await pool.query(
          "SELECT count(*)::int AS count FROM execution_events WHERE event_type='RESULT_LIVE_FILLED'",
        );
        assert.equal(r.rows[0].count, 1);
        if (round >= 0) {
          samples[name]!.response.push(...responses);
          samples[name]!.receipt.push(receiptTime!);
          samples[name]!.ledger.push(ledgerTime!);
        }
      }
    resultStats[width === 1 ? "sequential" : "duplicateBurst8"] =
      Object.fromEntries(
        Object.entries(samples).map(([name, s]) => [
          name,
          {
            response: stats(s.response),
            committedReceiptObserved: stats(s.receipt),
            ledgerCompletionObserved: stats(s.ledger),
          },
        ]),
      );
  }
  receipt.result = resultStats;
  const reconciliationPath = `${root}/artifacts/api-server/src/lib/selfTrade/agentReconciliation.ts`;
  const reconciliationHash = createHash("sha256")
    .update(readFileSync(reconciliationPath))
    .digest("hex");
  assert.equal(
    reconciliationHash,
    "737b02fa961f78ff912d55a44e3ec18bd9dc8b06a427dd9cfdb555117d6e15c1",
  );
  const priorReconcile = (await import(pathToFileURL(reconciliationPath).href))
    .reconcileAgentExecutions as typeof reconcileAgentExecutions;
  const settlementStats: Record<string, unknown> = {};
  for (const width of [1, 8]) {
    const samples: Record<string, number[]> = { previous: [], current: [] };
    for (let round = -5; round < (width === 1 ? 100 : 30); round++)
      for (const name of round % 2
        ? ["current", "previous"]
        : ["previous", "current"]) {
        await pool.query(
          "UPDATE self_trade_agent_executions SET status='FILLED',realized_pnl=NULL,close_price=NULL,closed_at=NULL WHERE id=1",
        );
        const fn =
          name === "previous" ? priorReconcile : reconcileAgentExecutions;
        const start = performance.now();
        const settled = await Promise.all(
          Array.from({ length: width }, async () => {
            const r = await fn(4);
            if (round >= 0) samples[name]!.push(performance.now() - start);
            return r.closed;
          }),
        );
        assert.equal(
          settled.reduce((n, v) => n + v, 0),
          1,
        );
        const check = await pool.query(
          "SELECT status,realized_pnl FROM self_trade_agent_executions WHERE id=1",
        );
        assert.equal(check.rows[0].status, "CLOSED");
        if (name === "previous")
          assert.ok(Math.abs(Number(check.rows[0].realized_pnl) - 100) < 1e-8);
        else assert.equal(check.rows[0].realized_pnl, null);
      }
    settlementStats[width === 1 ? "sequential" : "concurrent8"] = {
      previous: stats(samples.previous!),
      current: stats(samples.current!),
    };
  }
  receipt.agentSettlement = {
    baselineSourceHash: reconciliationHash,
    timing:
      "actual reconciliation resolution after settlement commit. Previous computes P/L from current account data; current withholds uncertified profit. Different accounting semantics on equivalent fixtures, not a speed/parity claim.",
    ...settlementStats,
  };
  // Additional admission refusal cost, including a long agent history. This
  // measures the newly added read only; it is not a full admission benchmark.
  const { hasUnresolvedAgentAccounting } = await import("../accountingHold.js");
  await pool.query(
    "CREATE INDEX qa_bench_execution_agent ON self_trade_agent_executions(agent_id)",
  );
  const accountingQuery: Record<string, unknown> = {};
  for (const historyRows of [0, 10000]) {
    if (historyRows)
      await pool.query(
        "INSERT INTO self_trade_agent_executions(agent_id,agent_key,symbol,side,executing_user_id,mode,idempotency_key,status,realized_pnl,management_state) SELECT 4,'agent','EURUSD','BUY',9,'LIVE','bench-history-'||n,'CLOSED',0,'{}'::jsonb FROM generate_series(1,$1) n",
        [historyRows],
      );
    for (const held of [false, true]) {
      await pool.query(
        "UPDATE self_trade_agent_executions SET management_state=$1::jsonb WHERE id=1",
        [
          JSON.stringify(
            held ? { closeAccounting: { status: "UNVERIFIED" } } : {},
          ),
        ],
      );
      const times: number[] = [];
      for (let round = 0; round < 40; round++)
        await Promise.all(
          Array.from({ length: 8 }, async () => {
            const start = performance.now();
            assert.equal(await hasUnresolvedAgentAccounting(db, 4), held);
            times.push(performance.now() - start);
          }),
        );
      accountingQuery[
        `${historyRows}_history_${held ? "held" : "clear"}_concurrent8`
      ] = { current: stats(times) };
    }
  }
  receipt.accountingAdmissionRead = {
    description:
      "Added refusal query only, not full admission; production agent-id index mirrored in disposable fixture; prior code had no accounting evidence check",
    ...accountingQuery,
  };
  const currentP95: number[] = [];
  const collect = (value: unknown, selected = false): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (selected && key === "p95Ms" && typeof child === "number")
        currentP95.push(child);
      else collect(child, selected || key === "current");
    }
  };
  collect({ risk, resultStats, settlementStats, accountingQuery });
  receipt.acceptance = {
    localP95TargetMs: 100,
    currentMeasuredP95Ms: currentP95,
    passed: currentP95.every((n) => n < 100),
  };
  receipt.limitations = [
    "No broker/EA/network/UI timing or competitor performance comparison",
    "Legacy missing actual execution identity remains unverified",
    "Existing best-effort duplicate execution-event writes can lose audit rows under contention; neither benchmark version changes that writer",
    "maxMs retains outliers, including tails beyond p99; one host is not a production capacity test",
  ];

  writeFileSync(
    process.env.ARX_MANAGEMENT_BENCHMARK_OUTPUT!,
    JSON.stringify(receipt, null, 2) + "\n",
  );
  assert.ok(
    currentP95.every((n) => n < 100),
    "Local p95 target exceeded; receipt retained",
  );
}
