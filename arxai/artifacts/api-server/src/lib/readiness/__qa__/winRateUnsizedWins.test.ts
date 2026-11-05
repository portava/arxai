// Review pass 3: the readiness win rate counts each paper close at the Risk
// Governor's risk count (paperBookReader.realizedOf), where a close whose
// amount could not be sized counts 0 when it won. That stricter count stays the
// readiness input. But the WIN_RATE_UNSTABLE flag (shown to the trader through
// the coach's activeRiskFlags) said "30d win rate 40% < 50%." as if it were the
// measured win rate, while 2 of the 10 closes won on price and were not
// counted as wins (the win rate by price move is 60%). The message now says
// what it leaves out.
//
// The real evaluateReadiness runs; only the paper book's read side is stubbed
// with fixed closes. Every other read fails against the unreachable test
// DATABASE_URL and is reported as a missing data source. Nothing is persisted.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/readiness/__qa__/winRateUnsizedWins.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

const realBook = await import("../../tradeEngine/paperBookReader.js");

type Close = { id: number; symbol: string; direction: string; lotSize: number; entryPrice: number; exitPrice: number; profitLoss: number; status: string; closedAt: Date; decisionId: null };
let closes: Close[] = [];
const at = (i: number) => new Date(Date.now() - (i + 1) * 3_600_000);
const close = (i: number, over: Partial<Close>): Close => ({
  id: i, symbol: "EURUSD", direction: "BUY", lotSize: 0.1, entryPrice: 1.1, exitPrice: 1.101, profitLoss: 10,
  status: "CLOSED_TP", closedAt: at(i), decisionId: null, ...over,
});

mock.module("../../tradeEngine/paperBookReader.js", {
  namedExports: {
    ...realBook,
    sumPaperRealizedSince: async () => 0,
    readOpenPaperOrders: async () => [],
    readPaperCloses: async () => closes.map((o) => ({ ...o, pnl: realBook.realizedOf(o) })),
    readPaperOrders: async () => closes,
    readActivePaperAccount: async () => null,
  },
});

const { evaluateReadiness } = await import("../traderReadiness.js");
const quiet = { info() {}, warn() {}, error() {} };

function tenCloses(unsizedWins: number): Close[] {
  const out: Close[] = [];
  let i = 0;
  // 6 closes won on price; `unsizedWins` of them are V75 target hits that
  // could not be sized (profit_loss holds the 0 placeholder).
  for (let k = 0; k < 6; k++) {
    out.push(k < unsizedWins
      ? close(i++, { symbol: "V75", entryPrice: 1000, exitPrice: 1020, lotSize: 1, profitLoss: 0 })
      : close(i++, {}));
  }
  for (let k = 0; k < 4; k++) out.push(close(i++, { exitPrice: 1.099, profitLoss: -10, status: "CLOSED_SL" }));
  return out;
}

test("the win-rate flag says closes of unknown size that won are not counted as wins", async () => {
  closes = tenCloses(2);
  const e = await evaluateReadiness({ persist: false, userId: 7, log: quiet as never });
  assert.equal(e.metrics.sampleSize, 10);
  assert.equal(e.metrics.winRate30d, 40, "the readiness input stays the stricter risk count");
  assert.equal(e.metrics.unsizedPaperCloses30d, 2);
  assert.equal(e.metrics.unsizedWinningPaperCloses30d, 2);
  const flag = e.riskFlags.find((f) => f.code === "WIN_RATE_UNSTABLE");
  assert.ok(flag, "40% is below 50%");
  assert.notEqual(flag.message, "30d win rate 40% < 50%.", "was stated as the measured win rate");
  assert.match(flag.message, /^30d win rate 40% < 50%/);
  assert.match(flag.message, /2 closes of unknown size that won on price are not counted as wins/);
});

test("with every close sized, the flag message is unchanged", async () => {
  closes = tenCloses(0);
  closes = closes.map((c, k) => (k === 0 || k === 1 ? { ...c, exitPrice: 1.099, profitLoss: -10, status: "CLOSED_SL" } : c));
  const e = await evaluateReadiness({ persist: false, userId: 7, log: quiet as never });
  assert.equal(e.metrics.winRate30d, 40);
  assert.equal(e.metrics.unsizedWinningPaperCloses30d, 0);
  const flag = e.riskFlags.find((f) => f.code === "WIN_RATE_UNSTABLE");
  assert.equal(flag?.message, "30d win rate 40% < 50%.");
});
