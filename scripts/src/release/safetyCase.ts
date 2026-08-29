// Per-release safety case (Blueprint Part II #55) — the pure core.
//
// Safety cases already exist per strategy promotion (edgePromotion's Part IV
// minimum-evidence package) and per execution-tier authority (the Tier 0
// product certificate) — but nothing packaged a SOFTWARE RELEASE: what
// changed, what new failure modes the change introduces, what replay/shadow
// evidence backs it, how it rolls back, and who approved it. This module
// defines that document as a machine-verifiable artifact:
//
//   docs/releases/<release-id>.safety-case.md
//
// with a pinned header block and required sections. The generator
// (generateSafetyCase.ts) computes the change scope from git and emits a
// skeleton whose human-owned sections carry the TBD_REQUIRED placeholder; the
// CI guard (check-release-safety-case.ts) refuses a release-tagged build
// whose safety case is missing, still carries a placeholder, or does not
// match the tagged commit. Green CI still never grants live authority
// (Article IV) — the safety case is a floor for RELEASING, not a grant.
//
// Pure: no filesystem, no git, no clock. Callers inject everything, so every
// drift shape is testable offline.

/** The placeholder the generator writes into human-owned sections. Its
 *  PRESENCE anywhere in the document refuses the release: an unfilled safety
 *  case is not a safety case. */
export const PLACEHOLDER = "TBD_REQUIRED";

/** Header fields, `Key: value` lines inside the pinned header block. */
export const REQUIRED_HEADER_FIELDS = [
  "Release",
  "Head-Commit",
  "Base-Commit",
  "Generated-At",
] as const;

/** Section headings every safety case must carry, in order. */
export const REQUIRED_SECTIONS = [
  "## Change scope",
  "## New failure modes declared",
  "## Replay / shadow evidence",
  "## Rollback",
  "## Approvals",
] as const;

const HEX_COMMIT_RE = /^[0-9a-f]{7,40}$/;

export interface SafetyCaseHeader {
  release: string;
  headCommit: string;
  baseCommit: string;
  generatedAt: string;
}

/** Parse the `Key: value` header lines. Returns nulls for missing fields. */
export function parseSafetyCaseHeader(content: string): Partial<SafetyCaseHeader> {
  const out: Partial<SafetyCaseHeader> = {};
  for (const line of content.split(/\r?\n/).slice(0, 40)) {
    const m = /^([A-Za-z-]+):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1]!;
    const value = m[2]!.trim();
    if (key === "Release") out.release = value;
    else if (key === "Head-Commit") out.headCommit = value;
    else if (key === "Base-Commit") out.baseCommit = value;
    else if (key === "Generated-At") out.generatedAt = value;
  }
  return out;
}

/**
 * Validate one safety-case document. `expected` pins what the build context
 * knows: the release id being built and (when available) the HEAD commit the
 * tag points at — a safety case written for a DIFFERENT commit is not
 * evidence about this one.
 */
export function analyzeSafetyCase(
  content: string,
  expected: { release: string; headCommit?: string | null },
): string[] {
  const violations: string[] = [];
  const header = parseSafetyCaseHeader(content);

  for (const field of REQUIRED_HEADER_FIELDS) {
    const key = field === "Release" ? "release"
      : field === "Head-Commit" ? "headCommit"
      : field === "Base-Commit" ? "baseCommit"
      : "generatedAt";
    if (!header[key as keyof SafetyCaseHeader]) {
      violations.push(`missing header field "${field}:" — the safety case must be generated, not hand-improvised`);
    }
  }

  if (header.release && header.release !== expected.release) {
    violations.push(
      `header Release "${header.release}" does not match the release being built ("${expected.release}")`,
    );
  }
  if (header.headCommit && !HEX_COMMIT_RE.test(header.headCommit)) {
    violations.push(`Head-Commit "${header.headCommit}" is not a git commit hash`);
  }
  if (header.baseCommit && !HEX_COMMIT_RE.test(header.baseCommit)) {
    violations.push(`Base-Commit "${header.baseCommit}" is not a git commit hash`);
  }
  if (
    expected.headCommit &&
    header.headCommit &&
    HEX_COMMIT_RE.test(header.headCommit) &&
    !expected.headCommit.startsWith(header.headCommit) &&
    !header.headCommit.startsWith(expected.headCommit)
  ) {
    violations.push(
      `Head-Commit ${header.headCommit} does not match the tagged build commit ${expected.headCommit} — ` +
        `a safety case for a different tree is not evidence about this one; regenerate it at the release commit`,
    );
  }

  for (const section of REQUIRED_SECTIONS) {
    if (!content.split(/\r?\n/).some((l) => l.trim() === section)) {
      violations.push(`missing required section "${section}"`);
    }
  }

  if (content.includes(PLACEHOLDER)) {
    violations.push(
      `document still contains ${PLACEHOLDER} — every human-owned section (failure modes, evidence, rollback, ` +
        `approvals) must be filled in before a release build passes; "none" must be written explicitly, never left blank`,
    );
  }

  return violations;
}

