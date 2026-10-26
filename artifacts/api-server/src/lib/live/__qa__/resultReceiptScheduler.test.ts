import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ResultReceiptScheduler,
  ResultReceiptCapacityError,
} from "../resultReceiptScheduler.js";
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const limits = { perKey: 2, global: 3, perKeyBytes: 100, globalBytes: 150 };
test("same-key reports each run once in arrival order and release all queue state", async () => {
  const queue = new ResultReceiptScheduler(limits);
  const barrier = deferred();
  const starts: number[] = [];
  const a = queue.run(9, "a", 10, async () => {
    starts.push(1);
    await barrier.promise;
    return "first";
  });
  const b = queue.run(9, "a", 20, async () => {
    starts.push(2);
    return "second";
  });
  await Promise.resolve();
  assert.deepEqual(starts, [1]);
  assert.deepEqual(queue.snapshot, { keys: 1, pending: 2, bytes: 30 });
  barrier.resolve();
  assert.deepEqual(await Promise.all([a, b]), ["first", "second"]);
  assert.deepEqual(starts, [1, 2]);
  assert.deepEqual(queue.snapshot, { keys: 0, pending: 0, bytes: 0 });
});
test("independent owners and commands progress while one key is held", async () => {
  const queue = new ResultReceiptScheduler(limits);
  const barrier = deferred();
  const held = queue.run(9, "a", 10, () => barrier.promise);
  assert.equal(await queue.run(10, "a", 10, async () => "owner"), "owner");
  assert.equal(await queue.run(9, "b", 10, async () => "command"), "command");
  barrier.resolve();
  await held;
  assert.equal(queue.snapshot.keys, 0);
});
test("one rejected operation does not strand its follower or a later retry", async () => {
  const queue = new ResultReceiptScheduler(limits);
  const barrier = deferred();
  const failure = queue.run(9, "a", 10, async () => {
    await barrier.promise;
    throw new Error("fault");
  });
  const observed = assert.rejects(failure, /fault/);
  const follower = queue.run(9, "a", 10, async () => "retained");
  barrier.resolve();
  await observed;
  assert.equal(await follower, "retained");
  assert.deepEqual(queue.snapshot, { keys: 0, pending: 0, bytes: 0 });
  assert.equal(await queue.run(9, "a", 10, async () => "retry"), "retry");
});
test("per-key and global count bounds reject before invoking work and clean up", async () => {
  const queue = new ResultReceiptScheduler(limits);
  const barrier = deferred();
  let invoked = false;
  const work = [
    queue.run(9, "a", 10, () => barrier.promise),
    queue.run(9, "a", 10, async () => undefined),
  ];
  await assert.rejects(
    queue.run(9, "a", 10, async () => {
      invoked = true;
    }),
    ResultReceiptCapacityError,
  );
  work.push(queue.run(9, "b", 10, () => barrier.promise));
  await assert.rejects(
    queue.run(9, "c", 10, async () => {
      invoked = true;
    }),
    ResultReceiptCapacityError,
  );
  assert.equal(invoked, false);
  assert.equal(queue.snapshot.pending, 3);
  barrier.resolve();
  await Promise.all(work);
  assert.deepEqual(queue.snapshot, { keys: 0, pending: 0, bytes: 0 });
});
test("per-key and global byte bounds include active and pending input", async () => {
  const queue = new ResultReceiptScheduler(limits);
  const barrier = deferred();
  const work = [queue.run(9, "a", 80, () => barrier.promise)];
  await assert.rejects(
    queue.run(9, "a", 21, async () => undefined),
    ResultReceiptCapacityError,
  );
  work.push(queue.run(9, "b", 70, () => barrier.promise));
  await assert.rejects(
    queue.run(9, "c", 1, async () => undefined),
    ResultReceiptCapacityError,
  );
  assert.equal(queue.snapshot.bytes, 150);
  barrier.resolve();
  await Promise.all(work);
  assert.deepEqual(queue.snapshot, { keys: 0, pending: 0, bytes: 0 });
});
test("oversized/invalid weight and invalid limits never allocate queue state", async () => {
  const queue = new ResultReceiptScheduler(limits);
  for (const weight of [-1, NaN, Infinity, 0.5, 151])
    await assert.rejects(
      queue.run(9, "a", weight, async () => undefined),
      ResultReceiptCapacityError,
    );
  assert.deepEqual(queue.snapshot, { keys: 0, pending: 0, bytes: 0 });
  assert.throws(
    () => new ResultReceiptScheduler({ ...limits, global: 0 }),
    /RESULT_RECEIPT_LIMIT_INVALID/,
  );
});
