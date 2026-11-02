import { test } from "node:test";
import assert from "node:assert/strict";

test("pending-P/L count stays user-scoped and excludes open/already-applied rows without transferring IDs", { skip: process.env.ARX_PERF_TEST_DB !== "1" }, async (t) => {
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(process.env.DATABASE_URL!).hostname));
  const { pool } = await import("@workspace/db");
  const { fetchInvestorBalanceParts } = await import("../../live/investorLiveBalance.js");
  const userId = -2100000999;
  try {
    await pool.query(`INSERT INTO shared_trade_attribution
      (user_id, virtual_account_id, shared_master_account_id, master_connection_id, symbol, side, lot_size, status)
      SELECT $1, -1, -1, -1, '__PERF_FIXTURE__', 'BUY', 0.01, 'closed' FROM generate_series(1,10000)`, [userId]);
    await pool.query(`INSERT INTO shared_trade_attribution
      (user_id, virtual_account_id, shared_master_account_id, master_connection_id, symbol, side, lot_size, status, realized_applied_at)
      VALUES ($1,-1,-1,-1,'__PERF_FIXTURE__','BUY',0.01,'open',null),
             ($1,-1,-1,-1,'__PERF_FIXTURE__','BUY',0.01,'closed',now()),
             ($2,-1,-1,-1,'__PERF_FIXTURE__','BUY',0.01,'closed',null)`, [userId, userId - 1]);
    const before = await pool.query("SELECT id FROM shared_trade_attribution WHERE user_id=$1 AND status='closed' AND realized_applied_at IS NULL", [userId]);
    const result = await fetchInvestorBalanceParts(userId);
    assert.equal(result.realizedPnLPendingCount, before.rowCount);
    assert.equal(result.realizedPnLPendingCount, 10000);
    assert.equal((await fetchInvestorBalanceParts(userId - 1)).realizedPnLPendingCount, 1);
    assert.equal((await fetchInvestorBalanceParts(userId - 2)).realizedPnLPendingCount, 0);
    const after = await pool.query("SELECT count(*) AS total FROM shared_trade_attribution WHERE user_id=$1 AND status='closed' AND realized_applied_at IS NULL", [userId]);
    t.diagnostic(JSON.stringify({ beforeRows: before.rowCount, afterRows: after.rowCount, beforeJsonBytes: Buffer.byteLength(JSON.stringify(before.rows)), afterJsonBytes: Buffer.byteLength(JSON.stringify(after.rows)) }));
    for (const projection of ["id", "count(*)"]) {
      const plan = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT ${projection} FROM shared_trade_attribution WHERE user_id=$1 AND status='closed' AND realized_applied_at IS NULL`, [userId]);
      t.diagnostic(JSON.stringify({ projection, plan: plan.rows[0]["QUERY PLAN"] }));
    }
  } finally {
    await pool.query("DELETE FROM shared_trade_attribution WHERE user_id IN ($1,$2) AND symbol='__PERF_FIXTURE__'", [userId, userId - 1]);
    await pool.end();
  }
});
