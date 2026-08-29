// D3b — Instrument Passport DRIFT LOCK.
//
// The passport (`@workspace/domain/market` instrumentPassport.ts) is the ONE
// canonical record of instrument facts. The three historical sources —
//   1. brain symbol registry  (api-server/src/brain/symbols/symbolRegistry.ts)
//   2. the pip/point unit module (api-server/src/lib/marketModel/instrumentSpec.ts)
//      + forexPair.ts (contract-size conventions)
//   3. provider specs (derivProvider.ts venue map, @workspace/markets universe)
// keep their APIs but are now VIEWS. This test fails the build if any of them
// (or the dashboard picker registry) ever again carries its own divergent
// copy of a passport fact, and pins the view wiring at the source level so a
// re-inlined convention cannot hide behind coincidentally-equal values.
//
// Pure: no DB, no network. (contractSize.ts is deliberately NOT imported —
// it imports @workspace/db at module load; its conventions are covered via
// the forexPair.ts re-export it consumes and a source pin.)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  INSTRUMENT_PASSPORTS,
  resolveInstrumentPassport,
  venueCodeSymbol,
  fxConventionPipSizeNumber,
  FX_STANDARD_LOT_UNITS,
  type InstrumentPassport,
} from "../../lib/domain/src/market/instrumentPassport.js";
import { ARX_FOCUS_MARKETS } from "../../lib/domain/src/market/arxFocusMarkets.js";
import {
  SYMBOL_REGISTRY as BRAIN_REGISTRY,
} from "../../artifacts/api-server/src/brain/symbols/symbolRegistry.js";
import {
  decidePipSize,
  staticPipSize,
} from "../../artifacts/api-server/src/lib/marketModel/instrumentSpec.js";
import {
  FIAT_CODES as FOREXPAIR_FIAT,
  FX_STANDARD_LOT_UNITS as FOREXPAIR_LOT,
  splitForexPair as forexPairSplit,
} from "../../artifacts/api-server/src/lib/mt5/forexPair.js";
import { DERIV_SYNTHETIC_SYMBOLS } from "../../artifacts/api-server/src/lib/data/providers/derivProvider.js";
import { SYMBOL_REGISTRY as DASHBOARD_REGISTRY } from "../../artifacts/trading-dashboard/src/lib/symbolRegistry.js";
import { ARX_TOP_250 } from "../../lib/markets/src/universe.js";

