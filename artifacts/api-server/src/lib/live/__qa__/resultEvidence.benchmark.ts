// Called only after the disposable PostgreSQL fixture validates its isolated DB.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { db, pool, arxLiveCommandsTable as commands } from "@workspace/db";
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
  assert.equal(
    hash,
    "cfeca39801a3c9a998e43bb2700c2696728810a8b0f6a70dde831b3d83b35aa5",
    "baseline must equal8042af50",
  );
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
  ] as const) {
    const width = workload.endsWith("32")
      ? 32
      : workload === "sequential"
        ? 1
        : 8;
    const rounds = width === 1 ? 100 : 30;
    const samples: Record<
      string,
      {
        response: number[];
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
        if (workload === "independent_commands8")
          await db.insert(commands).values(
            Array.from({ length: 7 }, (_, i) => ({
              commandId: `qa-bench-${i}`,
              userId: 9,
              bridgeConnectionId: 1,
              commandType: "MODIFY_LIVE_SLTP" as const,
              symbol: "EURUSD.a",
              side: "BUY" as const,
              orderType: "MODIFY",
              requestedVolume: 0.1,
              status: "SENT_TO_MT5_LIVE" as const,
            })),
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
              ...(workload.startsWith("distinct_report")
                ? { fillPrice: 1 + i / 100, brokerMessage: `report-${i}` }
                : {}),
              ...(workload === "independent_commands8" && i > 0
                ? { commandId: `qa-bench-${i - 1}` }
                : {}),
            };
            const before = performance.now();
            const r = await fn(args);
            if (round >= 0)
              samples[name].response.push(performance.now() - before);
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
            allUniqueReportsDurableObserved: durable,
            ...Object.fromEntries(
              Object.entries(s).filter(
                ([k]) => !["response", "durable"].includes(k),
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
      commit: "8042af5018bb900e5d150c2bf3d3447e5b304122",
      sourceHash: hash,
    },
    runtime: process.version,
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
      "Old path acknowledges best-effort persistence; current path requires atomic receipt plus hash-chain audit for each distinct report, so they provide different durability guarantees",
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
