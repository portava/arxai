// Foundation gates #19–#21 — deny-by-default, pass-path, staleness, tamper.
//
// Three layers under test:
//   1. The pure domain verdicts (lib/domain safety-contracts/foundationGates)
//      — every unresolvable fact must BLOCK an entry (default-deny), ops
//      commands must always be exempt (never trap exposure), and the capital
//      tier must be TIGHTEN-ONLY (effective cap <= every input cap).
//   2. The dispatch-side fact derivation (foundationGateInputs.ts) — the
//      provenance tamper cross-check (typed column vs payload-hash-covered
//      copy) and the fail-closed USD notional computation.
//   3. Source pins — the dispatch pipeline must supply real foundation
//      inputs to the evaluator (the null "preview" branch can never serve
//      the live dispatch path), and createLiveDraft must stamp both envelope
//      copies. Plus the tighten-only multiplier clamp in the agent lot sizer.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineSrc = readFileSync(path.join(here, "../liveCommandPipeline.ts"), "utf8");

const {
  isTradeableProvenanceSource,
  resolveCapitalTier,
  CAPITAL_TIERS,
  DEFAULT_CAPITAL_TIER,
  evaluateProvenanceGate,
  evaluateEdgePromotionGate,
  evaluateCapitalAdmissibilityGate,
  LIVE_PROVENANCE_MAX_AGE_MS,
} = await import("@workspace/domain/safety-contracts/foundationGates");
const { isTradeable } = await import("../../provenance/index.js");
const {
  buildCommandProvenanceEnvelope,
  parseCommandProvenanceEnvelope,
} = await import("../../provenance/commandProvenance.js");
const { deriveProvenanceFacts, computeNotionalUsd, edgePromotionRequiredForActor } =
  await import("../foundationGateInputs.js");
const { computeRiskAwareLot } = await import("@workspace/domain/self-trade");

// ── Taxonomy pin: the domain mirror can never drift from lib/provenance ────

test("domain tradeable allow-list agrees with lib/provenance isTradeable for every source literal", () => {
  const sources = ["LIVE_TICK", "DERIVED", "MODEL", "SYNTHETIC", "UNKNOWN", "STALE"] as const;
  for (const source of sources) {
    assert.equal(
      isTradeableProvenanceSource(source),
      isTradeable({ source }),
      `mirror drift on ${source}`,
    );
  }
  // Allow-list semantics: anything unrecognised is refused.
  assert.equal(isTradeableProvenanceSource("FUTURE_SOURCE"), false);
  assert.equal(isTradeableProvenanceSource(null), false);
});

// ── #19 PROVENANCE_UNPROVEN — pure verdicts ────────────────────────────────

const provenOk = () => ({
  envelopePresent: true,
  source: "LIVE_TICK",
  ageMs: 1_000,
  maxAgeMs: LIVE_PROVENANCE_MAX_AGE_MS,
  integrityCovered: true,
});

test("#19 pass-path: fresh, tradeable, integrity-covered entry provenance passes", () => {
  assert.equal(evaluateProvenanceGate(true, provenOk()).passed, true);
});

test("#19 deny-by-default: missing envelope blocks an entry", () => {
  assert.equal(evaluateProvenanceGate(true, { ...provenOk(), envelopePresent: false }).passed, false);
});

test("#19 staleness: age over the bound blocks; unknown age blocks (fail closed)", () => {
  assert.equal(evaluateProvenanceGate(true, { ...provenOk(), ageMs: LIVE_PROVENANCE_MAX_AGE_MS + 1 }).passed, false);
  assert.equal(evaluateProvenanceGate(true, { ...provenOk(), ageMs: null }).passed, false);
});

test("#19 corrupt bound blocks (never guess a limit)", () => {
  assert.equal(evaluateProvenanceGate(true, { ...provenOk(), maxAgeMs: Number.NaN }).passed, false);
  assert.equal(evaluateProvenanceGate(true, { ...provenOk(), maxAgeMs: -5 }).passed, false);
});

test("#19 tamper: an envelope not covered by the integrity hash blocks", () => {
  assert.equal(evaluateProvenanceGate(true, { ...provenOk(), integrityCovered: false }).passed, false);
});

