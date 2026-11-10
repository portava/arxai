// Test: validation_evidence_v1 — the hashed store for real-data validation runs.
//
// Runs against DATABASE_URL inside a private, throwaway Postgres SCHEMA (created
// and dropped here), so it never touches the shared tables a schema push made.
//
//   - the migration is idempotent AND re-attaches every CHECK/trigger over a bare
//     table of the kind `drizzle-kit push` creates (constraints missing)
//   - a real run (pinned fixture subset) round-trips: record → read VERIFIED
//   - recording the same run again is idempotent ("existing", same id)
//   - the database refuses: UPDATE/DELETE/TRUNCATE (append-only), live_allowed=true,
//     a ceiling above SHADOW, a payload whose hash does not match, a survivor
//     claiming liveAllowed inside the payload
//   - a row corrupted behind the triggers' back is reported as an INTEGRITY
//     failure on read, never returned as evidence
//
// Requires a reachable Postgres (the `ci` job has one). Fails hard otherwise.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { stableStringify } from "@workspace/discovery";
import { runRealDataValidation, DEFAULT_RUNNER_PARAMS } from "./research/realDataValidation.js";
import { fixtureInstruments } from "./research/runRealDataValidation.js";
import { ValidationEvidenceStore, ValidationEvidenceError, resultHashOf } from "../../artifacts/api-server/src/lib/research/validationEvidence.js";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };
const pg = createRequire(import.meta.resolve("@workspace/db"))("pg") as { Pool: new (o: { connectionString?: string; max?: number; options?: string }) => Pool };

const MIGRATION = readFileSync(new URL("../../lib/db/migrations/2026-11-09_validation_evidence_v1.sql", import.meta.url), "utf8");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

