// Synthetic-live-floor smoke must stay default-deny against production.
//
// scripts/src/syntheticLiveFloorQa.ts LIVE-FIRES the real liveCommandPipeline
// and MUTATES real DB rows (seeds + deletes a throwaway OWNER user, bumps then
// restores the master connection). It is guarded by two independent refusals
// that this CI guard locks in place:
//
//   1. It refuses (console.error "REFUSED" + process.exit(2)) unless
//      QA_ALLOW_DB_MUTATION === "true".
//   2. Against a PRODUCTION-like target it ALSO refuses unless the dedicated
//      QA_ALLOW_PROD_SMOKE === "true" opt-in is set.
//
// A future refactor could silently drop either refusal, letting the DB-mutating
// harness fire against production unintentionally. This guard fails the build if
// either refusal is removed. To avoid the source-scan false-pass trap (regexes
// matching the narration in THIS file's own header comment or the harness's),
// the harness source is comment-stripped before scanning, so only real code
// satisfies the guard.
import { read, rel, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

function readIfExists(p: string): string {
  try { return read(p); } catch { return ""; }
}

// Strip /* */ block comments and // line comments so prose narration about the
// refusals can never satisfy a code-presence assertion.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function checkSyntheticFloorProdDefaultDeny(): CheckResult {
  const violations: string[] = [];
  const harnessPath = join(ROOT, "scripts/src/syntheticLiveFloorQa.ts");
  const raw = readIfExists(harnessPath);
  const relPath = rel(harnessPath);

  if (!raw) {
    return {
      name: "synthetic-floor-prod-default-deny",
      ok: false,
      violations: [`${relPath}: harness file is missing — cannot verify default-deny refusals`],
    };
  }

  const src = stripComments(raw);

  // ── Refusal 1 — DB-mutation opt-in ──────────────────────────────────────
  // The harness must refuse unless QA_ALLOW_DB_MUTATION === "true".
  const dbGate = /QA_ALLOW_DB_MUTATION\s*!==\s*"true"/.test(src);
  if (!dbGate)
    violations.push(`${relPath}: missing the QA_ALLOW_DB_MUTATION !== "true" refusal condition`);

  // ── Refusal 2 — production opt-in (default-deny) ─────────────────────────
  // "production-like" must be detected (NODE_ENV=production OR a .replit.app
  // base URL) and refused unless QA_ALLOW_PROD_SMOKE === "true".
  const looksProdNodeEnv = /NODE_ENV\s*===\s*"production"/.test(src);
  if (!looksProdNodeEnv)
    violations.push(`${relPath}: production-like detection no longer checks NODE_ENV === "production"`);

  const looksProdDomain = /\\?\.replit\\?\.app/.test(src);
  if (!looksProdDomain)
    violations.push(`${relPath}: production-like detection no longer matches a .replit.app base URL`);

  const prodOptIn = /QA_ALLOW_PROD_SMOKE\s*===\s*"true"/.test(src);
  if (!prodOptIn)
    violations.push(`${relPath}: missing the QA_ALLOW_PROD_SMOKE === "true" opt-in read`);

  const prodRefusalCond = /looksProd\s*&&\s*!\s*allowProdSmoke/.test(src);
  if (!prodRefusalCond)
    violations.push(`${relPath}: missing the (looksProd && !allowProdSmoke) production refusal condition`);

  // ── Both refusals must hard-exit with code 2 and announce REFUSED ────────
  // Two distinct refusal branches → at least two process.exit(2) calls and two
  // "REFUSED" announcements in real (comment-stripped) code.
  const exit2Count = (src.match(/process\.exit\(\s*2\s*\)/g) ?? []).length;
  if (exit2Count < 2)
    violations.push(`${relPath}: expected at least 2 process.exit(2) refusals, found ${exit2Count}`);

  const refusedCount = (src.match(/REFUSED/g) ?? []).length;
  if (refusedCount < 2)
    violations.push(`${relPath}: expected at least 2 "REFUSED" refusal announcements, found ${refusedCount}`);

  return {
    name: "synthetic-floor-prod-default-deny",
    ok: violations.length === 0,
    violations,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkSyntheticFloorProdDefaultDeny();
  // eslint-disable-next-line no-console
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}`);
  for (const v of r.violations) {
    // eslint-disable-next-line no-console
    console.log(`  - ${v}`);
  }
  process.exit(r.ok ? 0 : 1);
}
