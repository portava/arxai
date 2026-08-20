// Regression suite for the provenance no-collapse CI guard (R4 slice 8)
// plus the R4 slice-7 entitlement-record row shaping.
//
// Proves with fixtures that:
//   1. The PRE-wave-3 pattern — a serving store keyed by bare
//      `${symbol}|${timeframe}` with no bridge identity — is classified
//      "bare" and FAILS the check when unallowlisted.
//   2. The wave-3 bridge-scoped store shape (nested per-bridge partition,
//      providers/mt5Provider.ts) is classified "bridge_partitioned" and
//      PASSES — both as a synthetic fixture and in situ via the real check.
//   3. Bridge-identity-in-key passes; sourceId/prose template literals and
//      comment-only occurrences never count; pins are a two-way ratchet
//      (count drift up OR down fails; stale pins fail).
//   4. `market_data_entitlements` rows shape correctly: column names, the
//      four recordable quality levels, and the NOT-NULL connectionScope
//      derivation that keeps the unique key hole-free.
//
// Pure logic — no DB, no network (the drizzle table object is inert schema
// metadata; nothing connects).
//
// Run: tsx ./src/ci/check-provenance-no-collapse.test.ts

import {
  analyzeSymbolTfKeys,
  hasBridgePartitionEvidence,
  checkProvenanceNoCollapse,
  ALLOWLIST,
} from "./check-provenance-no-collapse.js";
import {
  marketDataEntitlementsTable,
  entitlementScopeKey,
  MARKET_DATA_QUALITY_LEVELS,
  PROVIDER_LEVEL_SCOPE,
  type NewMarketDataEntitlement,
} from "../../../lib/db/src/schema/marketDataEntitlements.js";

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── 1. Analyzer fixtures ─────────────────────────────────────────────────────

// The PRE-wave-3 mt5Provider shape (audit §3.1): flat store, bare key.
const PRE_WAVE3_FIXTURE = `
interface CandleSeries { candles: unknown[]; updatedAt: number; }
const candleStore = new Map<string, CandleSeries>();
function seriesKey(symbol: string, timeframe: string): string {
  return \`\${symbol}|\${timeframe}\`;
}
export function updateCandlesFromMT5(symbol: string, candles: unknown[], timeframe: string) {
  candleStore.set(seriesKey(symbol, timeframe), { candles, updatedAt: Date.now() });
}
`;

// The wave-3 shape: same inner key, but applied inside a per-bridge partition.
const WAVE3_FIXTURE = `
interface CandleSeries { candles: unknown[]; updatedAt: number; bridgeConnectionId: number | null; }
const candleStore = new Map<string, Map<string, CandleSeries>>();
function bridgeKeyOf(bridgeConnectionId: number | null): string {
  return bridgeConnectionId != null ? String(bridgeConnectionId) : "unattributed";
}
function seriesKey(symbol: string, timeframe: string): string {
  return \`\${symbol}|\${timeframe}\`;
}
export function write(symbol: string, timeframe: string, bridgeConnectionId: number | null) {
  const partition = candleStore.get(bridgeKeyOf(bridgeConnectionId)) ?? new Map();
  partition.set(seriesKey(symbol, timeframe), { candles: [], updatedAt: 0, bridgeConnectionId });
}
`;

// Bridge identity carried IN the key itself.
const BRIDGE_IN_KEY_FIXTURE = `
const store = new Map<string, unknown>();
function key(bridgeConnectionId: number, symbol: string, timeframe: string) {
  return \`\${bridgeConnectionId}|\${symbol}|\${timeframe}\`;
}
`;

// sourceId-style colon identifier + prose — must produce ZERO hits.
const NON_KEY_FIXTURE = `
const sourceId = \`mt5_broker:\${symbol}:\${timeframe}\`;
const msg = \`No candles for \${symbol} \${timeframe}.\`;
`;

// Pattern present only inside comments — must produce ZERO hits.
const COMMENT_ONLY_FIXTURE = `
// Map key: \`\${symbol}|\${timeframe}\` → forming bar state.
/* legacy shape was \`\${symbol}|\${timeframe}\` before wave 3 */
const store = new Map<string, unknown>();
`;

{
  const hits = analyzeSymbolTfKeys(PRE_WAVE3_FIXTURE);
  record(
    "pre-wave-3 bare store fixture is classified bare",
    hits.length === 1 && hits[0].classification === "bare",
    `hits=${JSON.stringify(hits.map((h) => h.classification))}`,
  );
  record(
    "pre-wave-3 fixture has no partition evidence",
    !hasBridgePartitionEvidence(PRE_WAVE3_FIXTURE),
  );
}

{
  const hits = analyzeSymbolTfKeys(WAVE3_FIXTURE);
  record(
    "wave-3 bridge-partitioned fixture passes classification",
    hits.length === 1 && hits[0].classification === "bridge_partitioned",
    `hits=${JSON.stringify(hits.map((h) => h.classification))}`,
  );
  record(
    "wave-3 fixture shows partition evidence",
    hasBridgePartitionEvidence(WAVE3_FIXTURE),
  );
}

{
  const hits = analyzeSymbolTfKeys(BRIDGE_IN_KEY_FIXTURE);
  record(
    "bridge-identity-in-key fixture is classified bridge_keyed",
    hits.length === 1 && hits[0].classification === "bridge_keyed",
    `hits=${JSON.stringify(hits.map((h) => h.classification))}`,
  );
}

