import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { namedTestFiles, preflightNamedTests } from "./run-named-tests.mjs";

const launcher = new URL("./run-named-tests.mjs", import.meta.url).pathname;
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "arx-named-tests-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "present.test.mjs"), 'import {writeFileSync} from "node:fs";import {test} from "node:test";test("ran",()=>writeFileSync("ran", "yes"));');
  return cwd;
}
test("a missing test fails before even an existing test can run", t => {
  const cwd = fixture(t);
  const r = spawnSync(process.execPath, [launcher, "node", "--test", "present.test.mjs", "missing.test.mjs"], { cwd, encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /missing.test.mjs/); assert.equal(existsSync(join(cwd, "ran")), false);
});
test("a valid explicit inventory runs, and assertion failures propagate", t => {
  const cwd = fixture(t);
  const run = () => spawnSync(process.execPath, [launcher, "node", "--test", "present.test.mjs"], { cwd, encoding: "utf8" });
  assert.equal(run().status, 0); assert.equal(existsSync(join(cwd, "ran")), true);
  writeFileSync(join(cwd, "present.test.mjs"), 'import {test} from "node:test";test("fails",()=>{throw Error("regression")});');
  assert.equal(run().status, 1);
});
test("Vitest also refuses a partially absent inventory before launch", t => {
  const cwd = fixture(t);
  const r = spawnSync(process.execPath, [launcher, "vitest", "run", "present.test.mjs", "absent.test.tsx"], { cwd, encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /No tests were started/);
});
test("runner options are not counted as test files, including named patterns", () => {
  assert.deepEqual(namedTestFiles(["--import", "loader.ts", "--test-name-pattern", "fake.test.ts", "--test", "path with spaces/a.test.ts", "--test-reporter=tap"]), ["path with spaces/a.test.ts"]);
  assert.throws(() => preflightNamedTests(["--test"]), /No explicitly named/);
});
test("unexpanded globs and directories cannot satisfy the inventory", t => {
  const cwd = fixture(t);
  assert.throws(() => preflightNamedTests(["*.test.mjs"], cwd), /Missing named/);
  mkdirSync(join(cwd, "directory.test.mjs"));
  assert.throws(() => preflightNamedTests(["directory.test.mjs"], cwd), /Missing named/);
});
