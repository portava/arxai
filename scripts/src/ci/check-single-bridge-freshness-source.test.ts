// Negative fixtures for check-single-bridge-freshness-source. Pure, no IO.
import assert from "node:assert/strict";
import ts from "typescript";
import {
  ALLOW,
  AUTHORITY,
  POLICY,
  checkAuthorityShape,
  constantRef,
  isAgeIdentifier,
  isHeartbeatAgeIdentifier,
  isThresholdName,
  scanFile,
  scanSource,
  staleEntries,
} from "./check-single-bridge-freshness-source.js";

export {};

// ── threshold_const ──────────────────────────────────────────────────────────
// The pre-change declarations (round 3 survey) are each caught.
for (const src of [
  `const HEARTBEAT_DEGRADED_MS = 15_000;`,
  `const HEARTBEAT_FRESH_SECONDS = 15;`,
  `export const WATCHDOG_STALE_MAX_SECONDS = 60;`,
  `const MT5_ACCOUNT_SNAPSHOT_FRESH_MS = 60_000;`,
  `const POOL_SNAPSHOT_FRESH_BUDGET_MS = 60_000;`,
  `const HEARTBEAT_STALE_MS = 5 * 60 * 1000;`,
  `const HEARTBEAT_MAX_AGE_SEC = 15 as const;`,
  `function f() { const HEARTBEAT_STALE_MS = 15_000; return HEARTBEAT_STALE_MS; }`,
  `const r = { heartbeatStaleThresholdSec: 60 };`,
]) {
  const v = scanFile("routes/x.ts", src);
  assert.equal(v.length, 1, `expected one violation for: ${src}`);
  assert.match(v[0]!, /lib\/brokerHub\/freshness\.ts/);
}

// Importing a named threshold, or aliasing one, passes (as a declaration).
assert.deepEqual(scanFile("routes/x.ts", `import { MT5_HEARTBEAT_FRESH_BELOW_MS } from "../lib/brokerHub/freshness.js";\nconst HEARTBEAT_FRESH_MS = MT5_HEARTBEAT_FRESH_BELOW_MS;`), []);
assert.deepEqual(scanFile("routes/x.ts", `const r = { heartbeatStaleThresholdSec: MT5_HEARTBEAT_OFFLINE_AT_SECONDS };`), []);

// Cadences, counters and unrelated TTLs are not thresholds.
assert.deepEqual(scanFile("routes/x.ts", `const HEARTBEAT_INTERVAL_MS = 15_000;`), []);
assert.deepEqual(scanFile("routes/x.ts", `const counts = { STALE_HEARTBEAT: 0 };`), []);
assert.deepEqual(scanFile("routes/x.ts", `const SNAPSHOT_TTL_MS = 10_000;`), []);
assert.deepEqual(scanFile("routes/x.ts", `const MT5_FEED_FRESH_MS = 60_000;`), []);

// ── threshold_compare ───────────────────────────────────────────────────────
for (const src of [
  `const ok = hbAge !== null && hbAge <= 15;`,
  `const ok = ev.heartbeatAgeSec != null && ev.heartbeatAgeSec <= 15;`,
  `const c = !!lastHb && (Date.now() - lastHb.getTime() < 90_000);`,
  `const c = Date.now() - new Date(state.lastHeartbeatAt).getTime() < 30_000;`,
  `const f = snapshotAgeMs !== null && snapshotAgeMs < 60_000;`,
  `const f = brokerAgeMs <= 15_000;`,
  `if (15 >= hbAgeSec) x();`,
  // a local computed from a heartbeat is a heartbeat age, whatever its name
  `const age = r.lastHeartbeat ? now - r.lastHeartbeat.getTime() : null; const s = age < 15_000;`,
  `const ts = row.lastHeartbeat ? row.lastHeartbeat.getTime() : null; const ageSeconds = Math.round((Date.now() - ts) / 1000); const c = ageSeconds <= 60;`,
]) {
  assert.equal(scanFile("routes/x.ts", src).length, 1, `expected one violation for: ${src}`);
}

// 0 / 1 and non-heartbeat ages do not count.
assert.deepEqual(scanFile("routes/x.ts", `const ok = heartbeatAgeSec > 0;`), []);
assert.deepEqual(scanFile("routes/x.ts", `const ok = quoteAgeMs < 5_000;`), []);
assert.deepEqual(scanFile("routes/x.ts", `const age = trade.ageMinutes; const ok = age > 30;`), []);
// A same-named local in another scope that is NOT a heartbeat age is not tainted.
assert.deepEqual(
  scanFile("routes/x.ts", `function a(r) { const age = r.lastHeartbeat; return age; }\nfunction b() { let age = 0; return age >= 2; }`),
  [],
);
// A property named like a tainted local is not the local.
assert.deepEqual(scanFile("routes/x.ts", `const age = r.lastHeartbeat; const ok = m.age >= 2;`), []);
// Comments and strings never count.
assert.deepEqual(scanFile("routes/x.ts", `// hbAge <= 15 is the gate\nconst s = "HEARTBEAT_FRESH_MS = 15_000";`), []);

