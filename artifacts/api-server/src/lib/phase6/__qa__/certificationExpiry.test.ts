// #56 Continuous certification — coded review periods, authority reduction on
// lapse, and the recertification drill (OFFLINE).
//
// Locks:
//   * EXPIRY MATH: current inside the review period, LAPSED after it, and
//     malformed dates / invalid periods are LAPSED (fail closed), never
//     current and never a throw.
//   * REDUCE-ONLY: every seam can only ADD refusals/violations — a current
//     register adds nothing, and no function here grants anything.
//   * THE THREE SEAMS:
//       BROKER   → guided dispatch at a venue-permitting tier refuses with
//                  BROKER_CERTIFICATION_LAPSED (before any ticket is loaded
//                  or claimed); TIER_0 dry-run is NOT gated (it is the floor).
//       MODEL    → evaluatePromotion refuses an otherwise-allowed rung while
//                  a MODEL certification is lapsed.
//       RECOVERY → the kill-switch release violation list grows while a
//                  RECOVERY certification is lapsed.
//   * RECERTIFICATION DRILL (fixtures): lapse → authority reduced; recertify
//     (new certifiedAtIso, the reviewed-change act) → reduction lifts. The
//     drill proves the loop is closed in BOTH directions.
//
// Run: pnpm --filter @workspace/api-server run test:certification-expiry

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CODED_CERTIFICATIONS,
  evaluateCodedCertification,
  lapsedCertificationsOfKind,
  brokerCertificationDispatchRefusals,
  modelCertificationPromotionRefusals,
  recoveryCertificationReleaseViolations,
  type CodedCertification,
} from "@workspace/domain/safety-contracts/certificationExpiry";

const { evaluatePromotion, MIN_REAL_SHADOW_SAMPLE } = await import("../../learning/edgePromotion.js");
const { dispatchGuidedTicket } = await import("../guidedExecutionService.js");
type GuidedDispatchDeps = import("../guidedExecutionService.js").GuidedDispatchDeps;

// Fixture register: one certification per kind, certified at T_CERT for 90d.
const T_CERT = "2026-01-01T00:00:00.000Z";
const CURRENT_AT = new Date("2026-02-01T00:00:00.000Z"); // day 31 of 90
const LAPSED_AT = new Date("2026-06-01T00:00:00.000Z");  // long past day 90

function fixture(kind: CodedCertification["kind"], certifiedAtIso = T_CERT): CodedCertification {
  return {
    id: `drill-${kind.toLowerCase()}`,
    kind,
    subject: `${kind} drill fixture`,
    certifiedAtIso,
    reviewPeriodDays: 90,
    evidenceRef: "drill fixture — re-run the named harness",
  };
}

// ── Expiry math ─────────────────────────────────────────────────────────────

test("current inside the review period, lapsed after it", () => {
  const cert = fixture("BROKER");
  assert.equal(evaluateCodedCertification(cert, CURRENT_AT).status, "CURRENT");
  const lapsed = evaluateCodedCertification(cert, LAPSED_AT);
  assert.equal(lapsed.status, "LAPSED");
  assert.ok(lapsed.reason && lapsed.reason.includes("recertify"));
});

test("exact boundary: the expiry instant itself is still current; 1ms later lapses", () => {
  const cert = fixture("BROKER");
  const expiry = Date.parse(T_CERT) + 90 * 24 * 60 * 60 * 1000;
  assert.equal(evaluateCodedCertification(cert, new Date(expiry)).status, "CURRENT");
  assert.equal(evaluateCodedCertification(cert, new Date(expiry + 1)).status, "LAPSED");
});

test("malformed date and invalid period are LAPSED (fail closed), never a throw", () => {
  const badDate = { ...fixture("MODEL"), certifiedAtIso: "not-a-date" };
  const e1 = evaluateCodedCertification(badDate, CURRENT_AT);
  assert.equal(e1.status, "LAPSED");
  assert.ok(e1.reason && e1.reason.includes("unreadable"));

  const badPeriod = { ...fixture("MODEL"), reviewPeriodDays: 0 };
  assert.equal(evaluateCodedCertification(badPeriod, CURRENT_AT).status, "LAPSED");
});

test("the REAL coded register: every entry parses and was current when coded", () => {
  // Pinned date just after the register's newest certification — the register
  // must never ship born-lapsed or unreadable.
  const at = new Date("2026-08-29T00:00:00.000Z");
  for (const cert of CODED_CERTIFICATIONS) {
    const e = evaluateCodedCertification(cert, at);
    assert.equal(e.status, "CURRENT", `${cert.id} must be current at coding time: ${e.reason ?? ""}`);
    assert.ok(e.expiresAtMs !== null);
  }
  // All three kinds are covered — a kind with no certification would make its
  // seam trivially permanent-pass.
  for (const kind of ["BROKER", "MODEL", "RECOVERY"] as const) {
    assert.ok(CODED_CERTIFICATIONS.some((c) => c.kind === kind), `register must cover ${kind}`);
  }
});

// ── Reduce-only + the three seams ───────────────────────────────────────────

test("reduce-only: a current register contributes zero refusals on every seam", () => {
  const reg = [fixture("BROKER"), fixture("MODEL"), fixture("RECOVERY")];
  assert.deepEqual(brokerCertificationDispatchRefusals(CURRENT_AT, reg), []);
  assert.deepEqual(modelCertificationPromotionRefusals(CURRENT_AT, reg), []);
  assert.deepEqual(recoveryCertificationReleaseViolations(CURRENT_AT, reg), []);
});