export interface SafetyCaseScope {
  release: string;
  headCommit: string;
  baseCommit: string;
  generatedAtIso: string;
  /** `git diff --name-status base..head`, already split into lines. */
  changedFiles: readonly { status: string; path: string }[];
  /** One-line commit subjects, newest first. */
  commitSubjects: readonly string[];
}

/** Group changed files by top-level area for the scope table. */
export function groupChangeScope(files: readonly { status: string; path: string }[]): Map<string, number> {
  const groups = new Map<string, number>();
  for (const f of files) {
    const parts = f.path.split("/");
    const area = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
    groups.set(area, (groups.get(area) ?? 0) + 1);
  }
  return groups;
}

/** Render the generator's skeleton. Human-owned sections carry PLACEHOLDER. */
export function renderSafetyCaseSkeleton(scope: SafetyCaseScope): string {
  const groups = [...groupChangeScope(scope.changedFiles).entries()].sort((a, b) => b[1] - a[1]);
  const scopeLines =
    groups.length === 0
      ? ["(no files changed between base and head — verify the base ref)"]
      : groups.map(([area, n]) => `- ${area}: ${n} file${n === 1 ? "" : "s"}`);
  const commits =
    scope.commitSubjects.length === 0
      ? ["(no commits between base and head)"]
      : scope.commitSubjects.slice(0, 50).map((s) => `- ${s}`);

  return [
    `# Safety case — ${scope.release}`,
    "",
    `Release: ${scope.release}`,
    `Head-Commit: ${scope.headCommit}`,
    `Base-Commit: ${scope.baseCommit}`,
    `Generated-At: ${scope.generatedAtIso}`,
    "",
    "Machine-verified by scripts/src/ci/check-release-safety-case.ts: a",
    "release-tagged build REFUSES to pass while this document is missing, still",
    "carries an unfilled placeholder, or names a different commit. Filling it",
    "in is part of the release, not paperwork after it.",
    "",
    "## Change scope",
    "",
    `${scope.changedFiles.length} files changed since ${scope.baseCommit.slice(0, 12)}:`,
    "",
    ...scopeLines,
    "",
    "Commits:",
    "",
    ...commits,
    "",
    "## New failure modes declared",
    "",
    `${PLACEHOLDER} — list every NEW way this release can fail that the previous`,
    "release could not (or write \"none declared\" and stand behind it).",
    "",
    "## Replay / shadow evidence",
    "",
    `${PLACEHOLDER} — link the replay/shadow runs backing this release (suite`,
    "names, evidence files under docs/, champion-challenger / baseline windows).",
    "",
    "## Rollback",
    "",
    `${PLACEHOLDER} — the exact rollback: prior tag, unapplied migrations under`,
    "docs/migrations-pending/, flags to flip back. \"Redeploy previous tag\" only",
    "counts when the schema deltas are named additive.",
    "",
    "## Approvals",
    "",
    `${PLACEHOLDER} — who approved this release and when. The owner's press`,
    "stays the owner's press: this section records it, it never replaces it.",
    "",
  ].join("\n");
}
