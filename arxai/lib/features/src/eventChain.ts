// The tamper-evident chain core — pure, DB-free, and shared byte-for-byte with
// the writer.
//
// WHY THIS IS A SEPARATE SUBPATH (`@workspace/features/event-chain`)
// ------------------------------------------------------------------
// `lib/db` needs the canonicaliser in order to verify what Postgres hashed, but
// `lib/db` must not drag `@workspace/markets` (and eventually a whole feature
// stack) into every consumer. This file therefore imports `node:crypto` and
// NOTHING ELSE, so the DB package can depend on it freely.
//
// WHY THE CANONICALISER MATTERS MORE THAN THE HASH
// ------------------------------------------------
// SHA-256 is not the hard part; agreeing on exactly which bytes to hash is. If
// the writer and the verifier serialise the same event even slightly
// differently — key order, whitespace, how `undefined` is rendered — the chain
// reports tampering on every honest row and the alarm gets switched off. So
// there is exactly ONE canonical form, defined here, and both the TypeScript
// verifier and the in-database `digest()` writer consume it. The DB/TS agreement
// is asserted by `test:event-log-db`.
//
// prevHash is folded in LAST, after the event's own fields. That ordering is the
// property that makes the chain a chain: a row's hash covers both its content
// and its position, so an attacker cannot lift a genuine row out of one place in
// the history and drop it into another.

import { createHash } from "node:crypto";

/** The `prevHash` of the first row in a chain. */
export const GENESIS_PREV_HASH = "0".repeat(64);

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * JSON with keys sorted at every depth.
 *
 * `undefined` and non-finite numbers have no JSON representation and would both
 * collapse to `null`, so they are named explicitly — otherwise "the field was
 * absent" and "the field was NaN" would hash identically, and a chain that
 * cannot distinguish those two is not evidence of anything.
 */
export function stableStringify(v: unknown): string {
  if (v === undefined) return '"__undefined__"';
  if (v === null) return "null";
  if (typeof v === "number" && !Number.isFinite(v)) return `"__${String(v)}__"`;
  if (typeof v === "bigint") return `"${v.toString()}n"`;
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/**
 * The canonical byte string for one event.
 *
 * Format: the sorted-key JSON of the event's own fields, then a `|` separator,
 * then the previous row's hash. The separator is not decorative — without it,
 * a field whose value ends in hex digits could be shifted against the prevHash
 * to produce the same concatenation, which is the classic length-extension-style
 * ambiguity that makes two different histories hash alike.
 */
export function canonicalizeEvent(
  fields: Record<string, unknown>,
  prevHash: string | null,
): string {
  return `${stableStringify(fields)}|${prevHash ?? GENESIS_PREV_HASH}`;
}

/** Convenience: the row hash for a set of fields at a chain position. */
export function computeRowHash(
  fields: Record<string, unknown>,
  prevHash: string | null,
): string {
  return sha256Hex(canonicalizeEvent(fields, prevHash));
}

export interface ChainRow {
  /** Stable identifier, reported when this row is the break. */
  eventId: string;
  /** Everything covered by the hash EXCEPT prevHash. */
  fields: Record<string, unknown>;
  /** The previous row's `rowHash`; null/genesis for the first row. */
  prevHash: string | null;
  /** The hash as STORED — what is being checked, not what is recomputed. */
  rowHash: string;
}

export type ChainBreakReason = "CHECKSUM_MISMATCH" | "PREV_HASH_MISMATCH";

export interface ChainVerification {
  valid: boolean;
  /** How many rows were examined before returning. */
  checked: number;
  /** Index of the first bad row, or null when the chain is intact. */
  firstBreakIndex: number | null;
  /** `eventId` of the first bad row, or null. */
  brokenEventId: string | null;
  reason: ChainBreakReason | null;
}

/**
 * Walk a chain oldest-first, recomputing each hash and checking each link.
 *
 * The two failure modes are reported separately because they mean different
 * things operationally:
 *
 *   CHECKSUM_MISMATCH  — this row's CONTENT was edited. Its stored hash no
 *                        longer describes its stored fields.
 *   PREV_HASH_MISMATCH — this row's content is intact but its POSITION is
 *                        wrong: rows were reordered, spliced, or deleted.
 *
 * An edit that changes content is caught by the first check; a reordering, which
 * leaves every individual row's own hash perfectly valid, is caught only by the
 * second. Both are needed — either one alone leaves an obvious forgery.
 *
 * Returns on the FIRST break: everything after a break is unverifiable anyway,
 * since the linkage it depends on has already been broken.
 */
export function verifyChainRows(rows: readonly ChainRow[]): ChainVerification {
  let checked = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    checked++;

    // 1. Content: does the stored hash still describe the stored fields?
    if (computeRowHash(row.fields, row.prevHash) !== row.rowHash) {
      return {
        valid: false,
        checked,
        firstBreakIndex: i,
        brokenEventId: row.eventId,
        reason: "CHECKSUM_MISMATCH",
      };
    }

    // 2. Position: does this row actually follow the one before it?
    const expectedPrev = i === 0 ? null : rows[i - 1]!.rowHash;
    const actualPrev = row.prevHash ?? GENESIS_PREV_HASH;
    const wantPrev = expectedPrev ?? GENESIS_PREV_HASH;
    if (actualPrev !== wantPrev) {
      return {
        valid: false,
        checked,
        firstBreakIndex: i,
        brokenEventId: row.eventId,
        reason: "PREV_HASH_MISMATCH",
      };
    }
  }
  return {
    valid: true,
    checked,
    firstBreakIndex: null,
    brokenEventId: null,
    reason: null,
  };
}