test("kind isolation: a lapsed BROKER cert never leaks into MODEL/RECOVERY seams", () => {
  const reg = [fixture("BROKER"), fixture("MODEL", "2026-05-01T00:00:00.000Z"), fixture("RECOVERY", "2026-05-01T00:00:00.000Z")];
  // At LAPSED_AT the broker cert lapsed; model/recovery (certified 2026-05-01, 90d) are current.
  assert.equal(lapsedCertificationsOfKind("BROKER", LAPSED_AT, reg).length, 1);
  assert.deepEqual(modelCertificationPromotionRefusals(LAPSED_AT, reg), []);
  assert.deepEqual(recoveryCertificationReleaseViolations(LAPSED_AT, reg), []);
});

test("MODEL seam: a lapsed model certification refuses an otherwise-allowed promotion", () => {
  const edge = {
    status: "SHADOW",
    preregHash: null,
    validationReportJson: null,
    reportHash: null,
    shadowValidated: true,
    adminApproved: false,
    liveAllowed: false,
  };
  const evidence = { sampleSize: MIN_REAL_SHADOW_SAMPLE, syntheticExcluded: true };

  const current = evaluatePromotion(edge, evidence, CURRENT_AT, [fixture("MODEL")]);
  assert.equal(current.allowed, true, `expected allowed, got: ${current.reasons.join(",")}`);
  assert.equal(current.to, "DEMO");

  const lapsed = evaluatePromotion(edge, evidence, LAPSED_AT, [fixture("MODEL")]);
  assert.equal(lapsed.allowed, false);
  assert.equal(lapsed.patch, null);
  assert.ok(lapsed.reasons.some((r) => r.startsWith("MODEL_CERTIFICATION_LAPSED")));
});

test("RECOVERY seam: lapse adds a release violation; recertification lifts it", () => {
  const lapsedReg = [fixture("RECOVERY")];
  const v = recoveryCertificationReleaseViolations(LAPSED_AT, lapsedReg);
  assert.equal(v.length, 1);
  assert.ok(v[0]!.includes("recovery certification lapsed"));

  // The DRILL's recertification act: a NEW certifiedAtIso from re-running the
  // evidence, landed as a reviewed change. Same clock, reduction lifted.
  const recertReg = [fixture("RECOVERY", "2026-05-15T00:00:00.000Z")];
  assert.deepEqual(recoveryCertificationReleaseViolations(LAPSED_AT, recertReg), []);
});

// ── BROKER seam through the real dispatch service ───────────────────────────

function unreachedDeps(over: Partial<GuidedDispatchDeps> = {}): GuidedDispatchDeps {
  const audits: { kind: string; detail: string }[] = [];
  const deps: GuidedDispatchDeps = {
    configuredTier: "TIER_1_DEMO_GUIDED",
    loadActiveConstitution: async () => { throw new Error("must not be reached"); },
    loadObservedState: async () => { throw new Error("must not be reached"); },
    // Sentinel: reaching the ticket loader proves the cert gate PASSED.
    loadOwnedTicket: async () => null,
    deriveCurrentTerms: async () => { throw new Error("must not be reached"); },
    hasUnresolvedIntent: async () => { throw new Error("must not be reached"); },
    claimForDispatch: async () => { throw new Error("must not be reached"); },
    venueForTicket: async () => { throw new Error("must not be reached"); },
    deliverViaAdapter: async () => { throw new Error("must not be reached"); },
    isIndeterminate: () => false,
    newLiveCommandId: () => "cmd-qa",
    recordAudit: async (e) => { audits.push({ kind: e.kind, detail: e.detail }); },
    ...over,
  };
  (deps as GuidedDispatchDeps & { __audits: typeof audits }).__audits = audits;
  return deps;
}

test("BROKER seam: venue-permitting tier + lapsed broker cert refuses BEFORE any ticket work", async () => {
  const deps = unreachedDeps({
    certificationNowMs: LAPSED_AT.getTime(),
    certificationRegistry: [fixture("BROKER")],
  });
  const out = await dispatchGuidedTicket(
    { userId: 1, ticketId: "t1", marketCategory: "synthetic_index", conditions: [] },
    deps,
  );
  assert.equal(out.ok, false);
  assert.equal(out.refusal, "BROKER_CERTIFICATION_LAPSED");
  assert.equal(out.claimed, false);
  const audits = (deps as unknown as { __audits: { kind: string; detail: string }[] }).__audits;
  assert.ok(audits.some((a) => a.detail.includes("broker certification lapsed")));
});

test("BROKER seam drill: recertification restores dispatch past the cert gate", async () => {
  const deps = unreachedDeps({
    certificationNowMs: LAPSED_AT.getTime(),
    certificationRegistry: [fixture("BROKER", "2026-05-15T00:00:00.000Z")], // recertified
  });
  const out = await dispatchGuidedTicket(
    { userId: 1, ticketId: "t1", marketCategory: "synthetic_index", conditions: [] },
    deps,
  );
  // The sentinel ticket loader returned null → the NEXT wall refused, which
  // proves the certification gate passed and nothing else was weakened.
  assert.equal(out.refusal, "TICKET_AUTHORIZATION_REFUSED");
});

test("BROKER seam floor: TIER_0 dry-run is NOT gated by a lapsed broker cert", async () => {
  const deps = unreachedDeps({
    configuredTier: null, // resolves to TIER_0_DRY_RUN
    certificationNowMs: LAPSED_AT.getTime(),
    certificationRegistry: [fixture("BROKER")],
  });
  const out = await dispatchGuidedTicket(
    { userId: 1, ticketId: "t1", marketCategory: "synthetic_index", conditions: [] },
    deps,
  );
  assert.equal(out.refusal, "TICKET_AUTHORIZATION_REFUSED"); // reached the ticket wall
});
