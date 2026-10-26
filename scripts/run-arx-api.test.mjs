import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('preview passes only the approved admin bootstrap and keeps live access disabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arx-preview-launcher-'));
  const blocked = [
    'DERIV_API_TOKEN', 'DERIV_APP_ID', 'DERIV_ACCOUNT_ID', 'DERIV_API_MODE',
    'DERIV_ENABLED', 'DERIV_WS_URL', 'MT5_BRIDGE_TOKEN', 'MT5_ENVIRONMENT',
    'BROKER_PROVIDER', 'LIVE_TRADING_ALLOWED', 'ARX_DERIV_OWNER_USER_ID',
    'ARX_EXECUTION_TIER', 'ARX_OWNER_EMAIL', 'ARX_OWNER_INITIAL_PASSWORD',
    'OWNER_RESET_PASSWORD', 'NEW_ADMIN_PASSWORD', 'QA_OWNER_PASSWORD',
    'ARX_AUTH_TEST_PASSWORD', 'VAULT_OVERRIDE_TOKEN',
  ];
  try {
    // Intercept pnpm so this test never starts the API or touches the database.
    writeFileSync(join(dir, 'pnpm'), `#!/usr/bin/env bash
set -eu
[[ "$*" == "--filter @workspace/api-server run dev" ]]
[[ "$ARX_ADMIN_EMAIL" == "admin@example.invalid" ]]
[[ "$ARX_ADMIN_INITIAL_PASSWORD" == "synthetic-fixture-only" ]]
[[ "$ARX_LIVE_BROKER_EXECUTION_ENABLED" == "false" ]]
[[ "$ARX_DERIV_PUBLIC_DATA_ENABLED" == "true" ]]
for key in ${blocked.join(' ')}; do
  [[ ! -v "$key" ]]
done
printf '%s\\n' 'preview-launcher-contract-ok'
`, { mode: 0o700 });
    const result = spawnSync('/bin/bash', [resolve('scripts/run-arx-api.sh')], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:/bin:/usr/bin`,
        ARX_ADMIN_EMAIL: 'admin@example.invalid',
        ARX_ADMIN_INITIAL_PASSWORD: 'synthetic-fixture-only',
        ARX_LIVE_BROKER_EXECUTION_ENABLED: 'true',
        ...Object.fromEntries(blocked.map(key => [key, 'synthetic-blocked-fixture'])),
      },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), 'preview-launcher-contract-ok');
    assert.equal(result.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
