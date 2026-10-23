// Test: the Deriv contract domain model (@workspace/domain deriv-contracts).
//
// The three lies this slice removes, each pinned by a test:
//
//   1. TYPE BLEED. "A synthetic trade" used to mean an MT5 CFD position
//      (volume/lots, SL/TP prices). A Deriv multiplier contract is a different
//      thing (stake, multiplier, SL/TP AMOUNTS, contract_id lifecycle) and the
//      spec (§17:1040) bans mapping one onto the other. Pinned at COMPILE time
//      (@ts-expect-error: an MT5-shaped row is not assignable) and at RUNTIME
//      (the validator refuses a smuggled non-contract shape with a code).
//
//   2. HARDCODED VENUE LIMITS. Stake bounds and allowed multipliers come ONLY
//      from a venue contracts_for capability payload. Absent evidence is
//      UNKNOWN and UNKNOWN refuses — the suite proves missing bounds/ranges
//      refuse rather than pass, and that multiplier membership is EXACT
//      (never rounded to the nearest advertised value).
//
//   3. "PROBABLY DEMO". The virtual gate allows execution ONLY on a retained
//      identity with isVirtual === true and no operator/venue contradiction.
//      Null identity, is_virtual missing, real accounts, and identityMismatch
//      all produce the typed refusal DERIV_EXECUTION_REQUIRES_VIRTUAL_ACCOUNT.
//
// Pure unit test — no DB, no network, no env reads. Offline CI lane.

import { derivContracts } from "@workspace/domain";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const {
  parseMultiplierCapability,
  validateMultiplierContractIntent,
  assertVirtualAccountForExecution,
  DERIV_EXECUTION_REQUIRES_VIRTUAL_ACCOUNT,
} = derivContracts;

// Venue-shaped contracts_for fixture (snake_case exactly as the venue sends),
// including malformed entries, a non-multiplier category, and an entry for a
// DIFFERENT underlying — all of which must be excluded, never repaired.
const CONTRACTS_FOR_R75 = {
  contracts_for: {
    available: [
      {
        contract_category: "multiplier",
        contract_type: "MULTUP",
        underlying_symbol: "R_75",
        multiplier_range: [10, 20, 30, 40, 50],
        min_stake: 1,
        max_stake: 2000,
        currency: "USD",
      },
      {
        contract_category: "multiplier",
        contract_type: "MULTDOWN",
        underlying_symbol: "R_75",
        multiplier_range: [10, 20, 30, 40, 50],
        min_stake: 5,
        max_stake: 1000,
      },
      { contract_category: "callput", contract_type: "CALL", underlying_symbol: "R_75" },
      null,
      "garbage",
      { contract_category: "multiplier", contract_type: "MULTUP", underlying_symbol: "1HZ25V", multiplier_range: [999] },
    ],
    hit_count: 6,
  },
};

function validIntent(
  over: Partial<derivContracts.DerivMultiplierContractIntent> = {},
): derivContracts.DerivMultiplierContractIntent {
  return {
    kind: "DERIV_MULTIPLIER_CONTRACT",
    contractType: "MULTUP",
    symbol: "R_75",
    currency: "USD",
    stake: 10,
    multiplier: 20,
    ...over,
  };
}

function identity(
  over: Partial<derivContracts.DerivAccountIdentity> = {},
): derivContracts.DerivAccountIdentity {
  return {
    loginid: "VRTC9001234",
    isVirtual: true,
    currency: "USD",
    landingCompany: "virtual",
    declaredEnvironment: null,
    identityMismatch: false,
    retainedAt: new Date(0).toISOString(),
    retainedAtMs: 0,
    ...over,
  };
}

