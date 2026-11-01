// Execute the complete source aggregator with inert dependencies. No database,
// terminal or network access; this does not establish broker freshness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../meAccountShell.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('meAccountShell.ts', source, ts.ScriptTarget.Latest, true);
const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'computeAccountShell');
assert.ok(node);
const compiled = ts.transpileModule(node.getText(tree).replace(/^export\s+/, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

type Virtual = { virtualBalance: number; virtualEquity: number; virtualPnl?: number };
async function readShell(accounts: Virtual[], allocation?: Record<string, unknown>) {
  const tableNames = ['virtualTradingAccountsTable', 'sharedTradeAttributionTable',
    'userMasterLiveAccessTable', 'performanceDailyTable', 'paperTradesTable',
    'userTradingPermissionsTable', 'userSlotAllocationTable'];
  const tables = Object.fromEntries(tableNames.map(name => [name, { name, userId: name + '.userId' }]));
  const scopeReads: unknown[][] = [];
  const rows: Record<string, unknown[]> = {
    virtualTradingAccountsTable: accounts,
    userSlotAllocationTable: allocation ? [allocation] : [],
  };
  const db = { select: () => {
    let table = '';
    const query = {
      from: (t: { name: string }) => { table = t.name; return query; },
      where: (filter: unknown) => { scopeReads.push([table, filter]); return query; },
      limit: () => query,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows[table] ?? []).then(resolve),
    };
    return query;
  } };
  const deps = {
    ...tables, db, eq: (a: unknown, b: unknown) => [a, b], and: (...v: unknown[]) => v,
    isNull: (v: unknown) => [v, null],
    loadPlatformSettings: async () => ({ config: { accountRoutingMode: 'SHARED_MASTER_MT5' }, switches: { platformMode: 'OFF' } }),
    listUserConnections: async (id: number) => { assert.equal(id, 23); return []; },
    loadStoredLimitRows: async () => ({ userSettings: null }),
    effectiveLimitViews: () => ({ limits: { discipline: {}, maxRiskPerTradePercent: 1 }, views: {} }),
    getEffectiveTradingGovernance: async () => ({ isPrivileged: false, ownerLiveControlMode: false }),
    buildInvestorLiveBalanceSnapshot: async () => { throw new Error('skipInvestorSnapshot must avoid recursive live reader'); },
    toInvestorLiveBalanceWire: () => { throw new Error('unexpected live projection'); },
  };
  const compute = new Function(...Object.keys(deps), compiled + ';return computeAccountShell;')(...Object.values(deps));
  const result = await compute(23, { skipInvestorSnapshot: true });
  for (const [table, filter] of scopeReads) assert.ok(JSON.stringify(filter).includes(JSON.stringify([table + '.userId', 23])));
  assert.equal(result.tradingMode, 'DISABLED');
  assert.equal(result.live.source, 'unknown');
  return result;
}

test('zero virtual equity remains zero despite a positive balance', async () => {
  const shell = await readShell([{ virtualBalance: 1000, virtualEquity: 0 }]);
  assert.equal(shell.allocation.currentBalance, 1000);
  assert.equal(shell.allocation.equity, 0);
});

test('offsetting virtual equity values preserve their zero sum', async () => {
  const shell = await readShell([{ virtualBalance: 600, virtualEquity: 50 }, { virtualBalance: 400, virtualEquity: -50 }]);
  assert.equal(shell.allocation.equity, 0);
});

test('negative and positive equity are preserved independently of balance', async () => {
  for (const equity of [-25, 750]) {
    const shell = await readShell([{ virtualBalance: 1000, virtualEquity: equity }]);
    assert.equal(shell.allocation.equity, equity);
  }
});

test('allocated ledger uses its existing principal and P/L calculation, not virtual equity', async () => {
  const shell = await readShell([{ virtualBalance: 9999, virtualEquity: 5555, virtualPnl: -25 }], { allocatedFunds: 1000, accountCurrency: 'EUR' });
  assert.equal(shell.allocation.currentBalance, 975);
  assert.equal(shell.allocation.equity, 975);
  assert.equal(shell.allocation.currency, 'EUR');
});

test('allocation depleted to zero remains zero', async () => {
  const shell = await readShell([{ virtualBalance: 9999, virtualEquity: 5555, virtualPnl: -1000 }], { allocatedFunds: 1000 });
  assert.equal(shell.allocation.currentBalance, 0);
  assert.equal(shell.allocation.equity, 0);
});
