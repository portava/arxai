// Reproducible selected Risk Governor/Trade Engine integration lane.
// Run from the repository root with:
// pnpm --filter @workspace/api-server run test:isolated-server-lane tests/support/risk-integration.test.mjs
// The outer runner owns the disposable DB, inert API and non-local network block.
// NODE_TEST_CONTEXT must be removed only for the child test runner; preserve
// NODE_OPTIONS so its external-network blocker remains active.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('selected governed integration suites on disposable PostgreSQL', () => {
  assert.ok(process.env.ISOLATED_API_DIRECT_URL);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--import','tsx','--experimental-test-module-mocks','--test','--test-concurrency=1','--test-force-exit',
    'src/lib/tradeEngine/__qa__/paperBook.test.ts',
    'src/lib/tradeEngine/__qa__/simulatedOpen.test.ts',
    'src/lib/riskGovernor/__qa__/paperBookFacts.test.ts',
    'src/routes/__qa__/riskGovernorAutomation.test.ts',
    'src/lib/riskGovernor/__qa__/preTradeRules.test.ts',
    'src/lib/riskGovernor/__qa__/brokerHeartbeat.test.ts',
    'src/lib/riskGovernor/__qa__/effectiveLimitViews.test.ts',
    'src/lib/riskGovernor/__qa__/journalGovernor.test.ts',
    'src/lib/riskGovernor/__qa__/perUserLimits.test.ts',
    'src/lib/riskGovernor/__qa__/rewardRiskAndDailyLimits.test.ts',
    'src/lib/riskGovernor/__qa__/tradingDiscipline.test.ts',
    'src/lib/tradeEngine/__qa__/pipeline.test.ts',
    'src/lib/tradeEngine/__qa__/stagedContract.test.ts',
    'src/routes/__qa__/riskGovernorPipelines.test.ts'],
    { env, encoding:'utf8', timeout:180000, maxBuffer:20*1024*1024 });
  process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
  assert.doesNotMatch(run.stderr ?? '', /recursively/);
  assert.match(run.stdout ?? '', /(?:#|ℹ) tests [1-9][0-9]+/);
  assert.equal(run.status, 0, String(run.error ?? 'selected suite failed'));
});
