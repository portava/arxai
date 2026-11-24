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

test("a deferred sell uses bid to enter and skips a wide spread inside the band", () => {
  const book = new PublicPaperBracketHistory();
  for (const [epoch, bid, ask] of [[12, 100, 101], [14, 100.25, 100.4], [16, 100.05, 100.15], [18, 97.9, 98]]) {
    book.observe({ epoch: epoch!, symbol: "R_100", quote: bid!, bid, ask });
  }
  const plan = { action: "SELL", reference: 100, stop: 102, target: 98, reason: "fixture" } as const;
  const policy = { band: { from: 99.9, to: 100.1 }, maximumSpreadFractionOfStop: 0.25 };
  const grade = book.gradeTicket("R_100", plan, 10100, 18000, 20000, true, policy);
  assert.equal(grade.state, "TARGET");
  assert.equal(grade.path?.entry.atMs, 16000);
  assert.equal(grade.entry, 100.05);
  assert.equal(grade.exit, 98);

  const invalidated = new PublicPaperBracketHistory();
  invalidated.observe({ epoch: 12, symbol: "R_100", quote: 101.9, bid: 101.8, ask: 102.05 });
  invalidated.observe({ epoch: 14, symbol: "R_100", quote: 100, bid: 100, ask: 100.1 });
  const cancelled = invalidated.gradeTicket("R_100", plan, 10100, 14000, 20000, true, policy);
  assert.deepEqual(cancelled.noFill, { reason: "BRACKET_INVALIDATED", atMs: 12000 });
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

test("Forecast cannot verify a stop or target through a stale executable quote", () => {
  const plan = { action: "BUY" as const, reference: 100, stop: 99, target: 102, reason: "breakout" };
  for (const delayedBid of [98.8, 102.1, 100]) {
    const h = new PublicPaperBracketHistory();
    const add = (epoch: number, bid: number, receivedAt: number) =>
      h.observe({ symbol: "R_100", epoch, bid, ask: bid + 0.2, quote: bid + 0.1 }, receivedAt);
    add(12, 100, 12050);
    add(14, delayedBid, 17001);
    add(16, 102.3, 17002);
    assert.deepEqual(h.gradeTicket("R_100", plan, 11000, 17500), { state: "UNVERIFIED", entry: 100.2 });
  }
  const timely = new PublicPaperBracketHistory();
  timely.observe({ symbol: "R_100", epoch: 12, bid: 100, ask: 100.2, quote: 100.1 });
  timely.observe({ symbol: "R_100", epoch: 14, bid: 102, ask: 102.2, quote: 102.1 }, 17000);
  assert.deepEqual(timely.gradeTicket("R_100", plan, 11000, 17000),
    { state: "TARGET", entry: 100.2, exit: 102, observedAt: 17000 });
});

test("a stated entry expiry excludes a later quote even inside the publication window", () => {
  const history = new PublicPaperBracketHistory();
  const plan = { action: "BUY" as const, reference: 100, stop: 99, target: 102, reason: "test" };
  history.observe({ symbol: "R_100", epoch: 12, bid: 100, ask: 100.2, quote: 100.1 });
  assert.deepEqual(history.gradeTicket("R_100", plan, 11000, 12000, 11999), { state: "SKIPPED" });
  assert.deepEqual(history.gradeTicket("R_100", plan, 11000, 12000, 12000), { state: "OPEN", entry: 100.2 });
});

test("a producer timestamp ahead of availability cannot establish a fill", () => {
  const history = new PublicPaperBracketHistory();
  const plan = { action: "BUY" as const, reference: 100, stop: 99, target: 102, reason: "test" };
  history.observe({ symbol: "R_100", epoch: 12, bid: 100, ask: 100.2, quote: 100.1 }, 11500);
  assert.deepEqual(history.gradeTicket("R_100", plan, 11000, 11900), { state: "PENDING" });
  assert.deepEqual(history.gradeTicket("R_100", plan, 11000, 12500), { state: "SKIPPED" });
});

test("an already verified open Forecast ticket can settle after the entry tick ages out", () => {
  const h = new PublicPaperBracketHistory();
  const plan = { action: "BUY" as const, reference: 100, stop: 97, target: 103, reason: "paper" };
  const observe = (epoch: number, bid = 100) =>
    h.observe({ symbol: "1HZ75V", epoch, bid, ask: bid + 0.1, quote: bid + 0.05 });
  for (let epoch = 11; epoch <= 8199; epoch++) observe(epoch);
  assert.deepEqual(h.gradeTicket("1HZ75V", plan, 10100, 8199000), { state: "OPEN", entry: 100.1 });
  for (let epoch = 8200; epoch <= 8202; epoch++) observe(epoch);
  observe(8203, 103);
  const target = { state: "TARGET", entry: 100.1, exit: 103, observedAt: 8203000 };
  assert.deepEqual(h.gradeTicket("1HZ75V", plan, 10100, 8203000), target);
  assert.deepEqual(h.gradeTicket("1HZ75V", plan, 10100, 8203000), target);
  assert.equal(h.gradeTicket("1HZ75V", plan, 10100, 8202000).state, "OPEN");
  assert.equal(h.gradeTicket("1HZ75V", { ...plan, stop: 96 }, 10100, 8203000).state, "UNVERIFIED");
});

test("losing quote coverage after a Forecast checkpoint leaves the order unverified", () => {
  const h = new PublicPaperBracketHistory();
  const plan = { action: "SELL" as const, reference: 100, stop: 103, target: 97, reason: "paper" };
  for (let epoch = 11; epoch <= 8199; epoch++)
    h.observe({ symbol: "1HZ75V", epoch, bid: 100, ask: 100.1, quote: 100.05 });
  assert.equal(h.gradeTicket("1HZ75V", plan, 10100, 8199000).state, "OPEN");
  for (let epoch = 8201; epoch <= 8207; epoch++)
    h.observe({ symbol: "1HZ75V", epoch, bid: 96, ask: 96.1, quote: 96.05 });
  assert.deepEqual(h.gradeTicket("1HZ75V", plan, 10100, 8207000), { state: "UNVERIFIED", entry: 100 });
});
