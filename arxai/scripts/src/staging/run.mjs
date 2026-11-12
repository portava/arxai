// Disposable staging acceptance. No inherited application DB or credentials.
import { mkdtempSync, mkdirSync, readFileSync, existsSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';

export function cleanEnvironment(source, offlinePath) {
  return {
    HOME: source.HOME, PATH: source.PATH, LANG: 'C', LC_ALL: 'C', PGCONNECT_TIMEOUT: '5',
    NODE_ENV: 'development', ARX_PREVIEW_SAFE_START: 'true',
    ARX_LIVE_BROKER_EXECUTION_ENABLED: 'false', ALLOW_DEV_AUTH: 'false',
    ARX_DEMO_EXPIRY_SWEEP_ENABLED: 'false', ARX_ELEANOR_WATCH_SWEEPER_ENABLED: 'false',
    NODE_OPTIONS: `--import=${pathToFileURL(offlinePath).href}`,
    ...(source.NODE_PATH ? { NODE_PATH: source.NODE_PATH } : {}),
    ...(source.ESBUILD_BINARY_PATH ? { ESBUILD_BINARY_PATH: source.ESBUILD_BINARY_PATH } : {}),
  };
}
export function localAdminUrl(value) {
  const url = new URL(value);
  const socket = url.searchParams.get('host');
  if ([...url.searchParams.keys()].length !== new Set(url.searchParams.keys()).size || socket?.includes(',')) throw new Error('Multiple audit cluster targets are forbidden');
  const port = url.searchParams.get('port');
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw new Error('Invalid audit cluster port');
  if ([...url.searchParams.keys()].some(key => !['host', 'port'].includes(key))) throw new Error('Unsupported audit cluster connection override');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.password ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || (socket && !socket.startsWith('/'))) {
    throw new Error('ARX_STAGING_PG_URL must identify an explicit local audit cluster without a password');
  }
  return url;
}
export async function main() {
  if (process.env.NODE_ENV === 'production' || process.env.ARX_LIVE_BROKER_EXECUTION_ENABLED === 'true') throw new Error('Refusing staging QA in production or while live execution is enabled');
  const root = resolve(import.meta.dirname, '../../..');
  const folder = mkdtempSync(join(tmpdir(), 'arx-staging-'));
  const env = cleanEnvironment(process.env, join(import.meta.dirname, 'offline.mjs'));
  const tool = name => process.env.ARX_TEST_PG_BIN ? join(process.env.ARX_TEST_PG_BIN, name) : name;
  const database = `arx_staging_${randomBytes(8).toString('hex')}`;
  const socket = join(folder, 'socket'), data = join(folder, 'data');
  let started = false, created = false, server, admin, suiteChild, interrupted = false;
  const interrupt = () => { interrupted = true; suiteChild?.kill('SIGTERM'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const run = (cmd, args, extra = {}) => execFileSync(cmd, args, { cwd: root, env, stdio: 'pipe', timeout: 120_000, ...extra });
  try {
    if (process.env.ARX_STAGING_PG_URL) admin = localAdminUrl(process.env.ARX_STAGING_PG_URL);
    else {
      mkdirSync(socket, { mode: 0o700 });
      run(tool('initdb'), ['-D', data, '-U', 'arx_qa', '--auth-local=trust', '--auth-host=reject', '--no-locale']);
      run(tool('pg_ctl'), ['-D', data, '-l', join(folder, 'postgres.log'), '-o', `-k ${socket} -p 55497 -h '' -c dynamic_shared_memory_type=mmap`, '-w', 'start']);
      started = true;
      admin = new URL(`postgresql://arx_qa@localhost/postgres?host=${encodeURIComponent(socket)}&port=55497`);
    }
    run(tool('psql'), [admin.href, '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${database}`]);
    created = true;
    const target = new URL(admin); target.pathname = `/${database}`;
    env.DATABASE_URL = target.href;
    env.ARX_STAGING_DISPOSABLE_DB = database;
    env.ARX_STAGING_LOG_DIR = join(folder, 'suites'); mkdirSync(env.ARX_STAGING_LOG_DIR);
    env.ARX_STAGING_READY_FILE = join(folder, 'ready');
    run('pnpm', ['--filter', '@workspace/db', 'run', 'push-force']);
    const fd = openSync(join(folder, 'server.log'), 'w', 0o600);
    server = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'server.ts')], { cwd: join(root, 'scripts'), env, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    const deadline = Date.now() + 180_000;
    while (!existsSync(env.ARX_STAGING_READY_FILE)) {
      if (interrupted || server.exitCode !== null || server.signalCode !== null || Date.now() > deadline) throw new Error(`Staging API failed to start; see ${join(folder, 'server.log')}`);
      await delay(100);
    }
    const base = readFileSync(env.ARX_STAGING_READY_FILE, 'utf8');
    for (const name of ['QA_API_BASE', 'QA_BASE_URL', 'QA_BASE', 'ARX_QA_BASE_URL', 'BRIDGE_TEST_BASE']) env[name] = base;
    console.log(`Disposable staging DB ${database}; paused API ${base}; logs ${folder}`);
    if (interrupted) throw new Error('Staging run interrupted');
    const status = await new Promise(resolveStatus => {
      suiteChild = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, '../qaStagingDryRun.ts')], { cwd: join(root, 'scripts'), env, stdio: 'inherit' });
      let force;
      const timeout = setTimeout(() => {
        suiteChild.kill('SIGTERM');
        force = setTimeout(() => suiteChild.kill('SIGKILL'), 5000);
      }, 30 * 60_000);
      suiteChild.once('error', error => { console.error(error.message); });
      suiteChild.once('close', code => { clearTimeout(timeout); clearTimeout(force); resolveStatus(code ?? 1); });
    });
    return interrupted ? 1 : status;
  } catch (error) {
    console.error(error.message);
    if (error.stderr) console.error(String(error.stderr));
    return 1;
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      for (let i = 0; i < 50 && server.exitCode === null && server.signalCode === null; i++) await delay(100);
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    }
    try {
      if (created) run(tool('psql'), [admin.href, '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE ${database} WITH (FORCE)`]);
    } finally {
      if (started) {
        run(tool('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
        rmSync(data, { recursive: true, force: true }); rmSync(socket, { recursive: true, force: true });
      }
    }
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    console.log(`Staging evidence retained at ${folder}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
