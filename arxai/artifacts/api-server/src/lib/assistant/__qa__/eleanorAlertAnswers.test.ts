// "close it" answers an alert; "never mind" no longer stands down monitors
// (sweep 2026-11-04). Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelScope, isCloseAlertAnswer, pickWatchesToCancel } from "../eleanorAlertAnswers.js";

test("close answers", () => {
  for (const t of ["close it", "Close it.", "close that", "close the trade", "close it now", "close now", "yes close", "yes, close it", "ok close", "yeah close that!"]) {
    assert.equal(isCloseAlertAnswer(t), true, t);
  }
  for (const t of ["close EURUSD", "close all", "close", "close half", "close it at 1.09", "please analyse if I should close it"]) {
    assert.equal(isCloseAlertAnswer(t), false, t);
  }
});

const at = (m: number) => new Date(Date.parse("2026-11-04T10:00:00Z") + m * 60_000);
const rows = [
  { id: 1, kind: "MONITOR_TRADE", symbol: "EURUSD", createdAt: at(5) },
  { id: 2, kind: "WATCH_AND_ENTER", symbol: "XAUUSD", createdAt: at(3) },
  { id: 3, kind: "WATCH_AND_CLOSE", symbol: "GBPUSD", createdAt: at(4) },
  { id: 4, kind: "WATCH_AND_ENTER", symbol: "EURUSD", createdAt: at(1) },
];
const ids = (xs: Array<{ id: number }>) => xs.map((x) => x.id);

test("cancel scope: never mind → the most recent non-monitor watch only", () => {
  assert.equal(cancelScope("never mind", "CANCEL"), "LATEST_WATCH");
  assert.deepEqual(ids(pickWatchesToCancel(rows, "LATEST_WATCH")), [3]);
});

test("cancel scope: stop monitoring → the most recent monitor; all/everything → every watch", () => {
  assert.equal(cancelScope("stop monitoring", "CANCEL"), "LATEST_MONITOR");
  assert.deepEqual(ids(pickWatchesToCancel(rows, "LATEST_MONITOR")), [1]);
  assert.equal(cancelScope("cancel everything", "CANCEL"), "ALL");
  assert.equal(cancelScope("cancel all my pending orders", "CANCEL_PENDING_ORDER"), "ALL");
  assert.deepEqual(ids(pickWatchesToCancel(rows, "ALL")).sort(), [1, 2, 3, 4]);
});

test("cancel scope: a pending-order cancel stands down entries only, of the named symbol when given", () => {
  assert.equal(cancelScope("cancel my pending order", "CANCEL_PENDING_ORDER"), "PENDING_ENTRIES");
  assert.deepEqual(ids(pickWatchesToCancel(rows, "PENDING_ENTRIES")), [2, 4]);
  assert.deepEqual(ids(pickWatchesToCancel(rows, "PENDING_ENTRIES", "eurusd")), [4]);
});
