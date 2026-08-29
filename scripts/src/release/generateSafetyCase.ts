// generateSafetyCase.ts — per-release safety-case generator (#55).
//
// Usage:
//   pnpm --filter @workspace/scripts run release:safety-case -- --release v1.2.3 [--base <ref>]
//
// Computes the change scope from git (HEAD hash, base hash, name-status diff,
// commit subjects) and writes docs/releases/<release>.safety-case.md. The
// human-owned sections (new failure modes, replay/shadow evidence, rollback,
// approvals) are emitted as TBD_REQUIRED placeholders that the CI guard
// (check-release-safety-case.ts) REFUSES on a release-tagged build — the
// generator gets you an honest scope, never a rubber stamp.
//
// Refuses to overwrite an existing safety case: a written case for a release
// id is part of that release's record. Delete it deliberately to regenerate.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderSafetyCaseSkeleton } from "./safetyCase.js";
import { ROOT } from "../ci/_lib.js";

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1] ?? null;
}

const release = argValue("--release");
if (!release || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(release)) {
  console.error(
    "usage: release:safety-case -- --release <id> [--base <ref>]\n" +
      "release id must be filesystem-safe (e.g. v1.2.3, release-2026-09-01)",
  );
  process.exit(2);
}

const outDir = join(ROOT, "docs/releases");
const outPath = join(outDir, `${release}.safety-case.md`);
if (existsSync(outPath)) {
  console.error(
    `${outPath} already exists — a written safety case is part of the release record. ` +
      "Delete it deliberately if you truly mean to regenerate.",
  );
  process.exit(1);
}

let headCommit: string;
try {
  headCommit = git("rev-parse", "HEAD");
} catch (e) {
  console.error(`cannot resolve HEAD (not a git worktree?): ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

// Base: explicit --base, else the most recent reachable tag, else the root
// commit (first release: the scope is honestly "everything").
let baseRef = argValue("--base");
if (!baseRef) {
  try {
    baseRef = git("describe", "--tags", "--abbrev=0", "HEAD^");
  } catch {
    baseRef = null;
  }
}
let baseCommit: string;
try {
  baseCommit = baseRef
    ? git("rev-parse", `${baseRef}^{commit}`)
    : git("rev-list", "--max-parents=0", "HEAD").split("\n")[0]!;
} catch (e) {
  console.error(`cannot resolve base ref ${JSON.stringify(baseRef)}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const changedFiles = (baseCommit === headCommit
  ? ""
  : git("diff", "--name-status", `${baseCommit}..${headCommit}`))
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0)
  .map((l) => {
    const [status, ...rest] = l.split(/\t/);
    return { status: status ?? "?", path: rest[rest.length - 1] ?? "" };
  })
  .filter((f) => f.path.length > 0);

const commitSubjects = (baseCommit === headCommit
  ? ""
  : git("log", "--format=%h %s", `${baseCommit}..${headCommit}`))
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0);

const doc = renderSafetyCaseSkeleton({
  release,
  headCommit,
  baseCommit,
  generatedAtIso: new Date().toISOString(),
  changedFiles,
  commitSubjects,
});

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, doc, "utf8");
console.log(
  `wrote ${outPath}\n` +
    `  head ${headCommit.slice(0, 12)}, base ${baseCommit.slice(0, 12)}, ` +
    `${changedFiles.length} files, ${commitSubjects.length} commits\n` +
    "Now fill in every TBD_REQUIRED section — the release guard refuses the document until you do.",
);
