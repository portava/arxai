// Regression: when one of the two secret-scan count queries failed, the report
// coerced both counts to 0 and only the summary flag said "not checked". The
// page then showed "Frontend leaks: 0 / Log leaks: 0" beside "Scan: not
// checked", and nothing said which half (if any) was a real count.
//
// Each half now says whether it ran, so a count is shown only for a half
// that was checked.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

const fail = { frontend: false, logs: false };
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: Array<{ value?: unknown }> })?.queryChunks ?? [];
  return chunks.map((c) => (Array.isArray(c?.value) ? c.value.join("") : "")).join("");
}
const fakeDb = {
  execute: async (q: unknown) => {
    const text = sqlText(q);
    if (/from notification_logs/.test(text)) {
      if (fail.logs) throw new Error("notification_logs scan failed (fixture)");
      return { rows: [{ c: 2 }] };
    }
    if (/from notifications/.test(text)) {
      if (fail.frontend) throw new Error("notifications scan failed (fixture)");
      return { rows: [{ c: 0 }] };
    }
    throw new Error(`unexpected query: ${text}`);
  },
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const { probeSecretSafety } = await import("../health.js");

test("both halves ran: both counts are real", async () => {
  fail.frontend = false; fail.logs = false;
  const s = await probeSecretSafety();
  assert.equal(s.scanChecked, true);
  assert.equal(s.frontendScanChecked, true);
  assert.equal(s.logScanChecked, true);
  assert.equal(s.secretsDetectedInLogs, 2);
});

test("the log query failed: the frontend count is real, the log half is not checked", async () => {
  fail.frontend = false; fail.logs = true;
  const s = await probeSecretSafety();
  assert.equal(s.scanChecked, false);
  assert.equal(s.frontendScanChecked, true);
  assert.equal(s.logScanChecked, false);
  assert.equal(s.redactionWorking, false);
});

test("the frontend query failed: that half is not checked", async () => {
  fail.frontend = true; fail.logs = false;
  const s = await probeSecretSafety();
  assert.equal(s.frontendScanChecked, false);
  assert.equal(s.logScanChecked, true);
  assert.equal(s.secretsDetectedInLogs, 2);
});
