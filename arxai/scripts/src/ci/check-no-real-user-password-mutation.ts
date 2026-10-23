// Guard: no test, seed, QA, or ad-hoc script may mutate password_hash on
// a real (non-isolated) user, and no known smoke-test password may be
// hard-coded into the repo.
//
// What this catches:
//   1. `UPDATE users SET password_hash` / `usersTable.set({ passwordHash`
//      inside scripts/src/**, artifacts/api-server/src/seed/**, tests/**.
//      The ONE legitimate exception is the owner-reset CLI, which is
//      marked with a one-of-a-kind sentinel string.
//   2. `password_hash` writes targeting a literal user id of a known
//      real account (e.g. id=4 is the OWNER).
//   3. Any file containing the known banned smoke-test password
//      literals (e.g. "SmokeTest!2026"), which would mean someone
//      re-hard-coded the same throwaway password we burned previously.
//   4. `DELETE FROM auth_user_sessions WHERE user_id = 4` (or any
//      hard-coded real-owner session purge) outside the owner-reset
//      tool — clearing real owner sessions should never be an
//      automated test side effect.
//
// What this does NOT catch (intentional):
//   * Creating brand-new isolated test users (random emails, random
//     ids) and setting their password_hash. That is correct and safe.
//   * Production routes /auth/register and /auth/login, which create
//     and verify hashes through the proper code paths.

import { join } from "node:path";
import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";

const SCAN_ROOTS = [
  join(ROOT, "scripts/src"),
  join(ROOT, "artifacts/api-server/src/seed"),
  join(ROOT, "artifacts/api-server/src/scripts"),
  join(ROOT, "artifacts/api-server/src/tests"),
  join(ROOT, "artifacts/api-server/tests"),
  join(ROOT, "artifacts/trading-dashboard/src/tests"),
  join(ROOT, "lib/db/src/seed"),
];

// Cover non-TS script formats that could carry the same risk
// (raw JS, MJS, CJS, SQL fixtures, shell harnesses).
const SCAN_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".sql", ".sh"];

// Only the owner-reset tool (and this guard, which quotes the sentinel
// as a string literal) may carry this sentinel. Everything else that
// does is a CI failure.
const OWNER_TOOL_SENTINEL = "ARX-OWNER-PASSWORD-RESET-TOOL-SENTINEL-DO-NOT-COPY";
const OWNER_TOOL_FILE = "scripts/src/ownerSetPassword.ts";

// Real account ids that must never appear in a test/seed/script
// password mutation. Keep this list narrow — only accounts we know are
// real humans or production fixtures, not auto-created test rows.
const REAL_USER_IDS = new Set<number>([4]); // user 4 = OWNER andraie

// Passwords that have ever been used as throwaway smoke-test values
// and must never be re-introduced into tracked source.
const BANNED_PASSWORD_LITERALS = [
  "SmokeTest!2026",
];

const PW_MUTATION_PATTERNS: RegExp[] = [
  // Raw SQL forms
  /\bUPDATE\s+users\s+set\s+password_hash\b/i,
  /\bupdate\s+users\s+set\s+password_hash\b/i,
  // Drizzle forms
  /\busersTable\b[\s\S]{0,200}?\.set\s*\(\s*\{[\s\S]{0,400}?\bpasswordHash\s*:/,
  /\bset\s*\(\s*\{\s*passwordHash\s*:/,
];

const REAL_OWNER_SESSION_PURGE_PATTERNS: RegExp[] = [
  /\bDELETE\s+FROM\s+auth_user_sessions\s+WHERE\s+user_id\s*=\s*4\b/i,
  /\bauthUserSessionsTable\b[\s\S]{0,200}?\.where\s*\([\s\S]{0,200}?userId[\s\S]{0,40}?,\s*4\s*\)/,
];

function fileIsOwnerResetTool(absPath: string): boolean {
  return rel(absPath).replace(/\\/g, "/").endsWith(OWNER_TOOL_FILE);
}

function fileIsThisGuard(absPath: string): boolean {
  return rel(absPath).replace(/\\/g, "/").endsWith("scripts/src/ci/check-no-real-user-password-mutation.ts");
}

export function checkNoRealUserPasswordMutation(): CheckResult {
  const violations: string[] = [];
  for (const root of SCAN_ROOTS) {
    const files = walk(root, { exts: SCAN_EXTS });
    for (const f of files) {
      const src = read(f);
      const here = rel(f);

      // 1) Sentinel misuse — only the owner-reset tool may carry it.
      if (src.includes(OWNER_TOOL_SENTINEL) && !fileIsOwnerResetTool(f) && !fileIsThisGuard(f)) {
        violations.push(`${here} → contains owner-reset sentinel string. Only ${OWNER_TOOL_FILE} may.`);
      }

      // 2) Banned smoke-test password literals anywhere outside this
      //    guard and the owner-reset tool (which legitimately needs the
      //    literals in its BANNED_PASSWORDS reject-set).
      if (!fileIsThisGuard(f) && !fileIsOwnerResetTool(f)) {
        for (const banned of BANNED_PASSWORD_LITERALS) {
          if (src.includes(banned)) {
            violations.push(`${here} → contains banned smoke-test password literal "${banned}".`);
          }
        }
      }

      // 3) Password-hash mutations outside the owner-reset tool.
      if (!fileIsOwnerResetTool(f) && !fileIsThisGuard(f)) {
        const lines = src.split("\n");
        // Cheap multi-line match: re-test on the full src for the regex,
        // but report the first line index that mentions passwordHash for
        // helpful output.
        for (const pat of PW_MUTATION_PATTERNS) {
          if (pat.test(src)) {
            const idx = lines.findIndex((l) => /password_?[hH]ash/.test(l));
            const lineNo = idx >= 0 ? idx + 1 : 1;
            violations.push(`${here}:${lineNo} → password_hash mutation outside ${OWNER_TOOL_FILE}.`);
            break;
          }
        }
      }

      // 4) Real-owner session purges outside the owner-reset tool.
      if (!fileIsOwnerResetTool(f) && !fileIsThisGuard(f)) {
        for (const pat of REAL_OWNER_SESSION_PURGE_PATTERNS) {
          if (pat.test(src)) {
            violations.push(`${here} → purges auth_user_sessions for real user id 4 outside ${OWNER_TOOL_FILE}.`);
            break;
          }
        }
      }

      // 5) Hard-coded real user ids in proximity to passwordHash.
      if (!fileIsOwnerResetTool(f) && !fileIsThisGuard(f)) {
        if (/password_?[hH]ash/.test(src)) {
          for (const id of REAL_USER_IDS) {
            const idRe = new RegExp(`\\b(?:user[_-]?id|userId)\\s*[=:,]?\\s*${id}\\b`);
            if (idRe.test(src)) {
              violations.push(`${here} → references real user id ${id} alongside password_hash.`);
              break;
            }
          }
        }
      }
    }
  }

  return {
    name: "no-real-user-password-mutation",
    ok: violations.length === 0,
    violations,
    notes: [
      `Tests/seeds/scripts must create isolated test-only users (random email + random id) for password work.`,
      `The ONLY legitimate password-mutation tool is ${OWNER_TOOL_FILE}.`,
      `Banned smoke-test password literals: ${BANNED_PASSWORD_LITERALS.join(", ")}.`,
      `Real user ids guarded against: ${[...REAL_USER_IDS].join(", ")}.`,
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkNoRealUserPasswordMutation();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