// ── threshold_bypass (round 5, owner decision 17) ───────────────────────────
// A heartbeat age compared with a NAMED constant (instead of the policy
// classifier) fails: the pre-change forms of the moved sites.
for (const src of [
  `const ok = hbAge !== null && hbAge <= EA_HEARTBEAT_FRESH_SECONDS;`,
  `const HEARTBEAT_FRESH_SECONDS = X; const ok = hbAge !== null && hbAge <= HEARTBEAT_FRESH_SECONDS;`,
  `if (hb == null || hb > LIVE_HEARTBEAT_MAX_AGE_SEC) fail();`,
  `const fresh = b?.heartbeatAgeSeconds != null && b.heartbeatAgeSeconds <= r.constants.LIVE_HEARTBEAT_MAX_AGE_SEC;`,
  `const ageSec = lastHb ? Math.floor((Date.now() - new Date(lastHb).getTime()) / 1000) : null; const f = ageSec !== null && ageSec < HEARTBEAT_THRESHOLD_MS / 1000;`,
  `const age = now - r.lastHeartbeat.getTime(); if (age > BROKER_HEARTBEAT_DEGRADED_MS) x();`,
  `const ageSec = heartbeatAgeSeconds(c.lastHeartbeat); const connected = ageSec != null && ageSec * 1000 <= BRIDGE_FRESH_MS;`,
  `const reconnect = previousHeartbeat == null || now.getTime() - previousHeartbeat.getTime() > RECONNECT_GAP_MS;`,
]) {
  const v = scanFile("routes/x.ts", src);
  assert.equal(v.length, 1, `expected one bypass violation for: ${src}`);
  assert.match(v[0]!, /heartbeatPolicy\.ts/);
}
// The classifier form passes; a snapshot age vs a named snapshot threshold is a
// different concept (not a heartbeat bypass); a lowercase local is not a constant;
// an object literal that merely carries a heartbeat field is not a heartbeat age.
assert.deepEqual(scanFile("routes/x.ts", `const ok = isHeartbeatAgeSecondsFresh(hbAge);`), []);
assert.deepEqual(scanFile("routes/x.ts", `const f = snapshotAgeMs !== null && snapshotAgeMs < MT5_ACCOUNT_SNAPSHOT_FRESH_MS;`), []);
assert.deepEqual(scanFile("routes/x.ts", `const age = now - r.lastHeartbeat.getTime(); if (latest == null || age < latest) latest = age;`), []);
assert.deepEqual(scanFile("routes/x.ts", `const diag = { lastAcceptedHeartbeatAt: null, recent: [] }; if (diag.recent.length > RECENT_OBS_MAX) x();`), []);
assert.deepEqual(scanFile("routes/x.ts", `if (hbAge < Number.MAX_SAFE_INTEGER) x();`), []);
assert.equal(constantRef(ts.factory.createIdentifier("MT5_HEARTBEAT_OFFLINE_AT_MS")), "MT5_HEARTBEAT_OFFLINE_AT_MS");
assert.equal(constantRef(ts.factory.createIdentifier("latest")), null);
assert.equal(isHeartbeatAgeIdentifier("snapshotAgeMs"), false);
assert.equal(isHeartbeatAgeIdentifier("hbAgeSec"), true);

// ── lib/domain and the dashboard are scanned too (repo-relative keys, TSX) ──
// Pre-change domain evaluator / Phase B gate and dashboard literals fail.
assert.equal(scanFile("lib/domain/src/broker-health/evaluator.ts", `const HEARTBEAT_DEGRADED_MS = 30_000;`).length, 1);
assert.equal(scanFile("lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts", `export const LIVE_HEARTBEAT_MAX_AGE_SEC = 15 as const;`).length, 1);
assert.equal(scanFile("lib/domain/src/signal-intelligence/x.ts", `if (execution.heartbeatAgeSeconds > 30) s -= 25;`).length, 1);
assert.equal(scanFile("artifacts/trading-dashboard/src/pages/my-mt5.tsx", `const heartbeatOk = conn.heartbeatAgeSeconds != null && conn.heartbeatAgeSeconds < 90;`).length, 1);
assert.equal(
  scanFile("artifacts/trading-dashboard/src/components/admin/cockpit/OverviewSection.tsx", `export const S = ({ d }) => <Stat tone={(d.bridge.heartbeatAgeSeconds ?? 999) <= 15 ? "success" : "warning"} />;`).length,
  1,
);
assert.deepEqual(
  scanFile("artifacts/trading-dashboard/src/components/admin/cockpit/OverviewSection.tsx", `export const S = ({ d }) => <Stat tone={isHeartbeatAgeSecondsFresh(d.bridge.heartbeatAgeSeconds) ? "success" : "warning"} />;`),
  [],
);

