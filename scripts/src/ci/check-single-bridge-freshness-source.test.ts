// Negative fixtures for check-single-bridge-freshness-source. Pure, no IO.
import assert from "node:assert/strict";
import {
  ALLOW,
  AUTHORITY,
  checkAuthorityShape,
  isAgeIdentifier,
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

// Importing a named threshold, or aliasing one, passes.
assert.deepEqual(scanFile("routes/x.ts", `import { EA_HEARTBEAT_FRESH_MS } from "../lib/brokerHub/freshness.js";\nconst HEARTBEAT_FRESH_MS = EA_HEARTBEAT_FRESH_MS;`), []);
assert.deepEqual(scanFile("routes/x.ts", `const r = { heartbeatStaleThresholdSec: EA_HEARTBEAT_STALE_SECONDS };`), []);

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

// Comparing with a named threshold passes; 0 / 1 and non-heartbeat ages do not count.
assert.deepEqual(scanFile("routes/x.ts", `const ok = hbAge !== null && hbAge <= EA_HEARTBEAT_FRESH_SECONDS;`), []);
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

// ── authority, allowlist, staleness ─────────────────────────────────────────
// The authority itself may name literals.
assert.deepEqual(scanFile(AUTHORITY, `export const EA_HEARTBEAT_FRESH_MS = 15_000;`), []);

// Allowlisted file: up to `count` hits pass; one more fails.
const [allowKey, allowEntry] = Object.entries(ALLOW)[0]!;
assert.ok(allowEntry.count >= 1 && allowEntry.why.length > 20, "every entry has a count and a reason");
const one = `export const GUARDIAN_DEFAULTS = { maxSnapshotAgeMs: 2 * 60_000, fillGraceMs: 2 * 60_000 } as const;`;
assert.equal(scanSource(allowKey, one).length, 1);
assert.deepEqual(scanFile(allowKey, one), []);
const extra = scanFile(allowKey, `${one}\nconst HEARTBEAT_FRESH_MS = 15_000;`);
assert.ok(extra.length > 0 && /allows 1/.test(extra[0]!), "a new literal in an allowlisted file fails");

// Stale: file gone, or fewer hits than allowed.
assert.match(staleEntries(() => null)[0]!, /no longer exists/);
assert.match(staleEntries((k) => (k === allowKey ? `export const x = 1;` : null)).find((s) => s.startsWith(allowKey))!, /remove the entry/);
assert.deepEqual(staleEntries((k) => (k === allowKey ? one : null)), []);

// The authority must keep its named thresholds and classifier.
assert.match(checkAuthorityShape(() => null)[0]!, /missing/);
assert.ok(checkAuthorityShape(() => `export const EA_HEARTBEAT_FRESH_MS = 1;`).some((s) => /EA_HEARTBEAT_STALE_MS/.test(s)));
assert.deepEqual(
  checkAuthorityShape(() => `export const EA_HEARTBEAT_FRESH_MS = 1;\nexport const EA_HEARTBEAT_STALE_MS = 2;\nexport const MT5_ACCOUNT_SNAPSHOT_FRESH_MS = 3;\nexport function classifyAge(a) {}`),
  [],
);

// Name helpers.
assert.equal(isThresholdName("HEARTBEAT_FRESH_WINDOW_MS"), true);
assert.equal(isThresholdName("hbStaleSeconds"), true);
assert.equal(isThresholdName("HEARTBEAT_PERIOD_SECONDS"), false);
assert.equal(isAgeIdentifier("heartbeatAgeSeconds"), true);
assert.equal(isAgeIdentifier("lastHb"), true);
assert.equal(isAgeIdentifier("quoteAgeMs"), false);

// eslint-disable-next-line no-console
console.log("check-single-bridge-freshness-source fixtures: ok");