export async function run(): Promise<CiTestResultLike> {
  let passes = 0;
  let failures = 0;
  const assert = (cond: boolean, label: string) => {
    if (cond) { passes++; console.log(`  ✓ ${label}`); } else { failures++; console.error(`  ✗ ${label}`); }
  };
  const rejects = async (p: Promise<unknown>, match: RegExp): Promise<boolean> => {
    try { await p; return false; } catch (e) { return match.test(String((e as Error).message ?? e)) || match.test(String((e as { code?: string }).code)); }
  };

  console.log("validationEvidenceDbTest");
  console.log("========================\n");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for the validation evidence DB test");

  const schema = `vev_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` });
  try {
    // ── migration over a bare, pushed-style table ───────────────────────────
    console.log("Migration");
    await pool.query(`CREATE TABLE validation_evidence_v1 (id uuid PRIMARY KEY, run_kind text NOT NULL, runner_version text NOT NULL,
      dataset_source text NOT NULL, dataset_hash text NOT NULL, params_hash text NOT NULL, result_hash text NOT NULL,
      code_commit text NOT NULL, code_dirty boolean NOT NULL, trials integer NOT NULL, survivors integer NOT NULL,
      promotion_ceiling text NOT NULL, live_allowed boolean NOT NULL DEFAULT false, payload_hash text NOT NULL,
      manifest_hash text NOT NULL, payload_bytes integer NOT NULL, canonical_payload text NOT NULL,
      canonical_manifest text NOT NULL, created_at timestamptz NOT NULL)`);
    await pool.query(MIGRATION);
    await pool.query(MIGRATION);
    const cons = await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid = '${schema}.validation_evidence_v1'::regclass AND contype='c'`);
    const names = new Set(cons.rows.map((r) => r.conname as string));
    assert(["kind", "hashes", "never_live", "counts", "digest", "payload"].every((n) => names.has(`validation_evidence_v1_${n}_ck`)),
      `applied twice over a bare pushed table, every CHECK is attached (${names.size})`);
    const trg = await pool.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = '${schema}.validation_evidence_v1'::regclass AND NOT tgisinternal`);
    assert(trg.rows.length === 2, "…and both append-only triggers");

    // ── a real run round-trips ──────────────────────────────────────────────
    console.log("\nRecord and read a real run");
    const { datasetHash, instruments } = fixtureInstruments();
    const runResult = runRealDataValidation({ instruments: instruments.slice(0, 2), datasetHash, params: { ...DEFAULT_RUNNER_PARAMS, lookaheadSamples: 1 } });
    const run = runResult as unknown as Parameters<ValidationEvidenceStore["record"]>[0]["run"];
    const store = new ValidationEvidenceStore(pool as never);
    const a = await store.record({ run, datasetSource: "fixture:real-history-v1", codeCommit: COMMIT, codeDirty: false });
    assert(a.disposition === "created" && a.manifest.liveAllowed === false && a.manifest.promotionCeiling === "SHADOW", "a run is recorded, ceiling SHADOW, liveAllowed=false");
    assert(a.manifest.datasetHash === datasetHash && a.manifest.codeCommit === COMMIT && a.manifest.paramsHash === runResult.paramsHash,
      "the manifest carries the dataset hash, code commit and params hash");
    const b = await store.record({ run, datasetSource: "fixture:real-history-v1", codeCommit: COMMIT, codeDirty: false });
    assert(b.disposition === "existing" && b.manifest.id === a.manifest.id, "recording the same run again is idempotent");
    const read = await store.read(a.manifest.id);
    assert(read !== null && read.payloadVerified && stableStringify(read.run) === stableStringify(runResult), "read returns the exact run, payload verified");
    assert(read !== null && resultHashOf(read.run) === runResult.resultHash, "…and its resultHash re-derives from the stored body");
    const list = await store.list(10);
    assert(list.length === 1 && list[0]!.manifest.id === a.manifest.id, "list shows it with a verified manifest");
    assert(await store.read(randomUUID()) === null, "an unknown id reads as null, not as evidence");

    // A run whose resultHash does not re-derive is refused before any SQL.
    const forged = { ...runResult, survivors: [] as never[], resultHash: runResult.resultHash } as unknown as typeof run;
    const forgedRefused = await store.record({ run: { ...forged, fdr: { ...runResult.fdr, familySize: runResult.fdr.familySize + 1 } }, datasetSource: "x", codeCommit: COMMIT, codeDirty: false })
      .then(() => false, (e) => e instanceof ValidationEvidenceError && e.code === "INVALID_VALIDATION_EVIDENCE");
    assert(forgedRefused, "a run edited after hashing (resultHash no longer re-derives) is refused by the store");

    // ── the database itself refuses ─────────────────────────────────────────
    console.log("\nDatabase constraints");
    assert(await rejects(pool.query("UPDATE validation_evidence_v1 SET survivors = survivors"), /APPEND_ONLY/), "UPDATE is refused (append-only)");
    assert(await rejects(pool.query("DELETE FROM validation_evidence_v1"), /APPEND_ONLY/), "DELETE is refused");
    assert(await rejects(pool.query("TRUNCATE validation_evidence_v1"), /APPEND_ONLY/), "TRUNCATE is refused");

    const row = (await pool.query("SELECT * FROM validation_evidence_v1 WHERE id=$1", [a.manifest.id])).rows[0];
    const cols = Object.keys(row);
    const insert = (over: Record<string, unknown>) => {
      const r = { ...row, id: randomUUID(), code_commit: "f".repeat(40), ...over };
      return pool.query(`INSERT INTO validation_evidence_v1 (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, cols.map((c) => r[c]));
    };
    assert(await rejects(insert({ live_allowed: true }), /never_live_ck/), "live_allowed=true is refused by CHECK");
    assert(await rejects(insert({ promotion_ceiling: "DEMO" }), /never_live_ck/), "a ceiling above SHADOW is refused by CHECK");
    assert(await rejects(insert({ canonical_payload: `${row.canonical_payload} ` }), /counts_ck|digest_ck/), "a payload that no longer matches its hash is refused by CHECK");
    {
      const tampered = JSON.parse(row.canonical_payload);
      tampered.survivors = [{ key: "x", liveAllowed: true, promotionCeiling: "SHADOW" }];
      const text = stableStringify(tampered);
      const h = createHash("sha256").update(text).digest("hex");
      assert(await rejects(insert({ canonical_payload: text, payload_hash: h, payload_bytes: Buffer.byteLength(text), survivors: 1 }), /payload_ck/),
        "a payload with a survivor claiming liveAllowed is refused by CHECK even with consistent hashes");
    }

    // ── corruption behind the triggers' back is caught on read ──────────────
    console.log("\nRead-side verification");
    await pool.query("ALTER TABLE validation_evidence_v1 DISABLE TRIGGER validation_evidence_v1_no_change");
    await pool.query("ALTER TABLE validation_evidence_v1 DROP CONSTRAINT validation_evidence_v1_digest_ck");
    await pool.query("ALTER TABLE validation_evidence_v1 DROP CONSTRAINT validation_evidence_v1_counts_ck");
    await pool.query("UPDATE validation_evidence_v1 SET canonical_payload = replace(canonical_payload, '\"survivor\":false', '\"survivor\":true') WHERE id=$1", [a.manifest.id]);
    const corrupted = await store.read(a.manifest.id).then(() => "returned", (e) => (e instanceof ValidationEvidenceError ? e.code : String(e)));
    assert(corrupted === "VALIDATION_EVIDENCE_INTEGRITY", `a payload rewritten behind the triggers is an INTEGRITY failure on read (got ${corrupted})`);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "validationEvidenceDbTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => { console.error("[validationEvidenceDbTest] FAILED:", err); process.exit(1); },
  );
}
