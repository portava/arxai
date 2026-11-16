import { test } from "node:test";
import assert from "node:assert/strict";
import { liveAccountEventBus as bus } from "../liveAccountEventBus.js";

test("a broken viewer cannot delay other viewers until the fallback poll", () => {
  const seen: string[] = [];
  const broken = () => { seen.push("broken"); throw new Error("closed transport"); };
  const healthy = () => { seen.push("healthy"); };
  bus.on("failure-isolation", broken);
  bus.on("failure-isolation", healthy);
  try {
    assert.doesNotThrow(() => bus.emit("failure-isolation"));
    assert.deepEqual(seen, ["broken", "healthy"]);
  } finally {
    bus.off("failure-isolation", broken);
    bus.off("failure-isolation", healthy);
  }
});

test("subscriptions remain account scoped and removable", () => {
  let a = 0; let b = 0;
  const first = () => { a++; };
  const second = () => { b++; };
  bus.on("scope-a", first); bus.on("scope-b", second);
  try {
    bus.emit("scope-a");
    assert.equal(a, 1); assert.equal(b, 0);
    bus.off("scope-a", first); bus.emit("scope-a");
    bus.emit(null); bus.emit(undefined);
    assert.equal(a, 1); assert.equal(b, 0);
    bus.emit("scope-b"); assert.equal(b, 1);
  } finally {
    bus.off("scope-a", first); bus.off("scope-b", second);
  }
});

test("subscription changes during dispatch take effect on the next notification", () => {
  const seen: string[] = [];
  const late = () => { seen.push("late"); };
  const removed = () => { seen.push("removed"); };
  const first = () => {
    seen.push("first"); bus.off("dispatch", removed);
    bus.off("dispatch", first); bus.on("dispatch", late);
  };
  bus.on("dispatch", first); bus.on("dispatch", removed);
  try {
    bus.emit("dispatch");
    assert.deepEqual(seen, ["first", "removed"]);
    seen.length = 0; bus.emit("dispatch");
    assert.deepEqual(seen, ["late"]);
  } finally {
    bus.off("dispatch", first); bus.off("dispatch", removed); bus.off("dispatch", late);
  }
});
