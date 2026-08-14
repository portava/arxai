// Regression suite for the display-contract import-boundary CI guard.
//
// Exercises `scanForDisplayContractViolations` against synthetic fenced-module
// snippets. Forbidden imports / `mayShow*` references MUST be flagged; clean
// execution code, doc-comment mentions, similarly-named modules, and URLs MUST
// stay clean. Pure source analysis — no network, DB, or filesystem.

import {
  scanForDisplayContractViolations,
  FENCED_DIRS,
} from "./check-display-contract-import-boundary.js";

export {};

type Case = {
  name: string;
  src: string;
  shouldFlag: boolean;
  // Defaults to a generic fenced live file; override to exercise the file-scoped
  // barrel-import allowlist.
  relPath?: string;
};

const cases: Case[] = [
  // ── Must be flagged (a forbidden display→execution coupling) ───────────────
  {
    name: "named import of a mayShow* flag from the contract module",
    shouldFlag: true,
    src: `import { mayShowBias } from "@workspace/domain/market/marketDataSufficiency.js";
      export const x = mayShowBias;`,
  },
  {
    name: "import of the contract module without a .js extension",
    shouldFlag: true,
    src: `import { evaluateMarketDataSufficiency } from "../../market/marketDataSufficiency";`,
  },
  {
    name: "type-only import of the contract display surface",
    shouldFlag: true,
    src: `import type { MarketDataSufficiencyVerdict } from "@workspace/domain/market/marketDataSufficiency.js";`,
  },
  {
    name: "bare reference to a mayShow* flag with no import line",
    shouldFlag: true,
    src: `function gate(v: { mayShowDirection: boolean }) { return v.mayShowDirection === true; }`,
  },
  {
    name: "reference to the private deriveReadabilityPermissions helper",
    shouldFlag: true,
    src: `const p = deriveReadabilityPermissions("sufficient", "LIVE");`,
  },
  {
    name: "re-export of a flag from the contract module",
    shouldFlag: true,
    src: `export { mayShowTrend } from "../market/marketDataSufficiency.js";`,
  },
  {
    name: "barrel import of the evaluator from the @workspace/domain root",
    shouldFlag: true,
    src: `import { evaluateMarketDataSufficiency } from "@workspace/domain";
      export const e = evaluateMarketDataSufficiency;`,
  },
  {
    name: "barrel type import of the verdict from @workspace/domain/market",
    shouldFlag: true,
    src: `import type { MarketDataSufficiencyVerdict } from "@workspace/domain/market";`,
  },
  {
    name: "aliased barrel import of the evaluator is matched on its source name",
    shouldFlag: true,
    src: `import { evaluateMarketDataSufficiency as suff } from "@workspace/domain/market";
      export const e = suff;`,
  },
  {
    name: "the status TYPE via the barrel is forbidden in a non-allowlisted fenced file",
    shouldFlag: true,
    src: `import type { MarketDataSufficiencyStatus } from "@workspace/domain/market";
      export type S = MarketDataSufficiencyStatus;`,
  },
  {
    name: "namespace import of the market barrel + member access to the evaluator",
    shouldFlag: true,
    src: `import * as domain from "@workspace/domain/market";
      export const e = domain.evaluateMarketDataSufficiency;`,
  },
  {
    name: "wildcard re-export of the market barrel (export *)",
    shouldFlag: true,
    src: `export * from "@workspace/domain/market";`,
  },
  {
    name: "namespaced wildcard re-export of the domain root barrel (export * as ns)",
    shouldFlag: true,
    src: `export * as dom from "@workspace/domain";`,
  },
  {
    name: "named import of the evaluator via the /index.js barrel subpath",
    shouldFlag: true,
    src: `import { evaluateMarketDataSufficiency } from "@workspace/domain/market/index.js";
      export const e = evaluateMarketDataSufficiency;`,
  },
  {
    name: "named import of the evaluator via a relative market barrel directory",
    shouldFlag: true,
    src: `import { evaluateMarketDataSufficiency } from "../market";
      export const e = evaluateMarketDataSufficiency;`,
  },
  {
    name: "namespace import of a contract barrel is flagged unconditionally (whole-barrel binding)",
    shouldFlag: true,
    src: `import * as domain from "@workspace/domain/market";
      export const a = domain.isApprovedArxMarket;`,
  },
  {
    name: "namespace binding reached by destructuring is caught (import is flagged)",
    shouldFlag: true,
    src: `import * as d from "@workspace/domain/market";
      const { evaluateMarketDataSufficiency } = d;
      export const e = evaluateMarketDataSufficiency;`,
  },
  {
    name: "namespace binding reached by bracket access is caught (import is flagged)",
    shouldFlag: true,
    src: `import * as d from "@workspace/domain/market";
      export const e = d["evaluateMarketDataSufficiency"];`,
  },
  {
    name: "type-only namespace import of a contract barrel is flagged",
    shouldFlag: true,
    src: `import type * as d from "@workspace/domain/market";
      export type V = d.MarketDataSufficiencyVerdict;`,
  },
  {
    name: "dynamic import of a contract barrel is flagged",
    shouldFlag: true,
    src: `export async function load() {
        const d = await import("@workspace/domain/market");
        return d.evaluateMarketDataSufficiency;
      }`,
  },
  {
    name: "dynamic import of the direct contract module path is flagged",
    shouldFlag: true,
    src: `export async function load() {
        const d = await import("../market/marketDataSufficiency.js");
        return d.evaluateMarketDataSufficiency;
      }`,
  },
  {
    name: "named import of the `market` namespace from the @workspace/domain root barrel",
    shouldFlag: true,
    src: `import { market } from "@workspace/domain";
      export const e = market.evaluateMarketDataSufficiency;`,
  },
  {
    name: "re-export of the `market` namespace from the domain root barrel",
    shouldFlag: true,
    src: `export { market } from "@workspace/domain";`,
  },
  {
    name: "aliased `market` namespace import from the domain root is matched on its source name",
    shouldFlag: true,
    src: `import { market as m } from "@workspace/domain";
      export const e = m.evaluateMarketDataSufficiency;`,
  },
  {
    name: "`market` namespace import via a relative domain root index barrel",
    shouldFlag: true,
    src: `import { market } from "../index.js";
      export const e = market.evaluateMarketDataSufficiency;`,
  },
  {
    name: "multiline type-only import of the contract module is flagged",
    shouldFlag: true,
    src: `import type {
        MarketDataSufficiencyVerdict
      } from "@workspace/domain/market/marketDataSufficiency.js";
      export type V = MarketDataSufficiencyVerdict;`,
  },
  {
    name: "multiline dynamic import of the direct contract module path is flagged",
    shouldFlag: true,
    src: `export async function load() {
        const d = await import(
          "../market/marketDataSufficiency.js"
        );
        return d.evaluateMarketDataSufficiency;
      }`,
  },
  {
    name: "`market` namespace import via the bare relative domain root (`..`)",
    shouldFlag: true,
    src: `import { market } from "..";
      export const e = market.evaluateMarketDataSufficiency;`,
  },
  {
    name: "static template-literal dynamic import of the market barrel is flagged",
    shouldFlag: true,
    src: `export async function load() {
        const d = await import(\`@workspace/domain/market\`);
        return d.evaluateMarketDataSufficiency;
      }`,
  },
  {
    name: "static template-literal dynamic import of the direct contract module is flagged",
    shouldFlag: true,
    src: `export async function load() {
        const d = await import(\`../market/marketDataSufficiency.js\`);
        return d.evaluateMarketDataSufficiency;
      }`,
  },
  {
    name: "require() of the contract barrel is flagged (CJS escape)",
    shouldFlag: true,
    src: `const market = require("@workspace/domain/market");
      module.exports.e = market.evaluateMarketDataSufficiency;`,
  },
  {
    name: "require() of the direct contract module path is flagged",
    shouldFlag: true,
    src: `const m = require("../market/marketDataSufficiency.js");
      module.exports.e = m.evaluateMarketDataSufficiency;`,
  },
  {
    name: "require() of the bare-parent domain root is flagged",
    shouldFlag: true,
    src: `const { market } = require("..");
      module.exports.e = market.evaluateMarketDataSufficiency;`,
  },
  {
    name: "createRequire(import.meta.url)(barrel) inline form is flagged",
    shouldFlag: true,
    src: `import { createRequire } from "node:module";
      const market = createRequire(import.meta.url)("@workspace/domain/market");
      export const e = market.evaluateMarketDataSufficiency;`,
  },
  {
    name: "createRequire two-statement form (assigned require) is flagged",
    shouldFlag: true,
    src: `import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      const market = require("@workspace/domain/market");
      export const e = market.evaluateMarketDataSufficiency;`,
  },
  {
    name: "namespace import of the bare-parent domain root is flagged",
    shouldFlag: true,
    src: `import * as domain from "..";
      export const e = domain.market.evaluateMarketDataSufficiency;`,
  },
  {
    name: "createRequire aliased to a non-`require` name (barrel) is flagged",
    shouldFlag: true,
    src: `import { createRequire } from "node:module";
      const req = createRequire(import.meta.url);
      const market = req("@workspace/domain/market");
      export const e = market.evaluateMarketDataSufficiency;`,
  },
  {
    name: "createRequire alias (different name) of the direct contract module is flagged",
    shouldFlag: true,
    src: `import { createRequire } from "node:module";
      const cjsRequire = createRequire(import.meta.url);
      const m = cjsRequire("../market/marketDataSufficiency.js");
      export const e = m.evaluateMarketDataSufficiency;`,
  },
  {
    name: "createRequire alias of the bare-parent domain root is flagged",
    shouldFlag: true,
    src: `import { createRequire } from "node:module";
      const req = createRequire(import.meta.url);
      const { market } = req("..");
      export const e = market.evaluateMarketDataSufficiency;`,
  },
  {
    name: "aliasing the createRequire FACTORY itself (import { createRequire as mk }) is flagged",
    shouldFlag: true,
    src: `import { createRequire as makeRequire } from "node:module";
      const req = makeRequire(import.meta.url);
      const market = req("@workspace/domain/market");
      export const e = market.evaluateMarketDataSufficiency;`,
  },
  {
    name: "rebinding the bare `require` global then requiring the contract barrel is flagged",
    shouldFlag: true,
    src: `const r = require;
      const market = r("@workspace/domain/market");
      module.exports.e = market.evaluateMarketDataSufficiency;`,
  },

  // ── Phase-3 trade-health / readiness contract — same boundary ──────────────
  {
    name: "named import of an affordance flag from the trade-health contract module",
    shouldFlag: true,
    src: `import { mayShowTradeButton } from "../market/tradeHealthReadinessContract.js";
      export const x = mayShowTradeButton;`,
  },
  {
    name: "import of the trade-health contract module without a .js extension",
    shouldFlag: true,
    src: `import { evaluateTradeHealthReadiness } from "../../market/tradeHealthReadinessContract";`,
  },
  {
    name: "bare reference to a Phase-3 affordance ceiling with no import line",
    shouldFlag: true,
    src: `function gate(v: { mayShowOneClickButton: boolean }) { return v.mayShowOneClickButton === true; }`,
  },
  {
    name: "reference to the private deriveTradeHealthReadinessPermissions helper",
    shouldFlag: true,
    src: `const p = deriveTradeHealthReadinessPermissions({ liveConfirmedRead: true });`,
  },
  {
    name: "barrel import of the trade-health evaluator from @workspace/domain/market",
    shouldFlag: true,
    src: `import { evaluateTradeHealthReadiness } from "@workspace/domain/market";
      export const e = evaluateTradeHealthReadiness;`,
  },
  {
    name: "barrel type import of the trade-health verdict from the domain root",
    shouldFlag: true,
    src: `import type { TradeHealthReadinessVerdict } from "@workspace/domain";
      export type V = TradeHealthReadinessVerdict;`,
  },
  {
    name: "dynamic import of the direct trade-health contract module path is flagged",
    shouldFlag: true,
    src: `export async function load() {
        const d = await import("../market/tradeHealthReadinessContract.js");
        return d.evaluateTradeHealthReadiness;
      }`,
  },
  {
    name: "a similarly-named trade-health helper module is NOT the contract",
    shouldFlag: false,
    src: `import { foo } from "../market/tradeHealthReadinessContractHelper.js";
      export const f = foo;`,
  },

  // ── Trendline-truth display / decision-support contract — same boundary ─────
  {
    name: "named import of the trendline resolver from the contract module",
    shouldFlag: true,
    src: `import { resolveTrendlineTruth } from "../market/trendlineTruthContract.js";
      export const r = resolveTrendlineTruth;`,
  },
  {
    name: "import of the trendline contract module without a .js extension",
    shouldFlag: true,
    src: `import { resolveTrendlineTruth } from "../../market/trendlineTruthContract";`,
  },
  {
    name: "type-only import of the trendline verdict from the contract module",
    shouldFlag: true,
    src: `import type { TrendlineTruthVerdict } from "@workspace/domain/market/trendlineTruthContract.js";`,
  },
  {
    name: "barrel import of the trendline resolver from @workspace/domain/market",
    shouldFlag: true,
    src: `import { resolveTrendlineTruth } from "@workspace/domain/market";
      export const r = resolveTrendlineTruth;`,
  },
  {
    name: "barrel type import of the trendline verdict from the domain root",
    shouldFlag: true,
    src: `import type { TrendlineTruthVerdict } from "@workspace/domain";
      export type V = TrendlineTruthVerdict;`,
  },
  {
    name: "dynamic import of the direct trendline contract module path is flagged",
    shouldFlag: true,
    src: `export async function load() {
        const d = await import("../market/trendlineTruthContract.js");
        return d.resolveTrendlineTruth;
      }`,
  },
  {
    name: "a similarly-named trendline helper module is NOT the contract",
    shouldFlag: false,
    src: `import { foo } from "../market/trendlineTruthContractHelper.js";
      export const f = foo;`,
  },

  // ── Strategy Intelligence Upgrade — six child Truth contracts + the ─────────
  // composing market-intelligence snapshot. DISPLAY / decision-support only;
  // a fenced execution/safety module must never reach any of them.
  {
    name: "named import of the pivot resolver from the contract module",
    shouldFlag: true,
    src: `import { resolvePivotTruth } from "../market/pivotTruthContract.js";
      export const r = resolvePivotTruth;`,
  },
  {
    name: "barrel import of the pivot resolver from @workspace/domain/market",
    shouldFlag: true,
    src: `import { resolvePivotTruth } from "@workspace/domain/market";
      export const r = resolvePivotTruth;`,
  },
  {
    name: "named import of the direction resolver from the contract module",
    shouldFlag: true,
    src: `import { resolveDirectionTruth } from "../../market/directionTruthContract";
      export const r = resolveDirectionTruth;`,
  },
  {
    name: "type-only barrel import of the direction verdict from the domain root",
    shouldFlag: true,
    src: `import type { DirectionTruthVerdict } from "@workspace/domain";
      export type V = DirectionTruthVerdict;`,
  },
  {
    name: "named import of the entry resolver from the contract module",
    shouldFlag: true,
    src: `import { resolveEntryTruth } from "../market/entryTruthContract.js";
      export const r = resolveEntryTruth;`,
  },
  {
    name: "named import of the order-flow resolver from the contract module",
    shouldFlag: true,
    src: `import { resolveOrderFlowTruth } from "../market/orderFlowTruthContract.js";
      export const r = resolveOrderFlowTruth;`,
  },
  {
    name: "dynamic import of the direct timing contract module path is flagged",
    shouldFlag: true,
    src: `export async function load() {
        const d = await import("../market/timingTruthContract.js");
        return d.resolveTimingTruth;
      }`,
  },
  {
    name: "named import of the confluence resolver from the contract module",
    shouldFlag: true,
    src: `import { resolveConfluence } from "../market/confluenceTruthContract.js";
      export const r = resolveConfluence;`,
  },
  {
    name: "barrel import of the snapshot composer from @workspace/domain/market",
    shouldFlag: true,
    src: `import { composeMarketIntelligenceSnapshot } from "@workspace/domain/market";
      export const c = composeMarketIntelligenceSnapshot;`,
  },
  {
    name: "type-only barrel import of the MarketIntelligenceSnapshot from the domain root",
    shouldFlag: true,
    src: `import type { MarketIntelligenceSnapshot } from "@workspace/domain";
      export type S = MarketIntelligenceSnapshot;`,
  },
  {
    name: "barrel import of the StrategyVerdict deriver from the market barrel",
    shouldFlag: true,
    src: `import { deriveStrategyVerdict } from "@workspace/domain/market";
      export const d = deriveStrategyVerdict;`,
  },
  {
    name: "a similarly-named market-intelligence helper module is NOT the contract",
    shouldFlag: false,
    src: `import { foo } from "../market/marketIntelligenceContractHelper.js";
      export const f = foo;`,
  },

  // ── Must stay clean (no display→execution coupling) ────────────────────────
  {
    name: "named import of a NON-market namespace from the domain root is not the contract",
    shouldFlag: false,
    src: `import { killSwitch } from "@workspace/domain";
      export const k = killSwitch;`,
  },
  {
    name: "dynamic import of a non-contract market module is not the contract",
    shouldFlag: false,
    src: `export async function load() {
        const d = await import("../market/symbolRegistry.js");
        return d.resolveSymbol;
      }`,
  },
  {
    name: "wildcard re-export of a non-barrel safety module is not the contract",
    shouldFlag: false,
    src: `export * from "../safety-contracts/syntheticLiveFloor.js";`,
  },
  {
    name: "barrel import of the ARX-focus allowlist (not the display contract)",
    shouldFlag: false,
    src: `import { isApprovedArxMarket, ARX_FOCUS_BLOCKED_REASON } from "@workspace/domain/market";
      export const a = isApprovedArxMarket;`,
  },
  {
    name: "allowlisted live ENTRY adapter may import the status TYPE via the barrel",
    shouldFlag: false,
    relPath: "artifacts/api-server/src/lib/live/entryDataSufficiency.ts",
    src: `import type { MarketDataSufficiencyStatus } from "@workspace/domain/market";
      export type S = MarketDataSufficiencyStatus;`,
  },
  {
    name: "bare require of even a node builtin is forbidden in a fenced ESM module (root-cut)",
    shouldFlag: true,
    src: `const fs = require("node:fs");
      module.exports.read = fs.readFileSync;`,
  },
  {
    name: "require under a non-call callee syntax (require)(contract) is flagged (root-cut)",
    shouldFlag: true,
    src: `const market = (require)("@workspace/domain/market");
      module.exports.e = market.evaluateMarketDataSufficiency;`,
  },
  {
    name: "require.call(null, contract) method-call form is flagged (root-cut)",
    shouldFlag: true,
    src: `const market = require.call(null, "@workspace/domain/market");
      module.exports.e = market.evaluateMarketDataSufficiency;`,
  },
  {
    name: "createRequire is forbidden outright even when requiring a NON-contract module (root-cut)",
    shouldFlag: true,
    src: `import { createRequire } from "node:module";
      const req = createRequire(import.meta.url);
      const pkg = req("../market/symbolRegistry.js");
      export const r = pkg.resolveSymbol;`,
  },
  {
    name: "contract barrel specifier passed to a NON-require loader fn is flagged (runtime-arg root-cut)",
    shouldFlag: true,
    src: `const req = makeLoader();
      const market = req("@workspace/domain/market");
      export const e = market.evaluateMarketDataSufficiency;`,
  },
  {
    name: "bracket access to the global require with the contract barrel string is flagged (runtime-arg)",
    shouldFlag: true,
    src: `const market = (globalThis as any)["require"]("@workspace/domain/market");
      module.exports.e = market["evaluateMarketDataSufficiency"];`,
  },
  {
    name: "single-quoted globalThis['require'] bracket access to the contract is flagged (runtime-arg)",
    shouldFlag: true,
    src: `const m = globalThis['require']('../market/marketDataSufficiency.js');
      module.exports.e = m.evaluateMarketDataSufficiency;`,
  },
  {
    name: "Function.prototype.apply array-element form ([contract]) is flagged (spec-position)",
    shouldFlag: true,
    src: `const loader = (globalThis as any).require;
      const market = loader.apply(null, ["@workspace/domain/market"]);
      module.exports.e = market.evaluateMarketDataSufficiency;`,
  },
  {
    name: "apply with an array-LIKE object literal (spec in property value) is flagged (spec-position)",
    shouldFlag: true,
    src: `const r = (globalThis as any)["require"];
      const market = r.apply(null, { 0: "@workspace/domain/market", length: 1 });
      module.exports.e = market["evaluateMarketDataSufficiency"];`,
  },
  {
    name: "contract specifier stashed in a variable initializer (not an import) is flagged (spec-position)",
    shouldFlag: true,
    src: `const SPEC = "../market/marketDataSufficiency.js";
      export const where = SPEC;`,
  },
  {
    name: "side-effect contract import + globalThis['require'].cache walk is flagged",
    shouldFlag: true,
    src: `import "@workspace/domain/market";
      const cache = (globalThis as any)["require"].cache as Record<string, { exports: any }>;
      const market = Object.values(cache).map((m) => m.exports).find((e) => e?.evaluateMarketDataSufficiency);
      export const e = market.evaluateMarketDataSufficiency;`,
  },
  {
    name: "bare bracket access to the global require (no contract specifier literal) is flagged",
    shouldFlag: true,
    src: `const req = (globalThis as any)['require'];
      const cache = req.cache as Record<string, { exports: any }>;
      export const e = Object.values(cache)[0];`,
  },
  {
    name: "tagged-template on an identifier named `from` (backtick contract literal) is flagged",
    shouldFlag: true,
    src: `const from = (s: TemplateStringsArray) => import(s[0]!);
      const market = await from\`@workspace/domain/market\`;
      export const e = market.evaluateMarketDataSufficiency;`,
  },
  {
    name: "backtick contract literal as a runtime call argument is flagged (never a static import source)",
    shouldFlag: true,
    src: `const load = (s: string) => (globalThis as any).x(s);
      export const e = load(\`../market/marketDataSufficiency.js\`);`,
  },
  {
    name: "an unrelated loader fn invoked with a NON-contract specifier stays clean",
    shouldFlag: false,
    src: `const req = makeLoader();
      const sib = req("../market/symbolRegistry.js");
      export const e = sib.resolveSymbol;`,
  },
  {
    name: "side-effect static import of the ARX-focus barrel (non-contract members) stays clean",
    shouldFlag: false,
    src: `import { isApprovedArxMarket } from "@workspace/domain/market";
      export const ok = isApprovedArxMarket;`,
  },
  {
    name: "the WORD 'require' inside a user-facing string is NOT a require reference",
    shouldFlag: false,
    src: `export const MSG = "Live orders always require my explicit confirmation.";`,
  },
  {
    name: "domain identifiers like requireTakeProfit / required are not the require global",
    shouldFlag: false,
    src: `export function gate(p: { requireTakeProfit: boolean }) {
        const required = p.requireTakeProfit;
        return required;
      }`,
  },
  {
    name: "line-comment mentioning a forbidden symbol",
    shouldFlag: false,
    src: `// NOTE: execution code must never import mayShowBias from marketDataSufficiency.
      export const ok = true;`,
  },
  {
    name: "block-comment quoting a forbidden import",
    shouldFlag: false,
    src: `/* do NOT: import { mayShowBias } from "../market/marketDataSufficiency.js" */
      export const ok = true;`,
  },
  {
    name: "legitimate safety import (syntheticLiveFloor), no display contract",
    shouldFlag: false,
    src: `import { evaluateSymbolFeedVerdict } from "../safety-contracts/syntheticLiveFloor.js";
      export const v = evaluateSymbolFeedVerdict;`,
  },
  {
    name: "similarly-named module is not the display contract",
    shouldFlag: false,
    src: `import { foo } from "../market/marketDataSufficiencyHelper.js";
      export const f = foo;`,
  },
  {
    name: "URL containing :// is not mistaken for a comment or import",
    shouldFlag: false,
    src: `const docs = "https://example.com/marketDataSufficiency.js";
      export const u = docs;`,
  },
];

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const label = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  ${label}  ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log("\ndisplay-contract-import-boundary guard — regression suite");
for (const c of cases) {
  const flags = scanForDisplayContractViolations(
    c.relPath ?? "artifacts/api-server/src/lib/live/fake.ts",
    c.src,
  );
  const flagged = flags.length > 0;
  const ok = flagged === c.shouldFlag;
  record(
    c.name,
    ok,
    ok
      ? c.shouldFlag
        ? `flagged (${flags.length})`
        : "clean"
      : c.shouldFlag
        ? "expected a violation but got none"
        : `expected clean but got: ${flags[0]}`,
  );
}

// Structural regression: the T7-named execution/safety domains must stay inside
// the fence. A future edit dropping one would silently stop scanning that whole
// domain, so the scan precision above would no longer protect it.
const REQUIRED_FENCED_DIRS = [
  "lib/domain/src/safety-contracts",
  "lib/domain/src/kill-switch",
  "lib/domain/src/order-execution",
  "lib/domain/src/execution-gate",
  "lib/domain/src/risk-governor",
  "artifacts/api-server/src/lib/live",
  "artifacts/api-server/src/lib/liveTrading",
];
for (const dir of REQUIRED_FENCED_DIRS) {
  const covered = (FENCED_DIRS as readonly string[]).includes(dir);
  record(`FENCED_DIRS covers ${dir}`, covered, covered ? "fenced" : "NOT fenced");
}

const failed = results.filter((r) => !r.ok).length;
console.log(
  `\n${results.length - failed}/${results.length} display-contract-import-boundary cases passed`,
);
process.exit(failed === 0 ? 0 : 1);
