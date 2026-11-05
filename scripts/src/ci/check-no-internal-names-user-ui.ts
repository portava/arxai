// CI guard — no internal identifiers leak into normal user UI.
//
// SAFETY: Normal users must never see raw camelCase function names,
// internal feature-flag keys, raw `/api/...` routes rendered as text,
// stack traces, or JSON payloads. The brief explicitly allows internal
// identifiers inside an admin/operator/dev-only "Developer details"
// drawer; those surfaces are excluded from this scan via path globs.
//
// What this guard catches (in non-admin frontend source only):
//   1. Raw `/api/...` rendered as <code> body text in user-facing JSX.
//   2. `JSON.stringify(` rendered directly inside JSX (raw payload).
//   3. Specific forbidden internal token strings appearing as string
//      literals in JSX (heuristic: token appears NOT in a `from "..."`
//      import line and NOT as an object property key).
//   4. The assistant's old codename anywhere in the repository (any case,
//      any tracked text file, file paths included). The assistant is
//      Eleanor; the owner asked for the old name to appear nowhere
//      (2026-11-05). Personalised copy still resolves the display name at
//      runtime (frontend `useAssistantName().name`, backend
//      `getAssistantDisplayName()`).
//
// This is intentionally narrow. It is a regression guard, not a
// stylistic enforcer — the goal is to fail loudly when a leak of the
// shape we just sanitized re-appears.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { type CheckResult } from "./_lib.js";

const NAME = "no-internal-names-user-ui";

// User-facing frontend scan root. Admin/operator/system pages are
// excluded below because the brief allows internal identifiers inside
// admin Developer-details drawers.
const SCAN_ROOT = "artifacts/trading-dashboard/src";

// Files (or path fragments) where internal-identifier display is
// explicitly allowed because the surface is admin/operator/dev-only.
// Match by substring against the ripgrep "path:line:..." prefix.
const ADMIN_DEV_EXCLUDE = [
  "/pages/admin",                 // /admin-*.tsx and /admin/*
  "/pages/system-health",
  "/pages/audit-log",
  "/pages/security-center",
  "/pages/admin-security-status",
  "/pages/testing-control-center",
  "/pages/data-import",
  "/pages/data-protection",
  "/pages/broker-readonly",
  "/pages/replay-simulator",
  "/pages/status-command-center",
  "/pages/live-trading-control",
  "/pages/assistant-knowledge-gaps",
  "/pages/admin-diagnostics",
  "/pages/admin-control",
  "/pages/admin-permissions",
  "/components/admin/",
  "/components/live/LiveSharedStatusPanel.tsx",  // operator panel
];

// Pattern set. Each pattern is a ripgrep regex run against the SCAN_ROOT.
// A match is a violation unless the line's path matches an exclude.
type Pattern = { id: string; regex: string; reason: string };

const PATTERNS: Pattern[] = [
  {
    id: "code-tag-api-path",
    // <code ...>/api/foo</code>  → raw route in user copy
    regex: "<code[^>]*>/api/",
    reason: "raw /api/ path rendered as <code> text",
  },
  {
    id: "json-stringify-in-jsx",
    // {JSON.stringify(   → raw payload printed into user UI
    regex: "\\{JSON\\.stringify\\(",
    reason: "JSON.stringify rendered in JSX",
  },
  {
    id: "eleanor-tool-name-literal",
    regex: "(getMyPerformanceSummary|getMarketRead|executeTradeIntent|validateLiveTrade|fetchScannerData)",
    reason: "internal Eleanor tool/function name appears as identifier in non-admin source",
  },
  // T003-6 regression: typed-phrase prompts. Operator-style "type X to
  // enable/dispatch/confirm" wording must never appear in normal-user
  // UI. The phrases themselves can still exist as backend constants in
  // /lib/api/* (sent as confirmationIntent) and in /pages/admin/* (the
  // ADMIN_DEV_EXCLUDE list).
  //
  // NOTE: a `raw-engine-boolean-label` pattern was considered for raw
  // identifiers like `canExecuteRealBrokerOrder: true` rendered as a
  // JSX label, but a regex-only guard cannot tell the difference
  // between a real leak and a line that lives INSIDE an
  // `{mode.shouldShowAdminDiagnostics && (...)}` admin gate (which is
  // the sanctioned placement per T003). That guard belongs in a DOM /
  // E2E test where the runtime gate is observable; we intentionally do
  // not encode it as a static regex here.
  {
    id: "typed-phrase-prompt",
    regex: "[Tt]ype\\s+<[^>]*>(?:EXECUTE LIVE SHARED|QUEUE MICRO LIVE TEST|ENABLE LIVE TRADING)",
    reason: "operator-style typed-phrase prompt rendered to a normal user",
  },
  {
    id: "typed-phrase-prompt-plain",
    regex: "[Tt]ype\\s+(?:EXECUTE LIVE SHARED|QUEUE MICRO LIVE TEST|ENABLE LIVE TRADING)\\s+to",
    reason: "operator-style typed-phrase prompt rendered as plain text to a normal user",
  },
];

function pathFromRgLine(line: string): string {
  const i = line.indexOf(":");
  return i < 0 ? line : line.slice(0, i);
}

function isAdminExcluded(line: string): boolean {
  return ADMIN_DEV_EXCLUDE.some((frag) => line.includes(frag));
}

