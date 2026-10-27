import { it, after, mock } from "node:test";
import assert from "node:assert/strict";
let probes = 0;
let passes = 0;
let enabled = false;
let pendingProbe: Promise<void> | undefined;
let probeFailure = false;
mock.module("@workspace/db", {
  namedExports: {
    db: {
      execute: async () => {
        probes++;
        if (pendingProbe) await pendingProbe;
        if (probeFailure) throw Error("missing schema");
        return { rows: [] };
      },
    },
  },
});
mock.module("../../logger.js", {
  namedExports: { logger: { info() {}, warn() {}, error() {} } },
});
mock.module("../resultSettlementOutbox.js", {
  namedExports: {
    settlementWorkerEnabled: () => enabled,
    runResultSettlementPass: async () => {
      passes++;
      return { claimed: 0 };
    },
  },
});
const worker = await import("../resultSettlementWorker.js");
after(() => worker.stopResultSettlementWorker());
it("default-off startup does no database work and starts no background consumer", async () => {
  await worker.startResultSettlementWorker();
  assert.equal(probes, 0);
  assert.equal(passes, 0);
});
it("missing schema never enables recovery", async () => {
  enabled = true;
  probeFailure = true;
  await worker.startResultSettlementWorker();
  assert.equal(probes, 1);
  assert.equal(passes, 0);
  probeFailure = false;
});
it("stop during schema probe fences delayed startup and duplicate starts", async () => {
  let release!: () => void;
  pendingProbe = new Promise<void>((resolve) => {
    release = resolve;
  });
  const starting = worker.startResultSettlementWorker();
  await worker.startResultSettlementWorker();
  assert.equal(probes, 2);
  worker.stopResultSettlementWorker();
  release();
  await starting;
  pendingProbe = undefined;
  assert.equal(passes, 0);
  await worker.startResultSettlementWorker();
  assert.equal(probes, 3, "fresh explicit start can retry after stopped probe");
  worker.stopResultSettlementWorker();
  assert.equal(passes, 0);
});
