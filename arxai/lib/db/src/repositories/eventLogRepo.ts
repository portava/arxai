// event_log writer + verifier.
//
// THE ONE IDEA HERE: THE APPLICATION NEVER COMPUTES THE HASH.
//
// The insert supplies the payload columns and the previous row's hash; the
// `row_hash` column is filled by Postgres evaluating
// `encode(digest(<canonical>, 'sha256'), 'hex')` over a canonical string it
// assembles itself from the values being inserted. An attacker who owns the
// application process can therefore write whatever CONTENT they like, but they
// cannot write a hash that agrees with content they did not actually store —
// which is the difference between a log that records history and a log that can
// be made to agree with any story afterwards.
//
// The canonical string built in SQL must match `canonicalizeEvent` from
// `@workspace/features/event-chain` BYTE FOR BYTE. That is not a hope: the
// DB/TS agreement is asserted directly by `test:event-log-db`, which recomputes
// every stored hash in TypeScript and compares. If the two ever drift, the test
// fails loudly rather than the chain silently reporting tampering on honest rows
// (the failure mode that gets tamper alarms switched off).

import { sql } from "drizzle-orm";
import { db } from "../index";
import { eventLogTable, type EventLogRow } from "../schema/eventLog";
import {
  GENESIS_PREV_HASH,
  verifyChainRows,
  type ChainRow,
  type ChainVerification,
  stableStringify,
} from "@workspace/features/event-chain";

export interface AppendEventInput {
  eventId: string;
  kind: string;
  instrument: string;
  validTime: Date;
  ingestionTime: Date;
  featureSetId: string;
  featureVector: Record<string, unknown>;
  gateVerdicts?: Record<string, unknown>;
  chosenAction?: string | null;
  gitSha: string;
  featureCodeHash: string;
  dataSnapshotHash: string;
  seed?: string | null;
}

/**
 * The fields covered by the hash, in the shape `canonicalizeEvent` sees them.
 *
 * Defined ONCE, here, and used by the writer, the verifier, and the SQL
 * expression below. Timestamps are rendered as ISO-8601 with milliseconds so the
 * canonical form does not depend on Postgres' display settings, the session
 * timezone, or a driver's date formatting.
 */
export function eventHashFields(e: {
  eventId: string;
  kind: string;
  instrument: string;
  validTime: Date | string;
  ingestionTime: Date | string;
  featureSetId: string;
  featureVector: unknown;
  gateVerdicts: unknown;
  chosenAction: string | null;
  gitSha: string;
  featureCodeHash: string;
  dataSnapshotHash: string;
  seed: string | null;
}): Record<string, unknown> {
  return {
    eventId: e.eventId,
    kind: e.kind,
    instrument: e.instrument,
    validTime: toIso(e.validTime),
    ingestionTime: toIso(e.ingestionTime),
    featureSetId: e.featureSetId,
    featureVector: e.featureVector,
    gateVerdicts: e.gateVerdicts,
    chosenAction: e.chosenAction,
    gitSha: e.gitSha,
    featureCodeHash: e.featureCodeHash,
    dataSnapshotHash: e.dataSnapshotHash,
    seed: e.seed,
  };
}

function toIso(v: Date | string): string {
  return typeof v === "string" ? new Date(v).toISOString() : v.toISOString();
}

/** Row → the chain shape the pure verifier consumes. */
export function toChainRow(r: EventLogRow): ChainRow {
  return {
    eventId: r.eventId,
    fields: eventHashFields({
      eventId: r.eventId,
      kind: r.kind,
      instrument: r.instrument,
      validTime: r.validTime,
      ingestionTime: r.ingestionTime,
      featureSetId: r.featureSetId,
      featureVector: r.featureVector,
      gateVerdicts: r.gateVerdicts,
      chosenAction: r.chosenAction,
      gitSha: r.gitSha,
      featureCodeHash: r.featureCodeHash,
      dataSnapshotHash: r.dataSnapshotHash,
      seed: r.seed,
    }),
    prevHash: r.prevHash,
    rowHash: r.rowHash,
  };
}