test("#19 untradeable origins block: MODEL/SYNTHETIC/UNKNOWN/STALE", () => {
  for (const source of ["MODEL", "SYNTHETIC", "UNKNOWN", "STALE"]) {
    assert.equal(evaluateProvenanceGate(true, { ...provenOk(), source }).passed, false, source);
  }
});

test("#19 ops exemption: close/modify never blocks here even with no envelope", () => {
  assert.equal(evaluateProvenanceGate(false, { ...provenOk(), envelopePresent: false }).passed, true);
});

// ── #20 STRATEGY_NOT_LIVE_PROMOTED — pure verdicts ─────────────────────────

const promotedOk = () => ({
  required: true,
  edgeRefPresent: true,
  edgeStatus: "LIVE_CANDIDATE",
  edgeLiveAllowed: true,
  edgeEvidenceValid: true,
});

test("#20 pass-path: owner-pressed LIVE_CANDIDATE with intact evidence passes", () => {
  assert.equal(evaluateEdgePromotionGate(true, promotedOk()).passed, true);
});

test("#20 deny-by-default: required + no edge reference blocks", () => {
  assert.equal(evaluateEdgePromotionGate(true, { ...promotedOk(), edgeRefPresent: false }).passed, false);
});

test("#20 every unpromoted rung blocks", () => {
  for (const status of ["RESEARCH", "SHADOW", "DEMO", "RETIRED"]) {
    assert.equal(evaluateEdgePromotionGate(true, { ...promotedOk(), edgeStatus: status }).passed, false, status);
  }
  assert.equal(evaluateEdgePromotionGate(true, { ...promotedOk(), edgeStatus: null }).passed, false, "row not found");
});

test("#20 the owner's press is load-bearing: liveAllowed=false blocks even at LIVE_CANDIDATE", () => {
  assert.equal(evaluateEdgePromotionGate(true, { ...promotedOk(), edgeLiveAllowed: false }).passed, false);
});

test("#20 missing evidence window blocks", () => {
  assert.equal(evaluateEdgePromotionGate(true, { ...promotedOk(), edgeEvidenceValid: false }).passed, false);
});

test("#20 human manual commands are exempt; ops commands are exempt", () => {
  assert.equal(evaluateEdgePromotionGate(true, { ...promotedOk(), required: false, edgeRefPresent: false, edgeStatus: null }).passed, true);
  assert.equal(evaluateEdgePromotionGate(false, { ...promotedOk(), edgeRefPresent: false, edgeStatus: null }).passed, true);
});

test("#20 required-actor mapping: agents/system demand promotion, humans do not", () => {
  assert.equal(edgePromotionRequiredForActor("SELF_TRADE_AGENT"), true);
  assert.equal(edgePromotionRequiredForActor("SYSTEM"), true);
  assert.equal(edgePromotionRequiredForActor("USER"), false);
  assert.equal(edgePromotionRequiredForActor("ADMIN"), false);
  assert.equal(edgePromotionRequiredForActor("OWNER"), false);
});

// ── #21 CAPITAL_TIER_EXCEEDED — pure verdicts + tighten-only property ──────

const capitalOk = () => ({
  tier: "T1",
  openExposureUsd: 1_000,
  candidateExposureUsd: 1_100,
  userMaxLot: null as number | null,
});

test("#21 pass-path: within tier lot + exposure caps passes", () => {
  assert.equal(evaluateCapitalAdmissibilityGate(true, 0.01, capitalOk()).passed, true);
});

test("#21 deny-by-default: NULL tier resolves to the most restrictive rung", () => {
  const t = resolveCapitalTier(null);
  assert.ok(t != null);
  assert.equal(t.key, DEFAULT_CAPITAL_TIER);
  assert.equal(t.maxLotPerTrade, Math.min(...CAPITAL_TIERS.map((x) => x.maxLotPerTrade)));
});

test("#21 unknown tier literal blocks (fail closed, never guess a cap)", () => {
  assert.equal(resolveCapitalTier("PLATINUM"), null);
  assert.equal(evaluateCapitalAdmissibilityGate(true, 0.01, { ...capitalOk(), tier: "PLATINUM" }).passed, false);
});

test("#21 lot cap and exposure cap block when exceeded", () => {
  assert.equal(evaluateCapitalAdmissibilityGate(true, 0.05, { ...capitalOk(), tier: "T0" }).passed, false);
  assert.equal(evaluateCapitalAdmissibilityGate(true, 0.01, { ...capitalOk(), openExposureUsd: 30_000 }).passed, false);
});

