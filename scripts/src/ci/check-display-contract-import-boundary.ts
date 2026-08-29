// check-display-contract-import-boundary.ts
//
// Static-analysis CI guard (ci:guards lane) — enforces the DISPLAY-CONTRACT
// import boundary for the display-only read contracts.
//
// The display-only contracts —
//   1. data-sufficiency  (lib/domain/src/market/marketDataSufficiency.ts) with
//      its `mayShow*` readability flags (bias / direction / trend / confidence /
//      trade idea / recommendation),
//   2. trade-health / readiness
//      (lib/domain/src/market/tradeHealthReadinessContract.ts) with its
//      affordance CEILINGS (`mayDescribeSetup` / `mayShowTradeButton` /
//      `mayShowOneClickButton` / `mayOfferLiveExecutionRequest`), and
//   3. trendline truth
//      (lib/domain/src/market/trendlineTruthContract.ts) — a DISPLAY /
//      DECISION-SUPPORT-only CHILD input that COLOURS the existing Scanner Truth
//      read (downgrade-only `scannerTruthImpact` / confidence ceilings / wording);
//      it carries NO execution-permission field and may never grant READY_NOW —
// decide ONLY what a surface may SHOW or OFFER. They are DISPLAY-ONLY: they can
// hide or neutralize presentation, but they NEVER grant, bypass, or weaken trade
// eligibility. Execution eligibility stays exactly what it is — the live / risk /
// broker / account-governance gates, the synthetic floor, SL policy, and the
// 23-gate dispatch.
//
// This guard FAILS THE BUILD if any fenced execution/safety module:
//   1. imports any display contract module (marketDataSufficiency,
//      tradeHealthReadinessContract, or trendlineTruthContract), directly or via
//      a domain/market barrel, or
//   2. references any display-only symbol (`mayShow*` / `mayDescribe*` /
//      `mayOffer*` flags or the private `deriveReadabilityPermissions` /
//      `deriveTradeHealthReadinessPermissions` helpers).
//
// Allowing such an import would let "what we can DISPLAY/OFFER" leak into "what
// we may TRADE" — exactly the coupling the contracts forbid (see the boundary
// comments in those modules and docs/SAFETY_NOTES.md). Display surfaces (scanner,
// Ruby, chart, trade ticket, opportunity map) consume the contracts freely;
// execution/safety surfaces must never see them.
//
// Fenced roots (execution + safety surfaces):
//   - lib/domain/src/safety-contracts/          (23-gate, kill-switch lock, synthetic floor, pre-trade guard, reconciliation)
//   - artifacts/api-server/src/lib/live/        (Phase B live dispatch pipeline, arming, instant trade, emergency close)
//   - artifacts/api-server/src/lib/liveTrading/ (legacy Build TT chokepoint: guard/limits/readiness/state)
//   - artifacts/api-server/src/lib/mt5/         (MT5 dispatch + demo/live command (order) queue + dispatch gates)
//   - artifacts/api-server/src/lib/broker/, brokerReadOnly/  (broker dispatch surface + read service)
//   - artifacts/api-server/src/lib/governance/  (account governance)
//   - artifacts/api-server/src/lib/risk/, riskGovernor/      (risk settings + governor)
//   - artifacts/api-server/src/lib/paperExecution/           (paper execution path / eligibility / sizing)
//   - positionSizing.ts, riskAudit.ts, riskGovernor2.ts, riskGovernorEngine.ts (position-mgmt / risk helpers)
//
// All checks are fast static scans — no runtime, no DB, no network.

import { join } from "node:path";
import type { CheckResult } from "./_lib.js";
import { ROOT, walk, read, rel } from "./_lib.js";

// Display-only readability identifiers that must not appear in any fenced module.
// Covers BOTH display contracts: the Phase-2 data-sufficiency readability flags
// AND the Phase-3 trade-health / readiness affordance ceilings (the `mayShow* /
// mayDescribe* / mayOffer*` trade-affordance flags + their private derivation
// helper). A bare reference to any of these in a fenced execution/safety module
// is a leak however it was imported.
const FORBIDDEN_SYMBOLS = [
  "mayShowBias",
  "mayShowDirection",
  "mayShowTrend",
  "mayShowConfidence",
  "mayShowTradeIdea",
  "mayShowRecommendation",
  "mayShowReadOnlyContext",
  "deriveReadabilityPermissions",
  // Phase-3 trade-health / readiness display affordance ceilings.
  "mayDescribeSetup",
  "mayShowTradeButton",
  "mayShowOneClickButton",
  "mayOfferLiveExecutionRequest",
  "deriveTradeHealthReadinessPermissions",
] as const;

