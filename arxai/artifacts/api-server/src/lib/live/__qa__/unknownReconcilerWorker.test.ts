// Pins the scheduled UNKNOWN reconciler: without it, reconcileUnknownCommands
// had zero production callers, LIVE_UNKNOWN commands never resolved, and the
// dispatch freshness gate could never leave default-OFF (Ruling 10).
//
// Offline: pure helper + source-scan. No DB, no timers left running.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
// Dynamic import AFTER the env assignment above: the worker transitively
// pulls @workspace/db, which throws at module init without DATABASE_URL.
// The pg Pool is lazy, so the dummy unroutable URL never opens a connection.
const { unknownReconcilerEnabled, UNKNOWN_RECONCILER_INTERVAL_MS } =
  await import("../unknownReconcilerWorker.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const workerSrc = readFileSync(path.join(here, "../unknownReconcilerWorker.ts"), "utf8");
const indexSrc = readFileSync(path.join(here, "../../../index.ts"), "utf8");

test("enabled by default — absent env must NOT silently disable recovery", () => {
  assert.equal(unknownReconcilerEnabled(undefined), true);
});

test("only explicit false-y values disable it", () => {
  for (const off of ["0", "false", "off", "no", "FALSE", " Off "]) {
    assert.equal(unknownReconcilerEnabled(off), false, `${off} should disable`);
  }
  for (const on of ["1", "true", "on", "yes", "", "anything"]) {
    assert.equal(unknownReconcilerEnabled(on), true, `${on} should stay enabled`);
  }
});

test("cadence stays well inside the freshness gate's 5-minute default max-age", () => {
  const FRESHNESS_DEFAULT_MAX_AGE_MS = 300_000;
  assert.ok(
    UNKNOWN_RECONCILER_INTERVAL_MS < FRESHNESS_DEFAULT_MAX_AGE_MS / 2,
    "a healthy reconciler must keep the freshness gate satisfied with margin",
  );
});

test("worker is non-overlapping, fail-soft, and unref'd", () => {
  assert.match(workerSrc, /if \(running\) return;/, "must not re-enter a still-running pass");
  assert.match(workerSrc, /\.catch\(/, "a failed pass must not throw out of the timer");
  assert.match(workerSrc, /\.finally\(\(\) => \{ running = false; \}\)/, "the running flag must always clear");
  assert.match(workerSrc, /\.unref\(\)/, "timer must never hold the process open");
});

test("the worker only calls the reconciler — it originates no state itself", () => {
  // Any direct DB/table write here would bypass the reconciler's
  // evidence-only resolution contract.
  assert.ok(!/\bdb\.(insert|update|delete)\b/.test(workerSrc), "worker must not write DB rows directly");
  assert.match(workerSrc, /reconcileUnknownCommands\(\)/);
});

test("disabling is logged loudly so a dead reconciler is never mistaken for a healthy one", () => {
  assert.match(workerSrc, /logger\.warn/);
  assert.match(workerSrc, /unknown_reconciler_DISABLED_by_env/);
});

test("the worker is actually started by the server", () => {
  assert.match(indexSrc, /import \{ startUnknownReconcilerWorker \}/);
  assert.match(indexSrc, /^\s*startUnknownReconcilerWorker\(\);/m);
});
