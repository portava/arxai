import { pathToFileURL } from 'node:url';

/** Unauthenticated GETs only. A healthy but unidentified release does not pass. */
export async function verifyDeployment({ origin, revision, fetchImpl = fetch, timeoutMs = 10000 }) {
  const target = new URL(origin);
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || target.pathname !== '/') {
    throw new Error('Expected a credential-free HTTPS origin');
  }
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Expected a full source revision');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid request timeout');
  const checks = [];
  const add = (name, ok) => checks.push({ name, ok: Boolean(ok) });
  async function read(path, expectedStatus) {
    try {
      const response = await fetchImpl(new URL(path, target), {
        method: 'GET', redirect: 'error', credentials: 'omit',
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      add(path + ' HTTP status', response.status === expectedStatus);
      if (expectedStatus === 401) return null;
      add(path + ' no-store', /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? ''));
      const json = /application\/json/i.test(response.headers.get('content-type') ?? '');
      add(path + ' JSON response', json);
      if (!json) return null;
      return await response.json();
    } catch {
      // Do not echo provider error strings, bodies, headers or redirects.
      add(path + ' reachable and readable', false);
      return null;
    }
  }
  const health = await read('/api/healthz', 200);
  add('application liveness', health?.status === 'ok');
  add('exact deployed source revision', health?.build?.revision === revision);
  add('clean build source', health?.build?.sourceState === 'clean');
  const ready = await read('/api/health/ready', 200);
  add('database readiness', ready?.status === 'ready');
  await read('/api/me/system-health', 401);
  return { observedAt: new Date().toISOString(), origin: target.origin, expectedRevision: revision,
    ok: checks.every(c => c.ok), checks,
    scope: 'Read-only release identity, readiness and anonymous access checks; not broker or trading certification' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await verifyDeployment({ origin: process.argv[2], revision: process.argv[3] });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } catch {
    console.error('Usage: node scripts/release/verify-deployment.mjs https://app.example FULL_40_CHARACTER_REVISION');
    process.exitCode = 2;
  }
}
