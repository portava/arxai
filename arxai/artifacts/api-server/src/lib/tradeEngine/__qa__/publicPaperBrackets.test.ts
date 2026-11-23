import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PublicPaperBracketHistory } from "../publicPaperBrackets.js";

const order = {
  id: 7,
  symbol: "V100",
  direction: "BUY",
  stopLoss: 99,
  takeProfit: 102,
  openedAt: new Date(10100),
  updatedAt: new Date(10100),
};
function exercise(bids: [number, number][], direction = "BUY", start = 10100) {
  const book = new PublicPaperBracketHistory();
  for (const [epoch, bid] of bids)
    book.observe({
      epoch,
      symbol: "R_100",
      quote: bid + 0.1,
      bid,
      ask: bid + 0.2,
    });
  const [last, bid] = bids.at(-1)!;
  return book.read(
    {
      ...order,
      direction,
      stopLoss: direction === "BUY" ? 99 : 102,
      takeProfit: direction === "BUY" ? 102 : 99,
      updatedAt: new Date(start),
    },
    "R_100",
    {
      at: new Date(last * 1000),
      bid,
      ask: bid + 0.2,
      source: "market_data_router:deriv_public",
    },
  );
}
test("records the first stop even if the price later reaches the target", () => {
  const quote = exercise([
    [12, 100],
    [14, 98.8],
    [16, 102.5],
  ]);
  assert.ok(quote.ok);
  assert.equal(quote.bid, 98.8);
  assert.equal(+quote.at, 14000);
});
test("missing ticks before a later target require review", () =>
  assert.equal(
    exercise([
      [12, 100],
      [16, 102.5],
    ]).ok,
    false,
  ));
test("an observed target before an outage can settle", () => {
  const q = exercise([
    [12, 102.1],
    [20, 98],
  ]);
  assert.ok(q.ok);
  assert.equal(q.bid, 102.1);
});
test("a sell exits on ask and ignores crossings before a bracket edit", () => {
  const q = exercise(
    [
      [12, 102],
      [14, 100],
      [16, 101.9],
      [18, 98],
    ],
    "SELL",
    12100,
  );
  assert.ok(q.ok);
  assert.equal(+q.at, 16000);
});

test("Forecast receipt ignores a quote received before publication and grades the first later executable exit", () => {
  const history = new PublicPaperBracketHistory();
  const plan = {
    action: "BUY" as const,
    reference: 100,
    stop: 99,
    target: 102,
    entryLimit: 100.5,
    reason: "test",
  };
  const observe = (epoch: number, bid: number, recv = epoch * 1000) =>
    history.observe(
      { symbol: "R_100", epoch, quote: bid + 0.1, bid, ask: bid + 0.2 },
      recv,
      Math.max(recv, epoch * 1000),
    );
  observe(12, 100.9, 10300);
  observe(14, 100);
  observe(16, 98.8);
  observe(18, 103);
  const grade = history.gradeTicket("R_100", plan, 11000, 18100);
  assert.deepEqual(grade, {
    state: "STOP",
    entry: 100.2,
    exit: 98.8,
    observedAt: 16000,
  });
});
test("a gap, an unmarketable entry, and no settled exit stay distinct", () => {
  const h = new PublicPaperBracketHistory();
  const plan = {
    action: "SELL" as const,
    reference: 100,
    stop: 101,
    target: 98,
    entryLimit: 99.5,
    reason: "test",
  };
  h.observe({ symbol: "R_100", epoch: 12, quote: 100.1, bid: 100, ask: 100.2 });
  assert.equal(h.gradeTicket("R_100", plan, 11000, 12500).state, "OPEN");
  assert.equal(
    h.gradeTicket("R_100", { ...plan, entryLimit: 100.5 }, 11000, 12500).state,
    "SKIPPED",
  );
  h.observe({ symbol: "R_100", epoch: 16, quote: 97.1, bid: 97, ask: 97.2 });
  assert.equal(h.gradeTicket("R_100", plan, 11000, 16500).state, "UNVERIFIED");
});

test("Forecast uses the first fresh quote received after issuance within the same venue second", () => {
  const history = new PublicPaperBracketHistory();
  const plan = {
    action: "BUY" as const, reference: 100, stop: 99, target: 102, entryLimit: 100.5, reason: "test",
  };
  const add = (epoch: number, bid: number, receivedAt: number) =>
    history.observe({ symbol: "R_100", epoch, bid, ask: bid + 0.2, quote: bid + 0.1 }, receivedAt);
  add(10, 100.7, 10040);
  add(12, 100, 12052);
  add(14, 100.7, 14042);
  add(16, 102.1, 16031);
  assert.deepEqual(history.gradeTicket("R_100", plan, 12025, 12040), { state: "PENDING" });
  assert.deepEqual(history.gradeTicket("R_100", plan, 12025, 12052), { state: "OPEN", entry: 100.2 });
  assert.deepEqual(history.gradeTicket("R_100", plan, 12025, 16100), {
    state: "TARGET", entry: 100.2, exit: 102.1, observedAt: 16031,
  });
  assert.equal(history.gradeTicket("R_100", plan, 12052, 16100).state, "SKIPPED");
});