export async function run(): Promise<CiTestResultLike> {
  let passes = 0;
  let failures = 0;

  function assert(cond: boolean, label: string) {
    if (cond) {
      passes++;
      console.log(`  ✓ ${label}`);
    } else {
      failures++;
      console.error(`  ✗ ${label}`);
    }
  }
  const codes = (r: derivContracts.DerivContractValidationResult) => r.issues.map((i) => i.code);

  console.log("derivContractsTest");
  console.log("==================\n");

  // ── 1. Capability parsing — evidence in, evidence out, nothing invented ────
  console.log("contracts_for capability parsing");
  {
    const cap = parseMultiplierCapability(CONTRACTS_FOR_R75, "R_75");
    assert(cap !== null, "a multiplier-bearing payload parses to a capability");
    assert(cap!.symbol === "R_75", "capability is scoped to the requested symbol");
    assert(
      JSON.stringify(cap!.contractTypes) === JSON.stringify(["MULTDOWN", "MULTUP"]),
      "both advertised directions captured (sorted)",
    );
    assert(
      JSON.stringify(cap!.multiplierRange) === JSON.stringify([10, 20, 30, 40, 50]),
      "multiplier range is the venue's exact value list",
    );
    assert(
      !cap!.multiplierRange.includes(999),
      "an entry for a DIFFERENT underlying contributes nothing (999 excluded)",
    );
    assert(cap!.minStake === 5, "min stake is the most restrictive across entries (max of mins)");
    assert(cap!.maxStake === 1000, "max stake is the most restrictive across entries (min of maxes)");
    assert(cap!.currency === "USD", "declared currency captured");

    // Tolerant unwrap: the contracts_for object itself also parses.
    const inner = parseMultiplierCapability(CONTRACTS_FOR_R75.contracts_for, "R_75");
    assert(inner !== null && inner.multiplierRange.length === 5, "accepts the contracts_for object directly");

    // Honest absence: no multiplier availability → null, never an empty guess.
    assert(
      parseMultiplierCapability({ contracts_for: { available: [{ contract_category: "callput", contract_type: "CALL" }] } }, "R_75") === null,
      "a payload with no multiplier entries yields null capability",
    );
    assert(parseMultiplierCapability(undefined, "R_75") === null, "non-object payload yields null");
    assert(parseMultiplierCapability({ contracts_for: {} }, "R_75") === null, "missing available[] yields null");

    // Bounds absent from the payload stay null — never defaulted.
    const noBounds = parseMultiplierCapability(
      { available: [{ contract_category: "multiplier", contract_type: "MULTUP", multiplier_range: [10] }] },
      "R_75",
    );
    assert(noBounds !== null && noBounds.minStake === null && noBounds.maxStake === null,
      "absent stake bounds stay null (UNKNOWN), never invented");
  }

  // ── 2. Validators — capability-driven, fail-closed, exact ─────────────────
  console.log("\nmultiplier intent validation");
  {
    const cap = parseMultiplierCapability(CONTRACTS_FOR_R75, "R_75")!;

    const ok = validateMultiplierContractIntent(validIntent(), cap);
    assert(ok.ok && ok.issues.length === 0, "a capability-conformant intent passes");

    assert(codes(validateMultiplierContractIntent(validIntent({ stake: 0.5 }), cap)).includes("STAKE_BELOW_VENUE_MINIMUM"),
      "stake below the venue minimum refuses");
    assert(codes(validateMultiplierContractIntent(validIntent({ stake: 5000 }), cap)).includes("STAKE_ABOVE_VENUE_MAXIMUM"),
      "stake above the venue maximum refuses");
    assert(codes(validateMultiplierContractIntent(validIntent({ stake: Number.NaN }), cap)).includes("STAKE_NOT_A_POSITIVE_FINITE_NUMBER"),
      "a non-finite stake refuses before any bounds math");

    assert(codes(validateMultiplierContractIntent(validIntent({ multiplier: 25 }), cap)).includes("MULTIPLIER_NOT_IN_VENUE_RANGE"),
      "multiplier 25 refuses — membership is EXACT, 25 is never rounded to 20 or 30");
    assert(codes(validateMultiplierContractIntent(validIntent({ multiplier: -10 }), cap)).includes("MULTIPLIER_NOT_A_POSITIVE_FINITE_NUMBER"),
      "a negative multiplier refuses");

    assert(codes(validateMultiplierContractIntent(validIntent({ contractType: "MULTDOWN" }), { ...cap, contractTypes: ["MULTUP"] })).includes("CONTRACT_TYPE_NOT_AVAILABLE"),
      "a direction the venue does not advertise refuses");

    // UNKNOWN refuses — the three evidence-absence paths.
    assert(codes(validateMultiplierContractIntent(validIntent(), null)).includes("CAPABILITY_MISSING"),
      "no capability evidence at all refuses (UNKNOWN is a valid, blocking outcome)");
    assert(codes(validateMultiplierContractIntent(validIntent(), { ...cap, minStake: null, maxStake: null })).includes("STAKE_BOUNDS_UNKNOWN"),
      "unknown stake bounds refuse — limits are never guessed");
    assert(codes(validateMultiplierContractIntent(validIntent(), { ...cap, multiplierRange: [] })).includes("MULTIPLIER_RANGE_UNKNOWN"),
      "an empty advertised multiplier range refuses");

    assert(codes(validateMultiplierContractIntent(validIntent({ stopLoss: -5 }), cap)).includes("STOP_LOSS_NOT_A_POSITIVE_FINITE_AMOUNT"),
      "a non-positive stopLoss AMOUNT refuses");
    assert(codes(validateMultiplierContractIntent(validIntent({ takeProfit: 0 }), cap)).includes("TAKE_PROFIT_NOT_A_POSITIVE_FINITE_AMOUNT"),
      "a zero takeProfit AMOUNT refuses");
    const withRisk = validateMultiplierContractIntent(validIntent({ stopLoss: 5, takeProfit: 30, dealCancellation: true }), cap);
    assert(withRisk.ok, "positive SL/TP amounts and dealCancellation pass");

    assert(codes(validateMultiplierContractIntent(validIntent({ currency: "EUR" }), cap)).includes("CURRENCY_MISMATCH"),
      "a currency contradicting declared capability evidence refuses");
    assert(validateMultiplierContractIntent(validIntent({ currency: "EUR" }), { ...cap, currency: null }).ok,
      "no declared currency evidence → no fabricated currency check (venue re-validates at proposal time)");

    assert(codes(validateMultiplierContractIntent(validIntent({ symbol: "1HZ25V" }), cap)).includes("CAPABILITY_SYMBOL_MISMATCH"),
      "capability evidence for another symbol refuses");

    const multi = validateMultiplierContractIntent(validIntent({ stake: 0.5, multiplier: 25 }), cap);
    assert(!multi.ok && multi.issues.length === 2, "ALL violations are collected, not just the first");
  }

  // ── 3. No CFD/contract type bleed (spec §17:1040; audit red-fail test 7) ──
  console.log("\nMT5 CFD shapes cannot become Deriv contract intents");
  {
    // COMPILE-TIME pin: an MT5 command-row shape (volume + SL/TP prices, no
    // kind/stake/multiplier) must not be assignable. If the domain type ever
    // widens to accept it, typecheck:ci goes red on this unused expectation.
    // @ts-expect-error — volume/lots-based CFD shape is not a Deriv contract intent
    const mt5Shaped: derivContracts.DerivMultiplierContractIntent = { contractType: "MULTUP", symbol: "R_75", currency: "USD", volume: 0.01, stopLossPrice: 123.4, takeProfitPrice: 456.7 };
    void mt5Shaped;
    assert(true, "compile-time: MT5 CFD shape is not assignable (pinned via @ts-expect-error)");

    // RUNTIME pin: a smuggled cast still refuses with a code before anything
    // else is evaluated.
    const cap = parseMultiplierCapability(CONTRACTS_FOR_R75, "R_75")!;
    const smuggled = validateMultiplierContractIntent(
      { commandType: "PLACE_LIVE_MARKET_ORDER", symbol: "R_75", volume: 0.01, slPrice: 123.4, tpPrice: 456.7 } as unknown as derivContracts.DerivMultiplierContractIntent,
      cap,
    );
    assert(!smuggled.ok && codes(smuggled)[0] === "INTENT_KIND_INVALID",
      "runtime: an MT5 command row smuggled via cast refuses with INTENT_KIND_INVALID");
  }

  // ── 4. Virtual gate — the structural demo-only lock ───────────────────────
  console.log("\nvirtual-account execution gate");
  {
    assert(DERIV_EXECUTION_REQUIRES_VIRTUAL_ACCOUNT === "DERIV_EXECUTION_REQUIRES_VIRTUAL_ACCOUNT",
      "the refusal code literal is pinned");

    for (const missing of [null, undefined]) {
      const v = assertVirtualAccountForExecution(missing);
      assert(!v.allowed && v.code === DERIV_EXECUTION_REQUIRES_VIRTUAL_ACCOUNT,
        `${String(missing)} identity (no authorize this session) refuses`);
    }

    const real = assertVirtualAccountForExecution(identity({ loginid: "CR7654321", isVirtual: false }));
    assert(!real.allowed && /REAL/.test(real.allowed ? "" : real.reason),
      "a REAL account (is_virtual=false) refuses, naming the reason");

    const unknown = assertVirtualAccountForExecution(identity({ isVirtual: null }));
    assert(!unknown.allowed && /UNKNOWN/.test(unknown.allowed ? "" : unknown.reason),
      "is_virtual never stated refuses — UNKNOWN is not demo");

    const contradiction = assertVirtualAccountForExecution(identity({ identityMismatch: true }));
    assert(!contradiction.allowed,
      "identityMismatch refuses even alongside isVirtual=true (contradiction never passes)");

    const allowed = assertVirtualAccountForExecution(identity());
    assert(allowed.allowed === true && allowed.loginid === "VRTC9001234",
      "a proven virtual account with no contradiction is the ONLY allowing input");
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "derivContractsTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[derivContractsTest] FAILED:", err);
      process.exit(1);
    },
  );
}
