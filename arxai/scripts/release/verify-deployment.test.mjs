import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDeployment } from './verify-deployment.mjs';

const revision = 'a'.repeat(40);
function fixture(change = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (change.throw) throw new Error('secret provider details');
    const path = url.pathname;
    const body = path === '/api/healthz' ? { status: 'ok', build: { revision, sourceState: 'clean', ...change.build } }
      : { status: change.readiness ?? 'ready' };
    return new Response(JSON.stringify(body), { status: path === '/api/me/system-health' ? (change.privateStatus ?? 401) : (change.status ?? 200),
      headers: { 'content-type': change.contentType ?? 'application/json', 'cache-control': change.cache ?? 'no-store' } });
  };
  return { calls, run: () => verifyDeployment({ origin: 'https://arx.example', revision, fetchImpl }) };
}
test('exact healthy release passes using only bounded anonymous GETs', async () => {
  const f = fixture(); assert.equal((await f.run()).ok, true);
  assert.deepEqual(f.calls.map(c => c.url.pathname), ['/api/healthz','/api/health/ready','/api/me/system-health']);
  for (const {options} of f.calls) {
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error'); assert(options.signal instanceof AbortSignal);
    assert.equal(options.headers.authorization, undefined);
  }
});
test('healthy wrong/unknown/modified source never passes', async () => {
  for (const build of [{revision:'b'.repeat(40)},{revision:null},{sourceState:'modified'},{sourceState:'unknown'}]) {
    assert.equal((await fixture({build}).run()).ok, false);
  }
});
test('unready, cached, HTML, failed HTTP and exposed private endpoint fail', async () => {
  for (const change of [{readiness:'unavailable'},{cache:'public, max-age=60'},{contentType:'text/html'},{status:503},{privateStatus:200}]) {
    assert.equal((await fixture(change).run()).ok, false);
  }
});
test('network failures are redacted and fail closed', async () => {
  const result = await fixture({throw:true}).run();
  assert.equal(result.ok,false); assert(!JSON.stringify(result).includes('secret provider'));
});
test('invalid origin and revision refuse before any network access', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw Error(); };
  for (const origin of ['http://arx.example','https://u:p@arx.example','https://arx.example/?token=x','https://arx.example/path']) {
    await assert.rejects(verifyDeployment({origin, revision, fetchImpl}));
  }
  await assert.rejects(verifyDeployment({origin:'https://arx.example',revision:'main',fetchImpl}));
  assert.equal(called,false);
});
