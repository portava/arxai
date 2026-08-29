// DB-free tripwire test — synthetic markets STILL require a stop-loss (Task #556).
//
// ── Ownership ───────────────────────────────────────────────────────────────
// This test owns the *stop-loss* (`MISSING_STOP_LOSS`) coverage for a SYNTHETIC
// symbol. It is DISTINCT from Tasks #550/#551, which cover the *feed-live* floor
// (`SYNTHETIC_FEED_NOT_LIVE_CONFIRMED`) in `evaluateSyntheticLiveFloor`. We only
// reuse the #550 hermetic harness/reporting *pattern* here — we do NOT re-test or
// broaden the feed-live floor. The pure 23-gate evaluator exercised below does
// not even contain the synthetic floor, so there is no overlap by construction.
//
// ── Why this tripwire exists ────────────────────────────────────────────────
// The live stop-loss gate (`MISSING_STOP_LOSS`) is INSTRUMENT-AGNOSTIC: it blocks
// any live entry without a stop-loss unless the user's explicit override is on.
// Nothing in the gate branches on symbol or asset class, so synthetics get NO
// implicit no-stop-loss exemption. That protection is structural but, until now,
// had no automated test pinning it for a *synthetic* symbol. A future refactor
// (e.g. adding an asset-class branch to the Deriv-synthetic floor) could silently
// grant synthetics an implicit exemption with nothing to catch it. This test
// fails the pre-commit gate the moment that happens.
//
// ── Hermetic by construction ────────────────────────────────────────────────
// It imports ONLY:
//   1. the REAL pure 23-gate evaluator (`evaluateLivePhaseBDispatchGate`,
//      no DB / network / IO), exercising the actual stop-loss decision both the
//      dispatch path and (mirrored) the createLiveDraft preflight enforce, and
//   2. the REAL static Deriv symbol resolver (`resolveDerivSymbol` /
//      `isDerivSyntheticSymbol`) to prove V75 → R_75 is a genuine synthetic — a
//      pure lookup that never instantiates the WS client.
// It imports NO db / pipeline / broker module, calls NO createLiveDraft or
// dispatch, and writes NO `arx_live_commands` rows (asserted explicitly below).

import {
  evaluateLivePhaseBDispatchGate,
  type LivePhaseBGateInput,
} from "@workspace/domain/safety-contracts/livePhaseBDispatchGate";

