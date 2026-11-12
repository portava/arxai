import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const preflightPath = new URL("./preflight-test-paths.mjs", import.meta.url);

test("preflight accepts explicitly named test files that exist", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "test-path-preflight-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "present.test.mjs"), "");

  const result = spawnSync(process.execPath, [preflightPath.pathname, "present.test.mjs"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("preflight rejects missing files and directories before tests can run", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "test-path-preflight-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "not-a-test-file"));

  const result = spawnSync(
    process.execPath,
    [preflightPath.pathname, "missing.test.mjs", "not-a-test-file"],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing explicitly named test file/);
  assert.match(result.stderr, /missing\.test\.mjs/);
  assert.match(result.stderr, /not-a-test-file/);
  assert.match(result.stderr, /stopped before Node's test runner/);
});

test("preflight rejects an empty explicit file list", () => {
  const result = spawnSync(process.execPath, [preflightPath.pathname], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /No explicitly named test paths/);
});
