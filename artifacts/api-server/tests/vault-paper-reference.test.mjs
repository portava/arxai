// Run only through test:isolated-server-lane. These direct rows are fixtures
// in that lane's disposable database, never simulated or broker execution.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { BASE, call, freshTrader } from './support/governed.mjs';

let client, owner, other;
const paperIds = [];
const legacyIds = [];
const vaultIds = [];
let nextId = 1900100000;

before(async () => {
  assert.ok(process.env.ISOLATED_API_DIRECT_URL, 'requires disposable isolated lane');
  client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  owner = await freshTrader(client, 'vault-reference-owner');
  other = await freshTrader(client, 'vault-reference-other');
});

after(async () => {
  if (!client) return;
  await client.query('DELETE FROM vault_events WHERE id=ANY($1::int[])', [vaultIds]);
  await client.query('DELETE FROM paper_orders WHERE id=ANY($1::int[])', [paperIds]);
  await client.query('DELETE FROM trades WHERE id=ANY($1::int[])', [legacyIds]);
  await client.end();
});

async function seedPaper(id, userId = owner.id) {
  await client.query(`INSERT INTO paper_orders(id,user_id,paper_account_id,symbol,direction,entry_price,stop_loss,take_profit)
    VALUES($1,$2,$3,'QA-PAPER-REF','BUY',1.1,1.09,1.12)`, [id, userId, owner.accountId]);
  paperIds.push(id);
}

async function seedLegacy(id) {
  await client.query(`INSERT INTO trades(id,user_id,symbol,direction,lot,entry_price,stop_loss,take_profit,strategy,confidence)
    VALUES($1,$2,'QA-LEGACY-REF','BUY',0.01,1.1,1.09,1.12,'fixture',0)`, [id, other.id]);
  legacyIds.push(id);
}

async function checkReference(id, payload) {
  const { rows: [row] } = await client.query(`INSERT INTO vault_events(kind,source,severity,truth_domain,summary,payload,linked_trade_id,generated_at_iso)
    VALUES('PAPER_ORDER_PLACED','EXECUTION','INFO','EXECUTION','QA typed reference',$1::jsonb,$2,$3) RETURNING id`,
    [JSON.stringify(payload), String(id), new Date().toISOString()]);
  vaultIds.push(row.id);
  const response = await call(BASE, 'GET', '/system/vault/integrity?limit=2000');
  assert.equal(response.status, 200, JSON.stringify(response));
  return response.data.flags.filter(flag => flag.recordRef === `vault:${row.id}` && flag.category === 'DANGLING_REPLAY');
}

test('a valid owned paper reference does not require a matching legacy trade', async () => {
  const id = ++nextId;
  await seedPaper(id);
  assert.deepEqual(await checkReference(id, { entityType: 'paper_order', userId: owner.id }), []);
});

test('an absent paper order is reported as missing', async () => {
  const flags = await checkReference(++nextId, { entityType: 'paper_order', userId: owner.id });
  assert.equal(flags.length, 1);
  assert.match(flags[0].description, /unknown paper order/);
});

test('a paper reference must match the recorded owner', async () => {
  const id = ++nextId;
  await seedPaper(id);
  const flags = await checkReference(id, { entityType: 'paper_order', userId: other.id });
  assert.equal(flags.length, 1);
  assert.match(flags[0].description, /differently owned paper order/);
});

test('a colliding legacy ID cannot validate an absent paper order', async () => {
  const id = ++nextId;
  await seedLegacy(id);
  const flags = await checkReference(id, { entityType: 'paper_order', userId: owner.id });
  assert.equal(flags.length, 1);
  assert.match(flags[0].description, /unknown paper order/);
});

test('a collision with a legacy trade does not replace a paper order owner check', async () => {
  const id = ++nextId;
  await seedPaper(id);
  await seedLegacy(id);
  assert.deepEqual(await checkReference(id, { entityType: 'paper_order', userId: owner.id }), []);
  assert.equal((await checkReference(id, { entityType: 'paper_order', userId: other.id })).length, 1);
});

test('an explicit ownerless paper row is valid but missing owner evidence is not', async () => {
  const id = ++nextId;
  await seedPaper(id, null);
  assert.deepEqual(await checkReference(id, { entityType: 'paper_order', userId: null }), []);
  assert.equal((await checkReference(id, { entityType: 'paper_order' })).length, 1);
});

test('an out-of-range paper reference is flagged without an SQL cast failure', async () => {
  const flags = await checkReference('999999999999999999999', { entityType: 'paper_order', userId: owner.id });
  assert.equal(flags.length, 1);
});

test('untyped legacy trade references continue to resolve in the legacy book', async () => {
  const id = ++nextId;
  await seedLegacy(id);
  assert.deepEqual(await checkReference(id, { userId: other.id }), []);
});