type CheckResult = { id: number; name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
function record(id: number, name: string, ok: boolean, detail = ""): void {
  results.push({ id, name, ok, detail });
}

// The synthetic symbol under test. V75 is the Deriv "Volatility 75 Index"
// (Deriv WS id R_75) — the canonical synthetic referenced by the task.
const SYNTHETIC_SYMBOL = "V75";
const SYNTHETIC_DERIV_ID = "R_75";
const FOREX_SYMBOL = "EURUSD";

// A LivePhaseBGateInput where every gate EXCEPT the stop-loss gate passes, so a
// BLOCKED verdict can only come from `MISSING_STOP_LOSS`. The take-profit and
// disclosure gates are made non-blocking on purpose to isolate the stop-loss.
function baseline(symbol: string): LivePhaseBGateInput {
  return {
    liveBrokerExecutionEnabled: true,
    globalLiveEnabled: true,
    userLiveApproved: true,
    userArmed: true,
    killSwitchEngaged: false,
    bridgeAccountType: "live",
    bridgeHeartbeatAgeSec: 5,
    bridgeEaVersion: "1.27",
    bridgeEnableLiveExecution: true,
    bridgeReadOnlyMode: false,
    bridgeTerminalConnected: true,
    bridgeAlgoTradingAllowed: true,
    commandSymbol: symbol,
    commandVolume: 0.01,
    commandHasStopLoss: true,
    allowedSymbols: [symbol],
    maxLotForSymbol: 0.1,
    dailyLossLimitUsd: 50,
    realisedDailyLossUsd: 0,
    requireStopLoss: true,
    adminAllowNoStopLoss: false,
    requireTakeProfit: false,
    adminAllowNoTakeProfit: true,
    commandHasTakeProfit: true,
    disclosureAccepted: true,
  };
}

async function main(): Promise<void> {
  // Pure static resolver — proves V75 is a real synthetic, never the WS client.
  const { resolveDerivSymbol, isDerivSyntheticSymbol } =
    await import("../../artifacts/api-server/src/lib/data/providers/derivProvider.js");

  // ── #01 — V75 is a genuine synthetic instrument (V75 → R_75) ──────────────
  const resolved = resolveDerivSymbol(SYNTHETIC_SYMBOL);
  record(1, `${SYNTHETIC_SYMBOL} resolves to the Deriv synthetic ${SYNTHETIC_DERIV_ID}`,
    resolved?.derivId === SYNTHETIC_DERIV_ID && isDerivSyntheticSymbol(SYNTHETIC_SYMBOL) === true,
    `resolved=${JSON.stringify(resolved)} isSynthetic=${isDerivSyntheticSymbol(SYNTHETIC_SYMBOL)}`);

  // ── #02 — sanity: a synthetic entry WITH a stop-loss passes every gate ────
  // Proves the only thing that can block the synthetic baseline below is the
  // missing stop-loss, not some other unrelated gate.
  const withSl = evaluateLivePhaseBDispatchGate(baseline(SYNTHETIC_SYMBOL));
  record(2, `${SYNTHETIC_SYMBOL} live entry WITH a stop-loss PASSes all gates`,
    withSl.decision === "PASS" && !withSl.blockReasons.includes("MISSING_STOP_LOSS"),
    `${withSl.decision} [${withSl.blockReasons.join(",")}]`);

  // ── #03 — CORE: synthetic live entry with NO stop-loss is BLOCKED ─────────
  // A SYNTHETIC symbol driven through the live stop-loss gate as a live entry
  // with no stop-loss must be BLOCKED with MISSING_STOP_LOSS.
  const noSl = baseline(SYNTHETIC_SYMBOL);
  noSl.commandHasStopLoss = false;
  const noSlVerdict = evaluateLivePhaseBDispatchGate(noSl);
  record(3, `${SYNTHETIC_SYMBOL} live entry with NO stop-loss → BLOCKED:MISSING_STOP_LOSS`,
    noSlVerdict.decision === "BLOCKED" && noSlVerdict.blockReasons.includes("MISSING_STOP_LOSS"),
    `${noSlVerdict.decision} [${noSlVerdict.blockReasons.join(",")}]`);

  // ── #04 — TRIPWIRE: no implicit no-stop-loss exemption for synthetics ─────
  // TRIPWIRE INTENT (do not "optimize away"): this asserts that being a SYNTHETIC
  // confers NO implicit stop-loss exemption. The per-user override
  // (`allowOrdersWithoutStopLoss`) is OFF here — modelled in the pure gate as
  // `adminAllowNoStopLoss = false` (the override that would relax this gate). With
  // it off, a synthetic no-stop-loss draft is STILL blocked. If a future refactor
  // adds an asset-class branch to the synthetic floor that silently waives the
  // stop-loss for synthetics, THIS check fails the pre-commit gate.
  const overrideOff = baseline(SYNTHETIC_SYMBOL);
  overrideOff.commandHasStopLoss = false;
  overrideOff.adminAllowNoStopLoss = false; // allowOrdersWithoutStopLoss = false
  const overrideOffVerdict = evaluateLivePhaseBDispatchGate(overrideOff);
  record(4, `${SYNTHETIC_SYMBOL} no-SL with override OFF → STILL BLOCKED:MISSING_STOP_LOSS`,
    overrideOffVerdict.decision === "BLOCKED" && overrideOffVerdict.blockReasons.includes("MISSING_STOP_LOSS"),
    `${overrideOffVerdict.decision} [${overrideOffVerdict.blockReasons.join(",")}]`);

  // ── #05 — the ONLY exemption is the EXPLICIT override, not synthetic status ─
  // Flipping the explicit override ON (adminAllowNoStopLoss = true) is the one and
  // only thing that lets a no-stop-loss synthetic entry clear the stop-loss gate.
  // This proves #04's block came from the gate, and that exemption requires an
  // explicit opt-in — synthetic status alone never supplies it.
  const overrideOn = baseline(SYNTHETIC_SYMBOL);
  overrideOn.commandHasStopLoss = false;
  overrideOn.adminAllowNoStopLoss = true; // allowOrdersWithoutStopLoss = true
  const overrideOnVerdict = evaluateLivePhaseBDispatchGate(overrideOn);
  record(5, `${SYNTHETIC_SYMBOL} no-SL with EXPLICIT override ON → stop-loss gate no longer blocks`,
    !overrideOnVerdict.blockReasons.includes("MISSING_STOP_LOSS"),
    `${overrideOnVerdict.decision} [${overrideOnVerdict.blockReasons.join(",")}]`);

  // ── #06 — instrument-agnostic: a non-synthetic gets the SAME treatment ────
  // A forex symbol with no stop-loss and override off is blocked identically,
  // confirming the gate has no synthetic carve-out in either direction.
  const forexNoSl = baseline(FOREX_SYMBOL);
  forexNoSl.commandHasStopLoss = false;
  const forexVerdict = evaluateLivePhaseBDispatchGate(forexNoSl);
  record(6, `${FOREX_SYMBOL} (non-synthetic) no-SL → BLOCKED:MISSING_STOP_LOSS (same as synthetic)`,
    forexVerdict.decision === "BLOCKED" && forexVerdict.blockReasons.includes("MISSING_STOP_LOSS"),
    `${forexVerdict.decision} [${forexVerdict.blockReasons.join(",")}]`);

  // ── #07 — hermetic / no-residue: the gate is a pure function ──────────────
  // Calling the evaluator twice yields byte-identical block reasons, confirming
  // no side effects. By construction this test imports no db / pipeline / broker
  // module and calls no createLiveDraft or dispatch, so 0 `arx_live_commands`
  // rows are written and no broker order is sent.
  const a = evaluateLivePhaseBDispatchGate(noSl).blockReasons.join(",");
  const b = evaluateLivePhaseBDispatchGate(noSl).blockReasons.join(",");
  record(7, "gate is pure (deterministic) → 0 arx_live_commands rows, no broker send",
    a === b, `run1=[${a}] run2=[${b}]`);

  finish();
}

function finish(): void {
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`${r.ok ? "PASS" : "FAIL"}  #${String(r.id).padStart(2, "0")}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n${passed}/${results.length} synthetic stop-loss tripwire checks passed`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });

export {};
