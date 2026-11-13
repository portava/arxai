import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stableStringify } from "@workspace/features/event-chain";
import { ValidationEvidenceStore, ValidationEvidenceError, resultHashOf, VALIDATION_RUNNER_VERSION, VALIDATION_EVIDENCE_MANIFEST_VERSION } from "../validationEvidence.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const ID = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const run = { runnerVersion: VALIDATION_RUNNER_VERSION, datasetHash: "a".repeat(64), paramsHash: "b".repeat(64),
    resultHash: "", fdr: { familySize: 20 }, survivors: [{ liveAllowed: false, promotionCeiling: "SHADOW" }], metrics: { trades: 400, expectancyR: .3 } };
  run.resultHash = resultHashOf(run);
  const payload = stableStringify(run);
  const at = new Date("2026-11-13T12:00:00Z");
  const manifest = { version: VALIDATION_EVIDENCE_MANIFEST_VERSION, id: ID, runKind: "real_data_validation", runnerVersion: run.runnerVersion,
    datasetSource: "controlled-fixture", datasetHash: run.datasetHash, paramsHash: run.paramsHash, resultHash: run.resultHash,
    payloadHash: hash(payload), codeCommit: "c".repeat(40), codeDirty: false, trials: 20, survivors: 1,
    liveAllowed: false, promotionCeiling: "SHADOW", recordedAt: at.toISOString() };
  const canonicalManifest = stableStringify(manifest);
  const row = { id: ID, run_kind: "real_data_validation", runner_version: run.runnerVersion, dataset_source: manifest.datasetSource,
    dataset_hash: run.datasetHash, params_hash: run.paramsHash, result_hash: run.resultHash, code_commit: manifest.codeCommit, code_dirty: false,
    trials: 20, survivors: 1, promotion_ceiling: "SHADOW", live_allowed: false, payload_hash: hash(payload), manifest_hash: hash(canonicalManifest),
    payload_bytes: Buffer.byteLength(payload), canonical_payload: payload, canonical_manifest: canonicalManifest, created_at: at };
  return { run, row };
}
const storeFor = (row: unknown) => new ValidationEvidenceStore({ query: async () => ({ rows: row ? [row] : [] }) } as never);
const integrity = (e: unknown) => e instanceof ValidationEvidenceError && e.code === "VALIDATION_EVIDENCE_INTEGRITY";

test("a verified stored strategy result retains diagnostic provenance and a hard SHADOW ceiling", async () => {
  const { row, run } = fixture();
  const out = await storeFor(row).read(ID);
  assert.equal(out?.payloadVerified, true); assert.deepEqual(out?.run, run);
  assert.equal(out?.manifest.liveAllowed, false); assert.equal(out?.manifest.promotionCeiling, "SHADOW");
  assert.equal(out?.manifest.datasetSource, "controlled-fixture"); assert.equal(out?.manifest.trials, 20);
});
test("changed metrics or input/config hashes cannot reuse captured strategy evidence", async () => {
  for (const mutate of [
    (r: ReturnType<typeof fixture>["row"]) => { r.canonical_payload = r.canonical_payload.replace('"expectancyR":0.3', '"expectancyR":99'); },
    (r: ReturnType<typeof fixture>["row"]) => { r.dataset_hash = "d".repeat(64); },
    (r: ReturnType<typeof fixture>["row"]) => { r.params_hash = "d".repeat(64); },
    (r: ReturnType<typeof fixture>["row"]) => { r.payload_bytes++; },
    (r: ReturnType<typeof fixture>["row"]) => { r.manifest_hash = "d".repeat(64); },
    (r: ReturnType<typeof fixture>["row"]) => { r.survivors = 2; },
  ]) {
    const { row } = fixture(); mutate(row); await assert.rejects(storeFor(row).read(ID), integrity);
  }
});
test("rehashing an altered outer payload cannot conceal a mismatched inner result hash", async () => {
  const { row } = fixture();
  row.canonical_payload = row.canonical_payload.replace('"expectancyR":0.3', '"expectancyR":99');
  row.payload_hash = hash(row.canonical_payload); row.payload_bytes = Buffer.byteLength(row.canonical_payload);
  const manifest = JSON.parse(row.canonical_manifest); manifest.payloadHash = row.payload_hash;
  row.canonical_manifest = stableStringify(manifest); row.manifest_hash = hash(row.canonical_manifest);
  await assert.rejects(storeFor(row).read(ID), integrity);
});
test("profitable survivor metrics never authorize live execution or bypass strategy validity checks", async () => {
  let queries = 0;
  const store = new ValidationEvidenceStore({ query: async () => { queries++; return { rows: [] }; } } as never);
  for (const survivor of [{ liveAllowed: true, promotionCeiling: "SHADOW" }, { liveAllowed: false, promotionCeiling: "LIVE" }]) {
    const { run } = fixture(); run.survivors = [survivor]; run.resultHash = resultHashOf(run);
    await assert.rejects(store.record({ run, datasetSource: "fixture", codeCommit: "c".repeat(40), codeDirty: false }),
      (e: unknown) => e instanceof ValidationEvidenceError && e.code === "INVALID_VALIDATION_EVIDENCE");
  }
  assert.equal(queries, 0);
  for (const over of [{ live_allowed: true }, { promotion_ceiling: "LIVE" }]) await assert.rejects(storeFor({ ...fixture().row, ...over }).read(ID), integrity);
});
test("absence is unavailable evidence and storage errors expose no connection or secret detail", async () => {
  assert.equal(await storeFor(null).read(ID), null);
  const store = new ValidationEvidenceStore({ query: async () => { throw new Error("fixture database credential detail"); } } as never);
  await assert.rejects(store.read(ID), (e: unknown) => e instanceof ValidationEvidenceError && e.message === "VALIDATION_EVIDENCE_UNAVAILABLE");
});
