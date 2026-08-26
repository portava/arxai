// Offline fault-injection certification for the Deriv execution path.
//
// Proves the two invariants against forced venue responses, with no live order:
//
//   I1. ARX never claims a position EXISTS unless there is venue evidence.
//   I2. ARX never claims "NO TRADE" once an order may have reached the venue.
//
// Every test names which invariant it defends. The suite is grouped so both
// are legible as a whole rather than scattered through assertions.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  runDemoTradeCertification, __resetOrderLatchForTests,
  DEMO_TRADE_AUTHORIZATION,
} from "../demoTradeCertify.js";
import { injectedTransport, newLog, HAPPY, V, type InjectionPlan } from "./faultInjection.js";

const CONFIG = { appId: "arx-test-app", token: "fixture-not-a-real-token" };
const AUTH = { authorization: DEMO_TRADE_AUTHORIZATION };
const DEMO = { accounts: [{ account_id: "VRTC9001", account_type: "demo", currency: "USD", status: "active" }] };
const fetchDemo: typeof fetch =
  (async () => new Response(JSON.stringify(DEMO), {
    status: 200, headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

beforeEach(() => __resetOrderLatchForTests());

/** Run the harness against an injection plan. */
async function run(over: InjectionPlan = {}) {
  const log = newLog();
  const report = await runDemoTradeCertification(CONFIG, {
    ...AUTH, observeMs: 0, sleep: async () => {},
    fetchImpl: fetchDemo,
    transportFactory: injectedTransport({ ...HAPPY, ...over }, log),
  });
  return { report, log };
}

const step = (r: Awaited<ReturnType<typeof run>>["report"], name: string) =>
  r.steps.find((s) => s.step === name);

// ════════════════════════════════════════════════════════════════════════════
// I1 — a position is never claimed without venue evidence
// ════════════════════════════════════════════════════════════════════════════

test("I1: a REJECTED buy never produces a contract id", async () => {
  for (const code of ["InsufficientBalance", "MarketIsClosed",
    "ContractBuyValidationError", "InvalidContractProposal", "PriceMoved"]) {
    const { report } = await run({ buy: V.error(code) });
    __resetOrderLatchForTests();
    assert.equal(report.certified, false, `${code} certified`);
    assert.equal(report.contractId, null, `${code} invented a contract id`);
  }
});

test("I1: a success-shaped buy WITHOUT contract_id yields no position id", async () => {
  const { report } = await run({ buy: V.buy({ contract_id: undefined }) });
  assert.equal(report.contractId, null, "a contract id was invented from nothing");
  assert.equal(report.certified, false);
});

test("I1: a STRING contract_id is not accepted as a purchase", async () => {
  // Money fields were widened to accept numeric strings because Deriv's docs
  // conflict on them. contract_id was deliberately NOT widened: it is the
  // recovery handle, and accepting a loose type there risks tracking a
  // position under an id the venue does not recognise.
  const { report } = await run({ buy: V.buy({ contract_id: "555" }) });
  assert.equal(report.contractId, null);
  assert.equal(step(report, "buy")!.status, "UNRESOLVED");
});

test("I1: settlement is never claimed without settlement evidence", async () => {
  // is_sold / is_expired absent means STILL OPEN. Assuming settlement would
  // clear the alarm on a live position.
  const { report } = await run({ proposal_open_contract: V.open() });
  assert.equal(report.positionLeftOpen, true, "an open contract was treated as closed");
  assert.equal(report.certified, false);
});

test("I1: a settled reply about a DIFFERENT contract does not close ours", async () => {
  const { report } = await run({ proposal_open_contract: V.settled({ contract_id: 999 }) });
  assert.equal(report.positionLeftOpen, true);
  assert.equal(report.certified, false);
});

test("I1: a receiptless sell does not assert a close", async () => {
  // The `sell` block is NOT required by Deriv's schema, so this reply is
  // legitimate — and it is not evidence of anything.
  const { report } = await run({
    sell: { kind: "reply", body: { msg_type: "sell" } },
    proposal_open_contract: [V.open(), V.open()],   // venue still says OPEN
  });
  assert.equal(step(report, "sell")!.status, "UNRESOLVED");
  assert.equal(report.positionLeftOpen, true, "closed on no evidence");
});

test("I1: entry/exit spot are never invented when the venue omits them", async () => {
  const { report } = await run({
    proposal: V.proposal({ spot: 500 }),
    proposal_open_contract: V.settled({ entry_spot: undefined, exit_spot: undefined, current_spot: 999 }),
  });
  assert.equal(report.reconciliation!.entrySpot, null);
  assert.equal(report.reconciliation!.exitSpot, null);
  assert.equal(report.reconciliation!.quotedSpot, 500, "the quote is kept, labelled as a quote");
});

// ════════════════════════════════════════════════════════════════════════════
// I2 — "no trade" is never claimed once an order may have reached the venue
// ════════════════════════════════════════════════════════════════════════════

test("I2: a socket closed with the BUY in flight is UNRESOLVED, not a clean failure", async () => {
  // The order may have executed. This is the case I2 exists for: the client
  // simply cannot know, and a clean failure here would tell the owner nothing
  // is open when something may be.
  const { report, log } = await run({ buy: { kind: "close-without-reply" } });
  assert.equal(report.certified, false);
  assert.equal(step(report, "buy")!.status, "UNRESOLVED", "an in-flight buy was called a clean failure");
  assert.match(step(report, "buy")!.detail, /UNKNOWN/);
  assert.equal(report.positionLeftOpen, true, "must warn a position may exist");
  assert.ok(log.sent.includes("buy"), "the order did reach the wire");
});

test("I2: a buy that TIMES OUT is UNRESOLVED", async () => {
  const { report } = await run({
    buy: { kind: "throw", error: Object.assign(new Error("t"), { name: "AbortError" }) },
  });
  assert.equal(step(report, "buy")!.status, "UNRESOLVED");
  assert.equal(report.positionLeftOpen, true);
});

test("I2: a buy that succeeds then drops the socket keeps the contract id", async () => {
  // The id is the only recovery handle. Losing it turns a closeable position
  // into one nobody can find.
  const { report } = await run({
    buy: { kind: "reply-then-close", body: { buy: { contract_id: 777, buy_price: 1 } } },
  });
  assert.equal(report.contractId, 777, "the recovery handle was lost");
  assert.equal(report.positionLeftOpen, true);
});

test("I2: a failed SELL leaves the position reported OPEN with its id", async () => {
  const { report } = await run({
    sell: { kind: "throw", error: new Error("sell rejected") },
    proposal_open_contract: V.open(),
  });
  assert.equal(report.positionLeftOpen, true);
  assert.equal(report.contractId, 555);
  assert.match(step(report, "sell")!.detail, /LEFT OPEN/);
});

test("I2: a venue rejection of the SELL does not clear the alarm", async () => {
  const { report } = await run({
    sell: V.error("ContractAlreadySold"),
    proposal_open_contract: V.open(),
  });
  assert.equal(report.positionLeftOpen, true, "a rejected sell cleared the alarm");
});

// ════════════════════════════════════════════════════════════════════════════
// The tension: I1 and I2 must both hold on the SAME run
// ════════════════════════════════════════════════════════════════════════════

test("both: an ambiguous buy warns of a position AND invents no id", async () => {
  // Erring toward I1 alone would report a clean failure and strand a live
  // position; erring toward I2 alone would fabricate an id to report. The
  // correct answer does neither: warn, and say the id is unknown.
  const { report } = await run({ buy: { kind: "close-without-reply" } });
  assert.equal(report.positionLeftOpen, true, "I2: must warn");
  assert.equal(report.contractId, null, "I1: must not invent an id");
});

test("both: a rejected buy warns of NOTHING and certifies nothing", async () => {
  // The mirror case. A venue error is a REPLY — the order was adjudicated —
  // so there is no ambiguity to warn about, and equally nothing to certify.
  //
  // THIS TEST PREVIOUSLY LIED. Its name claimed the invariant while it
  // asserted only certified/contractId, never positionLeftOpen — which was
  // `true`, i.e. the code warned about a position the venue had just refused
  // to create. A test named for coverage it does not provide is worse than
  // no test, because it stops anyone looking.
  const { report, log } = await run({ buy: V.error("InsufficientBalance") });
  assert.equal(report.certified, false);
  assert.equal(report.contractId, null);
  assert.equal(report.positionLeftOpen, false,
    "a venue-refused order must not raise the open-position alarm");
  assert.equal(step(report, "buy")!.status, "FAIL",
    "an adjudicated refusal is a clean no-trade, not UNKNOWN");
  assert.ok(!log.sent.includes("sell"), "must not try to sell a position that never opened");
});

test("I2: a proven refusal and an unknowable failure are DISTINGUISHABLE", async () => {
  // These produced byte-identical reports. A venue that answered and refused
  // read exactly like a socket that vanished mid-order.
  const refused = await run({ buy: V.error("InsufficientBalance") });
  const unknown = await run({ buy: { kind: "close-without-reply" } });

  assert.equal(step(refused.report, "buy")!.status, "FAIL");
  assert.equal(step(unknown.report, "buy")!.status, "UNRESOLVED");
  assert.equal(refused.report.positionLeftOpen, false);
  assert.equal(unknown.report.positionLeftOpen, true);
  assert.notEqual(step(refused.report, "buy")!.detail, step(unknown.report, "buy")!.detail);
});

test("every documented rejection code is a clean no-trade", async () => {
  for (const code of ["InsufficientBalance", "MarketIsClosed",
    "ContractBuyValidationError", "InvalidContractProposal", "PriceMoved"]) {
    const { report, log } = await run({ buy: V.error(code) });
    __resetOrderLatchForTests();
    const buy = step(report, "buy")!;
    assert.equal(buy.status, "FAIL", `${code} reported as UNKNOWN`);
    assert.equal(report.positionLeftOpen, false, `${code} raised a false alarm`);
    // The venue's own code must survive so the operator's next action is
    // informed — "wait for the session" differs from "add funds".
    assert.match(buy.detail, new RegExp(code), `${code} was lost from the report`);
    assert.equal(buy.errorCode, "DERIV_NEW_API_TRADING_REJECTED");
    assert.ok(!log.sent.includes("sell"));
  }
});

test("UNRESOLVED steps keep their machine-readable code", async () => {
  // Triage on the one state that most needs it used to have prose only.
  const { report } = await run({ buy: { kind: "close-without-reply" } });
  assert.ok(step(report, "buy")!.errorCode, "UNRESOLVED dropped its classification");
});

// ════════════════════════════════════════════════════════════════════════════
// Requote
// ════════════════════════════════════════════════════════════════════════════

test("requote: the buy price CEILING is what ARX authorized, never the raw ask", async () => {
  const { log } = await run({ proposal: V.proposal({ ask_price: 0.4 }) });
  const buy = log.payloads.find((p) => "buy" in p)!;
  // The ceiling is min(quoted ask, cap) — never above what was authorized.
  assert.ok((buy["price"] as number) <= 1, `ceiling ${buy["price"]} exceeded the cap`);
  assert.equal(buy["price"], 0.4);
});

test("requote: a fill ABOVE the quoted ask is still reported at the venue's price", async () => {
  // ARX must report what the venue charged, not what it hoped to pay.
  const { report } = await run({
    proposal: V.proposal({ ask_price: 1 }),
    buy: V.buy({ buy_price: 0.97 }),
    sell: V.sell({ sold_for: 1.22 }),
    proposal_open_contract: V.settled({ profit: 0.25 }),
  });
  assert.equal(report.reconciliation!.buyPrice, 0.97, "reported a price the venue did not charge");
  // derived = 1.22 − 0.97 = 0.25, matching the venue's own profit.
  assert.equal(report.reconciliation!.agrees, true);
});

test("requote: an unstated ask price REFUSES before anything is sent", async () => {
  // `?? stake` invented a ceiling out of ARX's own intent, and the run
  // certified GREEN against a quote that never stated a price.
  const { report, log } = await run({ proposal: V.proposal({ ask_price: undefined }) });
  assert.equal(report.certified, false);
  assert.ok(!log.sent.includes("buy"), "sent an order against a priceless quote");
  assert.equal(report.positionLeftOpen, false);
  assert.match(step(report, "quote_validate")!.detail, /no readable ask price/);
});

test("requote: an UNREADABLE ask price refuses too", async () => {
  for (const junk of ["", "abc", "1,250.00", "1.2.3", null]) {
    const { report, log } = await run({ proposal: V.proposal({ ask_price: junk }) });
    __resetOrderLatchForTests();
    assert.equal(report.certified, false, `accepted ask_price ${JSON.stringify(junk)}`);
    assert.ok(!log.sent.includes("buy"));
  }
  // A numeric STRING is legitimate — the docs conflict on these types — and
  // must still be accepted, or the refusal would be over-broad.
  const okRun = await run({ proposal: V.proposal({ ask_price: "0.80" }) });
  assert.equal(okRun.report.certified, true, JSON.stringify(okRun.report.steps.filter((x) => x.status !== "PASS")));
});

test("requote: an ask ABOVE the cap refuses rather than silently clamping", async () => {
  // Clamping sent a doomed order the venue was always going to refuse —
  // spending a real order to learn what the quote already said.
  const { report, log } = await run({ proposal: V.proposal({ ask_price: 5.14 }) });
  assert.equal(report.certified, false);
  assert.ok(!log.sent.includes("buy"), "sent a clamped order against a 5.14 quote");
  assert.match(step(report, "quote_validate")!.detail, /above the 1 cap/);
});

test("I1: EXPIRY is not settlement — an expired unsold contract stays OPEN", async () => {
  // Deriv can report a contract expired, unsold and not settleable. Treating
  // expiry as closure cleared the alarm on a position the venue still called
  // unsold.
  const { report } = await run({ proposal_open_contract: V.expiredUnsold() });
  assert.equal(report.positionLeftOpen, true, "expiry cleared the open-position alarm");
  assert.equal(report.certified, false);
});

test("I1: is_expired alone, with is_sold absent, still does not settle", async () => {
  const { report } = await run({
    proposal_open_contract: { kind: "reply", body: {
      proposal_open_contract: { contract_id: 555, is_expired: 1, profit: 0.25 },
    } },
  });
  assert.equal(report.positionLeftOpen, true);
  assert.equal(report.certified, false);
});