test("#21 unresolvable exposure blocks entries (fail closed, never estimate)", () => {
  assert.equal(evaluateCapitalAdmissibilityGate(true, 0.01, { ...capitalOk(), openExposureUsd: null }).passed, false);
  assert.equal(evaluateCapitalAdmissibilityGate(true, 0.01, { ...capitalOk(), candidateExposureUsd: null }).passed, false);
});

test("#21 ops exemption: close/modify never blocks here", () => {
  assert.equal(evaluateCapitalAdmissibilityGate(false, 99, { ...capitalOk(), tier: "PLATINUM", openExposureUsd: null }).passed, true);
});

test("#21 tighten-only property: the tier can only REDUCE the effective lot cap", () => {
  // Fuzz over deterministic draws: for every (tier, userMaxLot) combination
  // the largest admitted volume is <= EACH input cap — the tier never
  // loosens an existing cap and the existing cap never loosens the tier.
  for (const tier of CAPITAL_TIERS) {
    for (const userMaxLot of [null, 0.005, 0.01, 0.2, 5]) {
      const caps = [tier.maxLotPerTrade, ...(userMaxLot != null ? [userMaxLot] : [])];
      const effective = Math.min(...caps);
      for (const volume of [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 3]) {
        const verdict = evaluateCapitalAdmissibilityGate(true, volume, {
          tier: tier.key, openExposureUsd: 0, candidateExposureUsd: 0, userMaxLot,
        });
        if (verdict.passed) {
          for (const cap of caps) {
            assert.ok(volume <= cap, `tier ${tier.key} admitted ${volume} above cap ${cap}`);
          }
        }
        if (volume > effective) {
          assert.equal(verdict.passed, false, `tier ${tier.key} must refuse ${volume} > ${effective}`);
        }
      }
    }
  }
});

// ── Provenance fact derivation — tamper cross-check ────────────────────────

const envelope = () => buildCommandProvenanceEnvelope({
  originActorType: "USER",
  dataSource: "LIVE_TICK",
  sourceId: "mt5_broker:EURUSD",
  asOf: new Date(Date.now() - 5_000),
});

test("derivation pass-path: matching typed + payload copies are integrity-covered", () => {
  const e = envelope();
  const facts = deriveProvenanceFacts({ typedEnvelope: e, payloadEnvelope: { ...e } });
  assert.equal(facts.envelopePresent, true);
  assert.equal(facts.integrityCovered, true);
  assert.equal(facts.source, "LIVE_TICK");
  assert.ok(facts.ageMs != null && facts.ageMs >= 5_000 && facts.ageMs < 60_000);
});

test("tamper: a typed column that diverges from the hashed payload copy is NOT integrity-covered", () => {
  const e = envelope();
  const tampered = { ...e, dataSource: "LIVE_TICK", sourceId: "mt5_broker:XAUUSD" };
  const facts = deriveProvenanceFacts({ typedEnvelope: tampered, payloadEnvelope: e });
  assert.equal(facts.envelopePresent, true);
  assert.equal(facts.integrityCovered, false, "a swapped feed id must break the cross-check");
});

test("tamper: a missing payload copy is NOT integrity-covered", () => {
  const facts = deriveProvenanceFacts({ typedEnvelope: envelope(), payloadEnvelope: null });
  assert.equal(facts.integrityCovered, false);
});

test("a malformed stored envelope parses to null (treated as absent, default-deny)", () => {
  assert.equal(parseCommandProvenanceEnvelope({ v: 1, originActorType: "GHOST" }), null);
  assert.equal(parseCommandProvenanceEnvelope("not an object"), null);
  assert.equal(parseCommandProvenanceEnvelope(null), null);
  const e = envelope();
  assert.equal(parseCommandProvenanceEnvelope({ ...e, dataSource: "INVENTED" }), null);
});

test("an envelope with no asOf reports unknown age (which the gate refuses)", () => {
  const e = buildCommandProvenanceEnvelope({
    originActorType: "USER", dataSource: "LIVE_TICK", sourceId: "x", asOf: null,
  });
  const facts = deriveProvenanceFacts({ typedEnvelope: e, payloadEnvelope: { ...e } });
  assert.equal(facts.ageMs, null);
  assert.equal(evaluateProvenanceGate(true, facts).passed, false);
});

