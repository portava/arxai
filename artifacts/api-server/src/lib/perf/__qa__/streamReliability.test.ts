import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Response } from "express";
import { createSseWriter, SSE_DRAIN_TIMEOUT_MS } from "../sseWriter.js";
import { startIntervalWorker } from "../intervalWorker.js";

const turn = () => new Promise<void>(r => setImmediate(r));

class Socket extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writes = 0;
  accepted = true;
  write(_data: string) { this.writes++; return this.accepted; }
  destroy() { this.destroyed = true; this.emit("close"); }
}

test("a stalled SSE consumer buffers one frame, then times out and releases its listeners", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new Socket(); socket.accepted = false;
  let cleanups = 0;
  const writer = createSseWriter(socket as unknown as Response, () => { cleanups++; });
  for (let i = 0; i < 10_000; i++) writer.send({ type: "snapshot", i });
  assert.equal(socket.writes, 1);
  assert.equal(socket.destroyed, false, "give a legitimate large frame time to flush");
  t.mock.timers.tick(SSE_DRAIN_TIMEOUT_MS);
  assert.equal(socket.destroyed, true);
  assert.equal(cleanups, 1);
  assert.equal(socket.listenerCount("close"), 0);
  assert.equal(socket.listenerCount("error"), 0);
  assert.equal(socket.listenerCount("drain"), 0);
});

test("SSE resumes after writable drain without disconnecting a healthy large response", () => {
  const socket = new Socket(); socket.accepted = false;
  const writer = createSseWriter(socket as unknown as Response, () => {});
  writer.send({ type: "snapshot" });
  assert.equal(socket.writes, 1);
  socket.emit("drain"); socket.accepted = true;
  assert.equal(writer.send({ type: "snapshot", newer: true }), true);
  assert.equal(socket.writes, 2);
  assert.equal(socket.destroyed, false);
  writer.close();
});

test("healthy SSE frames send immediately; disconnect before a read finishes suppresses late writes", () => {
  const socket = new Socket();
  let cleanups = 0;
  const writer = createSseWriter(socket as unknown as Response, () => { cleanups++; });
  assert.equal(writer.send({ type: "forming_bar" }), true);
  assert.equal(socket.writes, 1);
  socket.emit("close");
  assert.equal(writer.send({ type: "snapshot" }), false);
  assert.equal(socket.writes, 1);
  assert.equal(cleanups, 1);
});

test("periodic workers never overlap and stop removes the timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let release!: () => void;
  let calls = 0;
  const worker = startIntervalWorker(async () => {
    calls++;
    await new Promise<void>(r => { release = r; });
  }, 10, assert.fail);
  t.mock.timers.tick(10);
  await turn();
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  release(); await worker.drain();
  t.mock.timers.tick(10); await turn();
  assert.equal(calls, 2);
  worker.stop();
  release(); await worker.drain();
  t.mock.timers.tick(1000); await turn();
  assert.equal(calls, 2);
});