record(
  "sourceId/prose templates produce zero hits",
  analyzeSymbolTfKeys(NON_KEY_FIXTURE).length === 0,
);
record(
  "comment-only occurrences produce zero hits",
  analyzeSymbolTfKeys(COMMENT_ONLY_FIXTURE).length === 0,
);

// ── 2. End-to-end: the real check over the real tree ────────────────────────

{
  const r = checkProvenanceNoCollapse();
  record(
    "real lib/data tree passes (wave-3 store + verified allowlist, pins exact)",
    r.ok,
    r.ok ? `${r.notes?.length ?? 0} notes` : r.violations.join(" | "),
  );
}

// The RED direction, end to end: with an empty allowlist the repo's own bare
// display-cache keys become violations — proving the guard actually fails on
// unallowlisted bare keys (the pre-wave-3 pattern) rather than passing
// vacuously. Partitioned pins stay valid, so mt5Provider still passes.
{
  const r = checkProvenanceNoCollapse({ allowlist: [] });
  const flagsBare = r.violations.some((v) => v.includes("bare symbol|timeframe"));
  // A violation ABOUT mt5Provider starts with its path (the remediation text
  // of other files' violations also NAMES mt5Provider as the good example).
  const flagsMt5 = r.violations.some((v) =>
    v.startsWith("artifacts/api-server/src/lib/data/providers/mt5Provider.ts"),
  );
  record(
    "empty allowlist turns bare keys into violations (guard can fail RED)",
    !r.ok && flagsBare,
    `${r.violations.length} violation(s)`,
  );
  record(
    "wave-3 mt5Provider store still passes with the empty allowlist",
    !flagsMt5,
  );
}

// Ratchet both ways: a pin that undercounts (as if a new key were added) and
// a stale pin (file has no such keys) must both fail.
{
  const under = checkProvenanceNoCollapse({
    allowlist: ALLOWLIST.map((e) =>
      e.file.endsWith("chartIntelligence.ts") ? { ...e, count: e.count - 1 } : e,
    ),
  });
  record(
    "pin drift (count up vs pin) fails",
    !under.ok && under.violations.some((v) => v.includes("drifted")),
  );

  const stale = checkProvenanceNoCollapse({
    allowlist: [
      ...ALLOWLIST,
      {
        file: "artifacts/api-server/src/lib/data/freshness.ts",
        count: 1,
        reason: "test fixture — freshness.ts has no such keys",
      },
    ],
  });
  record(
    "stale allowlist pin fails",
    !stale.ok && stale.violations.some((v) => v.includes("Stale ALLOWLIST pin")),
  );
}

// ── 3. Entitlement row shaping (R4 slice 7) ─────────────────────────────────

{
  record(
    "quality levels are exactly realtime|delayed|snapshot|unavailable",
    JSON.stringify([...MARKET_DATA_QUALITY_LEVELS]) ===
      JSON.stringify(["realtime", "delayed", "snapshot", "unavailable"]),
  );

  record(
    "scope key derivation: bridge-scoped and provider-level",
    entitlementScopeKey(7) === "bridge:7" &&
      entitlementScopeKey(null) === PROVIDER_LEVEL_SCOPE &&
      entitlementScopeKey(undefined) === PROVIDER_LEVEL_SCOPE &&
      entitlementScopeKey(0) === "bridge:0",
  );

  // Column-name pins: the migration (drizzle-kit push, Replit-side) derives
  // the DDL from these — a rename is a schema change and must be deliberate.
  const cols = marketDataEntitlementsTable;
  record(
    "table column names are pinned",
    cols.provider.name === "provider" &&
      cols.bridgeConnectionId.name === "bridge_connection_id" &&
      cols.connectionScope.name === "connection_scope" &&
      cols.canonicalSymbol.name === "canonical_symbol" &&
      cols.dataQuality.name === "data_quality" &&
      cols.lastVerifiedAt.name === "last_verified_at",
  );
  record(
    "NOT NULL where the honesty contract needs it",
    cols.provider.notNull &&
      cols.connectionScope.notNull &&
      cols.canonicalSymbol.notNull &&
      cols.dataQuality.notNull &&
      cols.lastVerifiedAt.notNull &&
      !cols.bridgeConnectionId.notNull,
  );

  // Insert-type shaping: a connection-scoped and a provider-level row both
  // typecheck AND carry the derived scope. (Compile-time assertion via the
  // annotation; runtime assertion on the derived values.)
  const bridgeRow: NewMarketDataEntitlement = {
    provider: "mt5_broker",
    bridgeConnectionId: 42,
    connectionScope: entitlementScopeKey(42),
    canonicalSymbol: "eurusd",
    dataQuality: "realtime",
    lastVerifiedAt: new Date("2026-08-20T00:00:00Z"),
  };
  const providerRow: NewMarketDataEntitlement = {
    provider: "deriv",
    bridgeConnectionId: null,
    connectionScope: entitlementScopeKey(null),
    canonicalSymbol: "volatility_75_index",
    dataQuality: "unavailable",
    lastVerifiedAt: new Date("2026-08-20T00:00:00Z"),
  };
  record(
    "insert rows shape correctly for both scopes",
    bridgeRow.connectionScope === "bridge:42" &&
      providerRow.connectionScope === PROVIDER_LEVEL_SCOPE &&
      (MARKET_DATA_QUALITY_LEVELS as readonly string[]).includes(bridgeRow.dataQuality) &&
      (MARKET_DATA_QUALITY_LEVELS as readonly string[]).includes(providerRow.dataQuality),
  );
}

const failed = results.filter((r) => !r.ok).length;
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed}/${results.length} provenance-no-collapse cases passed`);
process.exit(failed === 0 ? 0 : 1);
