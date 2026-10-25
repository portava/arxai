// Presence/shape checks only. Never print credential values or connection URLs.
export function checkProductionEnvironment(env) {
  const checks = [];
  const add = (name, ok) => checks.push({ name, ok: Boolean(ok) });
  add('production runtime', env.NODE_ENV === 'production');
  add('live execution disabled', env.ARX_LIVE_BROKER_EXECUTION_ENABLED === 'false');
  add('development auth disabled', env.ALLOW_DEV_AUTH === 'false');
  add('invite-only registration', env.ARX_BETA_INVITE_REQUIRED === 'true');
  add('session secret configured', (env.SESSION_SECRET ?? '').trim().length >= 16);
  add('registration pepper configured', Boolean((env.REGISTRATION_KEY_PEPPER ?? '').trim()));
  const port = Number(env.PORT);
  add('valid listening port', /^\d+$/.test(env.PORT ?? '') && Number.isInteger(port) && port >= 1 && port <= 65535);
  let database = false;
  try { const u = new URL(env.DATABASE_URL); database = ['postgres:', 'postgresql:'].includes(u.protocol) && Boolean(u.hostname) && u.pathname.length > 1; } catch {}
  add('PostgreSQL connection configured', database);
  let origin = false;
  try {
    const u = new URL(env.APP_BASE_URL);
    origin = u.protocol === 'https:' && Boolean(u.hostname) && !u.username && !u.password
      && !u.search && !u.hash && u.pathname === '/'
      && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
      && !u.hostname.endsWith('.localhost') && !u.hostname.endsWith('.replit.dev');
    if (env.APP_PUBLIC_ORIGIN) {
      const reset = new URL(env.APP_PUBLIC_ORIGIN);
      origin = origin && reset.origin === u.origin && reset.pathname === '/' && !reset.search && !reset.hash && !reset.username && !reset.password;
    }
  } catch {}
  add('HTTPS public origin configured', origin);
  return { ok: checks.every(c => c.ok), checks };
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = checkProductionEnvironment(process.env);
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exitCode = report.ok ? 0 : 2;
}
