// Test: event_log — the Black Box, against a real Postgres.
//
// The claim being tested is narrow and load-bearing: THE DATABASE AND THE
// APPLICATION AGREE ON EXACTLY WHICH BYTES ARE HASHED.
//
// `row_hash` is computed inside Postgres by `digest(canonical, 'sha256')`. The
// verifier recomputes it in TypeScript from the shared canonicaliser. If those
// two ever disagree — by a key order, a timestamp format, a whitespace — then
// every honest row reports as tampered, and the first thing anyone does with a
// tamper alarm that cries wolf is switch it off. So the agreement is asserted
// directly, hash by hash, rather than assumed.
//
// Then the actual security property: a manual `UPDATE` to a payload byte,
// applied straight to the table with SQL — the exact move a compromised
// application or an operator with a psql prompt would make — must be caught.
// The application cannot repair it, because the application never had the
// ability to write the hash in the first place.
//
// SELF-SKIPS without DATABASE_URL and prints why. This test needs a real
// database (pgcrypto's digest() has no offline equivalent), so it runs in the
// integration lane, not the offline `ci` lane. The pure core it depends on is
// fully covered offline by test:black-box-features.
//
// SAFETY: touches only `event_log`, a new append-only table. Places no trades,
// reads no broker, and cleans up every row it writes.

import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const HAS_DB = Boolean(process.env.DATABASE_URL);