// ── USD notional — fail-closed conversion ──────────────────────────────────

test("notional resolves for a broker-specced symbol and a strict fiat pair", () => {
  // Broker truth: XAUUSD, 100 oz/lot, profit USD.
  assert.equal(
    computeNotionalUsd({ symbol: "XAUUSD", lots: 0.01, price: 2_400, brokerContractSize: 100, brokerProfitCurrency: "USD" }),
    0.01 * 100 * 2_400,
  );
  // FX standard lot fallback for a strict fiat pair.
  assert.equal(
    computeNotionalUsd({ symbol: "EURUSD", lots: 0.01, price: 1.1, brokerContractSize: null, brokerProfitCurrency: null }),
    0.01 * 100_000 * 1.1,
  );
});

test("notional fails closed: no spec for a non-fiat symbol, no price, no cross rate", () => {
  assert.equal(
    computeNotionalUsd({ symbol: "BTCUSD", lots: 1, price: 60_000, brokerContractSize: null, brokerProfitCurrency: null }),
    null, "crypto without broker spec must refuse, never assume the FX lot");
  assert.equal(
    computeNotionalUsd({ symbol: "EURUSD", lots: 0.01, price: null, brokerContractSize: null, brokerProfitCurrency: null }),
    null, "no price = no notional");
  assert.equal(
    computeNotionalUsd({ symbol: "EURGBP", lots: 0.01, price: 0.85, brokerContractSize: null, brokerProfitCurrency: null }),
    null, "GBP→USD needs a cross rate we do not hold — refuse, never estimate");
});

// ── Tighten-only multiplier clamp (gate #21 companion) ─────────────────────

test("sizeMultiplier > 1 is clamped: applied lot never exceeds the deterministic lot", () => {
  const base = {
    side: "BUY" as const, entryPrice: 1.1, stopLossPrice: 1.09,
    riskBudgetUsd: 100, valuePerUnitPerLot: 100_000,
    minLot: 0.01, maxLot: 100, lotStep: 0.01, agentMaxLot: 100,
  };
  const deterministic = computeRiskAwareLot({ ...base, sizeMultiplier: 1 });
  for (const m of [1.0001, 1.5, 2, 10, 1_000]) {
    const boosted = computeRiskAwareLot({ ...base, sizeMultiplier: m });
    assert.equal(boosted.multiplierClamped, true, `m=${m} must report the clamp`);
    assert.equal(boosted.lot, deterministic.lot, `m=${m} must size exactly like m=1`);
  }
  for (const m of [0.25, 0.5, 0.9, 1]) {
    const tightened = computeRiskAwareLot({ ...base, sizeMultiplier: m });
    assert.equal(tightened.multiplierClamped, false);
    assert.ok(tightened.lot <= deterministic.lot + 1e-9, `m=${m} may only tighten`);
  }
});

// ── Source pins — the dispatch path can never take the preview branch ──────

test("dispatchLiveCommand assembles foundation inputs and supplies them to the evaluator", () => {
  assert.ok(
    pipelineSrc.includes("const foundationInputs = await buildFoundationGateInputs({"),
    "dispatch must build real foundation inputs",
  );
  assert.ok(
    pipelineSrc.includes("foundation: foundationInputs,"),
    "dispatch must pass the assembled inputs — never null/omitted (the preview branch is not for dispatch)",
  );
});

test("createLiveDraft stamps BOTH envelope copies (typed column + payload-hash-covered payload copy)", () => {
  assert.ok(
    pipelineSrc.includes("provenanceEnvelope: provenanceEnvelope as unknown as Record<string, unknown> | null"),
    "typed provenance_envelope column must be stamped at draft",
  );
  assert.ok(
    pipelineSrc.includes("commandProvenance: provenanceEnvelope"),
    "the payload copy (covered by payloadHash) must be stamped at draft",
  );
  assert.ok(
    pipelineSrc.includes("commandProvenance: _provStripped"),
    "client-supplied payload.commandProvenance must be scrubbed — only the server may fill the trusted slot",
  );
});

test("foundation gate verdicts are logged on every dispatch (PASS included)", () => {
  assert.ok(pipelineSrc.includes(`event: "FOUNDATION_GATES_EVALUATED"`));
});
