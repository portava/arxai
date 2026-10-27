// Test: risk-aware lot sizer invariants (@workspace/domain/self-trade).
//
// `computeRiskAwareLot` turns an account-currency risk budget and a real stop
// into a broker-legal lot. This file pins the properties a sizer must hold for
// EVERY input, not just the handful of worked examples in
// selfTradeExecutionDomainTest.ts:
//
//   I1  a sized lot is finite and > 0 — never NaN / Infinity
//   I2  the lot sits EXACTLY on the broker step grid (no 0.1+0.2 drift, and
//       non-decimal steps such as 0.25 / 0.5 / 0.05 are honoured)
//   I3  the lot is inside [minLot, min(maxLot, agentMaxLot)]
//   I4  rounding never rounds UP past the (multiplier-reduced) risk budget; the
//       only way to exceed it is the broker-minimum clamp, which is then
//       reported as withinRiskBudget=false
//   I5  the lot is the LARGEST legal lot within budget (no needless undersizing)
//   I6  a size multiplier can only shrink the lot
//   M1  wider stop ⇒ lot never grows;  M2  bigger budget ⇒ lot never shrinks
//   R*  impossible / non-finite inputs refuse with a structured reasonCode
//       instead of silently clamping up
//
// Tolerance: risk comparisons allow a RELATIVE 1e-9. Stop distances such as
// 1.1 − 1.095 are not exactly representable in binary floating point, so the
// risk at an exactly-on-budget lot is 100.0000000000023, not 100. That is
// measurement noise in the input, not rounding by the sizer. Step-grid checks
// are exact (the lot must equal its canonical decimal representation).
//
// Fuzzing uses a SEEDED generator (mulberry32), never Math.random(), so every
// failure is reproducible from the printed case index.
//
// Pure unit test — no DB, no network, no clock. Offline CI lane.

import { computeRiskAwareLot } from "@workspace/domain/self-trade";

type Input = Parameters<typeof computeRiskAwareLot>[0];

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REL = 1e-9;

/** Decimal places needed to write `step` exactly (0.25 → 2, 0.5 → 1, 2 → 0). */
function decimalsOf(step: number): number {
  for (let d = 0; d <= 10; d++) {
    const scaled = step * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9 * Math.max(1, scaled)) return d;
  }
  return 10;
}

function onGrid(lot: number, step: number): boolean {
  const n = Math.round(lot / step);
  if (Math.abs(lot / step - n) > 1e-9 * Math.max(1, n)) return false;
  // Exact: the lot must be the canonical decimal value of n × step.
  return lot === Number((n * step).toFixed(decimalsOf(step)));
}

function effMult(m: number): number {
  return m > 0 && Number.isFinite(m) ? Math.min(m, 1) : 1;
}

function ceilingOf(i: Input): number {
  return Math.min(
    i.maxLot > 0 ? i.maxLot : Infinity,
    i.agentMaxLot > 0 ? i.agentMaxLot : Infinity,
  );
}

const BASE: Input = {
  side: "BUY",
  entryPrice: 1.1,
  stopLossPrice: 1.095,
  riskBudgetUsd: 100,
  valuePerUnitPerLot: 100_000,
  minLot: 0.01,
  maxLot: 100,
  lotStep: 0.01,
  agentMaxLot: 100,
  sizeMultiplier: 1,
};
const size = (o: Partial<Input>) => computeRiskAwareLot({ ...BASE, ...o });

