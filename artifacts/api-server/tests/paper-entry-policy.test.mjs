// Integration regression coverage. Run only through test:isolated-server-lane:
// its disposable database, inert API and non-local TCP/UDP/DNS blocker are required.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { BASE, DIRECT, call, freshTrader, paperOrder, paperOrdersOf } from './support/governed.mjs';
let client;
before(async () => {
  assert.ok(process.env.ISOLATED_API_DIRECT_URL, 'requires the disposable isolated lane');
  client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
});
beforeEach(async () => {
  await client.query("UPDATE safety_core SET operational_mode='PAPER_TRADING', global_state='NORMAL', kill_switch_engaged=false");
});
after(async () => { await client?.end(); });

for (const [column, value] of [
  ['operational_mode', 'OBSERVE_ONLY'], ['operational_mode', 'SUGGEST_ONLY'],
  ['global_state', 'SAFE_SHUTDOWN'], ['global_state', 'RECOVERY_MODE'], ['global_state', 'DEGRADED_MODE'],
]) test(`paper entry refuses ${value}, preserving a linked refusal`, async () => {
  const trader = await freshTrader(client, value);
  await client.query(`UPDATE safety_core SET ${column}=$1`, [value]);
  const result = await paperOrder(trader);
  assert.equal(result.status, 422, JSON.stringify(result));
  assert.match(result.data.error, /PAPER_(MODE|STATE)_BLOCK/);
  assert.deepEqual(await paperOrdersOf(client, trader.id), []);
  const { rows } = await client.query("SELECT v.linked_decision_id, a.payload FROM vault_events v JOIN audit_events a ON a.payload->>'linkedDecisionId'=v.linked_decision_id WHERE v.payload->>'userId'=$1", [String(trader.id)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.decision, 'block');
});

test('manual booking links exactly one order to its governor decision in both audit stores', async () => {
  const trader = await freshTrader(client, 'linked-order');
  const result = await paperOrder(trader);
  assert.equal(result.status, 200, JSON.stringify(result));
  const { rows } = await client.query("SELECT * FROM vault_events WHERE kind='PAPER_ORDER_PLACED' AND linked_trade_id=$1", [String(result.data.order.id)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.userId, trader.id);
  const decision = rows[0].linked_decision_id;
  assert.match(decision, /^risk:\d+$/);
  const { rows: audit } = await client.query("SELECT * FROM audit_events WHERE event_type='PAPER_ORDER_PLACED' AND payload->>'linkedTradeId'=$1", [String(result.data.order.id)]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].payload.linkedDecisionId, decision);
});

for (const table of ['vault_events', 'audit_events', 'paper_trade_events']) test(`failure writing ${table} rolls back the booked order and all booking evidence`, async () => {
  const trader = await freshTrader(client, `fault-${table}`);
  const condition = table === 'vault_events' ? "NEW.kind = 'PAPER_ORDER_PLACED'" : table === 'audit_events' ? "NEW.event_type = 'PAPER_ORDER_PLACED'" : "NEW.event_type = 'PLACED'";
  await client.query(`CREATE FUNCTION qa_booking_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'qa injected booking failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER qa_booking_fault BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION qa_booking_fault();`);
  try {
    const result = await paperOrder(trader);
    assert.equal(result.status, 500);
    assert.deepEqual(await paperOrdersOf(client, trader.id), []);
    const { rows } = await client.query("SELECT (SELECT count(*) FROM paper_trade_events WHERE user_id=$1) AS events, (SELECT count(*) FROM vault_events WHERE kind='PAPER_ORDER_PLACED' AND payload->>'userId'=$2) AS vault, (SELECT count(*) FROM audit_events WHERE event_type='PAPER_ORDER_PLACED' AND payload->>'userId'=$2) AS audit", [trader.id, String(trader.id)]);
    assert.deepEqual(rows[0], { events:'0', vault:'0', audit:'0' });
  } finally { await client.query(`DROP TRIGGER qa_booking_fault ON ${table}; DROP FUNCTION qa_booking_fault();`); }
});

test('a mode change after the governor decision is caught at final booking', async () => {
  const trader = await freshTrader(client, 'late-mode-change');
  await client.query(`CREATE FUNCTION qa_late_mode() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE safety_core SET operational_mode='SUGGEST_ONLY'; RETURN NEW; END $$; CREATE TRIGGER qa_late_mode AFTER INSERT ON user_risk_events FOR EACH ROW EXECUTE FUNCTION qa_late_mode();`);
  try {
    const result = await paperOrder(trader);
    assert.equal(result.status, 422, JSON.stringify(result));
    assert.match(result.data.error, /PAPER_MODE_BLOCK/);
    assert.deepEqual(await paperOrdersOf(client, trader.id), []);
    const { rows } = await client.query("SELECT * FROM vault_events WHERE kind='PAPER_ENTRY_HELD' AND payload->>'userId'=$1", [String(trader.id)]);
    assert.equal(rows.length, 1);
  } finally { await client.query('DROP TRIGGER qa_late_mode ON user_risk_events; DROP FUNCTION qa_late_mode();'); }
});

test('missing or duplicate Safety Core state refuses new paper entries', async () => {
  const trader = await freshTrader(client, 'ambiguous-safety');
  const { rows: original } = await client.query('SELECT * FROM safety_core');
  try {
    await client.query('DELETE FROM safety_core');
    assert.equal((await paperOrder(trader)).status, 422);
    await client.query("INSERT INTO safety_core(operational_mode,global_state) VALUES ('PAPER_TRADING','NORMAL'),('PAPER_TRADING','NORMAL')");
    assert.equal((await paperOrder(trader)).status, 422);
    assert.deepEqual(await paperOrdersOf(client, trader.id), []);
  } finally {
    await client.query('DELETE FROM safety_core');
    for (const r of original) await client.query('INSERT INTO safety_core(id,operational_mode,global_state,kill_switch_engaged) VALUES($1,$2,$3,$4)',[r.id,r.operational_mode,r.global_state,r.kill_switch_engaged]);
  }
});

test('the final booking excludes both mode changes and new Safety Core rows until commit', async () => {
  const trader = await freshTrader(client, 'posture-commit-lock');
  const writer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await writer.connect();
  await writer.query("SET lock_timeout='100ms'");
  // Pause after the real final posture check, inside the booking transaction.
  await client.query('SELECT pg_advisory_lock(1095915607, 20261028)');
  await client.query(`CREATE FUNCTION qa_pause_booking() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(1095915607, 20261028); RETURN NEW; END $$; CREATE TRIGGER qa_pause_booking BEFORE INSERT ON paper_orders FOR EACH ROW EXECUTE FUNCTION qa_pause_booking();`);
  let pending;
  try {
    pending = paperOrder(trader);
    const deadline = Date.now() + 10000;
    let waiting = false;
    while (Date.now() < deadline) {
      const { rows } = await client.query('SELECT 1 FROM pg_locks WHERE locktype=\'advisory\' AND classid=1095915607 AND objid=20261028 AND NOT granted');
      if (rows.length) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(waiting, 'booking must reach the post-check barrier');
    await assert.rejects(writer.query("UPDATE safety_core SET operational_mode='OBSERVE_ONLY'"), { code: '55P03' });
    await assert.rejects(writer.query("INSERT INTO safety_core(operational_mode,global_state) VALUES ('PAPER_TRADING','NORMAL')"), { code: '55P03' });
    await client.query('SELECT pg_advisory_unlock(1095915607, 20261028)');
    assert.equal((await pending).status, 200);
    await writer.query("UPDATE safety_core SET operational_mode='OBSERVE_ONLY'");
    assert.equal((await paperOrder(await freshTrader(client, 'after-posture-lock'))).status, 422);
  } finally {
    await client.query('SELECT pg_advisory_unlock(1095915607, 20261028)');
    if (pending) await pending;
    await client.query('DROP TRIGGER qa_pause_booking ON paper_orders; DROP FUNCTION qa_pause_booking();');
    await writer.end();
  }
});

for (const action of ['update', 'close']) test(`paper ${action} rolls back on audit failure, then works while entries are paused`, async () => {
  const trader = await freshTrader(client, `outcome-${action}`);
  const opened = await paperOrder(trader);
  assert.equal(opened.status, 200, JSON.stringify(opened));
  const order = opened.data.order;
  await client.query("UPDATE safety_core SET operational_mode='OBSERVE_ONLY'");
  const kind = action === 'update' ? 'PAPER_ORDER_UPDATED' : 'PAPER_ORDER_CLOSED';
  const run = () => action === 'update'
    ? trader.call('PATCH', `/paper/orders/${order.id}`, { stopLoss: order.entryPrice * 0.985 })
    : trader.call('POST', `/paper/orders/${order.id}/close`, {});
  await client.query(`CREATE FUNCTION qa_outcome_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='${kind}' THEN RAISE EXCEPTION 'qa injected outcome audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER qa_outcome_fault BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION qa_outcome_fault();`);
  try {
    assert.equal((await run()).status, 500);
    const { rows: [unchanged] } = await client.query('SELECT * FROM paper_orders WHERE id=$1', [order.id]);
    assert.equal(unchanged.status, 'OPEN');
    assert.equal(unchanged.stop_loss, order.stopLoss);
  } finally { await client.query('DROP TRIGGER qa_outcome_fault ON audit_events; DROP FUNCTION qa_outcome_fault();'); }
  assert.equal((await run()).status, 200, 'protective action still uses its own gates while new entries are paused');
  const { rows } = await client.query("SELECT * FROM audit_events WHERE event_type=$1 AND payload->>'linkedTradeId'=$2", [kind, String(order.id)]);
  assert.equal(rows.length, 1);
});

test('a manual paper request carrying an AI decision cannot bypass the pending-policy hold', async () => {
  const trader = await freshTrader(client, 'decision-provenance');
  const { simulatorPrice } = await import('./support/governed.mjs');
  const px = await simulatorPrice(trader, 'EURUSD');
  const result = await trader.call('POST', '/paper/orders', { paperAccountId: trader.accountId, symbol: 'EURUSD', direction: 'BUY', lotSize: 0.01, stopLoss: px * 0.97, takeProfit: px * 1.06, decisionId: 1 });
  assert.equal(result.status, 422);
  assert.match(result.data.error, /AI_ENTRY_POLICY_PENDING/);
  assert.deepEqual(await paperOrdersOf(client, trader.id), []);
});

test('keyed concurrent paper retries commit one order and one outcome trail', async () => {
  const trader = await freshTrader(client, 'keyed-retry');
  const { spawnSync } = await import('node:child_process');
  // Exercise the existing internal keyed contract used by Trade Action Center.
  // The child inherits this lane's disposable DB and network-blocking preload.
  const run = spawnSync(process.execPath, ['--import','tsx','tests/support/keyed-paper-retry.mts', String(trader.id), String(trader.accountId)], { encoding:'utf8', timeout:30000 });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /KEYED_RETRY_ASSERTIONS_PASSED/);
  const orders = await paperOrdersOf(client, trader.id);
  assert.equal(orders.length, 1);
  const { rows: [counts] } = await client.query("SELECT (SELECT count(*) FROM paper_trade_events WHERE paper_order_id=$1) AS events, (SELECT count(*) FROM vault_events WHERE kind='PAPER_ORDER_PLACED' AND linked_trade_id=$2) AS vault, (SELECT count(*) FROM audit_events WHERE event_type='PAPER_ORDER_PLACED' AND payload->>'linkedTradeId'=$2) AS audit",[orders[0].id,String(orders[0].id)]);
  assert.deepEqual(counts, { events:'1', vault:'1', audit:'1' });
});

test('concurrent governed bookings and their decisions preserve the audit chain', async () => {
  const traders = await Promise.all(Array.from({length:6}, (_, i) => freshTrader(client, `audit-race-${i}`)));
  const { rows: [before] } = await client.query('SELECT id, event_id FROM audit_events ORDER BY id DESC LIMIT 1');
  const results = await Promise.all(traders.map(t => paperOrder(t)));
  assert.ok(results.every(r => r.status === 200), JSON.stringify(results));
  const { rows } = await client.query('SELECT event_id,previous_event_id FROM audit_events WHERE id>$1 ORDER BY id', [before.id]);
  let previous = before.event_id;
  for (const row of rows) { assert.equal(row.previous_event_id, previous); previous = row.event_id; }
  assert.ok(rows.length >= traders.length*2);
});

test('global evidence is operator-only; traders retain only their own risk-event view', async () => {
  const owner = await freshTrader(client, 'evidence-owner');
  const other = await freshTrader(client, 'evidence-other');
  const booked = await paperOrder(owner);
  assert.equal(booked.status, 200);
  const orderId = String(booked.data.order.id);
  const { rows: [event] } = await client.query("SELECT event_id FROM audit_events WHERE event_type='PAPER_ORDER_PLACED' AND payload->>'linkedTradeId'=$1", [orderId]);
  assert.ok(event);
  const routes = [
    '/audit/events', '/audit/health', '/audit/integrity', '/audit/snapshot',
    `/audit/replay/${event.event_id}`, '/audit/retention', '/system/vault', '/system/vault/integrity',
  ];
  for (const path of routes) {
    assert.equal((await call(DIRECT, 'GET', path)).status, 401, `unauthenticated ${path}`);
    for (const trader of [owner, other]) {
      const result = await trader.call('GET', path);
      assert.equal(result.status, 403, `${trader.id}: ${path}`);
      assert.deepEqual(result.data, { error: 'FORBIDDEN', message: 'Operator access required.' });
    }
  }
  for (const path of ['/audit/correction', '/audit/_debug/capture', '/audit/_debug/force-fail'])
    assert.equal((await other.call('POST', path, {})).status, 403, path);
  const operator = await call(BASE, 'GET', `/system/vault?linkedTradeId=${orderId}`);
  assert.equal(operator.status, 200);
  assert.ok(operator.data.events.some(e => e.kind === 'PAPER_ORDER_PLACED' && e.payload.userId === owner.id));
  const audit = await call(BASE, 'GET', `/audit/events?tradeId=${orderId}`);
  assert.equal(audit.status, 200);
  assert.ok(audit.data.events.some(e => e.eventType === 'PAPER_ORDER_PLACED' && e.payload.userId === owner.id));
  const own = await owner.call('GET', '/me/risk/events');
  assert.equal(own.status, 200);
  assert.ok(own.data.events.length > 0);
  const otherRisk = await other.call('GET', '/me/risk/events');
  assert.equal(otherRisk.status, 200);
  assert.equal(otherRisk.data.events.length, 0);
});
