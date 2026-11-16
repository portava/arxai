import { test } from "node:test";
import assert from "node:assert/strict";
import { readProbeBody } from "./probe.js";
test("SSE isolation probe inspects the real initial snapshot and closes an endless stream", async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of [": keepalive\n\n", "data: {\"user", "Id\":\"42\",\"marker\":\"B-owned-private-row\"}\n\n"]) controller.enqueue(new TextEncoder().encode(part));
      // Deliberately never close: production SSE streams are unbounded.
    },
    cancel() { canceled = true; },
  });
  const body = await readProbeBody(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
  assert.match(body, /B-owned-private-row/);
  assert.match(body, /"userId":"42"/);
  assert.equal(canceled, true);
});
test("JSON isolation probes retain the complete response", async () => {
  assert.equal(await readProbeBody(new Response('{"private":"B-owned"}')), '{"private":"B-owned"}');
});
test("missing or oversized SSE snapshots fail the probe and cancel the reader", async () => {
  await assert.rejects(readProbeBody(new Response(": heartbeat\n\n", { headers: { "content-type": "text/event-stream" } })), /without an initial/);
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(100))); }, cancel() { canceled = true; } });
  await assert.rejects(readProbeBody(new Response(stream, { headers: { "content-type": "text/event-stream" } }), 20), /exceeded/);
  assert.equal(canceled, true);
});