/** Every invariant for one input. Returns the first violation, or null. */
function violation(i: Input): string | null {
  const r = computeRiskAwareLot(i);
  if (r.cannotSize) {
    if (r.lot !== 0) return `cannotSize but lot=${r.lot}`;
    if (r.reasonCode == null) return "cannotSize without a reasonCode";
    return null;
  }
  const step = i.lotStep > 1e-9 ? i.lotStep : 0.01;
  const minLot = i.minLot > 1e-9 ? i.minLot : step;
  const ceiling = ceilingOf(i);
  const stop = Math.abs(i.entryPrice - (i.stopLossPrice as number));
  const riskPerLot = stop * i.valuePerUnitPerLot;
  const effBudget = i.riskBudgetUsd * effMult(i.sizeMultiplier);

  if (!(Number.isFinite(r.lot) && r.lot > 0)) return `I1 lot=${r.lot}`;
  if (!onGrid(r.lot, step)) return `I2 lot=${r.lot} off step ${step}`;
  if (r.lot < minLot * (1 - REL)) return `I3 lot=${r.lot} < min ${minLot}`;
  if (r.lot > ceiling * (1 + REL)) return `I3 lot=${r.lot} > ceiling ${ceiling}`;
  if (Math.abs(r.actualRiskUsd - r.lot * riskPerLot) > 1e-9 * Math.max(1, r.actualRiskUsd))
    return `actualRisk ${r.actualRiskUsd} != lot×riskPerLot ${r.lot * riskPerLot}`;
  const over = r.actualRiskUsd > effBudget * (1 + REL);
  if (r.withinRiskBudget && over)
    return `I4 withinRiskBudget=true but risk ${r.actualRiskUsd} > budget ${effBudget}`;
  if (r.clampedBy !== "MIN_LOT" && over)
    return `I4 rounding exceeded budget: risk ${r.actualRiskUsd} > ${effBudget} (lot ${r.lot}, by ${r.clampedBy})`;
  if (r.clampedBy === "MIN_LOT" && !over && !r.withinRiskBudget)
    return `I4 within=false but risk ${r.actualRiskUsd} <= ${effBudget}`;
  if (r.clampedBy !== "MIN_LOT") {
    const next = Number(((Math.round(r.lot / step) + 1) * step).toFixed(decimalsOf(step)));
    const nextFitsBudget = next * riskPerLot <= effBudget * (1 - REL);
    const nextFitsCap = next <= ceiling * (1 - REL);
    if (nextFitsBudget && nextFitsCap)
      return `I5 undersized: lot ${r.lot}, next ${next} still fits budget ${effBudget} and cap ${ceiling}`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("riskAwareLotSizer — adversarial fixed cases");
{
  // Step 0.5 (index CFDs): raw 1.6 lots must round DOWN to 1.5, not up to 2.
  const half = size({ lotStep: 0.5, minLot: 0.5, riskBudgetUsd: 800 });
  check("step 0.5, raw 1.6 ⇒ 1.5 (never rounds up to 2)", half.lot === 1.5 && half.withinRiskBudget,
    `lot=${half.lot} risk=${half.actualRiskUsd}`);

  // Step 0.25: raw 0.3 must be 0.25 — 0.3 is not a legal volume.
  const quarter = size({ lotStep: 0.25, minLot: 0.25, riskBudgetUsd: 150 });
  check("step 0.25, raw 0.3 ⇒ 0.25 (on-grid)", quarter.lot === 0.25, `lot=${quarter.lot}`);

  // Step 0.05: 3 × 0.05 = 0.15000000000000002 must not become 0.2.
  const twentieth = size({ lotStep: 0.05, minLot: 0.05, riskBudgetUsd: 85 });
  check("step 0.05, raw 0.17 ⇒ 0.15 (no float drift up)", twentieth.lot === 0.15 && twentieth.withinRiskBudget,
    `lot=${twentieth.lot}`);

  // Step 1: raw 2.7 ⇒ 2.
  const whole = size({ lotStep: 1, minLot: 1, riskBudgetUsd: 1350 });
  check("step 1, raw 2.7 ⇒ 2", whole.lot === 2, `lot=${whole.lot}`);

  // 0.1 + 0.2 class: raw exactly 0.3 at step 0.1 ⇒ 0.3, exactly representable.
  const tenth = size({ lotStep: 0.1, riskBudgetUsd: 150 });
  check("step 0.1, raw 0.3 ⇒ exactly 0.3 (=== 0.3)", tenth.lot === 0.3, `lot=${tenth.lot}`);

  // Step 0.02: raw 0.07 ⇒ 0.06 exactly.
  const fiftieth = size({ lotStep: 0.02, minLot: 0.02, riskBudgetUsd: 35 });
  check("step 0.02, raw 0.07 ⇒ exactly 0.06", fiftieth.lot === 0.06, `lot=${fiftieth.lot}`);

  // Exactly-on-budget remains sized at budget (existing behaviour preserved).
  const exact = size({});
  check("raw 0.2 on 0.01 grid ⇒ 0.2 within budget", exact.lot === 0.2 && exact.withinRiskBudget,
    `lot=${exact.lot}`);

  // Agent cap below broker minimum: the minimum is NOT legal for this agent.
  const agentBelowMin = size({ agentMaxLot: 0.005 });
  check("agent cap < broker min ⇒ refuse MIN_LOT_EXCEEDS_CAP (not upsized past the cap)",
    agentBelowMin.cannotSize && agentBelowMin.reasonCode === "MIN_LOT_EXCEEDS_CAP" && agentBelowMin.lot === 0,
    `lot=${agentBelowMin.lot} rc=${agentBelowMin.reasonCode}`);

  const brokerMaxBelowMin = size({ maxLot: 0.05, minLot: 0.1, lotStep: 0.1 });
  check("broker max < broker min ⇒ refuse MIN_LOT_EXCEEDS_CAP",
    brokerMaxBelowMin.cannotSize && brokerMaxBelowMin.reasonCode === "MIN_LOT_EXCEEDS_CAP",
    `lot=${brokerMaxBelowMin.lot} rc=${brokerMaxBelowMin.reasonCode}`);

  // Min lot exceeds the budget: still reported (existing contract) but flagged.
  const minOver = size({ riskBudgetUsd: 1, stopLossPrice: 1.0 });
  check("min lot over budget ⇒ lot=min, withinRiskBudget=false, clampedBy=MIN_LOT",
    !minOver.cannotSize && minOver.lot === 0.01 && !minOver.withinRiskBudget && minOver.clampedBy === "MIN_LOT");

  // Multiplier-reduced budget: the min-lot clamp is judged against the REDUCED
  // budget. $150 budget × 0.5 = $75; min lot risk = $100 ⇒ over.
  const reducedOver = size({ riskBudgetUsd: 150, stopLossPrice: 1.0, sizeMultiplier: 0.5 });
  check("min-lot risk over the multiplier-reduced budget ⇒ withinRiskBudget=false",
    !reducedOver.cannotSize && reducedOver.lot === 0.01 && !reducedOver.withinRiskBudget,
    `within=${reducedOver.withinRiskBudget} risk=${reducedOver.actualRiskUsd}`);

  // Multipliers only reduce.
  const up = size({ sizeMultiplier: 3 });
  check("sizeMultiplier > 1 cannot size up past the budget", up.lot === 0.2 && up.withinRiskBudget,
    `lot=${up.lot}`);
  const infMult = size({ sizeMultiplier: Infinity, maxLot: 0, agentMaxLot: 0 });
  check("sizeMultiplier=Infinity ⇒ finite lot within budget",
    !infMult.cannotSize && infMult.lot === 0.2 && infMult.withinRiskBudget, `lot=${infMult.lot}`);
  // Pinned elsewhere: ≤0 / NaN multiplier is the defensive default of 1.
  const nanMult = size({ sizeMultiplier: Number.NaN });
  check("sizeMultiplier=NaN ⇒ treated as 1 (existing defensive default)", nanMult.lot === 0.2);

  // Non-finite / missing inputs refuse with a structured reason.
  const r1 = size({ riskBudgetUsd: Infinity, maxLot: 0, agentMaxLot: 0 });
  check("riskBudget=Infinity ⇒ NO_RISK_BUDGET", r1.cannotSize && r1.reasonCode === "NO_RISK_BUDGET",
    `lot=${r1.lot} rc=${r1.reasonCode}`);
  const r2 = size({ riskBudgetUsd: Number.NaN });
  check("riskBudget=NaN ⇒ NO_RISK_BUDGET", r2.cannotSize && r2.reasonCode === "NO_RISK_BUDGET");
  const r3 = size({ riskBudgetUsd: -5 });
  check("riskBudget<0 ⇒ NO_RISK_BUDGET", r3.cannotSize && r3.reasonCode === "NO_RISK_BUDGET");
  const r4 = size({ valuePerUnitPerLot: Infinity });
  check("valuePerUnitPerLot=Infinity ⇒ NO_CONTRACT_SPEC", r4.cannotSize && r4.reasonCode === "NO_CONTRACT_SPEC",
    `rc=${r4.reasonCode}`);
  const r5 = size({ valuePerUnitPerLot: Number.NaN });
  check("valuePerUnitPerLot=NaN ⇒ NO_CONTRACT_SPEC", r5.cannotSize && r5.reasonCode === "NO_CONTRACT_SPEC");
  const r6 = size({ entryPrice: Infinity });
  check("entry=Infinity ⇒ refuse (NO_STOP_DISTANCE)", r6.cannotSize && r6.reasonCode === "NO_STOP_DISTANCE",
    `rc=${r6.reasonCode}`);
  const r7 = size({ stopLossPrice: Number.NaN });
  check("stop=NaN ⇒ refuse (NO_STOP_DISTANCE)", r7.cannotSize && r7.reasonCode === "NO_STOP_DISTANCE");
  const r8 = size({ stopLossPrice: null });
  check("stop=null ⇒ NO_PROTECTIVE_STOP", r8.cannotSize && r8.reasonCode === "NO_PROTECTIVE_STOP");

  // Absurd leverage: a huge budget against a tiny stop is capped by the ceiling.
  const lev = size({ riskBudgetUsd: 1e12, stopLossPrice: 1.0999999, maxLot: 50, agentMaxLot: 100 });
  check("absurd leverage ⇒ capped at broker max 50 (MAX_LOT)", lev.lot === 50 && lev.clampedBy === "MAX_LOT",
    `lot=${lev.lot} by=${lev.clampedBy}`);
  // Ceiling that is itself off-grid floors onto the grid.
  const offCap = size({ riskBudgetUsd: 1e6, agentMaxLot: 0.237 });
  check("off-grid agent cap 0.237 ⇒ 0.23 (floored onto the grid)", offCap.lot === 0.23 && offCap.clampedBy === "AGENT_CAP",
    `lot=${offCap.lot}`);
  // No ceiling configured + a finite budget never yields Infinity.
  const uncapped = size({ maxLot: 0, agentMaxLot: 0, riskBudgetUsd: 1e9 });
  check("uncapped huge budget ⇒ finite on-grid lot", Number.isFinite(uncapped.lot) && onGrid(uncapped.lot, 0.01),
    `lot=${uncapped.lot}`);

  for (const [name, i] of [
    ["half", { ...BASE, lotStep: 0.5, minLot: 0.5, riskBudgetUsd: 800 }],
    ["quarter", { ...BASE, lotStep: 0.25, minLot: 0.25, riskBudgetUsd: 150 }],
    ["uncapped", { ...BASE, maxLot: 0, agentMaxLot: 0, riskBudgetUsd: 1e9 }],
  ] as const) {
    const v = violation(i as Input);
    check(`invariants hold for fixed case "${name}"`, v == null, v ?? "");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nriskAwareLotSizer — seeded property sweep");
const STEPS = [0.01, 0.1, 1, 0.5, 0.25, 0.05, 0.001, 0.02, 2, 5];
const CONTRACTS = [1, 10, 100, 5_000, 100_000];
const MULTS = [1, 0.7, 0.5, 0.35, 0.25, 0.125, 0.49];

function genInput(rnd: () => number): Input {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const step = pick(STEPS);
  const minLot = step * (1 + Math.floor(rnd() * 3));
  const maxLot = rnd() < 0.2 ? 0 : step * (1 + Math.floor(rnd() * 5000));
  const agentMaxLot = rnd() < 0.3 ? 0 : step * (1 + Math.floor(rnd() * 500)) + (rnd() < 0.3 ? step * rnd() : 0);
  const entryPrice = 10 ** (rnd() * 6 - 2); // 0.01 … 10,000
  const stopFrac = 10 ** (rnd() * 4 - 5); // 0.001% … 10%
  const side = rnd() < 0.5 ? "BUY" : "SELL";
  const stopLossPrice = side === "BUY" ? entryPrice * (1 - stopFrac) : entryPrice * (1 + stopFrac);
  const fx = 10 ** (rnd() * 3 - 2.5);
  return {
    side,
    entryPrice,
    stopLossPrice,
    riskBudgetUsd: 10 ** (rnd() * 8 - 2), // $0.01 … $1,000,000
    valuePerUnitPerLot: pick(CONTRACTS) * fx,
    minLot,
    maxLot,
    lotStep: step,
    agentMaxLot,
    sizeMultiplier: pick(MULTS),
  };
}

{
  const N = 20_000;
  const rnd = seeded(0x51ce);
  let violations = 0;
  let sized = 0;
  let firstFailure = "";
  for (let k = 0; k < N; k++) {
    const i = genInput(rnd);
    const v = violation(i);
    if (!computeRiskAwareLot(i).cannotSize) sized++;
    if (v) {
      violations++;
      if (!firstFailure) firstFailure = `case #${k}: ${v} :: ${JSON.stringify(i)}`;
    }
  }
  check(`I1–I5 hold over ${N} seeded inputs (${sized} sized, ${violations} violations)`, violations === 0, firstFailure);

  // I6 + monotonicity.
  const rnd2 = seeded(0xbead);
  let multUp = 0;
  let stopUp = 0;
  let budgetDown = 0;
  let mFirst = "";
  for (let k = 0; k < 10_000; k++) {
    const i = genInput(rnd2);
    const full = computeRiskAwareLot({ ...i, sizeMultiplier: 1 });
    const reduced = computeRiskAwareLot(i);
    if (!full.cannotSize && !reduced.cannotSize && reduced.lot > full.lot) {
      multUp++;
      mFirst ||= `mult case #${k}`;
    }
    const wider = computeRiskAwareLot({
      ...i,
      stopLossPrice: i.side === "BUY"
        ? i.entryPrice - 2 * (i.entryPrice - (i.stopLossPrice as number))
        : i.entryPrice + 2 * ((i.stopLossPrice as number) - i.entryPrice),
    });
    if (!reduced.cannotSize && !wider.cannotSize && wider.lot > reduced.lot) {
      stopUp++;
      mFirst ||= `stop case #${k}: ${reduced.lot} → ${wider.lot}`;
    }
    const richer = computeRiskAwareLot({ ...i, riskBudgetUsd: i.riskBudgetUsd * 1.5 });
    if (!reduced.cannotSize && (richer.cannotSize || richer.lot < reduced.lot)) {
      budgetDown++;
      mFirst ||= `budget case #${k}: ${reduced.lot} → ${richer.lot}`;
    }
  }
  check("I6 a multiplier never grows the lot (10000 draws)", multUp === 0, mFirst);
  check("M1 doubling the stop distance never grows the lot (10000 draws)", stopUp === 0, mFirst);
  check("M2 raising the budget never shrinks / un-sizes the lot (10000 draws)", budgetDown === 0, mFirst);
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
