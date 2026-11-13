import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import { NOW, connection, receipt } from "./nativeAccountReport.fixture.js";
const database = await import("@workspace/db");
const dialect = new PgDialect();
let latest = receipt();
let calls = 0;
let where: { sql: string; params: unknown[] };
let ordering = "";
let limit = 0;
const query = {
  from: () => query,
  where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => { where = dialect.sqlToQuery(condition); return query; },
  orderBy: (order: Parameters<PgDialect["sqlToQuery"]>[0]) => { ordering = dialect.sqlToQuery(order).sql; return query; },
  limit: async (n: number) => { limit = n; return [latest]; },
};
mock.module("@workspace/db", { namedExports: { ...database, db: { select: () => { calls++; return query; } } } });
const { loadBridgeV2AccountReport, loadLatestAccountReportAttempt } = await import("../nativeAccountReportReader.js");

test("reader queries only the authenticated owner/bridge and the latest attempt, not the latest accepted report", async () => {
  latest = receipt({ accepted: false });
  const out = await loadBridgeV2AccountReport(connection, () => NOW);
  assert.deepEqual(where.params, [connection.userId, connection.id, "ACCOUNT_SNAPSHOT"]);
  assert.match(where.sql, /user_id/); assert.match(where.sql, /bridge_connection_id/);
  assert.doesNotMatch(where.sql, /accepted|stream_key|duplicate_dropped/);
  assert.match(ordering, /"id" desc/i); assert.equal(limit, 1);
  assert.equal(out.nativeAccountReport.reason, "ACCOUNT_REPORT_REJECTED");
  assert.equal(out.nativeAccountReport.amounts, null); assert.equal(out.accountBalance, null);
  assert.equal(out.accountAmountsCurrentVerified, false);
});
test("a valid report preserves its observation date without transferring native decimals into legacy numeric money", async () => {
  latest = receipt();
  const out = await loadBridgeV2AccountReport(connection, () => NOW);
  assert.equal(out.nativeAccountReport.status, "reported");
  assert.equal(out.nativeAccountReport.amounts?.balance, "9007199254740993.12");
  assert.equal(out.lastAccountSnapshotAt, new Date(NOW - 1000).toISOString());
  assert.equal(out.accountBalance, null); assert.equal(out.accountEquity, null); assert.equal(out.accountAmountsCurrentVerified, false);
});
test("no authenticated connection means no database lookup or shared fallback", async () => {
  const before = calls;
  for (const scope of [null, { ...connection, userId: null }, { ...connection, id: 0 }]) assert.equal(await loadLatestAccountReportAttempt(scope), null);
  assert.equal(calls, before);
});
