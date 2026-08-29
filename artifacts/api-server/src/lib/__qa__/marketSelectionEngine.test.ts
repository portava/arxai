// Capability #24 — Market Selection Engine (advisory).
//
// Locked here:
//   * Markets are SCORED (data quality, execution quality, edge coverage,
//     evidence maturity, capacity, correlation, broker trust) rather than
//     hand-curated; the composite maps to ACTIVE/SHADOW/EXCLUDED proposals.
//   * ADVISORY ONLY: every record carries advisoryOnly:true; a proposed
//     change sets ownerActionRequired; the registry itself is NEVER mutated.
//   * HONESTY: missing dimensions are null with typed reasons; insufficient
//     evidence coverage can NEVER propose an upgrade (default-deny) but can
//     still downgrade an ACTIVE market on a hard red flag.
//   * Hysteresis: composites inside the band propose no change.
//   * EXCLUDED never jumps straight to ACTIVE.
//
// IO-free, deterministic. Offline `ci` lane.
// Run: pnpm --filter @workspace/api-server run test:market-selection

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARX_FOCUS_MARKETS,
  buildAdvisoryPostureRecord,
  runMarketSelectionEngine,
  currentPostureOf,
  scoreMarketSelection,
  type MarketSelectionEvidence,
} from "@workspace/domain/market";

const FULL_GOOD: Omit<MarketSelectionEvidence, "canonicalSymbol"> = {
  dataQuality01: 0.95, executionQuality01: 0.9, edgeCoverage01: 0.8,
  closedTrades: 200, backtestRuns: 30, capacity01: 0.8,
  correlationWithActiveSet01: 0.2, brokerTrust01: 0.9,
};

const FULL_BAD: Omit<MarketSelectionEvidence, "canonicalSymbol"> = {
  dataQuality01: 0.2, executionQuality01: 0.2, edgeCoverage01: 0.1,
  closedTrades: 120, backtestRuns: 25, capacity01: 0.2,
  correlationWithActiveSet01: 0.9, brokerTrust01: 0.3,
};

test("registry-derived current posture: enabled markets read as ACTIVE", () => {
  const v75 = ARX_FOCUS_MARKETS.find((m) => m.canonicalSymbol === "V75")!;
  assert.equal(currentPostureOf(v75), "ACTIVE");
});

test("strong evidence on an ACTIVE market holds it ACTIVE; weak evidence proposes a downgrade", () => {
  const hold = buildAdvisoryPostureRecord({ canonicalSymbol: "V75", ...FULL_GOOD });
  assert.equal(hold.status, "SCORED");
  assert.equal(hold.proposedPosture, "ACTIVE");
  assert.equal(hold.changed, false);
  assert.equal(hold.direction, "NONE");

  const down = buildAdvisoryPostureRecord({ canonicalSymbol: "V75", ...FULL_BAD });
  assert.equal(down.status, "SCORED");
  assert.notEqual(down.proposedPosture, "ACTIVE");
  assert.equal(down.direction, "DOWNGRADE");
  assert.equal(down.ownerActionRequired, true);
});

test("every record is advisory-only and a change always requires the owner press", () => {
  const records = runMarketSelectionEngine([
    { canonicalSymbol: "V75", ...FULL_GOOD },
    { canonicalSymbol: "EURUSD", ...FULL_BAD },
  ]);
  for (const r of records) {
    assert.equal(r.advisoryOnly, true);
    assert.equal(r.ownerActionRequired, r.changed);
  }
});

test("the engine NEVER mutates the registry", () => {
  const before = JSON.stringify(ARX_FOCUS_MARKETS);
  runMarketSelectionEngine([
    { canonicalSymbol: "V75", ...FULL_BAD },
    { canonicalSymbol: "EURUSD", ...FULL_GOOD },
    { canonicalSymbol: "XAUUSD", ...FULL_BAD },
  ]);
  assert.equal(JSON.stringify(ARX_FOCUS_MARKETS), before,
    "ARX_FOCUS_MARKETS must be byte-identical after the engine runs");
});

test("missing dimensions are typed-null, never fabricated", () => {
  const { dimensions } = scoreMarketSelection({ canonicalSymbol: "V75", dataQuality01: 0.9 });
  const exec = dimensions.find((d) => d.key === "executionQuality")!;
  assert.equal(exec.score01, null);
  assert.ok(exec.missingReason && exec.missingReason.length > 0);
  const data = dimensions.find((d) => d.key === "dataQuality")!;
  assert.equal(data.score01, 0.9);
});

test("insufficient evidence coverage can NEVER propose an upgrade", () => {
  // A market sitting at SHADOW with sparse-but-glowing evidence: default-deny
  // means no upgrade may be proposed from insufficient evidence.
  const r = buildAdvisoryPostureRecord({
    canonicalSymbol: "V75",
    currentPostureOverride: "SHADOW",
    dataQuality01: 1, // one dimension only, no maturity counts
  });
  assert.equal(r.status, "INSUFFICIENT_EVIDENCE");
  assert.notEqual(r.direction, "UPGRADE");
  assert.equal(r.proposedPosture, "SHADOW");
});

test("full strong evidence upgrades SHADOW → ACTIVE and EXCLUDED only → SHADOW", () => {
  const shadowUp = buildAdvisoryPostureRecord({
    canonicalSymbol: "V75", currentPostureOverride: "SHADOW", ...FULL_GOOD,
  });
  assert.equal(shadowUp.status, "SCORED");
  assert.equal(shadowUp.proposedPosture, "ACTIVE");
  assert.equal(shadowUp.direction, "UPGRADE");
  assert.equal(shadowUp.ownerActionRequired, true);

  const excludedUp = buildAdvisoryPostureRecord({
    canonicalSymbol: "V75", currentPostureOverride: "EXCLUDED", ...FULL_GOOD,
  });
  assert.equal(excludedUp.proposedPosture, "SHADOW",
    "EXCLUDED must never jump straight to ACTIVE");
});

test("insufficient evidence still downgrades an ACTIVE market on a hard red flag", () => {
  const r = buildAdvisoryPostureRecord({
    canonicalSymbol: "V75",
    dataQuality01: 0.05, // hard red — data is effectively unreadable
  });
  assert.equal(r.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(r.proposedPosture, "SHADOW");
  assert.equal(r.direction, "DOWNGRADE");
});

test("hysteresis: a composite inside the band proposes no change", () => {
  // Craft evidence landing just under the ACTIVE threshold (0.65) for an
  // ACTIVE market: inside the hysteresis margin the posture must hold.
  const r = buildAdvisoryPostureRecord({
    canonicalSymbol: "V75",
    dataQuality01: 0.62, executionQuality01: 0.62, edgeCoverage01: 0.62,
    closedTrades: 62, capacity01: 0.62, correlationWithActiveSet01: 0.38,
    brokerTrust01: 0.62,
  });
  assert.equal(r.status, "SCORED");
  assert.ok(r.composite01! > 0.60 && r.composite01! < 0.65,
    `composite ${r.composite01} should sit inside the hysteresis band`);
  assert.equal(r.changed, false);
});

test("a market outside the registry is NOT scored into existence", () => {
  const r = buildAdvisoryPostureRecord({ canonicalSymbol: "DOGEUSD", ...FULL_GOOD });
  assert.equal(r.status, "NOT_IN_REGISTRY");
  assert.equal(r.changed, false);
  assert.equal(r.ownerActionRequired, false);
});
