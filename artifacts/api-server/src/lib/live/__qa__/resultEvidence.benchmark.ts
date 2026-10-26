// Called only after the disposable PostgreSQL fixture validates its isolated DB.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { db, pool, arxLiveCommandsTable as commands } from "@workspace/db";
import * as realDatabase from "@workspace/db";
import { recordLiveCommandResult } from "../liveCommandPipeline.js";
import { verifySecurityEventChain } from "../../security/events.js";
export async function runResultEvidenceBenchmark(
  resetFixture: () => Promise<void>,
  report: () => Parameters<typeof recordLiveCommandResult>[0],
) {
  const root = process.env.ARX_RESULT_BASELINE_ROOT!;
  assert.ok(root?.startsWith("/Users/areyouok/arx-"));
  const sourcePath = `${root}/artifacts/api-server/src/lib/live/liveCommandPipeline.ts`;
  const hash = createHash("sha256")
    .update(readFileSync(sourcePath))
    .digest("hex");
  const baselineCommits: Record<string, string> = {
    cfeca39801a3c9a998e43bb2700c2696728810a8b0f6a70dde831b3d83b35aa5:
      "8042af5018bb900e5d150c2bf3d3447e5b304122",
    e1d0b2cb9a0a25e6a2a922b6a197d5e2ec396694d5d98a1b2e9cd7f3bd65bee9:
      "644182385862398a1f6209b46161b6c952d9f3d1",
  };
  const baselineCommit = baselineCommits[hash];
  assert.ok(baselineCommit, "baseline must match a frozen checked source");
  // Resolve both handlers to the exact same REAL database, pool and schema.
  // No query or transaction is mocked. This fixes previous baseline-witness
  // asymmetry (old worktree's own pool vs witness using the current pool).
  const baselineDbUrl = pathToFileURL(`${root}/lib/db/src/index.ts`).href;
  mock.module(baselineDbUrl, { namedExports: { ...realDatabase } });
  const baselineDatabase = await import(baselineDbUrl);
  assert.equal(baselineDatabase.pool, pool);
  assert.equal(baselineDatabase.db, db);
  assert.equal(
    createHash("sha256")
      .update(
        readFileSync(`${root}/artifacts/api-server/src/lib/security/events.ts`),
      )
      .digest("hex"),
    "c9bd6a4b1315c5099950d4ad3dcc37052369f52be38b802320e8a9985feb52db",
    "both versions retain the same real security-chain writer",
  );
  mock.module(
    pathToFileURL(
      `${root}/artifacts/api-server/src/lib/concurrency/exposureReservation.ts`,
    ).href,
    {
      namedExports: {
        fulfillReservationByCommandId: async () => undefined,
        releaseReservationByCommandId: async () => undefined,
      },
    },
  );
  const previous = await import(pathToFileURL(sourcePath).href);
  const stats = (v: number[]) => {
    const a = [...v].sort((a, b) => a - b);
    const q = (p: number) => Number(a[Math.ceil(p * a.length) - 1].toFixed(3));
    return {
      n: a.length,
      medianMs: q(0.5),
      p95Ms: q(0.95),
      p99Ms: q(0.99),
      maxMs: q(1),
    };
  };
  const results: Record<string, unknown> = {};
  const p95s: number[] = [];
  for (const workload of [
    "sequential",
    "identical_retry_burst8",
    "distinct_report_burst8",
    "distinct_report_burst32",
    "independent_commands8",
    "mixed_key_burst32_plus4",
  ] as const) {
    const width =
      workload === "mixed_key_burst32_plus4"
        ? 36
        : workload.endsWith("32")
          ? 32
          : workload === "sequential"
            ? 1
            : 8;
    const rounds = width === 1 ? 100 : 30;
    const samples: Record<
      string,
      {
        response: number[];
        independentResponse: number[];
        durable: number[];
        sent: number;
        uniqueExpected: number;
        events: number;
        chainRows: number;
        applied: number;
        acknowledged: number;
      }
    > = Object.fromEntries(
      ["previous", "current"].map((n) => [
        n,
        {
          response: [],
          independentResponse: [],
          durable: [],
          sent: 0,
          uniqueExpected: 0,
          events: 0,
          chainRows: 0,
          applied: 0,
          acknowledged: 0,
        },
      ]),
    );
    for (let round = -3; round < rounds; round++)
      for (const name of round % 2
        ? ["current", "previous"]
        : ["previous", "current"]) {
        await resetFixture();
        if (
          workload === "independent_commands8" ||
          workload === "mixed_key_burst32_plus4"
        )
          await db.insert(commands).values(
            Array.from(
              { length: workload === "independent_commands8" ? 7 : 4 },
              (_, i) => ({
                commandId: `qa-bench-${i}`,
                userId: 9,
                bridgeConnectionId: 1,
                commandType: "MODIFY_LIVE_SLTP" as const,
                symbol: "EURUSD.a",
                side: "BUY" as const,
                orderType: "MODIFY",
                requestedVolume: 0.1,
                status: "SENT_TO_MT5_LIVE" as const,
              }),
            ),
          );
        const fn =
          name === "previous"
            ? previous.recordLiveCommandResult
            : recordLiveCommandResult;
        const expected = workload === "identical_retry_burst8" ? 1 : width;
        const start = performance.now();
        let done = false;
        let complete: number | null = null;
        const witness = (async () => {
          while (!done) {
            const { rows } = await pool.query(
              "SELECT count(*)::int AS events FROM execution_events WHERE source='ea' AND event_type IN ('RESULT_LIVE_FILLED','LATE_RESULT_RETAINED')",
            );
            if (rows[0].events >= expected) {
              complete = performance.now() - start;
              return;
            }
            await new Promise((r) => setTimeout(r, 1));
          }
        })();
        const responses = await Promise.all(
          Array.from({ length: width }, async (_, i) => {
            const args = {
              ...report(),
              ...(workload.startsWith("distinct_report") ||
              workload === "mixed_key_burst32_plus4"
                ? { fillPrice: 1 + i / 100, brokerMessage: `report-${i}` }
                : {}),
              ...(workload === "independent_commands8" && i > 0
                ? { commandId: `qa-bench-${i - 1}` }
                : {}),
              ...(workload === "mixed_key_burst32_plus4" && i >= 32
                ? { commandId: `qa-bench-${i - 32}` }
                : {}),
            };
            const before = performance.now();
            const r = await fn(args);
            if (round >= 0)
              samples[name].response.push(performance.now() - before);
            if (round >= 0 && workload === "mixed_key_burst32_plus4" && i >= 32)
              samples[name].independentResponse.push(
                performance.now() - before,
              );
            return r;
          }),
        );
        done = true;
        await witness;
        const { rows } = await pool.query(
          "SELECT count(*)::int AS events,count(*) FILTER(WHERE payload->>'applied'='true')::int AS applied FROM execution_events WHERE source='ea' AND event_type IN ('RESULT_LIVE_FILLED','LATE_RESULT_RETAINED')",
        );
        const chain = await verifySecurityEventChain();
        assert.equal(chain.valid, true);
        assert.equal(chain.unknownCount, 0);
        if (complete == null && rows[0].events >= expected)
          complete = performance.now() - start;
        if (name === "current") {
          assert.equal(rows[0].events, expected);
          assert.equal(chain.checked, expected);
          assert.ok(responses.every((r) => r.ok));
        }
        if (round >= 0) {
          const record = samples[name];
          record.sent += width;
          record.uniqueExpected += expected;
          record.events += rows[0].events;
          record.applied += rows[0].applied;
          record.chainRows += chain.checked;
          record.acknowledged += responses.filter((r) => r.ok).length;
          if (complete != null) record.durable.push(complete);
        }
      }
    results[workload] = Object.fromEntries(
      Object.entries(samples).map(([name, s]) => {
        const response = stats(s.response);
        const durable = s.durable.length ? stats(s.durable) : null;
        if (name === "current") {
          p95s.push(response.p95Ms);
          if (durable) p95s.push(durable.p95Ms);
        }
        return [
          name,
          {
            response,
            ...(s.independentResponse.length
              ? { independentCommandResponse: stats(s.independentResponse) }
              : {}),
            allUniqueReportsDurableObserved: durable,
            ...Object.fromEntries(
              Object.entries(s).filter(
                ([k]) =>
                  !["response", "independentResponse", "durable"].includes(k),
              ),
            ),
            durableCompleteRounds: s.durable.length,
            rounds,
          },
        ];
      }),
    );
  }
  const receipt = {
    measuredAt: new Date().toISOString(),
    baseline: {
      commit: baselineCommit,
      sourceHash: hash,
    },
    runtime: process.version,
    poolIdentity: {
      actualDbEqual: baselineDatabase.db === db,
      actualPoolEqual: baselineDatabase.pool === pool,
      max: pool.options.max,
      witnessUsesSamePool: true,
      note: "Only baseline module resolution is redirected to real current DB exports; all queries, transactions, locks and commits execute. Earlier receipts retained with baseline/current pool asymmetry disclosed.",
    },
    fixture:
      "Actual old/new result handlers and same real security-chain writer; disposable Unix-socket PostgreSQL; synthetic MODIFY reports; exposure settlement stubbed identically",
    timing:
      "response is handler resolution; durable completion is 1ms polling observation of all unique receipt rows; missing baseline receipts are counted as incomplete, never dropped from coverage",
    results,
    acceptance: {
      localP95TargetMs: 100,
      measuredCurrentP95Ms: p95s,
      passed: p95s.every((n) => n < 100),
    },
    limitations: [
      "No network, EA, orders or broker latency measured",
      baselineCommit.startsWith("8042")
        ? "8042 path acknowledges best-effort persistence; current requires atomic evidence, so guarantees differ"
        : "Both644baseline and candidate require atomic receipt and unchanged securitychain; only bounded local scheduling differs",
      "Contradictory reports remain evidence, not new terminal state authority",
      "Serial gaps and maximum latency outliers retained; single-host fixture is not production capacity",
    ],
  };
  writeFileSync(
    process.env.ARX_RESULT_BENCHMARK_OUTPUT!,
    JSON.stringify(receipt, null, 2),
  );
  assert.ok(
    receipt.acceptance.passed,
    "local p95 budget failed; receipt retained",
  );
}
