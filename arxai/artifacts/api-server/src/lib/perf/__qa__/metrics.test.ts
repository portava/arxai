import { test } from "node:test";
import assert from "node:assert/strict";
import { recordPerf, summariseByAction, readRecentPerf, _resetPerfRecorderForTest } from "../perfRecorder.js";
import { readRuntimeMetrics } from "../runtimeMetrics.js";
import { databasePoolConfig } from "../../../../../../lib/db/src/poolConfig.js";

test("latency summaries expose p99 and 5xx counts; ring memory remains bounded", () => {
  _resetPerfRecorderForTest();
  for (let i = 0; i < 100; i++) recordPerf({ source: "server", action: "test", totalMs: i, status: i < 5 ? 503 : 200 });
  assert.deepEqual(summariseByAction()[0], { action: "test", count: 100, p50Ms: 50, p95Ms: 95, p99Ms: 99, maxMs: 99, slowCount: 0, errorCount: 5 });
  for (let i = 0; i < 2000; i++) recordPerf({ source: "server", action: "bounded", totalMs: 1 });
  assert.equal(readRecentPerf({ limit: 100000 }).length, 1024);
  _resetPerfRecorderForTest();
});

test("runtime diagnostics expose aggregate resource use and pool pressure only", () => {
  const result = readRuntimeMetrics({ totalCount: 10, idleCount: 0, waitingCount: 7 });
  assert.deepEqual(result.database, { total: 10, idle: 0, waiting: 7 });
  assert.deepEqual(result.alerts, ["DATABASE_POOL_WAITING"]);
  assert.ok(result.memory.rssBytes > 0);
  assert.ok(result.eventLoopUtilization >= 0 && result.eventLoopUtilization <= 1);
  assert.equal(readRuntimeMetrics({ totalCount: 1, idleCount: 1, waitingCount: 0 }).alerts.length, 0);
});

test("pool defaults preserve size and bound acquisition; malformed overrides fail fast", () => {
  assert.deepEqual(databasePoolConfig({}), { max: 10, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000 });
  assert.equal(databasePoolConfig({ ARX_DB_POOL_MAX: "4", ARX_DB_CONNECT_TIMEOUT_MS: "50" }).max, 4);
  for (const value of ["0", "-1", "NaN", "1.5", "101", ""]) assert.throws(() => databasePoolConfig({ ARX_DB_POOL_MAX: value }));
});
