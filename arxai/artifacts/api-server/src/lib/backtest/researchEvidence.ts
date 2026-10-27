import { createHash, randomUUID } from "node:crypto";
import type { pool as workspacePool } from "@workspace/db";
type Pool = typeof workspacePool;
// pg exposes the callback overload last; extract its non-null client type.
type PoolClient = NonNullable<Parameters<Parameters<Pool["connect"]>[0]>[1]>;
import { runCausalResearch, ResearchInputError, RESEARCH_ENGINE_VERSION, RESEARCH_STRATEGY_VERSION,
  type ResearchInput, type ResearchConfig, type ResearchResult, type DeepReadonly } from "@workspace/domain/backtest/research";

export const RESEARCH_MANIFEST_VERSION = "arx-research-manifest-v1";
export const RESEARCH_STORAGE_LIMITS = Object.freeze({ bars: 10_000, artifactBytes: 8 * 1024 * 1024,
  ownerRecords: 256, ownerBytes: 256 * 1024 * 1024, pageSize: 50 });
const LOCK_NAMESPACE = 1095915602; // 'ARXR'; dedicated to research, never trading.
type ErrorCode = "INVALID_RESEARCH_REQUEST" | "ARTIFACT_SIZE_LIMIT" | "REQUEST_KEY_CONFLICT"
  | "OWNER_STORAGE_LIMIT" | "RESEARCH_EVIDENCE_INTEGRITY" | "RESEARCH_EVIDENCE_UNAVAILABLE";
export class ResearchEvidenceError extends Error {
  constructor(public readonly code: ErrorCode) { super(code); this.name = "ResearchEvidenceError"; }
}
/** Only construct from authenticated SERVER context. No route/body authority is
 * accepted here; this module has no route, startup registration or worker. */