export async function run(): Promise<CiTestResultLike> {
  let passes = 0;
  let failures = 0;

  function assert(cond: boolean, label: string) {
    if (cond) {
      passes++;
      console.log(`  ✓ ${label}`);
    } else {
      failures++;
      console.error(`  ✗ ${label}`);
    }
  }

  console.log("eventLogDbTest");
  console.log("==============\n");

  if (!HAS_DB) {
    console.log("SKIPPED — DATABASE_URL is not set.");
    console.log("  event_log's row_hash is computed by Postgres via pgcrypto's digest(),");
    console.log("  which has no offline equivalent, so this test needs a real database.");
    console.log("  The pure chain core and feature path are covered offline by");
    console.log("  test:black-box-features (44 assertions), which gates every commit.");
    return { name: "eventLogDbTest", passes: 0, failures: 0 };
  }

  // Imported lazily: `@workspace/db` throws at import time without DATABASE_URL,
  // so a top-level import would break the skip path this test exists to provide.
  const { db, sql } = await import("./eventLogDbTestSupport.js");
  const { eventLogTable } = await import("@workspace/db");
  const { appendEvent, verifyChain, toChainRow } = await import(
    "@workspace/db/repositories"
  ).then((m) => m.eventLogRepo);
  const { computeRowHash, canonicalizeEvent, stableStringify } = await import(
    "@workspace/features/event-chain"
  );
  const { eq, like } = await import("drizzle-orm");

  const TAG = `qa-eventlog-${process.pid}-${Date.now()}`;
  const INSTRUMENT = `QA_${TAG}`;

  async function cleanup() {
    await db.delete(eventLogTable).where(like(eventLogTable.instrument, `QA_qa-eventlog-%`));
  }

  try {
    // pgcrypto must be available — say so plainly rather than failing obscurely
    // three assertions later.
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    const probe = await db.execute(
      sql`SELECT encode(digest('abc', 'sha256'), 'hex') AS h`,
    );
    const digestOk =
      (probe.rows?.[0] as { h?: string } | undefined)?.h ===
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    assert(digestOk, "pgcrypto digest('abc','sha256') matches the known SHA-256 of 'abc'");

    await cleanup();

    // ── Write three events ─────────────────────────────────────────────────
    const base = {
      instrument: INSTRUMENT,
      featureSetId: "fset_v1",
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      featureCodeHash: "fch_test",
      dataSnapshotHash: "dsh_test",
    };
    const written = [];
    for (const [i, spec] of [
      { kind: "OBSERVATION", action: null, fv: { z: 1, a: { d: 4, c: 3 } } },
      { kind: "DECISION", action: "BUY", fv: { sigma: 0.001, n: 75 } },
      { kind: "OUTCOME", action: null, fv: { pnl: -12.5 } },
    ].entries()) {
      written.push(
        await appendEvent({
          ...base,
          eventId: `${TAG}-${i}`,
          kind: spec.kind,
          validTime: new Date(Date.UTC(2026, 5, 19, 12, i, 0)),
          ingestionTime: new Date(Date.UTC(2026, 5, 19, 12, i, 30)),
          featureVector: spec.fv,
          gateVerdicts: { g1: "PASS", g18: "PASS" },
          chosenAction: spec.action,
          seed: `seed-${i}`,
        }),
      );
    }
    assert(written.length === 3, "three events appended");
    assert(
      written[0]!.prevHash === "0".repeat(64),
      "the genesis row's prevHash is 64 zeros",
    );
    assert(
      written[1]!.prevHash === written[0]!.rowHash &&
        written[2]!.prevHash === written[1]!.rowHash,
      "each row links to the previous row's rowHash",
    );
    assert(
      written.every((r) => /^[0-9a-f]{64}$/.test(r.rowHash)),
      "every rowHash is a 64-hex-char sha256 digest",
    );
    assert(
      new Set(written.map((r) => r.rowHash)).size === 3,
      "the three row hashes are distinct",
    );

    // ── THE CORE CLAIM: Postgres and TypeScript hashed the same bytes ───────
    let agreed = 0;
    for (const r of written) {
      const chainRow = toChainRow(r);
      const ts = computeRowHash(chainRow.fields, chainRow.prevHash);
      if (ts === r.rowHash) agreed++;
      else {
        console.error(`    DB   : ${r.rowHash}`);
        console.error(`    TS   : ${ts}`);
        console.error(`    canon: ${canonicalizeEvent(chainRow.fields, chainRow.prevHash)}`);
      }
    }
    assert(
      agreed === 3,
      `the in-DB row_hash equals sha256Hex(canonicalizeEvent(...)) BYTE-FOR-BYTE for ${agreed}/3 rows`,
    );

    // ── The chain verifies ─────────────────────────────────────────────────
    const v1 = await verifyChain();
    assert(v1.valid, `verifyChain() reports the chain intact (checked ${v1.checked})`);
    assert(v1.reason === null && v1.firstBreakIndex === null, "…with no break reported");

    // ── A manual UPDATE — the compromised-operator move — is caught ─────────
    await db
      .update(eventLogTable)
      .set({ chosenAction: "SELL" })
      .where(eq(eventLogTable.eventId, `${TAG}-1`));

    const v2 = await verifyChain();
    assert(!v2.valid, "a manual UPDATE to a payload byte is DETECTED");
    assert(
      v2.reason === "CHECKSUM_MISMATCH",
      `…as CHECKSUM_MISMATCH (got ${v2.reason})`,
    );
    assert(
      v2.brokenEventId === `${TAG}-1`,
      `…naming the exact row that was edited (got ${v2.brokenEventId})`,
    );
    assert(
      v2.firstBreakIndex === 1,
      `…at chain index 1 (got ${v2.firstBreakIndex})`,
    );

    // The forger cannot repair it through the application: `row_hash` is not an
    // insertable or updatable field on the writer's interface at all.
    const rows = await db
      .select()
      .from(eventLogTable)
      .where(eq(eventLogTable.eventId, `${TAG}-1`));
    const edited = rows[0]!;
    assert(
      edited.chosenAction === "SELL" && edited.rowHash === written[1]!.rowHash,
      "the edit changed the payload but left the DB-computed hash describing the ORIGINAL",
    );

    // ── Bitemporality is real, not a naming convention ─────────────────────
    assert(
      written.every((r) => r.ingestionTime.getTime() > r.validTime.getTime()),
      "valid_time and ingestion_time are stored as SEPARATE instants",
    );
    const asOf = new Date(Date.UTC(2026, 5, 19, 12, 1, 0));
    const knownBy = await db
      .select()
      .from(eventLogTable)
      .where(like(eventLogTable.instrument, INSTRUMENT));
    const visible = knownBy.filter((r) => r.ingestionTime.getTime() <= asOf.getTime());
    assert(
      visible.length === 1,
      `a replay as of ${asOf.toISOString()} sees only what was INGESTED by then (${visible.length} of 3)`,
    );

    // Nested JSON survives the round trip with its structure intact — the
    // canonicaliser sorts for HASHING, it does not rewrite what is stored.
    assert(
      stableStringify(written[0]!.featureVector) === '{"a":{"c":3,"d":4},"z":1}',
      "a nested feature vector canonicalises with keys sorted at every depth",
    );
  } finally {
    await cleanup();
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "eventLogDbTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[eventLogDbTest] FAILED:", err);
      process.exit(1);
    },
  );
}
