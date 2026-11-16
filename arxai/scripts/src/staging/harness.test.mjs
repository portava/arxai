import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanEnvironment, localAdminUrl } from './run.mjs';

test('staging child drops application credentials and inherited execution overrides', () => {
  const env = cleanEnvironment({ HOME: '/tmp', PATH: '/usr/bin', DATABASE_URL: 'postgresql://production/real', OPENAI_API_KEY: 'secret', MT5_BRIDGE_TOKEN: 'secret', NODE_OPTIONS: '--require=unsafe', ARX_LIVE_BROKER_EXECUTION_ENABLED: 'true' }, join(import.meta.dirname, 'offline.mjs'));
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.MT5_BRIDGE_TOKEN, undefined);
  assert.equal(env.ARX_LIVE_BROKER_EXECUTION_ENABLED, 'false');
  assert.equal(env.ARX_PREVIEW_SAFE_START, 'true');
  assert.equal(env.ARX_DEMO_EXPIRY_SWEEP_ENABLED, 'false');
  assert.equal(env.ALLOW_DEV_AUTH, 'false');
  assert.ok(!env.NODE_OPTIONS.includes('unsafe'));
});
test('an optional audit cluster must be local and cannot carry a password', () => {
  assert.equal(localAdminUrl('postgresql://qa@localhost/postgres?host=%2Ftmp%2Fqa').searchParams.get('host'), '/tmp/qa');
  for (const url of ['postgresql://qa@prod.example/postgres', 'postgresql://qa:secret@localhost/postgres', 'postgresql://qa@localhost/postgres?host=prod.example', 'https://localhost/postgres', 'postgresql://qa@localhost/postgres?hostaddr=203.0.113.1', 'postgresql://qa@localhost/postgres?host=%2Ftmp&host=remote.example', 'postgresql://qa@localhost/postgres?host=%2Ftmp,remote.example']) assert.throws(() => localAdminUrl(url));
});
test('outbound denial blocks public fetch and sockets while real loopback HTTP works', () => {
  const result = spawnSync(process.execPath, ['--import', join(import.meta.dirname, 'offline.mjs'), '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    import http from 'node:http';
    await assert.rejects(fetch('https://example.com'), /blocked/);
    assert.throws(() => net.connect({ host: 'example.com', port: 443 }), /blocked/);
    const server = http.createServer((_req, res) => res.end('local proof'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    assert.equal(await (await fetch('http://127.0.0.1:' + server.address().port)).text(), 'local proof');
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
});
