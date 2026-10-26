// Opt-in disposable PostgreSQL benchmark. Both handlers and all receipt/position
// writes are real; ancillary exposure/mission callbacks are controlled identically.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { recordLiveCommandResult } from "../../live/liveCommandPipeline.js";
export async function runManualResultRecoveryBenchmark(
  prepare: () => Promise<Parameters<typeof recordLiveCommandResult>[0]>,
) {
  const root = process.env.ARX_MANUAL_RESULT_BASELINE_ROOT!;
  assert.ok(root?.startsWith("/Users/areyouok/arx-"));
  const sourcePath = `${root}/artifacts/api-server/src/lib/live/liveCommandPipeline.ts`;
  const sourceHash = createHash("sha256")
    .update(readFileSync(sourcePath))
    .digest("hex");
  assert.equal(
    sourceHash,
    "cfeca39801a3c9a998e43bb2700c2696728810a8b0f6a70dde831b3d83b35aa5",
  );
  for (const [file, namedExports] of [
    [
      "concurrency/exposureReservation.ts",
      {
        fulfillReservationByCommandId: async () => {},
        releaseReservationByCommandId: async () => {},
      },
    ],
    [
      "missionExitManager.ts",
      { recordMissionTradeCloseByBrokerTicket: async () => {} },
    ],
  ] as const)
    mock.module(
      pathToFileURL(`${root}/artifacts/api-server/src/lib/${file}`).href,
      { namedExports },
    );
  const previous = await import(pathToFileURL(sourcePath).href);
  const stats = (values: number[]) => {
    const a = [...values].sort((x, y) => x - y);
    const p = (q: number) => Number(a[Math.ceil(q * a.length) - 1].toFixed(3));
    return {
      n: a.length,
      medianMs: p(0.5),
      p95Ms: p(0.95),
      p99Ms: p(0.99),
      maxMs: p(1),
    };
  };
  const results: Record<string, unknown> = {};
  const p95s: number[] = [];
  for (const width of [1, 8]) {
    const samples = Object.fromEntries(
      ["previous", "current"].map((n) => [
        n,
        {
          response: [] as number[],
          receipt: [] as number[],
          position: [] as number[],
        },
      ]),
    );
    for (let round = -3; round < 50; round++)
      for (const name of round % 2
        ? ["current", "previous"]
        : ["previous", "current"]) {
        const input = await prepare();
        let done = false,
          receipt: number | null = null,
          position: number | null = null;
        const start = performance.now();
        const witness = (async () => {
          while (!done) {
            const { rows } = await pool.query(
              "SELECT (SELECT count(*) FROM execution_events WHERE event_type='RESULT_LIVE_FILLED') AS receipts,(SELECT closed_at IS NOT NULL FROM arx_live_positions WHERE id=1) AS closed",
            );
            const elapsed = performance.now() - start;
            if (Number(rows[0].receipts) > 0 && receipt === null)
              receipt = elapsed;
            if (rows[0].closed && position === null) position = elapsed;
            if (receipt !== null && position !== null) return;
            await new Promise((r) => setTimeout(r, 1));
          }
        })();
        const fn =
          name === "previous"
            ? previous.recordLiveCommandResult
            : recordLiveCommandResult;
        try {
          await Promise.all(
            Array.from({ length: width }, async () => {
              const t = performance.now();
              const result = await fn(input);
              assert.equal(result.ok, true);
              if (round >= 0)
                samples[name].response.push(performance.now() - t);
            }),
          );
        } finally {
          done = true;
          await witness;
        }
        const { rows } = await pool.query(
          "SELECT closed_at,volume FROM arx_live_positions WHERE id=1",
        );
        assert.ok(rows[0].closed_at);
        assert.equal(rows[0].volume, 0.1);
        if (receipt === null || position === null) {
          const latest = await pool.query(
            "SELECT (SELECT count(*) FROM execution_events WHERE event_type='RESULT_LIVE_FILLED') AS receipts,(SELECT closed_at IS NOT NULL FROM arx_live_positions WHERE id=1) AS closed",
          );
          if (receipt === null && Number(latest.rows[0].receipts) > 0)
            receipt = performance.now() - start;
          if (position === null && latest.rows[0].closed)
            position = performance.now() - start;
        }
        if (name === "current") assert.notEqual(receipt, null);
        assert.notEqual(position, null);
        if (round >= 0) {
          if (receipt !== null) samples[name].receipt.push(receipt);
          samples[name].position.push(position!);
        }
        if (name === "current")
          assert.equal(
            (
              await pool.query(
                "SELECT id FROM execution_events WHERE event_type='POSITION_RESULT_APPLIED'",
              )
            ).rows.length,
            1,
          );
      }
    const result = Object.fromEntries(
      Object.entries(samples).map(([name, value]) => [
        name,
        {
          response: stats(value.response),
          receiptObserved: value.receipt.length ? stats(value.receipt) : null,
          receiptCoverage: {
            expectedRounds: 50,
            durableRounds: value.receipt.length,
            missingRounds: 50 - value.receipt.length,
          },
          positionCompletionObserved: stats(value.position),
        },
      ]),
    );
    results[
      width === 1
        ? "sequential_full_manual_close"
        : "identical_retry_burst8_full_manual_close"
    ] = result;
    for (const values of Object.values(samples.current))
      p95s.push(stats(values).p95Ms);
  }
  const receipt = {
    measuredAt: new Date().toISOString(),
    baseline: {
      commit: "8042af5018bb900e5d150c2bf3d3447e5b304122",
      sourceHash,
    },
    runtime: process.version,
    fixture:
      "Actual old/current full manual CLOSE handler; signed0.1-lot local row basis; no broker snapshot changes; real result/event/security-chain and position writes; ancillary exposure/mission callbacks stubbed equally",
    timing:
      "Handler response vs independently polled committed receipt and actual position closedAt;1ms observation granularity;50 alternating rounds with3 warmups; all outliers retained",
    results,
    acceptance: {
      localP95TargetMs: 100,
      p95s,
      passed: p95s.every((x) => x < 100),
    },
    limitations: [
      "No network/EA/broker/UI latency",
      "Old handler lacks signed row-version/cumulative marker protection; durability correctness compared separately",
      "Receipt/position timing does not certify broker account identity or realized P/L",
      "Missing baseline result receipts remain explicit incomplete coverage; conditional timing samples do not prove baseline durability",
    ],
  };
  writeFileSync(
    process.env.ARX_MANUAL_RESULT_BENCHMARK_OUTPUT!,
    JSON.stringify(receipt, null, 2) + "\n",
  );
  assert.equal(
    receipt.acceptance.passed,
    true,
    "manual recovery local completion p95 budget",
  );
}