// ── authority, allowlist, staleness ─────────────────────────────────────────
// The authority and the shared policy may name literals.
assert.deepEqual(scanFile(AUTHORITY, `export const MT5_ACCOUNT_SNAPSHOT_FRESH_MS = 60_000;`), []);
assert.deepEqual(scanFile(POLICY, `export const MT5_HEARTBEAT_FRESH_BELOW_MS = 15_000; const x = ageMs < MT5_HEARTBEAT_FRESH_BELOW_MS;`), []);

// Allowlisted file: up to `count` hits pass; one more fails.
const [allowKey, allowEntry] = Object.entries(ALLOW)[0]!;
for (const [k, e] of Object.entries(ALLOW)) assert.ok(e.count >= 1 && e.why.length > 20, `${k}: every entry has a count and a reason`);
const one = `export const GUARDIAN_DEFAULTS = { maxSnapshotAgeMs: 2 * 60_000, fillGraceMs: 2 * 60_000 } as const;`;
assert.equal(scanSource(allowKey, one).length, 1);
assert.deepEqual(scanFile(allowKey, one), []);
const extra = scanFile(allowKey, `${one}\nconst HEARTBEAT_FRESH_MS = 15_000;`);
assert.ok(extra.length > 0 && /allows 1/.test(extra[0]!), "a new literal in an allowlisted file fails");

// Stale: file gone, or fewer hits than allowed.
assert.match(staleEntries(() => null)[0]!, /no longer exists/);
assert.match(staleEntries((k) => (k === allowKey ? `export const x = 1;` : null)).find((s) => s.startsWith(allowKey))!, /remove the entry/);
assert.deepEqual(staleEntries((k) => (k === allowKey ? one : null)).filter((s) => s.startsWith(allowKey)), []);

// The server authority must re-export the policy, keep its snapshot threshold
// and define no heartbeat threshold of its own; the policy keeps the owner's
// bounds, its classifiers and stays import-free.
const goodAuthority = `export { classifyHeartbeatAgeMs } from "@workspace/domain/broker-health/heartbeatPolicy";\nexport const MT5_ACCOUNT_SNAPSHOT_FRESH_MS = 60_000;`;
const goodPolicy = `export const MT5_HEARTBEAT_FRESH_BELOW_MS = 15_000;\nexport const MT5_HEARTBEAT_OFFLINE_AT_MS = 60_000;\nexport function classifyHeartbeatAgeMs(a) {}\nexport function classifyHeartbeatAgeSeconds(a) {}\nexport function heartbeatAllowsExecution(f) {}`;
assert.match(checkAuthorityShape(() => null)[0]!, /missing/);
assert.deepEqual(checkAuthorityShape(() => goodAuthority, () => goodPolicy), []);
assert.ok(checkAuthorityShape(() => goodAuthority, () => null).some((s) => /shared heartbeat policy/.test(s)));
assert.ok(checkAuthorityShape(() => `${goodAuthority}\nexport const EA_HEARTBEAT_FRESH_MS = 15_000;`, () => goodPolicy).some((s) => /defines its own heartbeat/.test(s)));
assert.ok(checkAuthorityShape(() => `export const MT5_ACCOUNT_SNAPSHOT_FRESH_MS = 60_000;`, () => goodPolicy).some((s) => /re-export/.test(s)));
assert.ok(checkAuthorityShape(() => goodAuthority, () => goodPolicy.replace("15_000", "20_000")).some((s) => /owner decision 17/.test(s)));
assert.ok(checkAuthorityShape(() => goodAuthority, () => goodPolicy.replace("60_000", "120_000")).some((s) => /owner decision 17/.test(s)));
assert.ok(checkAuthorityShape(() => goodAuthority, () => `import x from "y";\n${goodPolicy}`).some((s) => /pure/.test(s)));
assert.ok(checkAuthorityShape(() => goodAuthority, () => goodPolicy.replace("heartbeatAllowsExecution", "x")).some((s) => /heartbeatAllowsExecution/.test(s)));

// Name helpers.
assert.equal(isThresholdName("HEARTBEAT_FRESH_WINDOW_MS"), true);
assert.equal(isThresholdName("hbStaleSeconds"), true);
assert.equal(isThresholdName("HEARTBEAT_PERIOD_SECONDS"), false);
assert.equal(isAgeIdentifier("heartbeatAgeSeconds"), true);
assert.equal(isAgeIdentifier("lastHb"), true);
assert.equal(isAgeIdentifier("quoteAgeMs"), false);

// eslint-disable-next-line no-console
console.log("check-single-bridge-freshness-source fixtures: ok");
