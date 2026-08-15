// Test: the Black Box core — tamper-evident chain + the one feature path.
//
// Three things are being proven, and each corresponds to a way a trading system
// lies to itself about its own history:
//
//   1. THE CHAIN CATCHES BOTH KINDS OF TAMPERING. Editing a row's CONTENT and
//      REORDERING rows are different attacks and only one of them changes any
//      individual row's own hash. A chain that checks only checksums is defeated
//      by shuffling; one that checks only linkage is defeated by editing. Both
//      are asserted, and each must produce its OWN reason code — "something is
//      wrong" is not evidence, "row 1 was edited" is.
//
//   2. THE FEATURE PATH IS asOf-INVARIANT WHERE IT CLAIMS TO BE. A Deriv
//      synthetic's σ is a closed form of N with no market read, so the vector is
//      identical at any asOf and equals a checked-in golden hash. If a refactor
//      ever changes those bytes, it changed the MATH, and every model trained
//      before it is now trained on something else.
//
//   3. LOOKAHEAD IS REFUSED. A reader offering a fact that had not yet been
//      INGESTED at the simulated moment must be rejected, not quietly used. The
//      value was true then — that is exactly what makes hindsight so convincing
//      — but nobody could have known it, so any edge built on it is imaginary.
//      The test also checks the DEFENSE IN DEPTH: a reader that fails to enforce
//      the rule is caught by computeFeatures itself.
//
// Pure unit test — no DB, no network, no clock. Offline CI lane.

import {
  sha256Hex,
  stableStringify,
  canonicalizeEvent,
  computeRowHash,
  verifyChainRows,
  GENESIS_PREV_HASH,
  computeFeatures,
  sigmaFeedKey,
  LookaheadError,
  FEATURE_SET_ID,
  type ChainRow,
  type PointInTimeFact,
  type PointInTimeReader,
} from "@workspace/features";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

/** Build a correctly-linked chain from a list of field objects. */
function buildChain(events: Array<{ eventId: string; fields: Record<string, unknown> }>): ChainRow[] {
  const rows: ChainRow[] = [];
  let prev: string | null = null;
  for (const e of events) {
    const rowHash = computeRowHash(e.fields, prev);
    rows.push({ eventId: e.eventId, fields: e.fields, prevHash: prev, rowHash });
    prev = rowHash;
  }
  return rows;
}