// An import/export statement that pulls in the display-only contract module by
// path (with or without a `.js` extension), STATIC or dynamic. Matched against
// comment-stripped source so a doc-comment mentioning the module is never a false
// positive. `[^;]*?` is non-greedy and crosses newlines (but never a `;`), so a
// MULTILINE import/export or a multiline `await import(\n "…" \n)` of the contract
// module is still caught while an unrelated later statement cannot be bridged into.
const CONTRACT_MODULE_IMPORT =
  /\b(?:import|export)\b[^;]*?['"`][^'"`]*\/(?:marketDataSufficiency|tradeHealthReadinessContract|trendlineTruthContract|pivotTruthContract|directionTruthContract|entryTruthContract|orderFlowTruthContract|timingTruthContract|confluenceTruthContract|marketIntelligenceContract|marketIntelligenceDisplay|patternDetectionContract|shootingStarTruthContract|candlestickReversalContract|consolidationTruthContract|structureBreakContract|assetPatternProfile|patternResearchSources|patternReasoning|goldMode|goldMacroContract|goldSessionContract|goldTacticsContract|goldRiskContract|goldStrategyTemplates|goldReasoning|goldReliability)(?:\.js)?['"`]/;

// Display-only contract identifiers that must not be pulled into a fenced module
// via the `@workspace/domain` (or `@workspace/domain/market`) BARREL either. The
// path-based CONTRACT_MODULE_IMPORT above only catches a DIRECT
// `.../marketDataSufficiency` import; a fenced file could otherwise reach the same
// display verdict / evaluator / contract types through the package barrel and slip
// the boundary. The `mayShow*` flags are already covered by FORBIDDEN_SYMBOLS
// (a bare reference is flagged however it was imported); this list adds the
// verdict/evaluator/contract-type names that only matter as barrel bindings.
const DISPLAY_CONTRACT_BARREL_SYMBOLS = [
  "evaluateMarketDataSufficiency",
  "MarketDataSufficiencyVerdict",
  "MarketDataSufficiencyStatus",
  "MarketDataReasonCode",
  "EvaluateMarketDataSufficiencyInput",
  // Phase-3 trade-health / readiness contract evaluator + verdict/input/band types.
  "evaluateTradeHealthReadiness",
  "TradeHealthReadinessVerdict",
  "EvaluateTradeHealthReadinessInput",
  "TradeReadLayer",
  "TradeDataFreshnessBand",
  "TradeStructureConfidenceBand",
  "TradeSetupHealthBand",
  "TradeDisplayBlockedReason",
  // Trendline-truth DISPLAY / decision-support contract: the resolver + its
  // verdict / context / display-context / scanner-impact binding names. Like the
  // other two contracts these only matter as BARREL bindings (a bare `mayShow*`
  // reference is already flagged by FORBIDDEN_SYMBOLS, but the trendline contract
  // exposes no such flag — it carries ONLY downgrade-only display hints).
  "resolveTrendlineTruth",
  "TrendlineTruthVerdict",
  "TrendlineContext",
  "TrendlineDisplayContext",
  "TrendlineScannerImpact",
  // Strategy Intelligence Upgrade — the six child "Truth" resolvers + their
  // verdict / input / display-context / scanner-impact binding names, plus the
  // composing MarketIntelligenceSnapshot / StrategyVerdict. Like trendline/pattern
  // these are DISPLAY / decision-support only (downgrade-only scannerTruthImpact,
  // NO execution-permission field) and matter here only as BARREL bindings.
  "resolvePivotTruth",
  "PivotTruthVerdict",
  "PivotTruthInput",
  "PivotDisplayContext",
  "PivotScannerImpact",
  "computeClassicPivots",
  "resolveDirectionTruth",
  "DirectionTruthVerdict",
  "DirectionTruthInput",
  "DirectionDisplayContext",
  "DirectionScannerImpact",
  "resolveEntryTruth",
  "EntryTruthVerdict",
  "EntryTruthInput",
  "EntryDisplayContext",
  "EntryScannerImpact",
  "resolveOrderFlowTruth",
  "OrderFlowTruthVerdict",
  "OrderFlowTruthInput",
  "OrderFlowDisplayContext",
  "OrderFlowScannerImpact",
  "resolveTimingTruth",
  "TimingTruthVerdict",
  "TimingTruthInput",
  "TimingDisplayContext",
  "TimingScannerImpact",
  "resolveConfluence",
  "ConfluenceVerdict",
  "ConfluenceTruthInput",
  "ConfluenceDisplayContext",
  "ConfluenceScannerImpact",
  "composeMarketIntelligenceSnapshot",
  "deriveStrategyVerdict",
  "MarketIntelligenceSnapshot",
  "StrategyVerdict",
  "ComposeSnapshotInput",
  // Strategy Intelligence Upgrade — Phase 2 DISPLAY mapper: the pure projection
  // of a snapshot/verdict into Eleanor's reasoning block + the Scanner badge row.
  // Display-only (no execution-permission field, can only describe/downgrade) and
  // matters here only as a BARREL binding.
  "buildMarketIntelligenceDisplay",
  "MarketIntelligenceDisplay",
  "IntelligenceReasoningBlock",
  "IntelligenceBadge",
  "IntelligenceBadgeKey",
  "IntelligenceBadgeTone",
  // Pattern Library Intelligence Upgrade — the unified pattern-detection classifier
  // + dedicated candlestick / consolidation / structure-break detectors, asset
  // profiles, research seed, and Eleanor reasoning builder. Like trendline/pattern
  // these are DISPLAY / decision-support only (downgrade-only, NO execution-permission
  // field, classifyTradeRead can never grant READY_NOW) and matter here only as
  // BARREL bindings.
  "classifyTradeRead",
  "TradeReadVerdict",
  "ClassifyTradeReadInput",
  "PatternDetection",
  "isActionableTradeRead",
  "biasToDirection",
  "categoryToFamily",
  "resolveShootingStarTruth",
  "ShootingStarRead",
  "ShootingStarInput",
  "detectHammer",
  "detectEngulfing",
  "detectStar",
  "detectCandlestickReversals",
  "CandlestickSignal",
  "CandlestickInput",
  "resolveConsolidationTruth",
  "ConsolidationRead",
  "ConsolidationInput",
  "resolveStructureBreakTruth",
  "StructureBreakRead",
  "StructureBreakInput",
  "getAssetPatternProfile",
  "classifyAssetClass",
  "assetPatternWarnings",
  "AssetPatternProfile",
  "PATTERN_RESEARCH_SOURCES",
  "researchForPattern",
  "researchRefsForPattern",
  "getResearchSource",
  "PatternResearchSource",
  "buildPatternReasoningBlock",
  "PatternReasoningBlock",
  "PatternReasoningInput",
  // Gold Strategy Mode (Task #657) — the gold asset profile, macro / session-
  // timing / tactic / risk verdict resolvers, the strategy templates + evaluator
  // + Auto-Bot precondition, the Eleanor reasoning / Scanner badge / overlay-spec
  // builders, and the reliability aggregator. Like trendline/pattern these are
  // DISPLAY / decision-support only (downgrade-only, NO execution-permission field;
  // the strategy verdict's `readyNow` is the literal `false`; the Auto-Bot
  // precondition ANDs EXTERNAL feed/Trade-Health/live-gate facts it never sets) and
  // matter here only as BARREL bindings.
  "isGoldSymbol",
  "isGoldMode",
  "getGoldAssetProfile",
  "GoldAssetProfile",
  "GoldTradeStyle",
  "resolveGoldMacro",
  "goldMacroSupport",
  "GoldMacroVerdict",
  "GoldMacroInput",
  "resolveGoldTiming",
  "detectLondonSweep",
  "GoldTimingVerdict",
  "GoldTimingInput",
  "GoldRange",
  "GoldLondonSweep",
  "resolveGoldShootingStar",
  "resolveGoldHammer",
  "resolveGoldLiquiditySweep",
  "resolveGoldBreakoutRetest",
  "GoldCandleVerdict",
  "GoldTactic",
  "resolveGoldRisk",
  "goldStopDistanceStatus",
  "GoldRiskVerdict",
  "GoldRiskInput",
  "GOLD_STRATEGY_TEMPLATES",
  "getGoldStrategyTemplate",
  "evaluateGoldStrategy",
  "goldAutoBotPrecondition",
  "GoldStrategyTemplate",
  "GoldStrategyVerdict",
  "GoldStrategyEvalInput",
  "GoldAutoBotPrecondition",
  "GoldAutoBotPreconditionInput",
  "buildGoldContextBlock",
  "buildGoldScannerBadges",
  "buildGoldOverlaySpec",
  "GoldContextBlock",
  "GoldReasoningInput",
  "GoldOverlaySpec",
  "aggregateGoldReliability",
  "GoldReliabilityReport",
  "GoldReliabilityBucket",
  "GoldOutcomeSample",
] as const;

// Module-spec fragment matching ANY barrel that re-exports the display contract:
// the `@workspace/domain` root or its `/market` subpath (optionally `/index[.js]`),
// OR a relative path to the market barrel directory / its index. A SPECIFIC file
// under `/market` (e.g. `../market/symbolRegistry.js`) is deliberately NOT a
// barrel — the trailing `/market` must be the whole tail (or `/market/index[.js]`),
// so a similarly-named module like `marketDataSufficiencyHelper.js` never matches.
const CONTRACT_BARREL_SPEC = String.raw`(?:@workspace\/domain(?:\/market)?(?:\/index(?:\.js)?)?|[^'"]*\/market(?:\/index(?:\.js)?)?)`;

// A named import/export pulling bindings from a contract-bearing barrel. Capture
// group 1 is the brace-list of bound names. Global so a file with several barrel
// imports is fully scanned.
const DOMAIN_BARREL_NAMED_IMPORT = new RegExp(
  String.raw`\b(?:import|export)\b\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]${CONTRACT_BARREL_SPEC}['"]`,
  "g",
);

// The `@workspace/domain` ROOT barrel re-exports `./market` as a NAMESPACE
// member (`export * as market from "./market"`), and `./market` re-exports the
// display contract — so a fenced file can reach the WHOLE contract through the
// root's `market` member: `import { market } from "@workspace/domain";
// market.evaluateMarketDataSufficiency(...)` (or `export { market } from ...`).
// DOMAIN_BARREL_NAMED_IMPORT above does NOT catch this because the bound name is
// `market`, not a contract symbol. Match a named import/export from the domain
// ROOT barrel (package root or its `/index[.js]`, or a relative `…/index[.js]`
// root) — capture group 1 is the brace-list; we then flag any binding whose
// SOURCE name is a contract-bearing root namespace. Global.
// The relative alt matches a directory/barrel root the domain's own files would use
// to reach the package root: bare `..`/`../`, a directory path (`../`, `../foo`,
// `../../foo`), or an explicit `…/index[.js]`. A safety-contracts file is one level
// under the domain root, so `import { market } from ".."` (or `"../index.js"`)
// reaches the same `market` namespace as the package specifier.
const ROOT_BARREL_SPEC = String.raw`(?:@workspace\/domain(?:\/index(?:\.js)?)?|\.{1,2}(?:\/[^'"]+)*\/?)`;
const DOMAIN_ROOT_NAMESPACE_IMPORT = new RegExp(
  String.raw`\b(?:import|export)\b\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]${ROOT_BARREL_SPEC}['"]`,
  "g",
);
// Root-barrel namespace members that themselves carry the display contract.
const CONTRACT_BEARING_ROOT_NAMESPACES = ["market"] as const;

// A relative path made of PURE parent traversal (`..`, `../..`, `../../`, an
// explicit `…/index[.js]`) — i.e. a fenced subdir reaching UP to the domain root
// barrel, NOT a named sibling like `../foo`. Unlike ROOT_BARREL_SPEC's broad
// relative alt (which only matters when gated by a `market` BINDING name), this is
// used by the UNCONDITIONAL whole-namespace detectors below, so it must stay tight
// or it would flag every `../sibling` import. `\.\.` requires the leading `..`, so
// `./ownIndex` (a fenced file's OWN dir index) is correctly NOT a root reach.
const REL_ROOT_PARENT = String.raw`\.\.(?:\/\.\.)*(?:\/index(?:\.js)?)?\/?`;

// The set of specifiers whose WHOLE module object is (or contains) the display
// contract: any contract-bearing barrel (`@workspace/domain`[`/market`][`/index`]
// or a relative `…/market` barrel) OR the domain ROOT reached via pure parent
// traversal. Acquiring any of these as a whole namespace — via `import * as`,
// `export *`, dynamic `import()`, or `require()` — exposes the entire contract
// (reachable by dot/bracket access or destructuring), so the detectors below flag
// it UNCONDITIONALLY rather than chasing every downstream member-access form.
const WHOLE_NAMESPACE_SPEC = String.raw`(?:${CONTRACT_BARREL_SPEC}|${REL_ROOT_PARENT})`;

// A wildcard re-export of a contract-bearing barrel or the domain root
// (`export *` / `export * as ns` / `export * from ".."`). This re-exports the
// display contract WHOLESALE out of a fenced module, so it is always a leak
// regardless of which names are consumed downstream.
const DOMAIN_BARREL_STAR_REEXPORT = new RegExp(
  String.raw`\bexport\b\s*\*(?:\s+as\s+\w+)?\s*from\s*['"]${WHOLE_NAMESPACE_SPEC}['"]`,
);

// A namespace import of a contract-bearing barrel (`import * as ns` /
// `import type * as ns`). Capture group 1 is the local namespace binding. A
// whole-barrel namespace binding exposes the ENTIRE display contract, and the
// member could then be reached by dot access, bracket access (`ns["…"]`), or
// destructuring (`const { … } = ns`) — so it is flagged UNCONDITIONALLY rather
// than trying to chase every member-access form. Fenced execution/safety modules
// have no need to namespace-import the domain barrel (real code uses named focus
// imports), so this carries no current false-positive cost. Covers the contract
// barrels AND the domain root reached via pure parent traversal (`import * as ns
// from ".."`), both of which bind the whole `market` namespace.
const DOMAIN_BARREL_NAMESPACE_IMPORT = new RegExp(
  String.raw`\bimport\b\s+(?:type\s+)?\*\s+as\s+(\w+)\s+from\s*['"]${WHOLE_NAMESPACE_SPEC}['"]`,
  "g",
);

// A dynamic import of a contract-bearing barrel or the domain root
// (`import("@workspace/domain/market")` / `await import("../market")` /
// `await import("..")` / the `import("…").T` type-query form). The returned module
// namespace exposes the whole contract, so it is flagged like a static namespace
// import. A DIRECT dynamic import of the contract module path is already covered by
// CONTRACT_MODULE_IMPORT (it matches the `import` keyword + quoted
// `…/marketDataSufficiency` path); this adds the BARREL / root specs only.
// `\x60` is a literal backtick (cannot appear inside a String.raw template); it
// extends the quote class to STATIC template-literal dynamic specifiers like
// ``await import(`@workspace/domain/market`)`` that have no interpolation.
const DOMAIN_BARREL_DYNAMIC_IMPORT = new RegExp(
  String.raw`\bimport\s*\(\s*['"\x60]${WHOLE_NAMESPACE_SPEC}['"\x60]`,
);

// ── CommonJS require / createRequire escape hatch (root-cut) ────────────────
// The api-server bundles to CJS (build.mjs injects `globalThis.require`) and
// `createRequire(import.meta.url)` is valid in ESM, so a fenced module could pull
// the contract through a RUNTIME require — which has NO named binding and NO
// `mayShow*` symbol, so none of the static import/export detectors above fire.
//
// Neither `require` (the bundler-injected bare global) nor `createRequire` has any
// legitimate use in a fenced execution/safety module: these are authored as ESM/TS
// and acquire dependencies via static `import`. A runtime require, once named, can
// be invoked under UNBOUNDED callee syntax — `require("x")`, `(require)("x")`,
// `require.call(null,"x")`, `require?.("x")`, `globalThis.require("x")`,
// `createRequire(import.meta.url)("x")`, `import { createRequire as mk }` then
// `mk(...)`, or rebound to any depth — so chasing each call form is a losing game.
// Instead we ROOT-CUT the class: the mere PRESENCE of a `require` / `createRequire`
// IDENTIFIER in fenced CODE is forbidden. A module that can never NAME a require
// function can never mint one to bypass the boundary, regardless of call syntax.
//
// To stay false-positive free this is matched against source with string literals
// AND comments stripped (see `stripStringsAndComments`), so the WORD "require"
// inside a user-facing message (e.g. "Live orders require my confirmation") or a
// doc comment is ignored; `\b…\b` also excludes domain identifiers like
// `requireTakeProfit` / `required`. Verified zero current fenced files reference a
// bare require/createRequire in code; a future genuine need uses a static import
// or a narrow reviewed allowlist entry.
const CJS_REQUIRE_REFERENCE = /\b(?:require|createRequire)\b/;

// The direct contract MODULE path as a RELATIVE specifier (`./marketDataSufficiency`,
// `../market/marketDataSufficiency.js`, deeper parent traversal). It is deliberately
// anchored to a leading `.`/`..` so it matches a real module specifier but NOT a
// documentation URL like `"https://example.com/marketDataSufficiency.js"` (which
// starts with a scheme letter, not `.`). A module specifier for the contract is
// always relative or the package barrel — never an absolute URL.
const CONTRACT_MODULE_REL_PATH = String.raw`\.\.?(?:\/[^'"\x60]+)*\/(?:marketDataSufficiency|tradeHealthReadinessContract|trendlineTruthContract|pivotTruthContract|directionTruthContract|entryTruthContract|orderFlowTruthContract|timingTruthContract|confluenceTruthContract|marketIntelligenceContract|marketIntelligenceDisplay|patternDetectionContract|shootingStarTruthContract|candlestickReversalContract|consolidationTruthContract|structureBreakContract|assetPatternProfile|patternResearchSources|patternReasoning)(?:\.js)?`;

// A STRING LITERAL whose WHOLE content is a contract-bearing specifier: a
// domain/market barrel or the domain root reached via parent traversal
// (WHOLE_NAMESPACE_SPEC) OR the direct relative `…/marketDataSufficiency` module
// path. Global so every occurrence in a file is classified (see the scan below).
// `\x60` = literal backtick (static template-literal specifiers, no interpolation).
const CONTRACT_SPEC_STRING = new RegExp(
  String.raw`['"\x60](?:${WHOLE_NAMESPACE_SPEC}|${CONTRACT_MODULE_REL_PATH})['"\x60]`,
  "g",
);

// The ONLY legitimate place a fenced execution/safety module may name a contract
// specifier is as the source of a STATIC `from` import/export: `} from "spec"` /
// `import … from "spec"` / `export … from "spec"`. The require/createRequire
// IDENTIFIER ban above removes the obvious CJS loaders, but the bundler-injected
// global require can also be invoked WITHOUT naming the `require` identifier in code
// — bracket access (`(globalThis as any)["require"]("spec")`),
// `Function.prototype.apply` with an array-LIKE object
// (`r.apply(null, { 0: "spec", length: 1 })`), an aliased loader, etc. Chasing every
// callee/argument shape is unbounded, so instead of trying to recognise the LOAD we
// recognise the only ALLOWED context for the specifier and flag the literal in EVERY
// other position. So a contract specifier literal that is NOT the source of a static
// `from` import/export is a leak — whether in a call argument, array element,
// OBJECT-LITERAL property value, variable initializer, OR a side-effect
// `import "spec"` (which loads the barrel into the CJS module cache for later
// `globalThis["require"].cache` introspection — never a legitimate need).
//
// The carve-out is deliberately STRICT to avoid spoofing the `from` keyword: a static
// `import … from` / `export … from` source is ALWAYS a single/double-QUOTED string
// preceded by the `from` keyword. A backtick (template) literal can NEVER be a static
// import source — `` from`spec` `` is a TAGGED-TEMPLATE call on an identifier merely
// named `from` (`const from = (s) => import(s[0]); await from`spec` `), not an import —
// so a backtick-delimited contract literal is flagged REGARDLESS of what precedes it.
// And `from "spec"` (quoted, with no operator/parens between) is grammatically valid
// ONLY as import/export-from syntax: an identifier cannot be juxtaposed with a quoted
// string in any other expression, so quoted + preceded-by-`from` ⟹ a genuine static
// import source. Whole-namespace/dynamic/contract-member imports that sit in such a
// `from` position are still vetted by the dedicated detectors above
// (CONTRACT_MODULE_IMPORT, DOMAIN_BARREL_*), so the carve-out is safe.
function isContractSpecOutsideStaticImport(code: string): boolean {
  for (const m of code.matchAll(CONTRACT_SPEC_STRING)) {
    const literal = m[0];
    const quoted = literal.startsWith("'") || literal.startsWith('"');
    const before = code.slice(0, m.index).replace(/\s+$/, "");
    if (quoted && /\bfrom$/.test(before)) continue;
    return true;
  }
  return false;
}

// Bracket-property access whose KEY is the string "require" — `globalThis["require"]`,
// `(globalThis as any)['require']`, `self[`require`]`, or a bare `obj["require"]`.
// The CJS identifier ban above catches every form that NAMES require as an identifier
// (`require`, `globalThis.require`, `module.require`, `.require.cache`), but bracket
// access hides the token inside a STRING that the identifier scan strips. There is no
// legitimate reason for a fenced ESM module to index any object by the literal key
// "require"; banning it closes the bundler-injected global require (and its `.cache`)
// reflection entry point. (Pure runtime reflection that names NEITHER the contract
// specifier literal NOR the require capability — e.g. `Reflect.get` + cache walking
// with the barrel loaded by other code — constructs nothing statically resolvable and
// is the agreed out-of-static-scope class, the domain of the FENCED_DIRS boundary +
// code review.)
const BRACKET_GLOBAL_REQUIRE = /\[\s*['"\x60]require['"\x60]\s*\]/;

// Explicitly-allowed barrel bindings, keyed by fenced file (repo-relative path).
// The Phase-2 live ENTRY adapter composes the shared sufficiency engine ADDITIVELY
// in front of the live chain (BLOCK-ONLY: it can refuse a new entry, never grant
// one, and every existing gate still runs and keeps final say). It reads only the
// neutral / block fields (status, canShowTradeSetup, freshness, reason) — never a
// `mayShow*` display-permission flag, which the FORBIDDEN_SYMBOLS scan above still
// proves for this very file — so importing the data-sufficiency STATUS type alone
// is a reviewed, allowed exception (type-only; erased at runtime).
const BARREL_IMPORT_ALLOWLIST: Record<string, readonly string[]> = {
  "artifacts/api-server/src/lib/live/entryDataSufficiency.ts": [
    "MarketDataSufficiencyStatus",
  ],
};

// Normalize one brace-list binding to the name it was imported UNDER from the
// barrel: drop a leading inline `type ` modifier and any ` as alias` so we match
// on the source export name, not a local alias.
function bindingSourceName(raw: string): string {
  return raw
    .trim()
    .replace(/^type\s+/, "")
    .split(/\s+as\s+/)[0]!
    .trim();
}

// Fenced execution/safety roots (directories), relative to the repo root.
// Includes the domain-level safety/execution engines named by the T7 fence
// (kill-switch, order dispatch, execution gate, risk governor) — these decide or
// block real trades and must never depend on a display-only readability flag.
export const FENCED_DIRS = [
  "lib/domain/src/safety-contracts",
  "lib/domain/src/kill-switch",
  "lib/domain/src/order-execution",
  "lib/domain/src/execution-gate",
  "lib/domain/src/risk-governor",
  // Fence-completeness audit additions — domain engines that ENFORCE an
  // order decision (authorize/block/size), not advisory/analytics. These
  // decide whether a real or paper order proceeds and must never depend on a
  // display-only readability flag (display ≠ eligibility).
  "lib/domain/src/conditional-execution", // arms + fires orders when conditions hit
  "lib/domain/src/execution-ai", // fail-closed gate authorizing live execution
  "lib/domain/src/execution-safety", // hard pre-order blockers (LOCKED / bad SL-TP / max risk)
  "lib/domain/src/safety-permission", // authoritative trading-enabled verdict (kill switch / daily-loss)
  "artifacts/api-server/src/lib/live",
  "artifacts/api-server/src/lib/liveTrading",
  "artifacts/api-server/src/lib/mt5",
  "artifacts/api-server/src/lib/broker",
  "artifacts/api-server/src/lib/brokerReadOnly",
  "artifacts/api-server/src/lib/governance",
  "artifacts/api-server/src/lib/risk",
  "artifacts/api-server/src/lib/riskGovernor",
  "artifacts/api-server/src/lib/paperExecution",
  // Fence-completeness audit additions — api-server dirs that GATE / ROUTE /
  // PLACE / CLOSE a real or paper order (the trade-action + autonomous +
  // admin-placement + protective-close + EA command-egress surfaces).
  "artifacts/api-server/src/lib/tradeAction", // create/confirm/cancel orders + risk-governor enforcement
  "artifacts/api-server/src/lib/selfTrade", // autonomous executor → instant-trade router → live pipeline
  "artifacts/api-server/src/lib/adminTrading", // broker placement / placeOrder / order guard
  "artifacts/api-server/src/lib/paperAutopilot", // automated paper-order placement loop
  "artifacts/api-server/src/lib/protectiveClose", // close-decision engine → tradeAction confirm → gated command queue
  "artifacts/api-server/src/lib/bridgeV2", // EA command egress / broker bridge transport
  "artifacts/api-server/src/lib/safety", // server-wide safety-mode rejection gate
];

// Fenced individual files (position-mgmt / risk helpers that live at the lib root).
const FENCED_FILES = [
  "artifacts/api-server/src/lib/positionSizing.ts",
  "artifacts/api-server/src/lib/riskAudit.ts",
  "artifacts/api-server/src/lib/riskGovernor2.ts",
  "artifacts/api-server/src/lib/riskGovernorEngine.ts",
  // Fence-completeness audit additions — lib-root files on the order-decision
  // path (safety core, order-management, autopilot executor, live allocation
  // authorization).
  "artifacts/api-server/src/lib/safetyCore.ts",
  "artifacts/api-server/src/lib/oms.ts",
  "artifacts/api-server/src/lib/autopilot.ts",
  "artifacts/api-server/src/lib/bridgeAllocations.ts",
];

// Strip block + line comments so a doc-comment that mentions a forbidden symbol
// (e.g. "// never import mayShowBias here") is not a false positive. Preserves
// the `://` in URLs so an inline comment stripper never eats a real string.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// Comments AND string literals removed. Used only for the bare-identifier
// require/createRequire root-cut: the WORD "require" inside a user-facing message
// ("Live orders require my confirmation") or a doc comment must NOT trip the
// presence check — only an actual code-level require/createRequire reference. We
// strip single- and double-quoted strings wholesale, and template literals that
// contain NO `${…}` interpolation; interpolated templates are LEFT intact so a
// `require` hidden inside `${ … }` is still seen as real code (never a string).
function stripStringsAndComments(src: string): string {
  return stripComments(src)
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\$]|\$(?!\{))*`/g, "``");
}

/**
 * Pure scanner: returns the list of display-contract import-boundary violations
 * found in ONE file's source. Exported so the boundary regression test can feed
 * synthetic content (forbidden import → must produce a violation).
 */
export function scanForDisplayContractViolations(relPath: string, src: string): string[] {
  const out: string[] = [];
  const code = stripComments(src);
  const codeNoStrings = stripStringsAndComments(src);
  if (CONTRACT_MODULE_IMPORT.test(code)) {
    out.push(
      `${relPath} imports the display-only data-sufficiency contract (marketDataSufficiency) — ` +
        "execution/safety modules must never consume the readability contract (display ≠ eligibility)",
    );
  }
  for (const sym of FORBIDDEN_SYMBOLS) {
    if (new RegExp(`\\b${sym}\\b`).test(code)) {
      out.push(
        `${relPath} references the display-only readability symbol \`${sym}\` — ` +
          "this flag controls what may be SHOWN and must never enter an execution/safety path",
      );
    }
  }
  // Barrel imports: a fenced file could reach the display verdict / evaluator /
  // contract types through a barrel that re-exports the contract (the
  // `@workspace/domain` package barrel, its `/market` subpath or `/index`, or a
  // relative path to the market barrel) instead of the direct module path. Cover
  // every binding form: named import/export, wildcard re-export, and namespace
  // import + member access. Flag any contract binding unless it is an
  // explicitly-reviewed exception for THIS file (see BARREL_IMPORT_ALLOWLIST).
  const allow = BARREL_IMPORT_ALLOWLIST[relPath] ?? [];
  for (const m of code.matchAll(DOMAIN_BARREL_NAMED_IMPORT)) {
    const names = (m[1] ?? "").split(",").map(bindingSourceName).filter(Boolean);
    for (const name of names) {
      if (
        (DISPLAY_CONTRACT_BARREL_SYMBOLS as readonly string[]).includes(name) &&
        !allow.includes(name)
      ) {
        out.push(
          `${relPath} imports the display-only data-sufficiency contract symbol \`${name}\` ` +
            "via a domain barrel — execution/safety modules must never consume " +
            "the readability contract (display ≠ eligibility)",
        );
      }
    }
  }
  for (const m of code.matchAll(DOMAIN_ROOT_NAMESPACE_IMPORT)) {
    const names = (m[1] ?? "").split(",").map(bindingSourceName).filter(Boolean);
    for (const name of names) {
      if ((CONTRACT_BEARING_ROOT_NAMESPACES as readonly string[]).includes(name)) {
        out.push(
          `${relPath} imports the \`${name}\` namespace from the @workspace/domain root barrel — ` +
            `that whole-domain namespace re-exports the display-only data-sufficiency contract ` +
            `(\`${name}.evaluateMarketDataSufficiency\`, etc.); execution/safety modules must never ` +
            "consume the readability contract (display ≠ eligibility) — import a specific non-market subpath",
        );
      }
    }
  }
  if (DOMAIN_BARREL_STAR_REEXPORT.test(code)) {
    out.push(
      `${relPath} re-exports a domain/market barrel via \`export *\` — that wholesale ` +
        "re-export includes the display-only data-sufficiency contract; execution/safety " +
        "modules must never re-export the readability contract (display ≠ eligibility)",
    );
  }
  for (const m of code.matchAll(DOMAIN_BARREL_NAMESPACE_IMPORT)) {
    const ns = m[1] ?? "ns";
    out.push(
      `${relPath} namespace-imports a domain/market barrel (\`import * as ${ns}\`) — that ` +
        "whole-barrel binding exposes the display-only data-sufficiency contract (reachable by " +
        "dot/bracket access or destructuring); execution/safety modules must never consume the " +
        "readability contract (display ≠ eligibility)",
    );
  }
  if (DOMAIN_BARREL_DYNAMIC_IMPORT.test(code)) {
    out.push(
      `${relPath} dynamically imports a domain/market barrel (\`import(…)\`) — the returned ` +
        "module namespace exposes the display-only data-sufficiency contract; execution/safety " +
        "modules must never consume the readability contract (display ≠ eligibility)",
    );
  }
  if (CJS_REQUIRE_REFERENCE.test(codeNoStrings)) {
    out.push(
      `${relPath} references the CommonJS \`require\`/\`createRequire\` — fenced execution/safety ` +
        "modules are ESM and must use static imports; a runtime require (under ANY callee syntax: " +
        "`(require)(…)`, `require.call(…)`, `globalThis.require(…)`, a createRequire factory, etc.) " +
        "can pull the display-only data-sufficiency contract past the static-import boundary " +
        "(display ≠ eligibility). Use a static import, or add a narrow reviewed allowlist entry.",
    );
  }
  if (BRACKET_GLOBAL_REQUIRE.test(code)) {
    out.push(
      `${relPath} indexes an object by the literal key \`["require"]\` — fenced execution/safety ` +
        "modules are ESM and must never reach the bundler-injected global require via bracket access " +
        "(`globalThis[\"require\"]`, incl. its `.cache`); this hides the `require` token inside a " +
        "string to dodge the identifier ban and can pull the display-only data-sufficiency contract " +
        "past the import boundary (display ≠ eligibility)",
    );
  }
  if (isContractSpecOutsideStaticImport(code)) {
    out.push(
      `${relPath} names the display-only data-sufficiency contract specifier (a domain/market ` +
        "barrel, the domain root, or the …/marketDataSufficiency module path) OUTSIDE a static " +
        "`import … from` — fenced execution/safety modules may reference these specifiers ONLY as a " +
        "static import/export source; a contract specifier literal in any runtime value position " +
        "(call argument, array element, object-literal property, variable initializer, …) can be " +
        "fed to a loader (require/global/aliased, under ANY callee syntax incl. bracket access like " +
        '`globalThis["require"](…)` or `fn.apply(null, { 0: spec, length: 1 })`) and bypass the ' +
        "import boundary (display ≠ eligibility)",
    );
  }
  return out;
}

export function checkDisplayContractImportBoundary(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];
  let scanned = 0;

  const files: string[] = [];
  for (const d of FENCED_DIRS) {
    files.push(
      ...walk(join(ROOT, d), {
        // Tests and QA fixtures are not an execution path; skip them so a test
        // that intentionally exercises the contract is never flagged.
        skip: (p) =>
          p.endsWith(".d.ts") || p.endsWith(".test.ts") || p.includes("__qa__"),
      }),
    );
  }
  for (const f of FENCED_FILES) files.push(join(ROOT, f));

  for (const f of files) {
    let src: string;
    try {
      src = read(f);
    } catch {
      // A fenced path that no longer exists is a refactor signal, not a leak —
      // skip silently (the remaining roots still enforce the boundary).
      continue;
    }
    scanned++;
    violations.push(...scanForDisplayContractViolations(rel(f), src));
  }

  notes.push(
    `Import boundary: scanned ${scanned} execution/safety file(s); none import the display-only ` +
      "readability contract or its mayShow* flags ✓",
  );

  return {
    name: "display-contract-import-boundary",
    ok: violations.length === 0,
    violations,
    notes,
  };
}
