// Execute the authenticated status handler's actual source with inert dependencies.
// No running server/database/terminal; receipt validity is tested by the existing reader suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { GetMt5StatusResponse } from '@workspace/api-zod';
const source = readFileSync(new URL('../mt5.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('mt5.ts', source, ts.ScriptTarget.Latest, true);
const call = tree.statements.map(n => ts.isExpressionStatement(n) ? n.expression : null).find(n =>
  n && ts.isCallExpression(n) && n.expression.getText(tree) === 'router.get' && n.arguments[0]?.getText(tree) === '"/mt5/status"');
assert.ok(call && ts.isCallExpression(call));
assert.equal(call.arguments[1]?.getText(tree), 'requireUser');
const code = ts.transpileModule('const handler=' + call.arguments.at(-1)!.getText(tree), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const now = Date.parse('2026-11-01T12:00:00Z');
const connection = (extra = {}) => ({ id: 11, userId: 23, lastHeartbeat: new Date(now - 1000), accountNumber: '12345678',
  brokerName: 'Fixture', serverName: 'Fixture server', accountCurrency: 'KWD', accountBalance: 900, accountEquity: 800,
  freeMargin: 700, margin: 100, mode: 'LIVE', ...extra });
const report = { status: 'reported', currentVerified: false, reason: 'CLOCK_AND_CONTINUITY_UNVERIFIED',
  observedAt: new Date(now - 2000).toISOString(), receivedAt: new Date(now - 1000).toISOString(), currency: 'KWD', currencyDigits: 3,
  amounts: { balance: '9007199254740993.123', equity: '0.000', profit: '-7.125', credit: '4.000', margin: '0.000', freeMargin: '0.000' } };
async function run(conn: ReturnType<typeof connection> | null, value: unknown = report, fail = false) {
  const selected: number[] = [], reads: unknown[] = []; let output: any;
  const query: any = { from: () => query, where: () => query, groupBy: async () => [] };
  const deps = { getUserActiveConnection: async (id: number) => { selected.push(id); return conn; },
    loadNativeAccountReport: async (c: unknown) => { reads.push(c); if (fail) throw new Error('receipt unavailable'); return value; },
    db: { select: () => query }, sql: () => null, eq: () => null, mt5CommandsTable: {},
    isHeartbeatAgeMsFresh: (age: number | null) => age != null && age >= 0 && age < 30000,
    Date: class extends Date { static now() { return now; } },
    process: { env: {} },
  };
  const handler = new Function(...Object.keys(deps), code + ';return handler;')(...Object.values(deps));
  await handler({ authUser: { id: 23, role: 'user' }, query: { userId: 99, connectionId: 99 }, body: { connectionId: 99 } },
    { json: (v: unknown) => { output = v; } });
  return { output, selected, reads };
}
test('ordinary user reads only their selected connection and exact native decimal report', async () => {
  const conn = connection(); const r = await run(conn);
  assert.deepEqual(r.selected, [23]); assert.deepEqual(r.reads, [conn]); assert.strictEqual(r.output.nativeAccountReport, report);
  assert.equal(r.output.liveLocked, true); assert.equal(r.output.liveExecutionEnabled, false);
});
test('missing connection never reads a master or any account report', async () => {
  const r = await run(null); assert.deepEqual(r.reads, []); assert.equal(r.output.nativeAccountReport, null); assert.equal(r.output.accountSnapshot, null);
});
test('unexpected cross-user connection is withheld before native receipt access', async () => {
  const r = await run(connection({ userId: 99 })); assert.deepEqual(r.reads, []); assert.equal(r.output.nativeAccountReport, null); assert.equal(r.output.accountSnapshot, null);
});
test('fresh heartbeat cannot replace a rejected native report with stored money', async () => {
  const unavailable = { status: 'unavailable', reason: 'ACCOUNT_REPORT_REJECTED', currentVerified: false, amounts: null };
  const r = await run(connection(), unavailable); assert.strictEqual(r.output.nativeAccountReport, unavailable); assert.equal(r.output.connected, true);
});
test('stale or absent heartbeat does not manufacture current money or discard separately qualified historical report', async () => {
  for (const lastHeartbeat of [new Date(now - 180000), null]) {
    const r = await run(connection({ lastHeartbeat })); assert.strictEqual(r.output.nativeAccountReport, report); assert.equal(r.output.connected, false);
  }
});
test('receipt reader failure fails the request instead of substituting legacy money', async () => {
  await assert.rejects(run(connection(), report, true), /receipt unavailable/);
});

test('generated status contract retains exact report text and accepts legacy omission', async () => {
  const r = await run(connection());
  const parsed = GetMt5StatusResponse.parse(r.output);
  assert.deepEqual(parsed.nativeAccountReport, report);
  assert.equal(GetMt5StatusResponse.parse({ ...r.output, nativeAccountReport: null }).nativeAccountReport, null);
  const { nativeAccountReport, ...legacy } = r.output;
  assert.equal(GetMt5StatusResponse.parse(legacy).nativeAccountReport, undefined);
  assert.equal(GetMt5StatusResponse.safeParse({ ...r.output, nativeAccountReport: { ...report, currentVerified: true } }).success, false);
  assert.equal(GetMt5StatusResponse.safeParse({ ...r.output, nativeAccountReport: { ...report, amounts: { ...report.amounts, equity: 0 } } }).success, false);
});

test('status contract accepts actual no-connection and stale responses without claiming current money', async () => {
  const absent = GetMt5StatusResponse.parse((await run(null)).output);
  assert.equal(absent.mode, 'NOT_CONNECTED'); assert.equal(absent.accountType, 'NONE');
  assert.equal(absent.accountSnapshot, null); assert.equal(absent.nativeAccountReport, null);
  const stale = GetMt5StatusResponse.parse((await run(connection({ lastHeartbeat: new Date(now - 180000) }))).output);
  assert.equal(stale.mode, 'STALE'); assert.equal(stale.connected, false); assert.deepEqual(stale.nativeAccountReport, report);
});