// Lines we treat as benign even in user-facing files — typically code
// that *defines* the friendly mapper itself or developer comments.
function isBenign(line: string): boolean {
  const path = pathFromRgLine(line);
  // Tests, specs and benchmarks are not rendered to users.
  if (isTestFile(path) || /\.benchmark\.[cm]?tsx?$/.test(path)) return true;
  // The bug-report dialog deliberately shows the user the redacted context
  // it is about to send ("Review"), so they can check it before submitting.
  if (path.endsWith("/components/help/FloatingHelpWidget.tsx") && line.includes("JSON.stringify(safeCtx")) return true;
  // `prop={JSON.stringify(...)}` is an attribute value (a React key, a
  // data-* attribute), not text rendered in the page.
  if (/=\{JSON\.stringify\(/.test(line)) return true;
  if (path.endsWith("/lib/friendlyLabels.ts")) return true;          // the mapper itself
  if (path.endsWith("/components/ui/EleanorTypingIndicator.tsx")) return true; // friendlyToolText mapper
  // ignore JSDoc / line comments that just describe the leak shape
  if (/^\s*\*\s/.test(line.split(":").slice(2).join(":"))) return true;
  if (/^\s*\/\//.test(line.split(":").slice(2).join(":"))) return true;
  return false;
}

// ── Old assistant codename: banned everywhere (2026-11-05) ─────────────────
//
// The owner asked for the assistant's old codename to appear nowhere
// ("i want the name ... nowhere"). Every tracked text file in the repo is
// scanned, case-insensitively, for the old name: code, identifiers, file
// paths, docs, SQL, agent memory. There is no allowlist. The pattern is
// assembled from letters so this guard does not itself contain the word.

const LEGACY_CODENAME = ["r", "u", "b", "y"].join("");
const LEGACY_RE = new RegExp(LEGACY_CODENAME, "gi");

// Test files are scanned too (the name is banned everywhere), so isTestFile
// is only used by the regex patterns above.
function isTestFile(file: string): boolean {
  return (
    /\.(test|spec)\.[cm]?tsx?$/.test(file) ||
    file.includes("/__tests__/") ||
    file.includes("/__qa__/") ||
    file.includes(".stories.")
  );
}

/**
 * Return `path:line:col` for every occurrence of the old codename in `src`,
 * plus one hit when the path itself contains it. Pure. Exported for the
 * regression test.
 */
export function findLegacyCodenameInSource(path: string, src: string): string[] {
  const hits: string[] = [];
  if (new RegExp(LEGACY_CODENAME, "i").test(path)) hits.push(`${path}: file path`);
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    LEGACY_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LEGACY_RE.exec(lines[i]!)) !== null) {
      hits.push(`${path}:${i + 1}:${m.index + 1}`);
    }
  }
  return hits;
}

function scanLegacyCodename(): string[] {
  let files: string[] = [];
  try {
    files = execSync("git ls-files -z", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\0")
      .filter(Boolean);
  } catch {
    return ["[legacy-assistant-codename] could not list tracked files (git ls-files failed)"];
  }
  const violations: string[] = [];
  for (const file of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(file);
    } catch {
      continue;
    }
    // Binary files (images, archives) are skipped: a NUL byte in the first 8 KB.
    if (buf.subarray(0, 8192).includes(0)) {
      if (new RegExp(LEGACY_CODENAME, "i").test(file)) violations.push(`[legacy-assistant-codename] ${file}: file path`);
      continue;
    }
    for (const hit of findLegacyCodenameInSource(file, buf.toString("utf8"))) {
      violations.push(`[legacy-assistant-codename] the old assistant name must not appear anywhere — use Eleanor — ${hit}`);
    }
  }
  return violations;
}

export function checkNoInternalNamesUserUi(): CheckResult {
  const violations: string[] = [];
  for (const pat of PATTERNS) {
    let out = "";
    try {
      out = execSync(
        `rg -n --no-heading -g'*.{ts,tsx}' -e '${pat.regex.replace(/'/g, "\\'")}' ${SCAN_ROOT} || true`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      out = "";
    }
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      if (isAdminExcluded(line)) continue;
      if (isBenign(line)) continue;
      violations.push(`[${pat.id}] ${pat.reason} — ${line}`);
    }
  }

  // 2026-11-05: the old assistant codename appears nowhere in the repo.
  violations.push(...scanLegacyCodename());

  if (violations.length === 0) {
    return {
      name: NAME,
      ok: true,
      violations: [],
      notes: [
        `0 internal-name leaks in user-facing UI (${PATTERNS.length} regex patterns over ${SCAN_ROOT}, ` +
          `${ADMIN_DEV_EXCLUDE.length} admin/dev frontend paths excluded from them) and 0 occurrences ` +
          `of the old assistant codename in any tracked file`,
      ],
    };
  }
  return {
    name: NAME,
    ok: false,
    violations: violations.slice(0, 50),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkNoInternalNamesUserUi();
  // eslint-disable-next-line no-console
  console.log(r.ok ? `[PASS] ${r.name}` : `[FAIL] ${r.name}`);
  // eslint-disable-next-line no-console
  for (const v of r.violations) console.log("  -", v);
  process.exit(r.ok ? 0 : 1);
}
