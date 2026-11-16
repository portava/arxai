// Synthetic subprocess for proving independent local queues retain DB authority.
import assert from "node:assert/strict";
import { mock } from "node:test";
const url = new URL(process.env.DATABASE_URL!);
assert.equal(process.env.ARX_RESULT_EVIDENCE_PG, "1");
assert.equal(url.pathname, "/arx_result_evidence_test");
assert.match(
  url.searchParams.get("host") ?? "",
  /\/arx-result-evidence-[^/]+\/socket$/,
);
mock.method(globalThis, "fetch", async () => {
  throw new Error("External network disabled");
});
mock.module("../../concurrency/exposureReservation.js", {
  namedExports: {
    fulfillReservationByCommandId: async () => undefined,
    releaseReservationByCommandId: async () => undefined,
  },
});
const { recordLiveCommandResult } = await import("../liveCommandPipeline.js");
const { pool } = await import("@workspace/db");
process.once("message", async (message: { worker: number }) => {
  try {
    const replies = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        recordLiveCommandResult({
          userId: 9,
          commandId: "qa-command",
          reportingBridgeConnectionId: 1,
          outcome: "LIVE_FILLED",
          brokerTicket: "123",
          executedVolume: 0.1,
          fillPrice: 1 + i / 100,
          brokerMessage: `worker-${message.worker}-${i}`,
        }),
      ),
    );
    assert.ok(replies.every((r) => r.ok && r.receiptPersisted));
    process.send?.({ done: true });
  } catch (error) {
    process.send?.({ error: String(error) });
    process.exitCode = 1;
  } finally {
    await pool.end();
    process.disconnect?.();
  }
});
process.send?.({ ready: true });