export interface ResearchOwnerContext { authenticatedOwnerId: number }
export interface ResearchRecordRequest { requestId: string; datasetId: string; input: ResearchInput; config: ResearchConfig }
interface Manifest {
  version: typeof RESEARCH_MANIFEST_VERSION; experimentId: string; ownerId: number; requestId: string; datasetId: string;
  engineVersion: string; strategyVersion: string; inputHash: string; configurationHash: string; strategyHash: string;
  resultHash: string; payloadHash: string; inputBars: number; payloadBytes: number; recordedAt: string;
}
interface Row {
  id: string; owner_id: number; request_id: string; dataset_id: string; manifest_version: string;
  engine_version: string; strategy_version: string; input_hash: string; configuration_hash: string;
  strategy_hash: string; result_hash: string; payload_hash: string; manifest_hash: string;
  input_bars: number; payload_bytes: number; canonical_payload: string; canonical_manifest: string; created_at: Date;
}
export interface ResearchStorageReceipt {
  storage: Readonly<{ committed: true; disposition: "created" | "existing"; manifestHash: string; payloadVerified: true }>;
  manifest: Readonly<Manifest>;
  /** Exact engine output: its persistedExperiment=false remains unchanged. The
   * storage receipt above records durability, not trading/verification authority. */
  result: DeepReadonly<ResearchResult>;
}
export interface ResearchCursor { recordedAt: string; experimentId: string }
function invalid(): never { throw new ResearchEvidenceError("INVALID_RESEARCH_REQUEST"); };
function integrity(): never { throw new ResearchEvidenceError("RESEARCH_EVIDENCE_INTEGRITY"); };
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function uuid(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) invalid(); return value as string; }
function owner(context: ResearchOwnerContext): number {
  const id = context?.authenticatedOwnerId;
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) invalid();
  return id;
}
function keys(value: unknown, expected: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some(key => !expected.includes(key))) invalid();
  // JSON canonicalization erases negative zero. Refuse it rather than return an
  // in-memory snapshot that differs from its exact persisted/reloaded value.
  if (actual.some(key => Object.is((value as Record<string, unknown>)[key], -0))) invalid();
}
function prepare(request: ResearchRecordRequest) {
  keys(request, ["requestId", "datasetId", "input", "config"]);
  const requestId = uuid(request.requestId), datasetId = uuid(request.datasetId), input = request.input, config = request.config;
  keys(input, ["symbol", "priceBasis", "intervalMs", "asOfMs", "source", "bars"]);
  keys(input.source, ["kind", "reference"]);
  // Never silently rewrite source attribution or store free-form source notes.
  if (input.source.reference !== datasetId || typeof input.symbol !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(input.symbol)
    || !Array.isArray(input.bars) || input.bars.length > RESEARCH_STORAGE_LIMITS.bars) invalid();
  for (const bar of input.bars) keys(bar, ["openTimeMs", "open", "high", "low", "close"]);
  keys(config, ["strategy", "costs", "maxEntryGapMs", "splits"]);
  keys(config.strategy, ["version", "lookbackBars", "thresholdPriceUnits", "stopDistancePriceUnits", "targetDistancePriceUnits", "maxHoldingBars"]);
  keys(config.costs, ["fullSpreadPriceUnits", "adverseSlippagePerFillPriceUnits", "feePerFillPriceUnits"]);
  keys(config.splits, ["trainEndExclusive", "validationEndExclusive"]);
  let result: DeepReadonly<ResearchResult>;
  try { result = runCausalResearch(input, config); } catch (error) { if (error instanceof ResearchInputError) invalid(); throw error; }
  const payload = JSON.stringify(result), bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > RESEARCH_STORAGE_LIMITS.artifactBytes) throw new ResearchEvidenceError("ARTIFACT_SIZE_LIMIT");
  return { requestId, datasetId, result, payload, bytes, payloadHash: sha256(payload) };
}
function manifestFor(row: Omit<Row, "canonical_payload" | "canonical_manifest" | "manifest_hash">): Manifest {
  return { version: RESEARCH_MANIFEST_VERSION, experimentId: row.id, ownerId: row.owner_id,
    requestId: row.request_id, datasetId: row.dataset_id, engineVersion: row.engine_version,
    strategyVersion: row.strategy_version, inputHash: row.input_hash, configurationHash: row.configuration_hash,
    strategyHash: row.strategy_hash, resultHash: row.result_hash, payloadHash: row.payload_hash,
    inputBars: row.input_bars, payloadBytes: row.payload_bytes, recordedAt: row.created_at.toISOString() };
}
function checkManifest(row: Omit<Row, "canonical_payload">): Readonly<Manifest> {
  try {
    if (row.manifest_version !== RESEARCH_MANIFEST_VERSION || row.engine_version !== RESEARCH_ENGINE_VERSION
      || row.strategy_version !== RESEARCH_STRATEGY_VERSION || row.payload_bytes > RESEARCH_STORAGE_LIMITS.artifactBytes
      || row.input_bars > RESEARCH_STORAGE_LIMITS.bars || !Number.isInteger(row.input_bars) || row.input_bars < 3
      || !Number.isInteger(row.payload_bytes) || row.payload_bytes < 1 || !Number.isInteger(row.owner_id) || row.owner_id < 1
      || ![row.id,row.request_id,row.dataset_id].every(value => UUID.test(value))
      || ![row.input_hash,row.configuration_hash,row.strategy_hash,row.result_hash,row.payload_hash,row.manifest_hash].every(value => /^[a-f0-9]{64}$/.test(value))) integrity();
    const manifest = manifestFor(row);
    if (JSON.stringify(manifest) !== row.canonical_manifest || sha256(row.canonical_manifest) !== row.manifest_hash) integrity();
    return Object.freeze(manifest);
  } catch { return integrity(); }
}
function verified(row: Row, disposition: "created" | "existing"): ResearchStorageReceipt {
  const manifest = checkManifest(row);
  try {
    if (Buffer.byteLength(row.canonical_payload, "utf8") !== row.payload_bytes || sha256(row.canonical_payload) !== row.payload_hash) integrity();
    const stored = JSON.parse(row.canonical_payload);
    // Recompute the pinned engine. This verifies semantic links as well as
    // hashes, not merely a caller-supplied or internally self-consistent digest.
    const candidate = prepare({ requestId: row.request_id, datasetId: row.dataset_id,
      input: stored.inputSnapshot, config: stored.configSnapshot });
    const hashes = candidate.result.fingerprints;
    if (candidate.payload !== row.canonical_payload || hashes.input !== row.input_hash
      || hashes.configuration !== row.configuration_hash || hashes.strategy !== row.strategy_hash
      || hashes.result !== row.result_hash || candidate.result.inputSnapshot.bars.length !== row.input_bars) integrity();
    return Object.freeze({ storage: Object.freeze({ committed: true as const, disposition, manifestHash: row.manifest_hash, payloadVerified: true as const }),
      manifest, result: candidate.result });
  } catch { return integrity(); }
}
function unavailable(error: unknown): never {
  if (error instanceof ResearchEvidenceError) throw error;
  const e = error as { code?: string; message?: string };
  if (e?.code === "P0001" && e.message === "RESEARCH_OWNER_STORAGE_LIMIT") throw new ResearchEvidenceError("OWNER_STORAGE_LIMIT");
  // Never echo SQL, source inputs or credentials. Failure includes uncertain
  // COMMIT outcome: retry with the same key, never report false acceptance.
  throw new ResearchEvidenceError("RESEARCH_EVIDENCE_UNAVAILABLE");
}
const metadataColumns = `id,owner_id,request_id,dataset_id,manifest_version,engine_version,strategy_version,
 input_hash,configuration_hash,strategy_hash,result_hash,payload_hash,manifest_hash,input_bars,payload_bytes,canonical_manifest,created_at`;

/** Caller owns the existing application pool. No new pool, connection, timer,
 * migration, broker action or automatic execution is started on import. */
