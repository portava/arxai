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
import { DerivNewApiError } from "../errors.js";

const CONFIG = { appId: "arx-test-app", token: "fixture-not-a-real-token" };
const AUTH = { authorization: DEMO_TRADE_AUTHORIZATION };
const DEMO = { accounts: [{ account_id: "VRTC9001", account_type: "demo", currency: "USD", status: "active" }] };
const fetchDemo: typeof fetch =
  (async () => new Response(JSON.stringify(DEMO), {
    status: 200, headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

beforeEach(() => __resetOrderLatchForTests());

/**
 * Run the harness against an injection plan.
 *
 * Resets the one-order latch FIRST. Without this a test calling run() twice
 * has its second buy refused by the latch before the injected fault is ever
 * reached — so the run under test never happens and the assertion passes for
 * the wrong reason. That is exactly what "I2: a proven refusal and an
 * unknowable failure are DISTINGUISHABLE" was doing: its second case was
 * being refused by the latch, not by the injected socket loss.
 */
async function run(over: InjectionPlan = {}) {
  __resetOrderLatchForTests();
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
  assert.match(step(report, "confirm_closed")!.detail, /not confirmed settled/);
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

// ════════════════════════════════════════════════════════════════════════════
// Late venue evidence resolving an UNKNOWN (audit priority 1)
// ════════════════════════════════════════════════════════════════════════════

test("a LATE buy receipt rescues an UNKNOWN into a known contract id", async () => {
  // ARX gave up waiting; the venue answered afterwards. Venue evidence
  // dominates local inference, so the position becomes findable instead of
  // staying an UNKNOWN nobody can act on.
  const log = newLog();
  log.orphans.push({
    reqId: 2, op: "buy",
    body: { buy: { contract_id: 4242, buy_price: 1 } },
    derivErrorCode: null,
  });
  const report = await runDemoTradeCertification(CONFIG, {
    ...AUTH, observeMs: 0, sleep: async () => {},
    fetchImpl: fetchDemo,
    transportFactory: injectedTransport({ ...HAPPY, buy: { kind: "close-without-reply" } }, log),
  });
  assert.equal(report.contractId, 4242, "authoritative late evidence was ignored");
  assert.equal(report.positionLeftOpen, true, "a confirmed position must still be flagged");
  assert.equal(step(report, "buy")!.status, "UNRESOLVED");
  assert.match(step(report, "buy")!.detail, /LATE venue receipt/);
});

test("a LATE venue REFUSAL turns an UNKNOWN into a clean no-trade", async () => {
  // Adjudication is adjudication whenever it arrives. Holding the alarm open
  // after the venue has said no is conservative in the wrong direction — it
  // sends an operator hunting for a contract that was never created.
  const log = newLog();
  log.orphans.push({
    reqId: 2, op: "buy", body: { error: { code: "InsufficientBalance" } },
    derivErrorCode: "InsufficientBalance",
  });
  const report = await runDemoTradeCertification(CONFIG, {
    ...AUTH, observeMs: 0, sleep: async () => {},
    fetchImpl: fetchDemo,
    transportFactory: injectedTransport({ ...HAPPY, buy: { kind: "close-without-reply" } }, log),
  });
  assert.equal(step(report, "buy")!.status, "FAIL");
  assert.equal(report.positionLeftOpen, false);
  assert.equal(report.contractId, null);
  assert.match(step(report, "buy")!.detail, /LATE venue reply REFUSED/);
});

test("a late reply for a DIFFERENT operation never resolves the buy", async () => {
  // Ownership is proven by the op ARX issued under that id, not by whatever
  // the reply happens to contain.
  const log = newLog();
  log.orphans.push({
    reqId: 2, op: "ping", body: { buy: { contract_id: 9999, buy_price: 1 } },
    derivErrorCode: null,
  });
  const report = await runDemoTradeCertification(CONFIG, {
    ...AUTH, observeMs: 0, sleep: async () => {},
    fetchImpl: fetchDemo,
    transportFactory: injectedTransport({ ...HAPPY, buy: { kind: "close-without-reply" } }, log),
  });
  assert.equal(report.contractId, null, "adopted a receipt from an unrelated request");
  assert.equal(step(report, "buy")!.status, "UNRESOLVED");
});

// ════════════════════════════════════════════════════════════════════════════
// Evidence precedence: receipt vs venue re-read (audit priority 3)
// ════════════════════════════════════════════════════════════════════════════

test("a refused sell still ASKS the venue — the rejection adjudicates the REQUEST", async () => {
  // "Already sold" refuses the sell precisely BECAUSE the contract is closed.
  // Returning open on that reply reports a closed position as open — a false
  // claim, even though it errs toward caution. The venue decides.
  const { report } = await run({
    sell: V.error("ContractAlreadySold", "sell"),
    proposal_open_contract: V.settled(),
  });
  assert.equal(report.positionLeftOpen, false, "reported a settled contract as open");
  assert.match(step(report, "confirm_closed")!.detail, /despite the sell request failing/);
});

test("a refused sell on a GENUINELY open contract keeps the alarm, with venue evidence", async () => {
  // The mandatory pair. Same rejection, opposite venue state, opposite verdict.
  const { report } = await run({
    sell: V.error("MarketIsClosed", "sell"),
    proposal_open_contract: V.open({ is_sold: 0, status: "open", is_settleable: 0 }),
  });
  assert.equal(report.positionLeftOpen, true);
  assert.match(step(report, "confirm_closed")!.detail, /NOT SOLD/);
  assert.match(step(report, "confirm_closed")!.detail, /status=open/);
});

test("a receipt CONTRADICTED by the venue does not report CLOSED — it surfaces", async () => {
  // The receipt says sold; the venue says unsold. ARX must not pick a side
  // quietly. A sell may have half-happened, and the operator needs to know
  // that before this account trades again.
  const { report } = await run({
    sell: V.sell({ sold_for: 1.25 }),
    proposal_open_contract: V.open({ is_sold: 0, status: "open" }),
  });
  assert.equal(report.certified, false);
  assert.equal(report.positionLeftOpen, true);
  const c = step(report, "confirm_closed")!;
  assert.equal(c.status, "FAIL");
  assert.match(c.detail, /CONTRADICTION/);
  assert.match(c.detail, /Not reporting CLOSED/);
});

// ════════════════════════════════════════════════════════════════════════════
// Settlement matrix (audit priority 6)
// ════════════════════════════════════════════════════════════════════════════

test("settlement is three-valued: SOLD / NOT_SOLD / ABSENT / UNRECOGNISED", async () => {
  const cases: Array<[unknown, string, boolean]> = [
    [1,      "SOLD",         false],   // [is_sold, evidence, positionLeftOpen]
    [true,   "SOLD",         false],
    [0,      "NOT_SOLD",     true],
    [false,  "NOT_SOLD",     true],
    [undefined, "ABSENT",    true],
    ["1",    "UNRECOGNISED", true],    // the string-drift trap
    ["true", "UNRECOGNISED", true],
    [null,   "ABSENT",       true],
  ];
  for (const [is_sold, evidence, leftOpen] of cases) {
    const { report } = await run({
      proposal_open_contract: { kind: "reply", body: {
        proposal_open_contract: {
          contract_id: 555, ...(is_sold === undefined ? {} : { is_sold }),
          profit: 0.25, entry_spot: 617, exit_spot: 618,
        },
      } },
    });
    __resetOrderLatchForTests();
    assert.equal(report.positionLeftOpen, leftOpen,
      `is_sold=${JSON.stringify(is_sold)} (${evidence}) gave leftOpen=${report.positionLeftOpen}`);
  }
});

test("an UNRECOGNISED is_sold names itself rather than looking like an open position", async () => {
  // A schema drift must be attributable. "is_sold was present in a type ARX
  // does not accept" sends someone to the schema; "not confirmed settled"
  // sends them to the venue to hunt a position that may be closed.
  const { report } = await run({
    proposal_open_contract: { kind: "reply", body: {
      proposal_open_contract: { contract_id: 555, is_sold: "1", profit: 0.25 },
    } },
  });
  assert.match(step(report, "confirm_closed")!.detail, /type ARX does not accept/);
});

test("SILENCE and NOT_SOLD are reported differently — they are different facts", async () => {
  const absent = await run({
    proposal_open_contract: { kind: "reply", body: {
      proposal_open_contract: { contract_id: 555, profit: 0.25 },
    } },
  });
  const notSold = await run({
    proposal_open_contract: V.open({ is_sold: 0, status: "open" }),
  });
  assert.match(step(absent.report, "confirm_closed")!.detail, /stated no is_sold at all/);
  assert.match(step(notSold.report, "confirm_closed")!.detail, /NOT SOLD/);
  // Both hold the alarm — being conservative is correct — but the operator is
  // told which situation they are in.
  assert.equal(absent.report.positionLeftOpen, true);
  assert.equal(notSold.report.positionLeftOpen, true);
});

// ════════════════════════════════════════════════════════════════════════════
// Partial fill: NOT REPRESENTABLE for a Deriv multiplier (audit priority 4)
// ════════════════════════════════════════════════════════════════════════════
//
// Settled from the published schemas, not from MT5 intuition:
//
//   buy_request.schema.json   required: ["buy","price"]. No quantity, size or
//                             lots field. `price` is documented as "Maximum
//                             price at which to purchase the contract" — a
//                             CEILING, which is why ARX's ceiling semantics
//                             are venue-enforced rather than aspirational.
//
//   buy_response.schema.json  the `buy` object requires all nine of
//                             [balance_after, buy_price, contract_id,
//                             longcode, payout, purchase_time, shortcode,
//                             start_time, transaction_id]. There is NO field
//                             for filled quantity or partial execution.
//
// A multiplier position is defined by stake and multiplier, not by lots. The
// buy is therefore ATOMIC: a contract is created or it is not.
//
// Modelling PARTIALLY_FILLED here would invent a state the venue cannot
// express — which is its own form of false certainty, just pointed at a
// phantom instead of a fact. liveCommandPipeline models it for MT5 because
// MT5 CAN partially fill; importing that blindly is what these tests forbid.

test("partial fill: the buy is ATOMIC — contract_id present, or it is not a purchase", async () => {
  // There is no third outcome to model, so the code must have exactly two.
  const filled = await run({ buy: V.buy({ contract_id: 555 }) });
  assert.equal(filled.report.contractId, 555);

  const notFilled = await run({ buy: V.buy({ contract_id: undefined }) });
  assert.equal(notFilled.report.contractId, null);
  assert.equal(step(notFilled.report, "buy")!.status, "UNRESOLVED");
});

test("partial fill: no PARTIALLY_FILLED concept leaks into the Deriv path", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL("../", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const code = readFileSync(new URL(f, dir), "utf8")
      // Comments EXPLAIN why the concept is absent; matching prose would be a
      // false failure, the mirror of the comment-trap that produced false
      // passes earlier in this workstream.
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/PARTIALLY_FILLED|partialFill|isPartialFill/.test(code),
      `${f} models partial fill, which Deriv's multiplier buy cannot express`);
  }
});

test("requote: `price` is a venue-enforced CEILING, and the EXECUTED price is read back", async () => {
  // buy_request documents price as the MAXIMUM. So ARX does not need to
  // police the fill price itself — but it must report what the venue actually
  // charged, which is buy_response.buy_price ("Actual effected purchase
  // price"), never the quote it hoped for.
  const { report, log } = await run({
    proposal: V.proposal({ ask_price: 0.9 }),
    buy: V.buy({ buy_price: 0.87 }),
    sell: V.sell({ sold_for: 1.12 }),
    proposal_open_contract: V.settled({ profit: 0.25 }),
  });
  const buyPayload = log.payloads.find((p) => "buy" in p)!;
  assert.equal(buyPayload["price"], 0.9, "the ceiling must be the venue's own ask");
  assert.equal(report.reconciliation!.buyPrice, 0.87, "must report what the venue charged");
  assert.equal(report.reconciliation!.agrees, true);
});

// ════════════════════════════════════════════════════════════════════════════
// Transmission evidence (F20) and late sell receipts (F11)
// ════════════════════════════════════════════════════════════════════════════

test("a buy that NEVER reached the socket is not described as written", async () => {
  // The measured defect: frames actually sent were ["proposal"] only, yet the
  // report read "transport is DISCONNECTED ... the buy frame WAS written to
  // the socket" — self-contradicting inside one sentence, and false.
  const { report, log } = await run({
    buy: { kind: "throw", error: new DerivNewApiError("DERIV_NEW_API_WS_CONNECT_FAILED", {
      detail: "transport is DISCONNECTED, not WS_READY", wireWritten: false,
    }) },
  });
  const buy = step(report, "buy")!;
  assert.equal(buy.status, "FAIL", "provable non-transmission is a clean no-trade");
  assert.equal(report.positionLeftOpen, false, "warned about an order that never left");
  assert.match(buy.detail, /NEVER written/);
  assert.ok(!/WAS written/.test(buy.detail), "claimed a write that did not happen");
  assert.ok(!log.sent.includes("sell"));
});

test("a buy lost IN FLIGHT is still UNKNOWN — absence of proof is not proof", async () => {
  // The mirror. wireWritten true (or unknown) must never become a no-trade.
  for (const wireWritten of [true, null]) {
    const { report } = await run({
      buy: { kind: "throw", error: new DerivNewApiError("DERIV_NEW_API_REQUEST_TIMEOUT", {
        detail: "no reply", wireWritten,
      }) },
    });
    assert.equal(step(report, "buy")!.status, "UNRESOLVED", `wireWritten=${wireWritten}`);
    assert.equal(report.positionLeftOpen, true);
  }
});

test("a LATE sell receipt is consulted before describing the position's fate", async () => {
  // The orphan drain was wired on the buy path only, so a receipt arriving
  // just after the sell timed out was discarded while ARX went on to describe
  // the outcome without it.
  const log = newLog();
  log.orphans.push({
    reqId: 5, op: "sell",
    body: { sell: { contract_id: 555, sold_for: 1.31 } },
    derivErrorCode: null,
  });
  const report = await runDemoTradeCertification(CONFIG, {
    ...AUTH, observeMs: 0, sleep: async () => {},
    fetchImpl: fetchDemo,
    transportFactory: injectedTransport({
      ...HAPPY,
      sell: { kind: "throw", error: new DerivNewApiError("DERIV_NEW_API_REQUEST_TIMEOUT", { detail: "no reply" }) },
      proposal_open_contract: V.settled({ profit: 0.31 }),
    }, log),
  });
  assert.match(step(report, "sell")!.detail, /LATE venue receipt reports the sale/);
  assert.equal(report.reconciliation!.sellProceeds, 1.31, "late proceeds were discarded");
  assert.equal(report.positionLeftOpen, false, "the venue confirmed settlement");
});

test("a late sell receipt for a DIFFERENT contract is not adopted", async () => {
  const log = newLog();
  log.orphans.push({
    reqId: 5, op: "sell",
    body: { sell: { contract_id: 888, sold_for: 9.99 } },
    derivErrorCode: null,
  });
  const report = await runDemoTradeCertification(CONFIG, {
    ...AUTH, observeMs: 0, sleep: async () => {},
    fetchImpl: fetchDemo,
    transportFactory: injectedTransport({
      ...HAPPY,
      sell: { kind: "throw", error: new DerivNewApiError("DERIV_NEW_API_REQUEST_TIMEOUT", { detail: "no reply" }) },
      proposal_open_contract: V.open({ is_sold: 0, status: "open" }),
    }, log),
  });
  assert.notEqual(report.reconciliation?.sellProceeds, 9.99);
  assert.equal(report.positionLeftOpen, true);
});
