// Single-trade DEMO certification (spec Phase 15).
//
// This is the only ARX code outside the 18-gate path that places an order, so
// these tests are almost entirely REFUSALS. A test that proves the happy path
// works is worth less here than one proving the harness cannot be made to
// place a second order, trade a real account, or run unattended.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  runDemoTradeCertification, assertSingleDemoOrder, recordOrderAttempt,
  __resetOrderLatchForTests, ordersPlaced,
  DEMO_TRADE_AUTHORIZATION, DEMO_TRADE_MAX_STAKE, DemoTradeRefusal,
} from "../demoTradeCertify.js";

const CONFIG = { appId: "arx-test-app", token: "fixture-not-a-real-token" };

beforeEach(() => __resetOrderLatchForTests());

const ACCOUNTS = (type: string) => ({
  accounts: [{ account_id: "VRTC9001", account_type: type, currency: "USD", status: "active" }],
});
const fakeFetch = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

function fakeTransport(over: Record<string, unknown> = {}, sink?: string[]) {
  const answers: Record<string, unknown> = {
    proposal: { proposal: { id: "quote-1", ask_price: 1 } },
    buy: { buy: { contract_id: 555, buy_price: 1, transaction_id: 9 } },
    proposal_open_contract: { proposal_open_contract: { contract_id: 555, is_sold: 1, profit: 0.25 } },
    sell: { sold: { sold_for: 1.25 } },
    ...over,
  };
  return () => ({
    connect: async () => {},
    getState: () => "WS_READY",
    close: () => {},
    send: async (p: Record<string, unknown>) => {
      const op = Object.keys(p).find((k) => k !== "req_id" && k !== "subscribe")!;
      sink?.push(op);
      if (!(op in answers)) throw new Error(`unexpected ${op}`);
      return answers[op] as Record<string, unknown>;
    },
  }) as never;
}

const AUTH = { authorization: DEMO_TRADE_AUTHORIZATION };

// ── Refusals ───────────────────────────────────────────────────────────────

test("without the exact authorization string, NOTHING is sent", async () => {
  const sent: string[] = [];
  for (const authorization of [undefined, "", "yes", "true", "place-one-demo-order"]) {
    const r = await runDemoTradeCertification(CONFIG, {
      authorization, fetchImpl: fakeFetch(ACCOUNTS("demo")), transportFactory: fakeTransport({}, sent),
    });
    assert.equal(r.certified, false, `accepted authorization: ${JSON.stringify(authorization)}`);
    assert.equal(r.steps[0]!.step, "authorization");
  }
  // A truthy value, a lowercase variant, and an empty string must all fail —
  // and the venue must never have been contacted.
  assert.equal(sent.length, 0);
  assert.equal(ordersPlaced(), 0);
});

test("a REAL account is refused before any order", async () => {
  const sent: string[] = [];
  const r = await runDemoTradeCertification(CONFIG, {
    ...AUTH, fetchImpl: fakeFetch(ACCOUNTS("real")), transportFactory: fakeTransport({}, sent),
  });
  assert.equal(r.certified, false);
  assert.equal(sent.length, 0, "nothing may be sent for a real account");
  assert.equal(ordersPlaced(), 0);
});

test("an account of UNKNOWN type is refused — not-real is not enough", async () => {
  // "Not real" alone would accept an account whose type the venue omitted.
  const sent: string[] = [];
  const r = await runDemoTradeCertification(CONFIG, {
    ...AUTH, fetchImpl: fakeFetch({ accounts: [{ account_id: "X1", status: "active" }] }),
    transportFactory: fakeTransport({}, sent),
  });
  assert.equal(r.certified, false);
  assert.equal(sent.length, 0);
});

test("a stake above the cap is refused before quoting", async () => {
  const sent: string[] = [];
  const r = await runDemoTradeCertification(CONFIG, {
    ...AUTH, stake: DEMO_TRADE_MAX_STAKE + 0.01,
    fetchImpl: fakeFetch(ACCOUNTS("demo")), transportFactory: fakeTransport({}, sent),
  });
  assert.equal(r.certified, false);
  assert.equal(sent.length, 0);
});

test("a SECOND order in the same process is impossible", async () => {
  // The latch is module state, so a fresh call cannot reset it.
  recordOrderAttempt();
  assert.throws(() => assertSingleDemoOrder({ buy: "q", price: 1 }), DemoTradeRefusal);
});

test("the order gate refuses an uncapped or unbounded price", async () => {
  for (const price of [undefined, 0, -1, Number.NaN, DEMO_TRADE_MAX_STAKE + 1]) {
    assert.throws(() => assertSingleDemoOrder({ buy: "q", price } as Record<string, unknown>),
      DemoTradeRefusal, `accepted price ${price}`);
  }
  assert.doesNotThrow(() => assertSingleDemoOrder({ buy: "q", price: DEMO_TRADE_MAX_STAKE }));
});

test("money-movement operations are refused outright", async () => {
  for (const op of ["cashier", "transfer_between_accounts", "topup_virtual",
    "buy_contract_for_multiple_accounts", "sell_expired"]) {
    assert.throws(() => assertSingleDemoOrder({ [op]: 1 }), DemoTradeRefusal, `${op} allowed`);
  }
});

// ── Honesty about an order that may exist ──────────────────────────────────