export class ResearchEvidenceStore {
  constructor(private readonly pool: Pick<Pool, "connect" | "query">) {}
  async record(context: ResearchOwnerContext, request: ResearchRecordRequest): Promise<ResearchStorageReceipt> {
    const ownerId = owner(context), prepared = prepare(request); // CPU work BEFORE any DB lock.
    let client: PoolClient | undefined, row: Row | undefined, duplicate = false, discardClient = false;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SELECT pg_advisory_xact_lock($1::int,$2::int)", [LOCK_NAMESPACE, ownerId]);
      const existing = await client.query<Row>("SELECT * FROM research_experiments_v1 WHERE owner_id=$1 AND request_id=$2", [ownerId, prepared.requestId]);
      if (existing.rows[0]) {
        row = existing.rows[0]; duplicate = true;
        if (row.dataset_id !== prepared.datasetId || row.canonical_payload !== prepared.payload) throw new ResearchEvidenceError("REQUEST_KEY_CONFLICT");
      } else {
        // The insert trigger serializes and checks scalar count/byte totals.
        // No payload scan, mutable quota row or independent execution lock.
        const clock = await client.query<{ recorded_at: Date }>("SELECT clock_timestamp() AS recorded_at");
        const hashes = prepared.result.fingerprints;
        row = { id: randomUUID(), owner_id: ownerId, request_id: prepared.requestId, dataset_id: prepared.datasetId,
          manifest_version: RESEARCH_MANIFEST_VERSION, engine_version: RESEARCH_ENGINE_VERSION, strategy_version: RESEARCH_STRATEGY_VERSION,
          input_hash: hashes.input, configuration_hash: hashes.configuration, strategy_hash: hashes.strategy, result_hash: hashes.result,
          payload_hash: prepared.payloadHash, input_bars: prepared.result.inputSnapshot.bars.length, payload_bytes: prepared.bytes,
          canonical_payload: prepared.payload, created_at: clock.rows[0]!.recorded_at, canonical_manifest: "", manifest_hash: "" };
        row.canonical_manifest = JSON.stringify(manifestFor(row)); row.manifest_hash = sha256(row.canonical_manifest);
        await client.query(`INSERT INTO research_experiments_v1
          (id,owner_id,request_id,dataset_id,manifest_version,engine_version,strategy_version,input_hash,configuration_hash,strategy_hash,result_hash,payload_hash,manifest_hash,input_bars,payload_bytes,canonical_payload,canonical_manifest,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [row.id,row.owner_id,row.request_id,row.dataset_id,row.manifest_version,row.engine_version,row.strategy_version,
            row.input_hash,row.configuration_hash,row.strategy_hash,row.result_hash,row.payload_hash,row.manifest_hash,
            row.input_bars,row.payload_bytes,row.canonical_payload,row.canonical_manifest,row.created_at]);
      }
      await client.query("COMMIT");
    } catch (error) {
      if (client) { try { await client.query("ROLLBACK"); } catch { discardClient = true; /* never return an uncertain transaction to the pool */ } }
      return unavailable(error);
    } finally { client?.release(discardClient); }
    // Exact retries are read-verified after releasing the owner lock. New rows
    // use the exact already-computed immutable engine output, never a rewrite.
    if (duplicate) return verified(row!, "existing");
    return Object.freeze({ storage: Object.freeze({ committed: true as const, disposition: "created" as const, manifestHash: row!.manifest_hash, payloadVerified: true as const }),
      manifest: Object.freeze(manifestFor(row!)), result: prepared.result });
  }
  async read(context: ResearchOwnerContext, experimentId: string): Promise<ResearchStorageReceipt | null> {
    const ownerId = owner(context), id = uuid(experimentId);
    try {
      const found = await this.pool.query<Row>("SELECT * FROM research_experiments_v1 WHERE owner_id=$1 AND id=$2", [ownerId,id]);
      return found.rows[0] ? verified(found.rows[0], "existing") : null;
    } catch (error) { return unavailable(error); }
  }
  async listMetadata(context: ResearchOwnerContext, options: { limit?: number; cursor?: ResearchCursor } = {}) {
    const ownerId = owner(context), limit = options.limit ?? 20, cursor = options.cursor;
    if (!Number.isInteger(limit) || limit < 1 || limit > RESEARCH_STORAGE_LIMITS.pageSize) invalid();
    if (cursor && (!UUID.test(cursor.experimentId) || !Number.isFinite(Date.parse(cursor.recordedAt))
      || new Date(cursor.recordedAt).toISOString() !== cursor.recordedAt)) invalid();
    try {
      const found = await this.pool.query<Omit<Row, "canonical_payload">>(`SELECT ${metadataColumns} FROM research_experiments_v1
        WHERE owner_id=$1 ${cursor ? "AND (created_at,id)<($2::timestamptz,$3::uuid)" : ""}
        ORDER BY created_at DESC,id DESC LIMIT $${cursor ? 4 : 2}`,
        cursor ? [ownerId,cursor.recordedAt,cursor.experimentId,limit] : [ownerId,limit]);
      const items = found.rows.map(row => Object.freeze({ manifest: checkManifest(row), manifestHash: row.manifest_hash,
        payloadVerified: false as const })); // A metadata page is not a payload-integrity claim.
      const last = items.at(-1)?.manifest;
      return Object.freeze({ items: Object.freeze(items), nextCursor: items.length === limit && last
        ? Object.freeze({ recordedAt: last.recordedAt, experimentId: last.experimentId }) : null });
    } catch (error) { return unavailable(error); }
  }
}
