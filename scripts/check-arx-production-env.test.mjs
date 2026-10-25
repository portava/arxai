import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProductionEnvironment } from './check-arx-production-env.mjs';

const valid = () => ({ NODE_ENV: 'production', ARX_LIVE_BROKER_EXECUTION_ENABLED: 'false',
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
  for (const [key, value] of [['NODE_ENV','development'],['ARX_LIVE_BROKER_EXECUTION_ENABLED','true'],['ARX_BETA_INVITE_REQUIRED','false']]) {
    assert.equal(checkProductionEnvironment({ ...valid(), [key]:value }).ok, false);
  }
});
test('rejects malformed ports and database schemes', () => {
  for (const port of ['0','-1','65536','8080oops','1.5','Infinity']) assert.equal(checkProductionEnvironment({ ...valid(), PORT:port }).ok, false);
  for (const url of ['file:///tmp/db','https://db.example','not-a-url']) assert.equal(checkProductionEnvironment({ ...valid(), DATABASE_URL:url }).ok, false);
});
test('requires an HTTPS origin without credentials, path, query, or fragment', () => {
  for (const url of ['http://arx.example','https://localhost','https://127.0.0.1','https://[::1]','https://a:b@arx.example','https://arx.example/login','https://arx.example/?token=x','https://arx.example/#x']) {
    assert.equal(checkProductionEnvironment({ ...valid(), APP_BASE_URL:url }).ok, false);
  }
});