test("a buy reply with NO contract id is UNRESOLVED, never 'no trade happened'", async () => {
  // The order reached the venue. Reporting a clean failure would tell the
  // owner nothing is open when something may be.
  const r = await runDemoTradeCertification(CONFIG, {
    ...AUTH, fetchImpl: fakeFetch(ACCOUNTS("demo")),
    transportFactory: fakeTransport({ buy: { buy: { buy_price: 1 } } }),
  });
  assert.equal(r.certified, false);
  const buyStep = r.steps.find((s) => s.step === "buy")!;
  assert.equal(buyStep.status, "UNRESOLVED");
  assert.match(buyStep.detail, /UNKNOWN/);
  assert.equal(r.positionLeftOpen, true, "must warn a position may exist");
});

test("a failed SELL reports the position as LEFT OPEN with its contract id", async () => {
  const r = await runDemoTradeCertification(CONFIG, {
    ...AUTH, observeMs: 0, sleep: async () => {},
    fetchImpl: fakeFetch(ACCOUNTS("demo")),
    transportFactory: fakeTransport({ sell: undefined as never }),
  });
  assert.equal(r.positionLeftOpen, true);
  assert.equal(r.contractId, 555, "the contract id must survive the failure");
  assert.match(r.steps.find((s) => s.step === "sell")!.detail, /LEFT OPEN/);
});

test("a P/L MISMATCH fails certification — that is the point of the run", async () => {
  const r = await runDemoTradeCertification(CONFIG, {
    ...AUTH, observeMs: 0, sleep: async () => {},
    fetchImpl: fakeFetch(ACCOUNTS("demo")),
    // proceeds 1.25 − cost 1 = 0.25 derived, but Deriv claims 99.
    transportFactory: fakeTransport({
      proposal_open_contract: { proposal_open_contract: { contract_id: 555, is_sold: 1, profit: 99 } },
    }),
  });
  assert.equal(r.certified, false);
  assert.match(r.steps.find((s) => s.step === "reconcile")!.detail, /MISMATCH/);
});

test("an unconfirmed closure is UNRESOLVED, not a pass", async () => {
  const r = await runDemoTradeCertification(CONFIG, {
    ...AUTH, observeMs: 0, sleep: async () => {},
    fetchImpl: fakeFetch(ACCOUNTS("demo")),
    transportFactory: fakeTransport({
      proposal_open_contract: { proposal_open_contract: { contract_id: 555 } },  // never settled
    }),
  });
  assert.equal(r.certified, false);
  assert.equal(r.positionLeftOpen, true);
});

// ── The happy path, and exactly one order within it ────────────────────────

test("a clean run places EXACTLY ONE buy and ONE sell, and reconciles", async () => {
  const sent: string[] = [];
  const r = await runDemoTradeCertification(CONFIG, {
    ...AUTH, observeMs: 0, sleep: async () => {},
    fetchImpl: fakeFetch(ACCOUNTS("demo")), transportFactory: fakeTransport({}, sent),
  });
  assert.equal(r.certified, true, JSON.stringify(r.steps.filter((s) => s.status !== "PASS")));
  assert.equal(sent.filter((o) => o === "buy").length, 1, "more than one buy");
  assert.equal(sent.filter((o) => o === "sell").length, 1, "more than one sell");
  assert.equal(r.positionLeftOpen, false);
  assert.equal(r.reconciliation!.agrees, true);
  assert.equal(ordersPlaced(), 1);
});

// ── Isolation from autonomous execution ────────────────────────────────────

test("EXACTLY ONE file imports the demo-trade harness: its own CLI", () => {
  // The owner's constraint: keep the first trade certification isolated from
  // autonomous execution. The allow-list is pinned to a single entry rather
  // than a pattern, so adding any new importer — a route, a job, a scheduler,
  // an adapter — fails this test by name.
  const SOLE_PERMITTED_IMPORTER = "src/scripts/derivDemoTradeCertify.ts";
  const roots = ["src/lib", "src/routes", "src/scripts", "src/services", "src/jobs"];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith(".ts")) continue;
      if (full.endsWith("/demoTradeCertify.ts") || full.endsWith("/newApiDemoTrade.test.ts")) continue;
      if (full.endsWith(SOLE_PERMITTED_IMPORTER)) continue;
      const code = readFileSync(full, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/demoTradeCertify/.test(code)) offenders.push(full);
    }
  };
  for (const r of roots) walk(`${process.cwd()}/${r}`);
  assert.deepEqual(offenders, [],
    `the demo-trade harness must be reachable ONLY from ${SOLE_PERMITTED_IMPORTER}, `
    + `but is also imported by: ${offenders.join(", ")}`);
  // And prove the permitted importer really does exist — otherwise this test
  // would pass trivially if the CLI were renamed or deleted.
  const cli = readFileSync(`${process.cwd()}/${SOLE_PERMITTED_IMPORTER}`, "utf8");
  assert.match(cli, /demoTradeCertify/, "the sole permitted importer no longer imports it");
});

test("the harness touches no execution adapter or dispatch path", () => {
  const code = readFileSync(new URL("../demoTradeCertify.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["ExecutionAdapter", "dispatchLiveCommand", "liveCommandPipeline",
    "PhaseBDispatch", "enqueueBridged", "strategy"]) {
    assert.ok(!code.includes(forbidden), `harness references ${forbidden}`);
  }
});
