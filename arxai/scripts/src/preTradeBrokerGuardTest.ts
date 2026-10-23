// Task #30 — pure unit test for the pre-trade broker-rule guard.
//
// The EA mirrors this exact logic in MQL5 before any OrderSend. This test pins
// the deterministic decisions so EA and server stay in lockstep.
//
// SAFETY: this guard can ONLY refuse. A PASS here never bypasses the 16-gate
// Phase B evaluator, the chokepoint, or the kill switch. These assertions prove
// it refuses on each unsafe broker condition and only passes when every
// broker-reported rule is satisfied.

import {
  evaluatePreTradeBrokerGuard,
  DEFAULT_PRE_TRADE_GUARD_LIMITS,
  type PreTradeGuardInput,
  type PreTradeGuardKey,
} from "@workspace/domain/safety-contracts/preTradeBrokerGuard";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

// A fully-healthy baseline input — every broker rule satisfied. Each test
// mutates exactly one field to force exactly one refusal.
function healthy(): PreTradeGuardInput {
  return {
    side: "BUY",
    volume: 0.1,
    stopLoss: 1.0950,
    takeProfit: 1.1100,
    requestedPrice: 1.1000,
    quote: { bid: 1.0999, ask: 1.1000, quoteAgeMs: 500 },
    spec: {
      visible: true,
      tradeAllowed: true,
      tradeMode: "FULL",
      marketOpen: true,
      point: 0.0001,
      minVolume: 0.01,
      maxVolume: 100,
      volumeStep: 0.01,
      stopsLevelPoints: 10,
      freezeLevelPoints: 0,
    },
    limits: { ...DEFAULT_PRE_TRADE_GUARD_LIMITS },
  };
}

function expectReason(name: string, input: PreTradeGuardInput, reason: PreTradeGuardKey) {
  const r = evaluatePreTradeBrokerGuard(input);
  record(name, r.ok === false && r.reason === reason, `ok=${r.ok} reason=${r.reason ?? "null"} (expected ${reason})`);
}

// 0. Baseline passes.
{
  const r = evaluatePreTradeBrokerGuard(healthy());
  record("healthy input passes", r.ok === true && r.reason === null, `ok=${r.ok} reason=${r.reason ?? "null"}`);
}

// 1. Quote freshness — fail-closed when stale or unknown.
{
  const i = healthy();
  i.quote.quoteAgeMs = 60_000;
  expectReason("stale quote refused", i, "QUOTE_STALE");
}
{
  const i = healthy();
  i.quote.quoteAgeMs = null;
  expectReason("missing quote age fails closed", i, "QUOTE_STALE");
}

// 2. No prices.
{
  const i = healthy();
  i.quote.bid = 0;
  i.quote.ask = 0;
  expectReason("no prices refused", i, "NO_PRICES");
}

// 3. Spread too wide.
{
  const i = healthy();
  i.quote.ask = 1.2000; // 1000 pt spread
  expectReason("wide spread refused", i, "SPREAD_TOO_WIDE");
}

// 4. Market closed.
{
  const i = healthy();
  i.spec.marketOpen = false;
  expectReason("market closed refused", i, "MARKET_CLOSED");
}

// 5. Symbol not tradable (mode restricts the side).
{
  const i = healthy();
  i.spec.tradeMode = "SHORTONLY"; // BUY blocked
  expectReason("short-only blocks BUY", i, "SYMBOL_NOT_TRADABLE");
}
{
  const i = healthy();
  i.spec.tradeAllowed = false;
  expectReason("trade disabled refused", i, "SYMBOL_NOT_TRADABLE");
}

// 6. Deviation / slippage.
{
  const i = healthy();
  i.requestedPrice = 1.0950; // 50pt away from ask 1.1000, default max 20
  expectReason("excess deviation refused", i, "DEVIATION_TOO_LARGE");
}

// 7. Volume below min.
{
  const i = healthy();
  i.volume = 0.001;
  expectReason("volume below min refused", i, "VOLUME_BELOW_MIN");
}

// 8. Volume above max.
{
  const i = healthy();
  i.volume = 500;
  expectReason("volume above max refused", i, "VOLUME_ABOVE_MAX");
}

// 9. Volume off step.
{
  const i = healthy();
  i.volume = 0.105; // not a multiple of 0.01
  expectReason("off-step volume refused", i, "VOLUME_OFF_STEP");
}

// 10. Stop loss too close.
{
  const i = healthy();
  i.stopLoss = 1.0999; // 1pt from entry, stops level is 10pt
  expectReason("SL too close refused", i, "STOP_LOSS_TOO_CLOSE");
}

// 10b. Take profit too close — EA must mirror this (parity check).
{
  const i = healthy();
  i.stopLoss = null; // isolate the TP check
  i.takeProfit = 1.10005; // ~0.5pt from ask 1.1000, stops level 10pt
  expectReason("TP too close refused", i, "TAKE_PROFIT_TOO_CLOSE");
}

// 10c. Stop inside freeze distance — EA must mirror this (parity check).
{
  const i = healthy();
  i.spec.stopsLevelPoints = 0; // disable stops check so freeze surfaces
  i.spec.freezeLevelPoints = 20;
  i.stopLoss = 1.0995; // 5pt from ask, inside 20pt freeze
  i.takeProfit = null;
  expectReason("stop inside freeze refused", i, "STOP_INSIDE_FREEZE");
}

// 11. Fail-OPEN: unknown spec numbers must NOT fabricate a refusal.
{
  const i = healthy();
  i.spec.minVolume = null;
  i.spec.maxVolume = null;
  i.spec.volumeStep = null;
  i.spec.stopsLevelPoints = null;
  const r = evaluatePreTradeBrokerGuard(i);
  record("unknown spec numbers fail-open", r.ok === true, `ok=${r.ok} reason=${r.reason ?? "null"}`);
}

const failed = results.filter((r) => !r.pass);
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) process.exit(1);
process.exit(0);
