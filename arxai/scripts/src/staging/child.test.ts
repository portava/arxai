import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runChild } from "./child.js";
const options = { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 5000 };
test("staging child preserves nonzero exits and full diagnostics", async () => {
  const result = await runChild(process.execPath, ["-e", "console.log('evidence'); console.error('failure'); process.exit(7)"], options);
  assert.equal(result.status, 7);
  assert.match(result.output, /evidence/); assert.match(result.output, /failure/);
  assert.equal(result.timedOut, false);
});
test("staging timeout kills stubborn descendants as well as their parent", async () => {
  const folder = mkdtempSync(join(tmpdir(), "arx-staging-child-"));
  try {
    const pidFile = join(folder, "pid");
    const program = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);`;
    const result = await runChild(process.execPath, ["-e", program, pidFile], { ...options, timeoutMs: 5000 });
    assert.equal(result.timedOut, true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    let alive = true;
    for (let i = 0; i < 50; i++) {
      try { process.kill(pid, 0); } catch { alive = false; break; }
      await delay(20);
    }
    assert.equal(alive, false, "no timed-out grandchild survives");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
test("staging output overflow fails instead of exhausting memory", async () => {
  const result = await runChild(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)"], { ...options, maxBytes: 100 });
  assert.equal(result.timedOut, true);
  assert.ok(result.output.length <= 100);
});
