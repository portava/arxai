// CI-pinned proof that the wave-4 pre-gate caps (price collar, signal age,
// cluster exposure) are actually settable, and that the writer never lets a
// value exceed its hard ceiling — the enforcement built in waves 4-5 was
// inert without this: a cap that can never be set never blocks anything.
//
// Offline: source-scan only, no DB. Matches the dummy-DATABASE_URL pattern
// used across artifacts/api-server/src/lib/live/__qa__.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineSrc = readFileSync(path.join(here, "../liveCommandPipeline.ts"), "utf8");
const arminSrc = readFileSync(path.join(here, "../liveArming.ts"), "utf8");
const meLiveSrc = readFileSync(
  path.join(here, "../../../routes/meLive.ts"),
  "utf8",
);

test("hard ceilings are declared for all four wave-4 caps", () => {
  for (const name of [
    "ARX_LIVE_HARD_MAX_ENTRY_DEVIATION_BPS",
    "ARX_LIVE_HARD_MAX_SIGNAL_AGE_MS",
    "ARX_LIVE_HARD_MAX_CLUSTER_RISK_USD",
    "ARX_LIVE_HARD_MAX_CLUSTER_POSITIONS",
  ]) {
    assert.ok(arminSrc.includes(`export const ${name}`), `${name} must be declared in liveArming.ts`);
  }
});

test("updateUserSettings accepts all four caps and clamps every one against its hard ceiling", () => {
  const fnStart = pipelineSrc.indexOf("export async function updateUserSettings");
  assert.ok(fnStart > -1, "updateUserSettings must exist");
  const fnBody = pipelineSrc.slice(fnStart, pipelineSrc.indexOf("\nexport ", fnStart + 10));

  for (const [field, ceiling] of [
    ["maxEntryDeviationBps", "ARX_LIVE_HARD_MAX_ENTRY_DEVIATION_BPS"],
    ["maxSignalAgeMs", "ARX_LIVE_HARD_MAX_SIGNAL_AGE_MS"],
    ["maxClusterRiskUsd", "ARX_LIVE_HARD_MAX_CLUSTER_RISK_USD"],
    ["maxClusterPositions", "ARX_LIVE_HARD_MAX_CLUSTER_POSITIONS"],
  ] as const) {
    assert.ok(fnBody.includes(`args.${field}`), `updateUserSettings must read args.${field}`);
    assert.ok(fnBody.includes(ceiling), `${field} must be clamped against ${ceiling}`);
  }
  // The clamp helper must reject non-positive/garbage rather than store it —
  // never fabricate a cap value.
  assert.match(fnBody, /!Number\.isFinite\(value\)\s*\|\|\s*value\s*<=\s*0/);
});

test("PUT /me/live/settings exposes all four caps and the GET response reports the hard ceilings", () => {
  assert.match(meLiveSrc, /router\.put\("\/me\/live\/settings"/);
  for (const field of [
    "maxEntryDeviationBps",
    "maxSignalAgeMs",
    "maxClusterRiskUsd",
    "maxClusterPositions",
  ]) {
    assert.ok(meLiveSrc.includes(`capField("${field}")`), `PUT handler must thread ${field} through capField()`);
  }
  assert.ok(meLiveSrc.includes("hardCaps:"), "GET/PUT responses must report the hard ceilings so the UI can render bounds");
});

test("requireStopLoss remains excluded from user-settable fields (unchanged safety invariant)", () => {
  const fnStart = pipelineSrc.indexOf("export async function updateUserSettings");
  const fnBody = pipelineSrc.slice(fnStart, pipelineSrc.indexOf("\nexport ", fnStart + 10));
  assert.ok(fnBody.includes("args.requireStopLoss"));
  // The PUT route must never read requireStopLoss out of the request body.
  const putStart = meLiveSrc.indexOf('router.put("/me/live/settings"');
  const putBody = meLiveSrc.slice(putStart, meLiveSrc.indexOf("\nrouter.", putStart + 10));
  assert.ok(!putBody.includes("b.requireStopLoss"), "requireStopLoss must stay non-user-mutable");
});
