// #55 Per-release safety case — pure validator + guard tests (OFFLINE).
//
// Locks:
//   * SKELETON HONESTY: the generator's skeleton carries the real computed
//     scope AND a TBD_REQUIRED placeholder in every human-owned section — and
//     the validator REFUSES that skeleton until every placeholder is replaced
//     (a generated-but-unfilled safety case is not a safety case).
//   * VALIDATION: missing header fields, missing sections, a wrong release
//     id, and a safety case written for a DIFFERENT commit all refuse.
//   * RELEASE DETECTION is explicit: ARX_RELEASE_TAG, or a v*/release-* tag
//     at HEAD; a development build passes with a note and no paperwork; a
//     release build with no document refuses.
//   * Change-scope grouping is deterministic.
//
// Run: pnpm --filter @workspace/scripts run test:release-safety-case

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PLACEHOLDER,
  REQUIRED_SECTIONS,
  analyzeSafetyCase,
  groupChangeScope,
  parseSafetyCaseHeader,
  renderSafetyCaseSkeleton,
  type SafetyCaseScope,
} from "../release/safetyCase.js";
import {
  analyzeReleaseSafetyCase,
  resolveReleaseContext,
} from "../ci/check-release-safety-case.js";

const HEAD = "aabbccddeeff00112233445566778899aabbccdd";
const BASE = "1122334455667788990011223344556677889900";

function scope(): SafetyCaseScope {
  return {
    release: "v9.9.9",
    headCommit: HEAD,
    baseCommit: BASE,
    generatedAtIso: "2026-08-29T00:00:00.000Z",
    changedFiles: [
      { status: "M", path: "artifacts/api-server/src/index.ts" },
      { status: "A", path: "artifacts/api-server/src/lib/x.ts" },
      { status: "M", path: "lib/domain/src/y.ts" },
      { status: "M", path: "package.json" },
    ],
    commitSubjects: ["abc123 fix: a thing", "def456 feat: another"],
  };
}

function completedDoc(): string {
  let doc = renderSafetyCaseSkeleton(scope());
  // Fill every human-owned section the way a releasing engineer would.
  while (doc.includes(PLACEHOLDER)) {
    doc = doc.replace(PLACEHOLDER, "none declared — reviewed on 2026-08-29");
  }
  return doc;
}

test("skeleton carries the computed scope and a placeholder per human section", () => {
  const doc = renderSafetyCaseSkeleton(scope());
  assert.ok(doc.includes(`Release: v9.9.9`));
  assert.ok(doc.includes(`Head-Commit: ${HEAD}`));
  assert.ok(doc.includes(`Base-Commit: ${BASE}`));
  assert.ok(doc.includes("artifacts/api-server: 2 files"));
  assert.ok(doc.includes("abc123 fix: a thing"));
  for (const s of REQUIRED_SECTIONS) assert.ok(doc.includes(s), `skeleton must carry ${s}`);
  assert.equal(doc.split(PLACEHOLDER).length - 1, 4, "one placeholder per human-owned section");
});

test("the unfilled skeleton REFUSES validation — generation is not completion", () => {
  const v = analyzeSafetyCase(renderSafetyCaseSkeleton(scope()), { release: "v9.9.9", headCommit: HEAD });
  assert.ok(v.some((x) => x.includes(PLACEHOLDER)));
});

test("a completed document validates clean", () => {
  const v = analyzeSafetyCase(completedDoc(), { release: "v9.9.9", headCommit: HEAD });
  assert.deepEqual(v, []);
});

test("header parsing round-trips", () => {
  const h = parseSafetyCaseHeader(completedDoc());
  assert.equal(h.release, "v9.9.9");
  assert.equal(h.headCommit, HEAD);
  assert.equal(h.baseCommit, BASE);
  assert.ok(h.generatedAt);
});

test("missing header fields and sections refuse", () => {
  const v = analyzeSafetyCase("# empty\n", { release: "v9.9.9" });
  assert.equal(v.length, 4 + REQUIRED_SECTIONS.length);
  assert.ok(v.some((x) => x.includes('"Release:"')));
  assert.ok(v.some((x) => x.includes('"## Rollback"')));
});

test("a safety case for a different commit refuses", () => {
  const other = "9".repeat(40);
  const v = analyzeSafetyCase(completedDoc(), { release: "v9.9.9", headCommit: other });
  assert.ok(v.some((x) => x.includes("does not match the tagged build commit")));
});

test("a safety case for a different release id refuses", () => {
  const v = analyzeSafetyCase(completedDoc(), { release: "v1.0.0", headCommit: HEAD });
  assert.ok(v.some((x) => x.includes("does not match the release being built")));
});

test("abbreviated Head-Commit matching the full hash is accepted", () => {
  const doc = completedDoc().replace(`Head-Commit: ${HEAD}`, `Head-Commit: ${HEAD.slice(0, 12)}`);
  const v = analyzeSafetyCase(doc, { release: "v9.9.9", headCommit: HEAD });
  assert.deepEqual(v, []);
});

test("change-scope grouping is by top-level area", () => {
  const g = groupChangeScope(scope().changedFiles);
  assert.equal(g.get("artifacts/api-server"), 2);
  assert.equal(g.get("lib/domain"), 1);
  assert.equal(g.get("package.json"), 1);
});

// ── Release detection + the guard's decision ────────────────────────────────

test("ARX_RELEASE_TAG declares a release build without git", () => {
  const ctx = resolveReleaseContext({ ARX_RELEASE_TAG: "v2.0.0" }, () => null);
  assert.equal(ctx.releaseId, "v2.0.0");
});

test("a v-tag at HEAD declares a release build; other tags do not", () => {
  const git = (args: string[]) =>
    args[0] === "tag" ? "v1.2.3\nsome-other-tag" : HEAD;
  assert.equal(resolveReleaseContext({}, git).releaseId, "v1.2.3");

  const gitNoRelease = (args: string[]) => (args[0] === "tag" ? "checkpoint-foo" : HEAD);
  assert.equal(resolveReleaseContext({}, gitNoRelease).releaseId, null);
});

test("no git and no env resolves to a development build (note, not violation)", () => {
  const ctx = resolveReleaseContext({}, () => null);
  assert.equal(ctx.releaseId, null);
  const out = analyzeReleaseSafetyCase(ctx, () => null);
  assert.deepEqual(out.violations, []);
});

test("a release build with no safety case REFUSES", () => {
  const ctx = { releaseId: "v3.0.0", headCommit: HEAD, notes: [] };
  const out = analyzeReleaseSafetyCase(ctx, () => null);
  assert.equal(out.violations.length, 1);
  assert.ok(out.violations[0]!.includes("has no safety case"));
});

test("a release build with a completed matching safety case passes", () => {
  const ctx = { releaseId: "v9.9.9", headCommit: HEAD, notes: [] };
  const out = analyzeReleaseSafetyCase(ctx, (p) =>
    p === "docs/releases/v9.9.9.safety-case.md" ? completedDoc() : null,
  );
  assert.deepEqual(out.violations, []);
});

test("a release build with an UNFILLED safety case refuses", () => {
  const ctx = { releaseId: "v9.9.9", headCommit: HEAD, notes: [] };
  const out = analyzeReleaseSafetyCase(ctx, () => renderSafetyCaseSkeleton(scope()));
  assert.ok(out.violations.some((v) => v.includes(PLACEHOLDER)));
});
