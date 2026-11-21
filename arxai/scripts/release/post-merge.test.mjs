import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const entry of ['scripts/post-merge.sh', 'arxai/scripts/post-merge.sh']) {
  for (const installStatus of [0, 1]) {
    test(`${entry} only installs ARX dependencies (install status ${installStatus})`, () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'arx-post-merge-')));
      try {
        for (const dir of ['scripts', 'arxai/scripts', 'bin']) mkdirSync(join(root, dir), { recursive: true });
        for (const path of ['scripts/post-merge.sh', 'arxai/scripts/post-merge.sh']) {
          copyFileSync(new URL('../../../' + path, import.meta.url), join(root, path));
        }
        const calls = join(root, 'calls');
        writeFileSync(join(root, 'bin/pnpm'), '#!/bin/sh\nprintf "%s|%s\\n" "$(pwd -P)" "$*" >> "$ARX_TEST_CALLS"\nexit "$ARX_TEST_INSTALL_STATUS"\n', { mode: 0o755 });
        const result = spawnSync('bash', [join(root, entry)], {
          cwd: tmpdir(), encoding: 'utf8',
          env: { PATH: `${root}/bin:${process.env.PATH}`, ARX_TEST_CALLS: calls, ARX_TEST_INSTALL_STATUS: String(installStatus) },
        });
        assert.equal(result.status, installStatus, result.stderr);
        assert.equal(readFileSync(calls, 'utf8'), `${root}/arxai|install --frozen-lockfile\n`);
        assert.equal(result.stdout.includes('No database schema changes'), installStatus === 0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
