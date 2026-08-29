// D3b — Instrument Passport: registry closure + UNIT CLOSURE property test.
//
// Proves, for EVERY passport entry, that the unit conversion chain
//
//   price points → pips → quote-currency P&L → integer minor units
//                  (via @workspace/money)     → back → identical pips/points
//
// round-trips EXACTLY (bigint equality, no epsilon), and that an inexact or
// under-specified conversion is REFUSED with a typed reason instead of being
// rounded or guessed. This makes the 100,000× P&L class of bug (an FX
// contract size applied to a non-FX instrument, or a unit silently invented)
// structurally impossible: there is no code path that produces a currency
// amount without a complete, provenance-tagged unit chain.
//
// Pure: no DB, no network. Broker-reported fields are exercised with a grid
// of representative FIXTURE specs (labelled as such — the shipped passport
// keeps them null with provenance BROKER_REPORTED).

import { ARX_FOCUS_MARKETS } from "../../lib/domain/src/market/arxFocusMarkets.js";
import {
  INSTRUMENT_PASSPORTS,
  resolveInstrumentPassport,
  getInstrumentPassport,
  completeUnitChain,
  pipsToPriceDelta,
  priceDeltaToPips,
  pointsToPriceDelta,
  priceDeltaToPoints,
  pipsToQuotePnl,
  quotePnlToPips,
  parseExactDec,
  decToString,
  decEquals,
  fxConventionPipSize,
  splitForexPair,
  FX_STANDARD_LOT_UNITS,
  type BrokerReportedSpec,
  type InstrumentPassport,
  type UnitChain,
} from "../../lib/domain/src/market/instrumentPassport.js";
import { Money, scaleForCurrency } from "../../lib/money/src/index.js";

