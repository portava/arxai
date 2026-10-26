import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProductionEnvironment } from './check-arx-production-env.mjs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const valid = () => ({ NODE_ENV: 'production', ALLOW_DEV_AUTH: 'false', ARX_LIVE_BROKER_EXECUTION_ENABLED: 'false',
  ARX_BETA_INVITE_REQUIRED: 'true', SESSION_SECRET: 'test-only-session-secret',
  REGISTRATION_KEY_PEPPER: 'test-only-pepper', PORT: '8080',
  DATABASE_URL: 'postgresql://fixture@127.0.0.1:55449/rehearsal', APP_BASE_URL: 'https://arx.example.invalid' });

test('accepts a configured initial launch without arming live', () => {
  assert.equal(checkProductionEnvironment(valid()).ok, true);
});
test('refuses absent or whitespace secrets without exposing supplied values', () => {
  for (const key of ['SESSION_SECRET', 'REGISTRATION_KEY_PEPPER', 'DATABASE_URL']) {
    for (const value of ['', '   ']) assert.equal(checkProductionEnvironment({ ...valid(), [key]: value }).ok, false);
  }
  const secret = 'never-print-this-sensitive-value';
  assert.equal(JSON.stringify(checkProductionEnvironment({ ...valid(), SESSION_SECRET: secret })).includes(secret), false);
});
test('rejects development mode, live arming, and public registration', () => {
  for (const [key, value] of [['ALLOW_DEV_AUTH','true'],['NODE_ENV','development'],['ARX_LIVE_BROKER_EXECUTION_ENABLED','true'],['ARX_BETA_INVITE_REQUIRED','false']]) {
    assert.equal(checkProductionEnvironment({ ...valid(), [key]:value }).ok, false);
  }
});
test('rejects malformed ports and database schemes', () => {
  for (const port of ['0','-1','65536','8080oops','1.5','Infinity']) assert.equal(checkProductionEnvironment({ ...valid(), PORT:port }).ok, false);
  for (const url of ['file:///tmp/db','https://db.example','not-a-url','postgres:///database','postgres://host']) assert.equal(checkProductionEnvironment({ ...valid(), DATABASE_URL:url }).ok, false);
});
test('requires an HTTPS origin without credentials, path, query, or fragment', () => {
  for (const url of ['http://arx.example','https://localhost','https://127.0.0.1','https://[::1]','https://a:b@arx.example','https://arx.example/login','https://arx.example/?token=x','https://arx.example/#x','https://preview.replit.dev','https://app.localhost']) {
    assert.equal(checkProductionEnvironment({ ...valid(), APP_BASE_URL:url }).ok, false);
  }
});
test('reset-link origin must agree with the selected production origin', () => {
  assert.equal(checkProductionEnvironment({ ...valid(), APP_PUBLIC_ORIGIN: 'https://arx.example.invalid/' }).ok, true);
  for (const origin of ['https://other.example', 'https://arx.example.invalid/reset', 'https://user:password@arx.example.invalid', 'https://arx.example.invalid/?key=secret']) {
    assert.equal(checkProductionEnvironment({ ...valid(), APP_PUBLIC_ORIGIN: origin }).ok, false);
  }
});

test('launcher forces safe launch flags and removes inherited broker/bootstrap credentials', () => {
  const folder = mkdtempSync(join(tmpdir(), 'arx-launcher-'));
  try {
    const scripts = join(folder, 'scripts', 'release'); mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'run-arx-production.sh'), readFileSync(fileURLToPath(new URL('./run-arx-production.sh', import.meta.url))));
    writeFileSync(join(scripts, 'check-arx-production-env.mjs'), `
      const forbidden = ['MT5_BRIDGE_TOKEN','DERIV_API_TOKEN','ARX_ADMIN_INITIAL_PASSWORD','ARX_OWNER_EMAIL','OWNER_RESET_PASSWORD','VAULT_OVERRIDE_TOKEN'];
      if (forbidden.some(k => process.env[k] !== undefined)) process.exit(3);
      if (process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEV_AUTH !== 'false'
        || process.env.ARX_LIVE_BROKER_EXECUTION_ENABLED !== 'false' || process.env.ARX_BETA_INVITE_REQUIRED !== 'true') process.exit(4);
      process.stdout.write('SAFE\\n');
    `);
    const env = { PATH: process.env.PATH, ...valid(), NODE_ENV: 'development', ALLOW_DEV_AUTH: 'true',
      ARX_LIVE_BROKER_EXECUTION_ENABLED: 'true', ARX_BETA_INVITE_REQUIRED: 'false',
      MT5_BRIDGE_TOKEN: 'fake-test', DERIV_API_TOKEN: 'fake-test', ARX_ADMIN_INITIAL_PASSWORD: 'fake-test',
      ARX_OWNER_EMAIL: 'fake@example.test', OWNER_RESET_PASSWORD: 'fake-test', VAULT_OVERRIDE_TOKEN: 'fake-test' };
    const result = spawnSync('bash', [join(scripts, 'run-arx-production.sh'), '--check'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'SAFE\n');
    const missing = spawnSync('bash', [join(scripts, 'run-arx-production.sh')], { env, encoding: 'utf8' });
    assert.equal(missing.status, 2); assert.match(missing.stderr, /Build the ARX API/);
    mkdirSync(join(folder, 'artifacts/api-server/dist'), { recursive:true });
    writeFileSync(join(folder, 'artifacts/api-server/dist/index.mjs'), `if (process.env.ARX_SERVE_DASHBOARD !== 'true') process.exit(4); console.log('BUILT_APP_STARTED');`);
    const noDashboard = spawnSync('bash', [join(scripts, 'run-arx-production.sh')], { env, encoding:'utf8' });
    assert.equal(noDashboard.status,2); assert.match(noDashboard.stderr,/Build the ARX dashboard/);
    mkdirSync(join(folder, 'artifacts/trading-dashboard/dist/public'), { recursive:true });
    writeFileSync(join(folder, 'artifacts/trading-dashboard/dist/public/index.html'), '<title>fixture</title>');
    const complete = spawnSync('bash', [join(scripts, 'run-arx-production.sh')], { env, encoding:'utf8' });
    assert.equal(complete.status,0,complete.stderr); assert.match(complete.stdout,/BUILT_APP_STARTED/);

    const bad = spawnSync('bash', [join(scripts, 'run-arx-production.sh'), '--enable-live'], { env, encoding: 'utf8' });
    assert.equal(bad.status, 2); assert.match(bad.stderr, /Usage/); assert.equal(bad.stdout, '');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
