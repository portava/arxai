import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join, sep } from "node:path";

const SERVER_ROOTS = [
  join(ROOT, "artifacts/api-server/src"),
  join(ROOT, "lib"),
];

// User-facing frontend files that must NEVER send a spoofed `x-security-role`
// header. The header is dead, misleading code on a user-facing page: it is
// rejected in production and superseded by the real session cookie whenever a
// user is logged in. The deliberate admin/tester pages
// (`testing-control-center`, `admin-diagnostics`, `autopilot-control-center`,
// etc.) rely on the dev header fallback BY DESIGN and are intentionally NOT
// scanned here. Add more user-facing files as they are hardened.
const FRONTEND_SCANNED_FILES = [
  "artifacts/trading-dashboard/src/pages/market-scanner.tsx",
  "artifacts/trading-dashboard/src/pages/live-ai-auto-test.tsx",
].map((p) => p.split("/").join(sep));

const ALLOWED_FILES = new Set(
  [
    "artifacts/api-server/src/lib/security/session.ts",
    "artifacts/api-server/src/lib/security/middleware.ts",
    "artifacts/api-server/src/routes/adminTrading.ts",
    "scripts/src/ci/check-security-role-header.ts",
  ].map((p) => p.split("/").join(sep)),
);

const ALLOWLIST_SUBSTR = [
  `${sep}tests${sep}`,
  `${sep}__tests__${sep}`,
  `${sep}seed${sep}`,
  ".test.ts",
  ".spec.ts",
];

const PATTERN =
  /(req\.header\s*\(\s*["'`]x-security-role["'`]\s*\)|req\.headers\s*\[\s*["'`]x-security-role["'`]\s*\]|["'`]x-security-role["'`])/i;

function scanFile(f: string, violations: string[]): void {
  const relPath = rel(f);
  const src = read(f);
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    if (PATTERN.test(line)) {
      violations.push(`${relPath}:${i + 1} → ${trimmed.slice(0, 120)}`);
    }
  });
}

export function checkSecurityRoleHeader(): CheckResult {
  const violations: string[] = [];
  for (const root of SERVER_ROOTS) {
    const files = walk(root);
    for (const f of files) {
      if (!f.endsWith(".ts") && !f.endsWith(".tsx") && !f.endsWith(".mts")) continue;
      if (ALLOWLIST_SUBSTR.some((s) => f.includes(s))) continue;
      const relPath = rel(f);
      if (ALLOWED_FILES.has(relPath)) continue;
      scanFile(f, violations);
    }
  }
  // User-facing frontend files: explicit allowlist of files that must stay
  // free of the spoofed header (the deliberate admin/tester pages are NOT in
  // this list and are intentionally left alone).
  for (const f of FRONTEND_SCANNED_FILES) {
    scanFile(join(ROOT, f), violations);
  }
  return {
    name: "security-role-header-allowlist",
    ok: violations.length === 0,
    violations,
    notes: [
      "Direct reads of the `x-security-role` header are forbidden outside the approved files.",
      "Approved (allowlisted) authority sources:",
      "  - artifacts/api-server/src/lib/security/session.ts (single auditable control point)",
      "  - artifacts/api-server/src/lib/security/middleware.ts (server-derived resolver)",
      "  - artifacts/api-server/src/routes/adminTrading.ts (header-hint-must-match-session pattern)",
      "All other server code MUST resolve role via `readRoleFromRequest(req)` from",
      "`lib/security/middleware.ts`. Never trust client-supplied role headers.",
      "User-facing frontend scanned (must NOT send a spoofed header):",
      "  - artifacts/trading-dashboard/src/pages/market-scanner.tsx",
      "  - artifacts/trading-dashboard/src/pages/live-ai-auto-test.tsx",
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkSecurityRoleHeader();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
