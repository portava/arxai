// Task #763 — pure unit tests for the forward (shadow) chart-series builder. No
// DB, no network → safe for the offline `ci` lane. Locks: realised-R equity from
// closed shadow outcomes only, ordering by outcome time, drawdown-in-R, floating
// R reported as null (never guessed), open-tracking count, honest empty state,
// and the honest provenance label.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildForwardChartSeries, FORWARD_SERIES_LABEL,
  type ForwardDecisionInput,
} from "../forwardChartSeries.js";

function dec(p: Partial<ForwardDecisionInput> & { id: string; status: string }): ForwardDecisionInput {
  return {
    id: p.id, ts: p.ts ?? "2026-01-01T00:00:00.000Z",
    symbol: p.symbol ?? "EURUSD", strategy: p.strategy ?? "flame",
    action: p.action ?? "BUY", entry: p.entry ?? 1.1, status: p.status,
    pnlR: p.pnlR, outcomeAt: p.outcomeAt,
  };
}

test("empty input → honest empty series", () => {
  const s = buildForwardChartSeries([]);
  assert.equal(s.kind, "FORWARD");
  assert.equal(s.label, FORWARD_SERIES_LABEL);
  assert.equal(s.unit, "R");
  assert.equal(s.equity.length, 0);
  assert.equal(s.markers.length, 0);
  assert.equal(s.realizedR, 0);
  assert.equal(s.floatingR, null);
  assert.equal(s.openTrackingCount, 0);
});

test("only closed (WIN/LOSS) decisions contribute realised R, ordered by outcomeAt", () => {
  const s = buildForwardChartSeries([
    dec({ id: "a", status: "SHADOW_WIN", pnlR: 2, outcomeAt: "2026-01-03T00:00:00.000Z" }),
    dec({ id: "b", status: "SHADOW_LOSS", pnlR: -1, outcomeAt: "2026-01-02T00:00:00.000Z" }),
    dec({ id: "c", status: "SHADOW_TRACKING_OUTCOME" }), // still open → no R, counted
    dec({ id: "d", status: "SHADOW_WIN" }), // no pnlR/outcomeAt → ignored
  ]);
  // closed = b (-1) then a (+2) by outcome time → cumulative 0, -1, +1
  assert.equal(s.summary.tracked, 2);
  assert.equal(s.summary.wins, 1);
  assert.equal(s.summary.losses, 1);
  assert.equal(s.realizedR, 1);
  assert.equal(s.openTrackingCount, 1);
  const last = s.equity[s.equity.length - 1]!;
  assert.equal(last.equity, 1);
  // markers ordered by outcome time
  assert.deepEqual(s.markers.map((m) => m.status), ["SHADOW_LOSS", "SHADOW_WIN"]);
});

test("drawdown in R tracks peak-to-trough; floating R stays null", () => {
  const s = buildForwardChartSeries([
    dec({ id: "1", status: "SHADOW_WIN", pnlR: 3, outcomeAt: "2026-01-01T00:00:00.000Z" }), // peak 3
    dec({ id: "2", status: "SHADOW_LOSS", pnlR: -2, outcomeAt: "2026-01-02T00:00:00.000Z" }), // 1, dd 2
    dec({ id: "3", status: "SHADOW_LOSS", pnlR: -1, outcomeAt: "2026-01-03T00:00:00.000Z" }), // 0, dd 3
  ]);
  assert.equal(s.maxDrawdownR, 3);
  assert.equal(s.realizedR, 0);
  assert.equal(s.floatingR, null);
});
