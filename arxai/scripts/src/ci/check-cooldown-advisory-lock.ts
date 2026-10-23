// Rate-limiter race guard — the per-(action, scope) advisory lock must stay.
//
// artifacts/api-server/src/lib/security/cooldowns.ts is a safety-critical shared
// primitive used by LOGIN, ADMIN_ACTION, RUBY_*, and MANUAL_SCAN. Its
// consumeRateLimit() serializes concurrent attempts on the SAME (action, scope)
// by taking a Postgres advisory lock (pg_advisory_xact_lock) keyed by
// hashtext("<action>:<scope>") at the TOP of its transaction — BEFORE the SELECT
// that reads the prior window. Without that lock two simultaneous FIRST hits can
// both read "no row", both evaluate allowed:true, and both pass before either
// upsert lands (the unique index only prevents a duplicate ROW, not a duplicate
// ALLOW decision read from a not-yet-written window).
//
// A future refactor of cooldowns.ts could silently drop the lock and reintroduce
// the race. The runtime concurrency test (cooldownConcurrentFirstHit.test.ts)
// catches it only if someone runs it against a live DB. This source-scan guard
// fails the build the instant the serialization is removed, no DB required —
// mirroring the synthetic-floor default-deny guard pattern.
//
// To avoid the source-scan false-pass trap (a regex matching the narration in
// THIS file's header or in cooldowns.ts's own explanatory comments), the target
// source is comment-stripped before scanning, so only real code satisfies the
// guard.
import { read, rel, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

function readIfExists(p: string): string {
  try {
    return read(p);
  } catch {
    return "";
  }
}

// Strip /* */ block comments and // line comments so prose narration about the
// advisory lock can never satisfy a code-presence assertion.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function checkCooldownAdvisoryLock(): CheckResult {
  const name = "cooldown-advisory-lock";
  const violations: string[] = [];
  const targetPath = join(ROOT, "artifacts/api-server/src/lib/security/cooldowns.ts");
  const raw = readIfExists(targetPath);
  const relPath = rel(targetPath);

  if (!raw) {
    return {
      name,
      ok: false,
      violations: [`${relPath}: file is missing — cannot verify the rate-limiter advisory lock`],
    };
  }

  const src = stripComments(raw);

  // Isolate consumeRateLimit's body so the assertions can't be satisfied by some
  // OTHER function that happens to use an advisory lock. Scan from the function
  // declaration to the next top-level `export ` (isCooldownActive).
  const fnStart = src.search(/export\s+async\s+function\s+consumeRateLimit\b/);
  if (fnStart < 0) {
    return {
      name,
      ok: false,
      violations: [`${relPath}: consumeRateLimit() is no longer an exported async function — cannot verify the advisory lock`],
    };
  }
  const after = src.slice(fnStart + 1);
  const nextExport = after.search(/\nexport\s/);
  const fnBody = nextExport < 0 ? src.slice(fnStart) : src.slice(fnStart, fnStart + 1 + nextExport);

  // 1) The advisory lock must be a TRANSACTION-scoped lock (released on
  //    commit/rollback). A session-scoped pg_advisory_lock would leak across
  //    pooled connections and is the wrong primitive here.
  const advisoryLock = /pg_advisory_xact_lock\s*\(/.test(fnBody);
  if (!advisoryLock) {
    violations.push(
      `${relPath}: consumeRateLimit() no longer takes a pg_advisory_xact_lock — the rate-limiter concurrency race is reintroduced`,
    );
  }

  // 2) The lock key must be derived from BOTH the action AND the scope, so one
  //    actor never throttles another and two hits on the SAME (action, scope)
  //    serialize. Look for hashtext(...) over an `${action}:${scopeKey}`
  //    template (the only safe composite key shape).
  const keyedByActionAndScope =
    /hashtext\s*\(\s*`\$\{action\}:\$\{scopeKey\}`\s*\)/.test(fnBody) ||
    // tolerate minor formatting / interpolation-order changes while still
    // requiring BOTH action and scopeKey inside the same hashtext(...) call.
    /hashtext\s*\([^)]*\baction\b[^)]*\bscopeKey\b[^)]*\)/.test(fnBody);
  if (advisoryLock && !keyedByActionAndScope) {
    violations.push(
      `${relPath}: the advisory lock key is no longer derived from BOTH action and scopeKey (must be hashtext(\`\${action}:\${scopeKey}\`)) — different scopes could collide or one actor could throttle another`,
    );
  }

  // 3) The lock must be taken INSIDE the transaction (on tx, not the pooled db)
  //    so it is bound to that transaction's lifetime.
  const lockOnTx = /tx\s*\.\s*execute\s*\(\s*sql`[^`]*pg_advisory_xact_lock/.test(fnBody);
  if (advisoryLock && !lockOnTx) {
    violations.push(
      `${relPath}: the pg_advisory_xact_lock is no longer executed on the transaction (tx.execute) — a session-scoped or out-of-transaction lock would not serialize the read+upsert atomically`,
    );
  }

  // 4) The lock must be acquired BEFORE the SELECT that reads the prior window;
  //    locking after the read defeats the purpose (both hits already read).
  const lockIdx = fnBody.search(/pg_advisory_xact_lock/);
  const selectIdx = fnBody.search(/\.\s*from\s*\(\s*securityCooldownsTable\s*\)/);
  if (advisoryLock && lockIdx >= 0 && selectIdx >= 0 && lockIdx > selectIdx) {
    violations.push(
      `${relPath}: the advisory lock is taken AFTER the securityCooldownsTable SELECT — it must be acquired BEFORE the read so concurrent first hits serialize`,
    );
  }

  return { name, ok: violations.length === 0, violations };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkCooldownAdvisoryLock();
  // eslint-disable-next-line no-console
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}`);
  for (const v of r.violations) {
    // eslint-disable-next-line no-console
    console.log(`  - ${v}`);
  }
  process.exit(r.ok ? 0 : 1);
}
