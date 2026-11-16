// CI guard — per-user-isolation-me-routes
//
// Verifies every Express route file that declares ANY `/me/*` route
// enforces per-user auth on every `/me/*` handler AND never trusts a
// client-supplied userId for read filters.
//
// Discovery is route-prefix based (NOT filename based) so /me/* routes
// declared in files like tradingSessions.ts, pendingOrderDraft.ts,
// auth.ts, or health.ts are also covered. Only the /me/* handlers in
// those files are evaluated — non-/me routes are ignored.
//
// Rules per /me/* handler:
//   R1. The handler MUST be auth-gated by ONE OF:
//         (a) `requireUser` listed in the handler args, OR
//         (b) inline pattern within the first ~16 lines of the handler
//             body: a `userId = ... authUser?.id ?? 0` read (or a call
//             to a file-level `uid(req)` helper that resolves the same)
//             followed by `if (!userId)` returning 401.
//   R2. The file MUST NOT use client-supplied `userId` from body/params/
//       query for *anything*. Covers dot, optional-chain, bracket and
//       destructuring patterns. The authenticated userId is the only
//       source of identity.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult } from "./_lib.js";

const ROUTES_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "artifacts",
  "api-server",
  "src",
  "routes",
);

// Any route declaration whose path starts with /me, with or without a
// trailing slash/segment. Examples:
//   router.get("/me", ...)
//   router.get("/me/", ...)
//   router.post("/me/live/commands/:id/dispatch", ...)
const ME_ROUTE_LINE = /^\s*router\.(get|post|put|patch|delete)\(\s*["'`]\/me(\/|["'`])/;

function listFilesWithMeRoutes(): string[] {
  const files: string[] = [];
  for (const f of readdirSync(ROUTES_DIR)) {
    if (!f.endsWith(".ts")) continue;
    const full = join(ROUTES_DIR, f);
    const raw = readFileSync(full, "utf-8");
    if (raw.split("\n").some((ln) => ME_ROUTE_LINE.test(ln))) {
      files.push(full);
    }
  }
  return files;
}

function findHandlerBlocks(lines: string[]): Array<{ start: number; head: string; isMe: boolean }> {
  const blocks: Array<{ start: number; head: string; isMe: boolean }> = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    if (/^\s*router\.(get|post|put|patch|delete)\(/.test(ln)) {
      blocks.push({ start: i, head: ln, isMe: ME_ROUTE_LINE.test(ln) });
    }
  }
  return blocks;
}

// Names of helper functions that are PROVEN to resolve to
// `authUser?.id ?? 0`. We require the helper declaration AND its body to
// contain `authUser?.id ?? 0`; a bare mention elsewhere in the file is
// not enough. This prevents R1 from passing on a future regression where
// someone declares `const uid = (req) => req.body.userId` and a stray
// comment elsewhere contains `authUser?.id ?? 0`.
function fileHelperNames(raw: string): Set<string> {
  const out = new Set<string>();
  // Pattern: `const <name> = ( ... ) ... authUser?.id ?? 0 ... ;` within
  // the same declaration. We allow a body span of up to 400 chars so a
  // multi-line arrow with type annotations and the safe cast still matches.
  const arrowRe = /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\([^)]*\)[\s\S]{0,400}?\bauthUser\??\.id\s*\?\?\s*0/g;
  // Pattern: `function <name>(...) { ... authUser?.id ?? 0 ... }`.
  // Body may contain `}` (e.g., from type-cast `req as Request & { … }`),
  // so use a non-greedy any-char window of up to 400 chars.
  const fnRe = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)[\s\S]{0,80}?\{[\s\S]{0,400}?\bauthUser\??\.id\s*\?\?\s*0/g;
  let m: RegExpExecArray | null;
  while ((m = arrowRe.exec(raw)) !== null) out.add(m[1]!);
  while ((m = fnRe.exec(raw)) !== null) out.add(m[1]!);
  return out;
}

function handlerIsAuthGated(lines: string[], startIdx: number, verifiedHelpers: Set<string>): boolean {
  const headRegion = lines.slice(startIdx, Math.min(startIdx + 6, lines.length)).join("\n");
  if (/\brequireUser\b/.test(headRegion)) return true;
  const bodyRegion = lines.slice(startIdx, Math.min(startIdx + 16, lines.length)).join("\n");
  // Pattern A: inline `userId = ... authUser?.id ?? 0`.
  const hasUidReadInline = /\bconst\s+userId\s*=[^;]*authUser\??\.id\s*\?\?\s*0/.test(bodyRegion);
  // Pattern B: handler calls a *verified* helper — the helper's body
  // must itself contain `authUser?.id ?? 0`. We extract the call name
  // and check membership in verifiedHelpers.
  let hasUidViaHelper = false;
  const callMatch = bodyRegion.match(/\bconst\s+userId\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*req\s*\)/);
  if (callMatch && verifiedHelpers.has(callMatch[1]!)) hasUidViaHelper = true;
  const hasGuard = /if\s*\(\s*!\s*userId\s*\)/.test(bodyRegion) && /401/.test(bodyRegion);
  return (hasUidReadInline || hasUidViaHelper) && hasGuard;
}

export function checkPerUserIsolationMeRoutes(): CheckResult {
  const violations: string[] = [];
  const files = listFilesWithMeRoutes();
  let meHandlerCount = 0;

  for (const filePath of files) {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n");
    const fileShort = filePath.split("/").slice(-1)[0]!;

    // R2 — client-supplied userId forbidden anywhere in the file.
    // Covers dot, optional-chain, bracket-access, destructuring.
    const R2_PATTERNS: RegExp[] = [
      /req\.body\??\.userId\b/,
      /req\.params\??\.userId\b/,
      /req\.query\??\.userId\b/,
      /req\.(body|params|query)\s*\[\s*["']userId["']\s*\]/,
      /\{\s*[^}]*\buserId\b[^}]*\}\s*=\s*req\.(body|params|query)\b/,
    ];
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
      for (const re of R2_PATTERNS) {
        if (re.test(line)) {
          violations.push(`${fileShort}:${idx + 1} [R2-client-supplied-userId] ${trimmed.slice(0, 100)}`);
          break;
        }
      }
    });

    // R1 — every /me/* handler block must be auth-gated. Non-/me handlers
    // in the same file (e.g. /healthz) are out of scope for this guard.
    const verifiedHelpers = fileHelperNames(raw);
    const blocks = findHandlerBlocks(lines);
    for (const b of blocks) {
      if (!b.isMe) continue;
      meHandlerCount++;
      if (!handlerIsAuthGated(lines, b.start, verifiedHelpers)) {
        violations.push(`${fileShort}:${b.start + 1} [R1-handler-not-auth-gated] ${b.head.trim().slice(0, 100)}`);
      }
    }
  }

  return {
    name: "per-user-isolation-me-routes",
    ok: violations.length === 0,
    violations,
    notes: [
      `scanned ${files.length} route file(s) containing /me/* routes; ${meHandlerCount} /me/* handlers evaluated`,
    ],
  };
}