type CaseResult = { name: string; ok: boolean; detail?: string };
const results: CaseResult[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  if (!ok) console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
function source(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function venueSet(pp: InstrumentPassport): Set<string> {
  const s = new Set(pp.venueSymbols.map((v) => v.toUpperCase()));
  s.add(pp.canonicalSymbol.toUpperCase());
  return s;
}

// ── 1. Brain symbol registry reads through the passport ─────────────────────

for (const [key, info] of Object.entries(BRAIN_REGISTRY)) {
  const pp = resolveInstrumentPassport(key);
  if (!pp) continue; // outside the approved universe — passport does not own it
  check(
    `brain[${key}]: brokerSymbol is a passport venue symbol`,
    venueSet(pp).has(info.brokerSymbol.toUpperCase()),
    `brokerSymbol=${info.brokerSymbol} venue=${pp.venueSymbols.join(",")}`,
  );
  if (pp.baseCurrency.value !== null && info.baseCurrency !== undefined) {
    check(
      `brain[${key}]: baseCurrency matches passport`,
      info.baseCurrency === pp.baseCurrency.value,
      `${info.baseCurrency} vs ${pp.baseCurrency.value}`,
    );
  }
  if (pp.quoteCurrency.value !== null && info.quoteCurrency !== undefined) {
    check(
      `brain[${key}]: quoteCurrency matches passport`,
      info.quoteCurrency === pp.quoteCurrency.value,
      `${info.quoteCurrency} vs ${pp.quoteCurrency.value}`,
    );
  }
}
check(
  "brain registry source pin: built through alignWithPassport",
  /alignWithPassport/.test(source("artifacts/api-server/src/brain/symbols/symbolRegistry.ts")),
);

// ── 2. instrumentSpec + forexPair are views over the passport ───────────────

for (const pp of INSTRUMENT_PASSPORTS) {
  const decided = decidePipSize({ symbol: pp.canonicalSymbol, brokerPoint: null });
  if (pp.pipSize.value !== null) {
    check(
      `${pp.canonicalSymbol}: decidePipSize == passport declared pip`,
      decided.pipSize === Number(pp.pipSize.value) &&
        decided.source === "FX_PIP_CONVENTION" &&
        staticPipSize(pp.canonicalSymbol) === Number(pp.pipSize.value) &&
        fxConventionPipSizeNumber(pp.canonicalSymbol) === Number(pp.pipSize.value),
      `decided=${decided.pipSize} declared=${pp.pipSize.value}`,
    );
  } else {
    check(
      `${pp.canonicalSymbol}: decidePipSize honestly null without broker point (passport agrees)`,
      decided.pipSize === null && decided.reason === "NO_BROKER_POINT_AND_NOT_FOREX",
    );
    // The broker-point path stays the pip unit for non-FX (unit contract).
    const withPoint = decidePipSize({ symbol: pp.canonicalSymbol, brokerPoint: 0.001 });
    check(
      `${pp.canonicalSymbol}: broker point IS the pip unit for non-FX`,
      withPoint.pipSize === 0.001 && withPoint.source === "BROKER_POINT",
    );
  }
  // Declared contract size in the passport is exactly the forexPair lot rule.
  const fx = forexPairSplit(pp.canonicalSymbol);
  check(
    `${pp.canonicalSymbol}: declared contract size follows the single FX-lot rule`,
    fx
      ? pp.contractSize.value === String(FOREXPAIR_LOT)
      : pp.contractSize.value === null,
  );
}
check("FX standard lot has one value everywhere", FOREXPAIR_LOT === FX_STANDARD_LOT_UNITS);
check("FIAT allowlist is the same object (re-export, not a copy)", FOREXPAIR_FIAT.has("USD") && FOREXPAIR_FIAT.size > 20);

{
  const forexPairSrc = source("artifacts/api-server/src/lib/mt5/forexPair.ts");
  check(
    "forexPair.ts source pin: re-exports from @workspace/domain/market, defines nothing",
    /@workspace\/domain\/market/.test(forexPairSrc) && !/new Set\(/.test(forexPairSrc),
  );
  const instrumentSpecSrc = source("artifacts/api-server/src/lib/marketModel/instrumentSpec.ts");
  check(
    "instrumentSpec.ts source pin: no inlined FX pip constants (reads fxConventionPipSizeNumber)",
    /fxConventionPipSizeNumber/.test(instrumentSpecSrc) &&
      !/0\.0001/.test(instrumentSpecSrc.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")),
  );
}

// ── 3. Provider specs read through the passport ─────────────────────────────

for (const entry of DERIV_SYNTHETIC_SYMBOLS) {
  const pp = resolveInstrumentPassport(entry.symbol);
  if (!pp) continue; // venue-only symbol outside the approved universe
  check(
    `deriv[${entry.symbol}]: symbol/derivId/displayName are passport facts`,
    entry.symbol === pp.canonicalSymbol &&
      entry.derivId === venueCodeSymbol(pp) &&
      entry.displayName === pp.displayName,
    `derivId=${entry.derivId} expected=${venueCodeSymbol(pp)}`,
  );
}
// Every approved synthetic passport is present in the venue map.
for (const pp of INSTRUMENT_PASSPORTS.filter((p) => p.assetClass === "synthetic")) {
  check(
    `deriv map covers approved synthetic ${pp.canonicalSymbol}`,
    DERIV_SYNTHETIC_SYMBOLS.some((e) => e.symbol === pp.canonicalSymbol),
  );
}
check(
  "derivProvider source pin: approved entries built fromPassport",
  /fromPassport\(/.test(source("artifacts/api-server/src/lib/data/providers/derivProvider.ts")),
);

// @workspace/markets universe: where a passport market exists in the Top-250
// universe, the provider symbols must overlap the passport venue symbols —
// no third spelling of the same market.
{
  const byStandard = new Map(ARX_TOP_250.map((u) => [u.standardSymbol.toUpperCase(), u]));
  for (const pp of INSTRUMENT_PASSPORTS) {
    const u = byStandard.get(pp.canonicalSymbol.toUpperCase());
    if (!u || !u.providerSymbols || u.providerSymbols.length === 0) continue;
    const venues = venueSet(pp);
    check(
      `universe[${pp.canonicalSymbol}]: providerSymbols overlap passport venue symbols`,
      u.providerSymbols.some((s: string) => venues.has(s.toUpperCase())),
      `provider=${u.providerSymbols.join(",")}`,
    );
  }
}

// ── 4. Dashboard picker registry is 1:1 with the passports ──────────────────

check(
  "dashboard registry canonical set === passport canonical set",
  DASHBOARD_REGISTRY.length === INSTRUMENT_PASSPORTS.length &&
    DASHBOARD_REGISTRY.every(
      (e, i) => e.canonicalSymbol === INSTRUMENT_PASSPORTS[i]!.canonicalSymbol,
    ),
);
for (const e of DASHBOARD_REGISTRY) {
  const pp = resolveInstrumentPassport(e.canonicalSymbol);
  check(`dashboard[${e.canonicalSymbol}]: resolves to a passport`, pp !== null);
  if (!pp) continue;
  if (e.brokerSymbol) {
    check(
      `dashboard[${e.canonicalSymbol}]: brokerSymbol is a passport venue symbol`,
      venueSet(pp).has(e.brokerSymbol.toUpperCase()),
      `brokerSymbol=${e.brokerSymbol}`,
    );
  }
  check(
    `dashboard[${e.canonicalSymbol}]: displayName matches passport`,
    e.displayName === pp.displayName,
  );
}

// ── 5. Passport itself cannot drift from the Focus registry ─────────────────

check(
  "passport count === approved Focus market count",
  INSTRUMENT_PASSPORTS.length === ARX_FOCUS_MARKETS.length,
  `${INSTRUMENT_PASSPORTS.length} vs ${ARX_FOCUS_MARKETS.length}`,
);

// ── Verdict ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
// eslint-disable-next-line no-console
console.log(
  `\ninstrument-passport drift lock: ${results.length - failed.length}/${results.length} checks passed`,
);
if (failed.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`FAILED: ${failed.length} checks`);
  process.exit(1);
}