/** A reader with no data at all. */
const EMPTY_READER: PointInTimeReader = { latestFact: () => null };

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

  console.log("blackBoxFeaturesTest");
  console.log("====================\n");

  // ── 1. Canonicalisation ────────────────────────────────────────────────────
  console.log("Canonicalisation — one agreed byte string, or the chain is noise");
  {
    assert(
      stableStringify({ b: 1, a: 2 }) === stableStringify({ a: 2, b: 1 }),
      "key order does not change the canonical form",
    );
    assert(
      stableStringify({ x: { d: 1, c: 2 } }) === '{"x":{"c":2,"d":1}}',
      "keys are sorted at every DEPTH, not just the top level",
    );
    assert(
      stableStringify({ a: undefined }) !== stableStringify({ a: null }),
      "undefined and null are distinguishable (both would be JSON null)",
    );
    assert(
      stableStringify({ a: NaN }) !== stableStringify({ a: null }),
      "NaN and null are distinguishable — 'absent' and 'NaN' must not hash alike",
    );
    assert(stableStringify([3, 1, 2]) === "[3,1,2]", "array ORDER is preserved (it is data)");

    // prevHash is folded in LAST, and the separator prevents ambiguity.
    assert(
      canonicalizeEvent({ a: 1 }, "abc") === '{"a":1}|abc',
      "canonical form is <fields>|<prevHash>, with prevHash last",
    );
    assert(
      canonicalizeEvent({ a: 1 }, null) === `{"a":1}|${GENESIS_PREV_HASH}`,
      "a null prevHash canonicalises as the genesis hash",
    );
    // Without the separator, these two would concatenate identically.
    assert(
      canonicalizeEvent({ a: "x" }, "yz") !== canonicalizeEvent({ a: "xy" }, "z"),
      "the separator stops a field value being shifted against prevHash",
    );
    assert(
      sha256Hex("") === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "sha256Hex matches the known SHA-256 of the empty string",
    );
    assert(
      computeRowHash({ a: 1 }, null) === sha256Hex(canonicalizeEvent({ a: 1 }, null)),
      "computeRowHash is exactly sha256(canonicalizeEvent(...))",
    );
  }

  // ── 2. The chain catches BOTH kinds of tampering ───────────────────────────
  console.log("\nTamper detection");
  {
    const source = [
      { eventId: "ev1", fields: { kind: "DECISION", instrument: "EURUSD", chosenAction: "BUY" } },
      { eventId: "ev2", fields: { kind: "OBSERVATION", instrument: "EURUSD", price: 1.1 } },
      { eventId: "ev3", fields: { kind: "OUTCOME", instrument: "EURUSD", pnl: -12.5 } },
    ];
    const good = buildChain(source);

    const okv = verifyChainRows(good);
    assert(okv.valid && okv.checked === 3 && okv.reason === null,
      "an intact 3-row chain verifies (checked 3, no reason)");
    assert(okv.firstBreakIndex === null && okv.brokenEventId === null,
      "…and reports no break index or event");
    assert(verifyChainRows([]).valid, "an empty chain is vacuously valid");
    assert(verifyChainRows([good[0]!]).valid, "a single genesis row verifies");

    // (a) A flipped byte in the CONTENT of row 1.
    const edited = buildChain(source);
    edited[1] = { ...edited[1]!, fields: { ...edited[1]!.fields, price: 1.2 } };
    const e = verifyChainRows(edited);
    assert(!e.valid, "an edited payload is rejected");
    assert(e.reason === "CHECKSUM_MISMATCH", `…as CHECKSUM_MISMATCH (got ${e.reason})`);
    assert(e.firstBreakIndex === 1, `…at index 1 (got ${e.firstBreakIndex})`);
    assert(e.brokenEventId === "ev2", `…naming ev2 (got ${e.brokenEventId})`);

    // A one-character edit is enough — the point of a hash.
    const tiny = buildChain(source);
    tiny[2] = { ...tiny[2]!, fields: { ...tiny[2]!.fields, pnl: -12.50000001 } };
    assert(verifyChainRows(tiny).reason === "CHECKSUM_MISMATCH",
      "a change in the 8th decimal place is still caught");

    // (b) REORDERING. Every individual row's own hash still verifies — this is
    // the attack a checksum-only chain misses entirely.
    const shuffled = buildChain(source);
    const tmp = shuffled[1]!;
    shuffled[1] = shuffled[2]!;
    shuffled[2] = tmp;
    assert(
      computeRowHash(shuffled[1]!.fields, shuffled[1]!.prevHash) === shuffled[1]!.rowHash,
      "the reordered row's OWN checksum is still perfectly valid",
    );
    const s = verifyChainRows(shuffled);
    assert(!s.valid, "…yet the reordered chain is rejected");
    assert(s.reason === "PREV_HASH_MISMATCH", `…as PREV_HASH_MISMATCH (got ${s.reason})`);
    assert(s.firstBreakIndex === 1, `…at index 1 (got ${s.firstBreakIndex})`);

    // (c) Deleting a row from the middle breaks the linkage.
    const deleted = buildChain(source);
    deleted.splice(1, 1);
    const d = verifyChainRows(deleted);
    assert(!d.valid && d.reason === "PREV_HASH_MISMATCH",
      "deleting a middle row is caught as PREV_HASH_MISMATCH");

    // (d) Splicing in a well-formed but foreign row.
    const spliced = buildChain(source);
    const foreign = buildChain([{ eventId: "evX", fields: { kind: "DECISION", forged: true } }])[0]!;
    spliced.splice(1, 0, foreign);
    const sp = verifyChainRows(spliced);
    assert(!sp.valid, "a spliced-in row is rejected even though its own hash is valid");
    assert(sp.brokenEventId === "evX" || sp.firstBreakIndex === 1,
      "…and the break is located at the splice point");

    // (e) A truncated chain (rows dropped from the END) still verifies — stated
    // out loud because it is a REAL limit of a hash chain, not an oversight.
    // Detecting truncation needs an external anchor (a published head hash);
    // that is a separate concern and is not claimed here.
    assert(verifyChainRows(good.slice(0, 2)).valid,
      "a chain truncated at the END still verifies (a known limit — needs an external head anchor)");
  }

  // ── 3. The feature path ────────────────────────────────────────────────────
  console.log("\nFeature path — one implementation, asOf-invariant where it claims to be");
  {
    const t1 = "2026-06-19T12:00:00.000Z";
    const t2 = "2027-01-02T03:04:05.000Z";

    const a = computeFeatures("Volatility 75 Index", t1, EMPTY_READER);
    const b = computeFeatures("Volatility 75 Index", t2, EMPTY_READER);

    assert(a.featureSetId === FEATURE_SET_ID, `featureSetId is ${FEATURE_SET_ID}`);
    assert(a.dataSnapshotHash === b.dataSnapshotHash,
      "a synthetic's dataSnapshotHash is asOf-INVARIANT (closed form, no market read)");
    assert(a.expectedMoveSigma1min === b.expectedMoveSigma1min,
      "…and so is its σ");

    // σ must equal the closed form to 1e-12.
    const expected = (75 / 100) / Math.sqrt(365 * 1440);
    assert(
      a.expectedMoveSigma1min !== null &&
        Math.abs(a.expectedMoveSigma1min - expected) < 1e-12,
      `V75 σ_1min equals (75/100)/√(365·1440) to 1e-12 (got ${a.expectedMoveSigma1min})`,
    );

    // GOLDEN VECTOR. If this changes, the feature MATH changed, and every model
    // trained before the change is now trained on a different function.
    //
    // The value is not "whatever the code emitted" — it is derived independently
    // from the canonical string, so the anchor checks the implementation rather
    // than merely recording it:
    //
    //   canonical: {"instrument":"Volatility 75 Index","kind":"SYNTHETIC_CLOSED_FORM","volIndex":75}
    //   $ node -e 'console.log(require("crypto").createHash("sha256")
    //       .update(JSON.stringify({instrument:"Volatility 75 Index",
    //         kind:"SYNTHETIC_CLOSED_FORM",volIndex:75}),"utf8").digest("hex"))'
    //   25ac20b2783fae5827c5aeb31f6d3d51e7750b68cce58d43d820ee890562e1d1
    const GOLDEN_V75_SNAPSHOT_HASH =
      "25ac20b2783fae5827c5aeb31f6d3d51e7750b68cce58d43d820ee890562e1d1";
    assert(
      a.dataSnapshotHash === GOLDEN_V75_SNAPSHOT_HASH,
      `V75 golden dataSnapshotHash is byte-identical (got ${a.dataSnapshotHash})`,
    );

    // The reader is never consulted for a synthetic — nothing to look ahead at.
    let consulted = false;
    computeFeatures("Volatility 100 Index", t1, {
      latestFact: () => { consulted = true; return null; },
    });
    assert(!consulted, "a synthetic instrument makes NO market read at all");

    // A measured instrument with no data yields null σ — never 0, which is a
    // valid volatility meaning "does not move" and would size as if risk-free.
    const none = computeFeatures("EURUSD", t1, EMPTY_READER);
    assert(none.expectedMoveSigma1min === null,
      "a measured instrument with no data has σ = null, never 0");

    // A measured instrument WITH an in-window fact uses it.
    const measured = computeFeatures("EURUSD", t1, {
      latestFact: <T,>() =>
        ({
          validTimeIso: "2026-06-19T11:59:00.000Z",
          ingestionTimeIso: "2026-06-19T11:59:30.000Z",
          value: 0.00042,
        }) as PointInTimeFact<T>,
    });
    assert(measured.expectedMoveSigma1min === 0.00042, "an in-window measured σ is used");
    assert(measured.dataSnapshotHash !== none.dataSnapshotHash,
      "…and changes the snapshot hash (provenance is in the hash)");
    assert(sigmaFeedKey("EURUSD") === "sigma1min:EURUSD", "the feed key is stable");
  }

  // ── 4. Lookahead is refused ────────────────────────────────────────────────
  console.log("\nLookahead — refused, and re-checked rather than trusted");
  {
    const asOf = "2026-06-19T12:00:00.000Z";

    // (a) A reader that correctly throws.
    let threw: unknown = null;
    try {
      computeFeatures("EURUSD", asOf, {
        latestFact: (key) => {
          throw new LookaheadError(key, asOf, "2026-06-19T12:00:01.000Z");
        },
      });
    } catch (err) { threw = err; }
    assert(threw instanceof LookaheadError, "a throwing reader's LookaheadError propagates");
    assert((threw as LookaheadError).name === "LookaheadError",
      "…as a DISTINCT error type, so a harness cannot catch-and-continue past it");

    // (b) DEFENSE IN DEPTH: a reader that FORGETS to enforce the rule and
    // returns a future-ingested fact must still be caught.
    let threw2: unknown = null;
    try {
      computeFeatures("EURUSD", asOf, {
        latestFact: <T,>() =>
          ({
            validTimeIso: "2026-06-19T11:00:00.000Z", // was true before asOf…
            ingestionTimeIso: "2026-06-19T18:00:00.000Z", // …but learned 6h later
            value: 0.0009,
          }) as PointInTimeFact<T>,
      });
    } catch (err) { threw2 = err; }
    assert(threw2 instanceof LookaheadError,
      "a non-enforcing reader returning a future-INGESTED fact is caught by computeFeatures");

    // (c) A future VALID time is refused too.
    let threw3: unknown = null;
    try {
      computeFeatures("EURUSD", asOf, {
        latestFact: <T,>() =>
          ({
            validTimeIso: "2026-06-20T00:00:00.000Z",
            ingestionTimeIso: "2026-06-19T11:00:00.000Z",
            value: 0.0009,
          }) as PointInTimeFact<T>,
      });
    } catch (err) { threw3 = err; }
    assert(threw3 instanceof LookaheadError, "a future VALID time is refused as well");

    // (d) A fact exactly AT asOf is admissible — the window is inclusive.
    const atBoundary = computeFeatures("EURUSD", asOf, {
      latestFact: <T,>() =>
        ({ validTimeIso: asOf, ingestionTimeIso: asOf, value: 0.0005 }) as PointInTimeFact<T>,
    });
    assert(atBoundary.expectedMoveSigma1min === 0.0005,
      "a fact timestamped exactly at asOf IS admissible (the window is inclusive)");

    // (e) An unparseable timestamp fails CLOSED, not open.
    let threw4: unknown = null;
    try {
      computeFeatures("EURUSD", asOf, {
        latestFact: <T,>() =>
          ({ validTimeIso: "not-a-date", ingestionTimeIso: asOf, value: 1 }) as PointInTimeFact<T>,
      });
    } catch (err) { threw4 = err; }
    assert(threw4 instanceof LookaheadError,
      "an unparseable timestamp is refused (fails closed, never assumed in-window)");
  }

  // ── 5. Determinism ─────────────────────────────────────────────────────────
  console.log("\nDeterminism");
  {
    const t = "2026-06-19T12:00:00.000Z";
    const runs = Array.from({ length: 5 }, () =>
      JSON.stringify(computeFeatures("Volatility 75 Index", t, EMPTY_READER)));
    assert(new Set(runs).size === 1, "five runs produce a byte-identical feature vector");
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "blackBoxFeaturesTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[blackBoxFeaturesTest] FAILED:", err);
      process.exit(1);
    },
  );
}
