import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const installStatus of [0, 1]) test(`post-merge never pushes schema (install status ${installStatus})`, () => {
  const root = mkdtempSync(join(tmpdir(), 'arx-post-merge-'));
  try {
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'scripts', 'post-merge.sh'), readFileSync(new URL('../post-merge.sh', import.meta.url)));
    const calls = join(root, 'calls');
    writeFileSync(join(root, 'bin', 'pnpm'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ARX_TEST_CALLS"\nexit "$ARX_TEST_INSTALL_STATUS"\n', { mode: 0o755 });
    const result = spawnSync('bash', [join(root, 'scripts', 'post-merge.sh')], {
      cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        ARX_TEST_CALLS: calls, ARX_TEST_INSTALL_STATUS: String(installStatus) },
    });
    assert.equal(result.status, installStatus);
    assert.equal(readFileSync(calls, 'utf8'), 'install --frozen-lockfile\n');
    assert.equal(result.stdout.includes('No database schema changes'), installStatus === 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