type CaseResult = { name: string; ok: boolean; detail?: string };
const results: CaseResult[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  if (!ok) console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

// Deterministic PRNG (mulberry32) so a failure is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xd3b);
function randPips(): bigint {
  // Signed, up to ~1e9 pips — far beyond any real move, still exact.
  const mag = BigInt(Math.floor(rand() * 1_000_000_000));
  return rand() < 0.5 ? -mag : mag;
}

// ── 1. Registry closure: exactly one passport per approved market ───────────

check(
  "one passport per approved Focus market (1:1, same order)",
  INSTRUMENT_PASSPORTS.length === ARX_FOCUS_MARKETS.length &&
    INSTRUMENT_PASSPORTS.every(
      (p, i) => p.canonicalSymbol === ARX_FOCUS_MARKETS[i]!.canonicalSymbol,
    ),
  `${INSTRUMENT_PASSPORTS.length} passports vs ${ARX_FOCUS_MARKETS.length} markets`,
);
check(
  "no duplicate canonical symbols",
  new Set(INSTRUMENT_PASSPORTS.map((p) => p.canonicalSymbol.toUpperCase())).size ===
    INSTRUMENT_PASSPORTS.length,
);
for (const mk of ARX_FOCUS_MARKETS) {
  const byCanonical = resolveInstrumentPassport(mk.canonicalSymbol);
  check(
    `resolvable by canonical: ${mk.canonicalSymbol}`,
    byCanonical?.canonicalSymbol === mk.canonicalSymbol,
  );
  for (const alias of mk.mt5Aliases) {
    check(
      `resolvable by venue spelling: ${alias} → ${mk.canonicalSymbol}`,
      resolveInstrumentPassport(alias)?.canonicalSymbol === mk.canonicalSymbol,
    );
  }
}

// ── 2. Provenance honesty: broker truth is never invented statically ────────

for (const pp of INSTRUMENT_PASSPORTS) {
  const fx = splitForexPair(pp.canonicalSymbol);
  if (fx) {
    check(
      `${pp.canonicalSymbol}: FX pip/contract/quote are DECLARED`,
      pp.pipSize.provenance === "DECLARED" &&
        pp.pipSize.value === fxConventionPipSize(pp.canonicalSymbol) &&
        pp.contractSize.provenance === "DECLARED" &&
        pp.contractSize.value === String(FX_STANDARD_LOT_UNITS) &&
        pp.quoteCurrency.value === fx.quote,
    );
  } else {
    check(
      `${pp.canonicalSymbol}: non-FX pip & contract await broker spec (null + reason)`,
      pp.pipSize.value === null &&
        pp.pipSize.provenance === "BROKER_REPORTED" &&
        pp.pipSize.reason === "AWAITS_BROKER_SPEC" &&
        pp.contractSize.value === null &&
        pp.contractSize.reason === "AWAITS_BROKER_SPEC",
    );
  }
  check(
    `${pp.canonicalSymbol}: point/minLot/lotStep are always broker truth`,
    pp.pointSize.value === null && pp.minLot.value === null && pp.lotStep.value === null,
  );
}

// ── 3. The 100,000× lock: no chain without a complete unit basis ────────────

// Without a broker spec, every non-FX instrument REFUSES to form a chain —
// the FX standard lot can never leak onto gold, silver, crypto, indices or
// synthetics.
for (const pp of INSTRUMENT_PASSPORTS) {
  const r = completeUnitChain(pp, { quoteScaleFor: scaleForCurrency });
  if (splitForexPair(pp.canonicalSymbol)) {
    check(
      `${pp.canonicalSymbol}: declared-complete FX chain`,
      r.chain !== null &&
        decToString(r.chain.contractSize) === String(FX_STANDARD_LOT_UNITS) &&
        r.chain.contractProvenance === "DECLARED",
    );
  } else {
    check(
      `${pp.canonicalSymbol}: no broker spec ⇒ typed refusal (never a guessed unit)`,
      r.chain === null && r.reason !== null,
      `reason=${r.reason}`,
    );
  }
}

// Broker truth beats the declared FX lot for contract size (decideContractSize
// authority order), while the FX pip CONVENTION beats the broker point
// (decidePipSize authority order). The asymmetry is deliberate — assert it.
{
  const eur = getInstrumentPassport("EURUSD")!;
  const r = completeUnitChain(eur, {
    broker: { point: 0.00001, contractSize: 12_345, profitCurrency: "USD" },
    quoteScaleFor: scaleForCurrency,
  });
  check(
    "EURUSD: broker contract size OVERRIDES the declared lot; convention pip beats broker point",
    r.chain !== null &&
      decToString(r.chain.contractSize) === "12345" &&
      r.chain.contractProvenance === "BROKER_REPORTED" &&
      decToString(r.chain.pipSize) === "0.0001" &&
      r.chain.pipProvenance === "DECLARED",
  );
}
{
  const xau = getInstrumentPassport("XAUUSD")!;
  const withBroker = completeUnitChain(xau, {
    broker: { point: 0.01, contractSize: 100, profitCurrency: "USD" },
    quoteScaleFor: scaleForCurrency,
  });
  check(
    "XAUUSD: broker spec completes the chain with the BROKER contract (100), not the FX lot",
    withBroker.chain !== null &&
      decToString(withBroker.chain.contractSize) === "100" &&
      decToString(withBroker.chain.pipSize) === "0.01" &&
      withBroker.chain.pipProvenance === "BROKER_REPORTED",
  );
  const invalid = completeUnitChain(xau, {
    broker: { point: 0.01, contractSize: -5, profitCurrency: "USD" },
    quoteScaleFor: scaleForCurrency,
  });
  check(
    "XAUUSD: an INVALID broker contract fails closed (no declared fallback)",
    invalid.chain === null && invalid.reason === "CONTRACT_SIZE_INVALID",
  );
}
{
  // Unknown quote-currency scale ⇒ refusal, never an assumed 2.
  const v75 = getInstrumentPassport("V75")!;
  const r = completeUnitChain(v75, {
    broker: { point: 0.0001, contractSize: 1, profitCurrency: "ZZZ" },
    quoteScaleFor: scaleForCurrency,
  });
  check("unknown currency scale ⇒ QUOTE_SCALE_UNKNOWN", r.chain === null && r.reason === "QUOTE_SCALE_UNKNOWN");
}

// ── 4. UNIT CLOSURE property: exact round trip for EVERY passport ───────────

// Fixture broker-spec grid for entries whose chain needs broker truth. These
// are TEST FIXTURES spanning the realistic spec space — they are not shipped
// defaults and the passport itself stays null for these fields.
const FIXTURE_POINTS = [0.00001, 0.0001, 0.001, 0.01, 0.1, 1];
const FIXTURE_CONTRACTS = [1, 100, 5000, 100_000];
const FIXTURE_CURRENCIES = ["USD", "JPY"];
const LOTS = ["0.01", "0.1", "0.5", "1", "2.5", "10", "100"];

function chainsFor(pp: InstrumentPassport): Array<{ label: string; chain: UnitChain }> {
  const out: Array<{ label: string; chain: UnitChain }> = [];
  const bare = completeUnitChain(pp, { quoteScaleFor: scaleForCurrency });
  if (bare.chain) out.push({ label: "declared", chain: bare.chain });
  for (const point of FIXTURE_POINTS) {
    for (const contractSize of FIXTURE_CONTRACTS) {
      for (const profitCurrency of FIXTURE_CURRENCIES) {
        const broker: BrokerReportedSpec = { point, contractSize, profitCurrency };
        const r = completeUnitChain(pp, { broker, quoteScaleFor: scaleForCurrency });
        if (r.chain) {
          out.push({ label: `broker(${point},${contractSize},${profitCurrency})`, chain: r.chain });
        }
      }
    }
  }
  return out;
}

let roundTrips = 0;
let typedRefusals = 0;
let closureFailures = 0;

for (const pp of INSTRUMENT_PASSPORTS) {
  const chains = chainsFor(pp);
  check(`${pp.canonicalSymbol}: at least one completable unit chain`, chains.length > 0);

  for (const { label, chain } of chains) {
    for (let i = 0; i < 6; i++) {
      const pips = i === 0 ? 1n : i === 1 ? -1n : i === 2 ? 0n : randPips();
      const lots = LOTS[Math.floor(rand() * LOTS.length)]!;

      // pips → price delta → pips (always exact by construction).
      const delta = pipsToPriceDelta(pips, chain);
      const pipsBack = priceDeltaToPips(delta, chain);
      if (pipsBack.pips !== pips) {
        closureFailures++;
        check(`${pp.canonicalSymbol} ${label}: pips→delta→pips identity`, false,
          `pips=${pips} back=${String(pipsBack.pips)} reason=${pipsBack.reason}`);
        continue;
      }

      // points → delta → points (pip unit doubles as the point fixture).
      const pointSize = decToString(chain.pipSize);
      const asDelta = pointsToPriceDelta(pips, pointSize);
      const pointsBack = asDelta.delta ? priceDeltaToPoints(asDelta.delta, pointSize) : { points: null, reason: asDelta.reason };
      if (pointsBack.points !== pips) {
        closureFailures++;
        check(`${pp.canonicalSymbol} ${label}: points→delta→points identity`, false, `pips=${pips}`);
        continue;
      }

      // pips → quote P&L minor units (via lib/money) → pips.
      const pnl = pipsToQuotePnl(pips, lots, chain);
      if (pnl.amount === null) {
        // A refusal must be typed AND must never carry a rounded amount.
        typedRefusals++;
        if (pnl.reason !== "NOT_REPRESENTABLE_AT_QUOTE_SCALE") {
          closureFailures++;
          check(`${pp.canonicalSymbol} ${label}: refusal is typed`, false, `reason=${pnl.reason}`);
        }
        continue;
      }
      // Cross-check the minor units against @workspace/money's own exact
      // decimal parser — the two independent paths must agree to the unit.
      const viaMoney = Money.of(pnl.amount.decimal, pnl.amount.currency);
      const moneyAgrees =
        viaMoney.minor === pnl.amount.minorUnits && viaMoney.scale === pnl.amount.scale;
      // Round trip through Money's serialised decimal string.
      const back = quotePnlToPips(
        Money.fromMinor(pnl.amount.minorUnits, pnl.amount.currency).minor,
        lots,
        chain,
      );
      const deltaBack = parseExactDec(viaMoney.toDecimalString());
      const decimalAgrees = deltaBack !== null && decEquals(deltaBack, { units: pnl.amount.minorUnits, scale: pnl.amount.scale });
      if (!moneyAgrees || !decimalAgrees || back.pips !== pips) {
        closureFailures++;
        check(
          `${pp.canonicalSymbol} ${label}: pips→P&L(minor)→pips exact round trip`,
          false,
          `pips=${pips} lots=${lots} minor=${pnl.amount.minorUnits} back=${String(back.pips)} moneyAgrees=${moneyAgrees}`,
        );
        continue;
      }
      roundTrips++;
    }
  }
}

check("exact round trips executed in volume", roundTrips > 3000, `count=${roundTrips}`);
check("refusal branch exercised (inexact ⇒ typed, never rounded)", typedRefusals > 0, `count=${typedRefusals}`);
check("zero closure failures", closureFailures === 0, `failures=${closureFailures}`);

// Anchor values (the numbers every FX desk knows — wrong units cannot hide):
{
  const eur = completeUnitChain(getInstrumentPassport("EURUSD")!, { quoteScaleFor: scaleForCurrency }).chain!;
  const p = pipsToQuotePnl(1n, "1", eur);
  check("anchor: EURUSD 1 pip × 1.00 lot = exactly 10.00 USD (1000 minor)",
    p.amount !== null && p.amount.minorUnits === 1000n && p.amount.currency === "USD");
  const jp = completeUnitChain(getInstrumentPassport("EURJPY")!, { quoteScaleFor: scaleForCurrency }).chain!;
  const pj = pipsToQuotePnl(1n, "0.01", jp);
  check("anchor: EURJPY 1 pip × 0.01 lot = exactly 10 JPY (10 minor, scale 0)",
    pj.amount !== null && pj.amount.minorUnits === 10n && pj.amount.scale === 0);
}

// ── Verdict ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
// eslint-disable-next-line no-console
console.log(
  `\ninstrument-passport unit closure: ${results.length - failed.length}/${results.length} checks passed, ` +
    `${roundTrips} exact round trips, ${typedRefusals} typed refusals`,
);
if (failed.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`FAILED: ${failed.length} checks`);
  process.exit(1);
}
