// QA-only phase profiling. The caller must first verify the disposable DB identity.
// Instrumented timings diagnose overhead; they are not the acceptance benchmark.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
// Driver interception is QA-only; the API package does not expose pg type declarations.
const pg = createRequire(import.meta.url)("pg") as {
  Client: {
    new (options: { connectionString?: string }): any;
    prototype: { query: any };
  };
};
import { pool } from "@workspace/db";
import { resultReceiptScheduler } from "../resultReceiptScheduler.js";
import { recordLiveCommandResult } from "../liveCommandPipeline.js";
import { verifySecurityEventChain } from "../../security/events.js";

type Trace = {
  round: number;
  report: number;
  locks: number;
  phases: { phase: string; ms: number }[];
  responseMs?: number;
};
const stats = (values: number[]) => {
  const a = [...values].sort((x, y) => x - y);
  const quantile = (q: number) =>
    Number(a[Math.ceil(q * a.length) - 1].toFixed(3));
  return {
    n: a.length,
    medianMs: quantile(0.5),
    p95Ms: quantile(0.95),
    p99Ms: quantile(0.99),
    maxMs: quantile(1),
    totalMs: Number(a.reduce((x, y) => x + y, 0).toFixed(3)),
  };
};
function queryPhase(text: string, trace: Trace): string {
  const q = text.toLowerCase();
  if (q === "begin" || q === "commit" || q === "rollback") return q;
  if (q.includes("pg_advisory_xact_lock")) return "security_chain_lock_query";
  if (q.includes("arx_live_commands") && q.includes("for update"))
    return ++trace.locks === 1
      ? "command_claim_query_including_row_wait"
      : "evidence_anchor_relock_query";
  if (
    q.includes("execution_events") &&
    q.includes("reportfingerprint") &&
    q.trimStart().startsWith("select")
  )
    return "fingerprint_lookup";
  if (q.includes('update "arx_live_commands"')) return "command_update";
  if (q.includes("insert into execution_events"))
    return "execution_event_insert";
  if (q.includes('insert into "live_trading_audit"'))
    return "ordinary_audit_insert";
  if (q.includes('insert into "security_events"'))
    return "security_chain_insert";
  if (q.includes('from "security_events"')) return "security_chain_head_read";
  return "other_query";
}
export async function profileResultEvidence(
  resetFixture: () => Promise<void>,
  report: () => Parameters<typeof recordLiveCommandResult>[0],
) {
  const context = new AsyncLocalStorage<Trace>();
  const traces: Trace[] = [];
  const rounds: {
    round: number;
    elapsedMs: number;
    receiptCount: number;
    durableObservedMs: number;
  }[] = [];
  const waits: Record<string, number> = {};
  const originalRun = resultReceiptScheduler.run;
  resultReceiptScheduler.run = function (
    userId,
    commandId,
    weightBytes,
    receipt,
  ) {
    const trace = context.getStore();
    const start = performance.now();
    return originalRun.call(this, userId, commandId, weightBytes, () => {
      if (trace)
        trace.phases.push({
          phase: "local_schedule_wait",
          ms: performance.now() - start,
        });
      return receipt();
    }) as ReturnType<typeof receipt>;
  };
  const originalConnect = pool.connect;
  const originalQuery = pg.Client.prototype.query;
  // Preserve both node-postgres promise and callback overloads. Witness queries
  // outside the request context are intentionally absent from phase attribution.
  (pool as any).connect = function (...args: any[]) {
    const trace = context.getStore();
    const start = performance.now();
    const record = () => {
      if (trace)
        trace.phases.push({
          phase: "pool_acquire_including_queue",
          ms: performance.now() - start,
        });
    };
    if (typeof args[0] === "function") {
      const callback = args[0];
      args[0] = (...values: any[]) => {
        record();
        return callback(...values);
      };
      return (originalConnect as any).apply(this, args);
    }
    return (originalConnect as any).apply(this, args).then(
      (client: unknown) => {
        record();
        return client;
      },
      (error: unknown) => {
        record();
        throw error;
      },
    );
  };
  (pg.Client.prototype as any).query = function (...args: any[]) {
    const trace = context.getStore();
    if (!trace) return (originalQuery as any).apply(this, args);
    const phase = queryPhase(
      typeof args[0] === "string" ? args[0] : (args[0]?.text ?? ""),
      trace,
    );
    const start = performance.now();
    const record = () =>
      trace.phases.push({ phase, ms: performance.now() - start });
    const callbackIndex = args.length - 1;
    if (typeof args[callbackIndex] === "function") {
      const callback = args[callbackIndex];
      args[callbackIndex] = (...values: any[]) => {
        record();
        return callback(...values);
      };
      return (originalQuery as any).apply(this, args);
    }
    const result = (originalQuery as any).apply(this, args);
    if (result?.then)
      return result.then(
        (value: unknown) => {
          record();
          return value;
        },
        (error: unknown) => {
          record();
          throw error;
        },
      );
    throw new Error("PROFILE_UNSUPPORTED_QUERY_INTERFACE");
  };
  // Independent observer never consumes one of the application's ten pool slots.
  const observer = new pg.Client({
    connectionString: process.env.DATABASE_URL,
  });
  await observer.connect();
  try {
    for (let round = -3; round < 30; round++) {
      await resetFixture();
      const start = performance.now();
      let done = false;
      let durableObservedMs: number | null = null;
      // Keep the original acceptance workload's pooled1ms receipt witness.
      const witness = (async () => {
        while (!done) {
          const { rows } = await pool.query(
            "SELECT count(*)::int AS events FROM execution_events WHERE source='ea' AND event_type IN ('RESULT_LIVE_FILLED','LATE_RESULT_RETAINED')",
          );
          if (rows[0].events >= 32) {
            durableObservedMs = performance.now() - start;
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      })();
      const monitor = (async () => {
        while (!done) {
          const { rows } = await observer.query(
            "SELECT wait_event_type,wait_event,count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' GROUP BY wait_event_type,wait_event",
          );
          if (round >= 0)
            for (const r of rows) {
              const key = `${r.wait_event_type ?? "running"}:${r.wait_event ?? "running"}`;
              waits[key] = (waits[key] ?? 0) + r.count;
            }
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      })();
      const replies = await Promise.all(
        Array.from({ length: 32 }, (_, i) => {
          const trace: Trace = { round, report: i, locks: 0, phases: [] };
          if (round >= 0) traces.push(trace);
          return context.run(trace, async () => {
            const reportStart = performance.now();
            const reply = await recordLiveCommandResult({
              ...report(),
              fillPrice: 1 + i / 100,
              brokerMessage: `report-${i}`,
            });
            trace.responseMs = performance.now() - reportStart;
            return reply;
          });
        }),
      );
      const elapsedMs = performance.now() - start;
      done = true;
      await Promise.all([monitor, witness]);
      const { rows } = await pool.query(
        "SELECT count(*)::int AS count FROM execution_events WHERE source='ea'",
      );
      assert.equal(rows[0].count, 32);
      assert.ok(replies.every((r) => r.ok && r.receiptPersisted));
      const chain = await verifySecurityEventChain();
      assert.equal(chain.valid, true);
      assert.equal(chain.checked, 32);
      assert.equal(chain.unknownCount, 0);
      if (round >= 0)
        rounds.push({
          round,
          elapsedMs,
          receiptCount: rows[0].count,
          durableObservedMs: durableObservedMs ?? performance.now() - start,
        });
    }
  } finally {
    await observer.end();
    resultReceiptScheduler.run = originalRun;
    pool.connect = originalConnect;
    pg.Client.prototype.query = originalQuery;
  }
  const byPhase: Record<string, number[]> = {};
  for (const trace of traces)
    for (const value of trace.phases)
      (byPhase[value.phase] ??= []).push(value.ms);
  const profiles = Object.fromEntries(
    Object.entries(byPhase).map(([key, values]) => [key, stats(values)]),
  );
  writeFileSync(
    process.env.ARX_RESULT_PROFILE_OUTPUT!,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        base: "644182385862398a1f6209b46161b6c952d9f3d1",
        runtime: process.version,
        workload:
          "30 rounds of32distinct reports +3warmups; actual handler/event/unchanged securitychain; same10slot pool; profiling observer is additional connection",
        instrumentation:
          "Query timings include client/driver/network/server and lock waits; not isolated SQL execution. Sampling wait events is diagnostic and adds overhead. No changed pool settings or altered transaction/durability.",
        phaseStats: profiles,
        response: stats(traces.map((t) => t.responseMs!)),
        allResponses: stats(rounds.map((r) => r.elapsedMs)),
        durableObserved: stats(rounds.map((r) => r.durableObservedMs)),
        waitEventSamples: waits,
        traces,
        rounds,
      },
      null,
      2,
    ),
  );
}