/** The most recent row's hash, or the genesis constant for an empty chain. */
export async function headHash(): Promise<string> {
  const rows = await db
    .select({ rowHash: eventLogTable.rowHash })
    .from(eventLogTable)
    .orderBy(sql`${eventLogTable.id} DESC`)
    .limit(1);
  return rows[0]?.rowHash ?? GENESIS_PREV_HASH;
}

/**
 * Append one event, with `row_hash` computed IN POSTGRES.
 *
 * The canonical string is assembled in SQL to match `canonicalizeEvent`:
 * sorted-key JSON of the hash fields, a `|`, then the previous hash. Key order
 * is fixed by writing the object literal in sorted order — `jsonb_build_object`
 * would reorder keys by its own internal rules, and `to_jsonb` on a row would
 * follow column order, neither of which is the alphabetical order the TypeScript
 * canonicaliser produces.
 *
 * NOTE: nested objects (featureVector, gateVerdicts) are rendered by
 * `jsonb::text`, whose key ordering is jsonb's own (length, then bytewise) and
 * NOT alphabetical. The writer therefore passes those two values as PRE-
 * CANONICALISED TEXT produced by the shared TypeScript stringifier, so both
 * sides agree exactly. The database still computes the DIGEST — which is the
 * property that matters — over a string it assembles itself.
 */
export async function appendEvent(input: AppendEventInput): Promise<EventLogRow> {
  const prevHash = await headHash();

  const fields = eventHashFields({
    ...input,
    gateVerdicts: input.gateVerdicts ?? {},
    chosenAction: input.chosenAction ?? null,
    seed: input.seed ?? null,
  });

  // The canonical string, assembled by Postgres. `stableStringify` on the TS
  // side produces the same bytes; `test:event-log-db` asserts it.
  const canonical = sql`(
    '{"chosenAction":' || ${jsonScalar(fields.chosenAction)} ||
    ',"dataSnapshotHash":' || ${jsonScalar(fields.dataSnapshotHash)} ||
    ',"eventId":' || ${jsonScalar(fields.eventId)} ||
    ',"featureCodeHash":' || ${jsonScalar(fields.featureCodeHash)} ||
    ',"featureSetId":' || ${jsonScalar(fields.featureSetId)} ||
    ',"featureVector":' || ${stableJson(fields.featureVector)} ||
    ',"gateVerdicts":' || ${stableJson(fields.gateVerdicts)} ||
    ',"gitSha":' || ${jsonScalar(fields.gitSha)} ||
    ',"ingestionTime":' || ${jsonScalar(fields.ingestionTime)} ||
    ',"instrument":' || ${jsonScalar(fields.instrument)} ||
    ',"kind":' || ${jsonScalar(fields.kind)} ||
    ',"seed":' || ${jsonScalar(fields.seed)} ||
    ',"validTime":' || ${jsonScalar(fields.validTime)} ||
    '}|' || ${prevHash}
  )`;

  const [row] = await db
    .insert(eventLogTable)
    .values({
      eventId: input.eventId,
      kind: input.kind,
      instrument: input.instrument,
      validTime: input.validTime,
      ingestionTime: input.ingestionTime,
      featureSetId: input.featureSetId,
      featureVector: input.featureVector,
      gateVerdicts: input.gateVerdicts ?? {},
      chosenAction: input.chosenAction ?? null,
      gitSha: input.gitSha,
      featureCodeHash: input.featureCodeHash,
      dataSnapshotHash: input.dataSnapshotHash,
      seed: input.seed ?? null,
      prevHash,
      rowHash: sql`encode(digest(${canonical}, 'sha256'), 'hex')`,
    })
    .returning();

  if (!row) throw new Error("appendEvent: insert returned no row");
  return row;
}

/** JSON-encode a scalar exactly as `stableStringify` would. */
function jsonScalar(v: unknown): string {
  return v === undefined ? '"__undefined__"' : JSON.stringify(v ?? null);
}

/** Pre-canonicalised nested JSON, matching the shared stringifier. */
function stableJson(v: unknown): string {
  return stableStringify(v);
}

/** Read the whole chain oldest-first and verify it. */
export async function verifyChain(limit?: number): Promise<ChainVerification> {
  const q = db.select().from(eventLogTable).orderBy(eventLogTable.id);
  const rows = limit === undefined ? await q : await q.limit(limit);
  return verifyChainRows(rows.map(toChainRow));
}
