import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithDeadline, openStreamWithDeadline } from "../requestDeadline.js";

test("deadline rejects and aborts an unresponsive provider transport", async () => {
  let signal!: AbortSignal;
  await assert.rejects(runWithDeadline(s => { signal = s; return new Promise(() => {}); }, 15, "trade_coach"), /llm_timeout:trade_coach/);
  assert.equal(signal.aborted, true);
});

test("successful calls return unchanged and release their deadline", async () => {
  assert.equal(await runWithDeadline(async () => "same analytical response", 1000, "test"), "same analytical response");
});

test("the total deadline covers stalled response bodies after stream headers", async () => {
  let signal!: AbortSignal;
  const stream = await openStreamWithDeadline(async s => {
    signal = s;
    return { async *[Symbol.asyncIterator]() { yield "first"; await new Promise(() => {}); } };
  }, 20, "assistant_chat");
  const iterator = stream[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: "first" });
  await assert.rejects(iterator.next(), /llm_timeout:assistant_chat/);
  assert.equal(signal.aborted, true);
});

test("consumer cancellation aborts the stream without waiting for its deadline", async () => {
  let signal!: AbortSignal;
  const stream = await openStreamWithDeadline(async s => {
    signal = s;
    return { async *[Symbol.asyncIterator]() { yield 1; yield 2; } };
  }, 1000, "assistant_chat");
  for await (const item of stream) { assert.equal(item, 1); break; }
  assert.equal(signal.aborted, true);
});
