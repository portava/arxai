// Real-data validation evidence store (validation_evidence_v1).
//
// Writes one immutable, hash-checked row per real-data validation run and reads
// it back VERIFIED. The run itself is produced by
// scripts/src/research/realDataValidation.ts; this module only stores and
// verifies, so it has no dependency on the validation engine.
//
// Verification on every read (a row that fails any of these is reported as an
// integrity failure, never returned as evidence):
//   - sha256(canonical_payload) == payload_hash, sha256(canonical_manifest) == manifest_hash
//   - the payload re-canonicalises to itself byte-for-byte
//   - the payload's own resultHash re-derives from its body
//   - every survivor in the payload is liveAllowed=false with ceiling SHADOW
//
// Nothing here promotes, sizes or places anything. promotion_ceiling is the
// literal "SHADOW" and live_allowed the literal false — the table's CHECKs
// refuse anything else, and this file contains no other value for either.
// Caller owns the pool. No timer, worker or migration is started on import.

import { createHash, randomUUID } from "node:crypto";
import { stableStringify } from "@workspace/features/event-chain";
import type { pool as workspacePool } from "@workspace/db";
type Pool = typeof workspacePool;

export const VALIDATION_EVIDENCE_MANIFEST_VERSION = "arx-validation-evidence-manifest-v1";
export const VALIDATION_RUNNER_VERSION = "arx-real-data-validation-v1";
export const VALIDATION_EVIDENCE_MAX_BYTES = 16 * 1024 * 1024;

type ErrorCode = "INVALID_VALIDATION_EVIDENCE" | "VALIDATION_EVIDENCE_INTEGRITY" | "VALIDATION_EVIDENCE_UNAVAILABLE" | "VALIDATION_EVIDENCE_CONFLICT";
export class ValidationEvidenceError extends Error {
  constructor(public readonly code: ErrorCode) { super(code); this.name = "ValidationEvidenceError"; }
}

/** The minimal shape of a runner result this store needs to index. */
export interface ValidationRunLike {
  runnerVersion: string;
  datasetHash: string;
  paramsHash: string;
  resultHash: string;
  fdr: { familySize: number };
  survivors: Array<{ liveAllowed: boolean; promotionCeiling: string }>;
  [k: string]: unknown;
}

export interface ValidationEvidenceManifest {
  version: typeof VALIDATION_EVIDENCE_MANIFEST_VERSION;
  id: string;
  runKind: "real_data_validation";
  runnerVersion: string;
  datasetSource: string;
  datasetHash: string;
  paramsHash: string;
  resultHash: string;
  payloadHash: string;
  codeCommit: string;
  codeDirty: boolean;
  trials: number;
  survivors: number;
  liveAllowed: false;
  promotionCeiling: "SHADOW";
  recordedAt: string;
}

interface Row {
  id: string; run_kind: string; runner_version: string; dataset_source: string; dataset_hash: string;
  params_hash: string; result_hash: string; code_commit: string; code_dirty: boolean; trials: number;
  survivors: number; promotion_ceiling: string; live_allowed: boolean; payload_hash: string;
  manifest_hash: string; payload_bytes: number; canonical_payload?: string; canonical_manifest: string; created_at: Date;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const HEX64 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function invalid(): never { throw new ValidationEvidenceError("INVALID_VALIDATION_EVIDENCE"); }
function integrity(): never { throw new ValidationEvidenceError("VALIDATION_EVIDENCE_INTEGRITY"); }

/** Re-derive a run's resultHash from its body. */
export function resultHashOf(run: Record<string, unknown>): string {
  const { resultHash: _omit, ...body } = run;
  return sha256(stableStringify(body));
}

function checkRun(run: ValidationRunLike): void {
  if (!run || typeof run !== "object") invalid();
  if (run.runnerVersion !== VALIDATION_RUNNER_VERSION) invalid();
  if (![run.datasetHash, run.paramsHash, run.resultHash].every((h) => typeof h === "string" && HEX64.test(h))) invalid();
  if (!Number.isInteger(run.fdr?.familySize) || run.fdr.familySize < 1 || !Array.isArray(run.survivors)) invalid();
  if (run.survivors.length > run.fdr.familySize) invalid();
  if (run.survivors.some((s) => !s || typeof s !== "object" || s.liveAllowed !== false || s.promotionCeiling !== "SHADOW")) invalid();
  if (resultHashOf(run) !== run.resultHash) invalid();
}

function manifestOf(row: Row): ValidationEvidenceManifest {
  return {
    version: VALIDATION_EVIDENCE_MANIFEST_VERSION, id: row.id, runKind: "real_data_validation",
    runnerVersion: row.runner_version, datasetSource: row.dataset_source, datasetHash: row.dataset_hash,
    paramsHash: row.params_hash, resultHash: row.result_hash, payloadHash: row.payload_hash,
    codeCommit: row.code_commit, codeDirty: row.code_dirty, trials: row.trials, survivors: row.survivors,
    liveAllowed: false, promotionCeiling: "SHADOW", recordedAt: row.created_at.toISOString(),
  };
}

function verifiedManifest(row: Row): ValidationEvidenceManifest {
  if (row.live_allowed !== false || row.promotion_ceiling !== "SHADOW" || !UUID.test(row.id)) integrity();
  if (sha256(row.canonical_manifest) !== row.manifest_hash) integrity();
  const manifest = manifestOf(row);
  if (stableStringify(manifest) !== row.canonical_manifest) integrity();
  return manifest;
}

function verifiedPayload(row: Row): Record<string, unknown> {
  const text = row.canonical_payload;
  if (typeof text !== "string" || sha256(text) !== row.payload_hash || Buffer.byteLength(text, "utf8") !== row.payload_bytes) integrity();
  let parsed: ValidationRunLike;
  try { parsed = JSON.parse(text) as ValidationRunLike; } catch { return integrity(); }
  if (stableStringify(parsed) !== text) integrity();
  try { checkRun(parsed); } catch { integrity(); }
  if (parsed.runnerVersion !== row.runner_version || row.run_kind !== "real_data_validation") integrity();
  if (parsed.resultHash !== row.result_hash || parsed.datasetHash !== row.dataset_hash || parsed.paramsHash !== row.params_hash
    || parsed.survivors.length !== row.survivors || parsed.fdr.familySize !== row.trials) integrity();
  return parsed;
}

function unavailable(error: unknown): never {
  if (error instanceof ValidationEvidenceError) throw error;
  // Never echo SQL or connection details.
  throw new ValidationEvidenceError("VALIDATION_EVIDENCE_UNAVAILABLE");
}

const metadataColumns = `id,run_kind,runner_version,dataset_source,dataset_hash,params_hash,result_hash,code_commit,code_dirty,
  trials,survivors,promotion_ceiling,live_allowed,payload_hash,manifest_hash,payload_bytes,canonical_manifest,created_at`;

export interface ValidationEvidenceReceipt {
  disposition: "created" | "existing";
  manifest: ValidationEvidenceManifest;
  manifestHash: string;
}

export class ValidationEvidenceStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async record(input: { run: ValidationRunLike; datasetSource: string; codeCommit: string; codeDirty: boolean }): Promise<ValidationEvidenceReceipt> {
    const { run, datasetSource, codeCommit, codeDirty } = input;
    checkRun(run);
    if (typeof datasetSource !== "string" || datasetSource.length < 1 || datasetSource.length > 200) invalid();
    if (!COMMIT.test(codeCommit) || typeof codeDirty !== "boolean") invalid();
    const payload = stableStringify(run);
    const bytes = Buffer.byteLength(payload, "utf8");
    if (bytes > VALIDATION_EVIDENCE_MAX_BYTES) invalid();
    try {
      const existing = await this.pool.query<Row>(
        `SELECT ${metadataColumns},canonical_payload FROM validation_evidence_v1
         WHERE dataset_hash=$1 AND params_hash=$2 AND result_hash=$3 AND code_commit=$4 AND code_dirty=$5`,
        [run.datasetHash, run.paramsHash, run.resultHash, codeCommit, codeDirty]);
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.canonical_payload !== payload) throw new ValidationEvidenceError("VALIDATION_EVIDENCE_CONFLICT");
        verifiedPayload(row);
        return { disposition: "existing", manifest: verifiedManifest(row), manifestHash: row.manifest_hash };
      }
      const clock = await this.pool.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const row: Row = {
        id: randomUUID(), run_kind: "real_data_validation", runner_version: run.runnerVersion, dataset_source: datasetSource,
        dataset_hash: run.datasetHash, params_hash: run.paramsHash, result_hash: run.resultHash, code_commit: codeCommit,
        code_dirty: codeDirty, trials: run.fdr.familySize, survivors: run.survivors.length, promotion_ceiling: "SHADOW",
        live_allowed: false, payload_hash: sha256(payload), manifest_hash: "", payload_bytes: bytes,
        canonical_payload: payload, canonical_manifest: "", created_at: clock.rows[0]!.now,
      };
      row.canonical_manifest = stableStringify(manifestOf(row));
      row.manifest_hash = sha256(row.canonical_manifest);
      await this.pool.query(
        `INSERT INTO validation_evidence_v1 (id,run_kind,runner_version,dataset_source,dataset_hash,params_hash,result_hash,
           code_commit,code_dirty,trials,survivors,promotion_ceiling,live_allowed,payload_hash,manifest_hash,payload_bytes,
           canonical_payload,canonical_manifest,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [row.id, row.run_kind, row.runner_version, row.dataset_source, row.dataset_hash, row.params_hash, row.result_hash,
          row.code_commit, row.code_dirty, row.trials, row.survivors, row.promotion_ceiling, row.live_allowed, row.payload_hash,
          row.manifest_hash, row.payload_bytes, row.canonical_payload, row.canonical_manifest, row.created_at]);
      return { disposition: "created", manifest: manifestOf(row), manifestHash: row.manifest_hash };
    } catch (error) { return unavailable(error); }
  }

  /** Metadata page, newest first. Manifests are verified; payloads are not read. */
  async list(limit = 20): Promise<Array<{ manifest: ValidationEvidenceManifest; manifestHash: string }>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) invalid();
    try {
      const found = await this.pool.query<Row>(
        `SELECT ${metadataColumns} FROM validation_evidence_v1 ORDER BY created_at DESC, id DESC LIMIT $1`, [limit]);
      return found.rows.map((row) => ({ manifest: verifiedManifest(row), manifestHash: row.manifest_hash }));
    } catch (error) { return unavailable(error); }
  }

  /** One run, fully verified. Null when absent. */
  async read(id: string): Promise<{ manifest: ValidationEvidenceManifest; manifestHash: string; run: Record<string, unknown>; payloadVerified: true } | null> {
    if (typeof id !== "string" || !UUID.test(id)) invalid();
    try {
      const found = await this.pool.query<Row>(
        `SELECT ${metadataColumns},canonical_payload FROM validation_evidence_v1 WHERE id=$1`, [id]);
      const row = found.rows[0];
      if (!row) return null;
      return { manifest: verifiedManifest(row), manifestHash: row.manifest_hash, run: verifiedPayload(row), payloadVerified: true };
    } catch (error) { return unavailable(error); }
  }
}
