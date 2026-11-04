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
//   4. The raw internal assistant codename "Ruby" appearing in
//      user-facing copy (JSX text or string literals) anywhere in the
//      normal-user frontend, the user-facing API routes, OR the shared
//      backend library that assembles that copy
//      (`artifacts/api-server/src/lib`). Task #809 renamed the assistant
//      to "Eleanor" for users; every user-facing mention must resolve the
//      display name at runtime (frontend `useAssistantName().name`,
//      backend `getAssistantDisplayName()`).
//      Internal identifiers (types, hooks, DB columns, `ruby_*` event
//      sources, permission keys, CSS/test-ids) keep the internal name
//      and are NOT flagged — the scan is comment/string-aware and only
//      looks at the standalone word `Ruby`, never glued identifiers
//      like `RubyState` / `allowRuby` / `ruby_recommendation`.
//      Admin/operator/dev-only library surfaces keep the internal name
//      and are listed in ASSISTANT_LIB_INTERNAL_ALLOWLIST below.
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
    id: "ruby-tool-name-literal",
    regex: "(getMyPerformanceSummary|getMarketRead|executeTradeIntent|validateLiveTrade|fetchScannerData)",
    reason: "internal Ruby tool/function name appears as identifier in non-admin source",
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
  if (path.endsWith("/lib/friendlyLabels.ts")) return true;          // the mapper itself
  if (path.endsWith("/components/ui/RubyTypingIndicator.tsx")) return true; // friendlyToolText mapper
  // ignore JSDoc / line comments that just describe the leak shape
  if (/^\s*\*\s/.test(line.split(":").slice(2).join(":"))) return true;
  if (/^\s*\/\//.test(line.split(":").slice(2).join(":"))) return true;
  return false;
}

// ── Assistant-name leak scan (Task #809) ──────────────────────────────────────
//
// The word "Ruby" is the internal assistant codename. Users now see
// "Eleanor" (or whatever the display-name resolver returns). This scan
// is comment/string-aware so it flags ONLY genuine user-facing copy:
// JSX text and string/template literals. Comments are neutralized;
// glued identifiers (RubyState, allowRuby, ruby_recommendation) never
// match because we require the standalone word boundary `\bRuby\b`.

const ASSISTANT_SCAN_ROOTS = [
  SCAN_ROOT,
  "artifacts/api-server/src/routes",
  // The shared backend library also assembles user-facing copy (assistant
  // tool descriptions, chart decision-memory summaries, feature help text).
  // A routes+frontend-only scan cannot see it, so a regression to a copy
  // string in lib would slip through — include it.
  "artifacts/api-server/src/lib",
  // The pure domain library composes scanner/assistant explanation copy
  // (e.g. signal-intelligence market-read sentences surfaced at
  // GET /me/market-edge). Include it so a copy regression there is caught.
  "lib/domain/src",
];

// Admin/operator/dev-only LIBRARY surfaces where the internal name "Ruby"
// legitimately survives (the brief keeps admin/operator/dev naming
// internal). Each entry is a specific file path fragment with the surface
// audience noted. Kept deliberately narrow (exact files, not directories)
// so a genuine user-facing leak elsewhere in lib still fails the guard.
const ASSISTANT_LIB_INTERNAL_ALLOWLIST = [
  "/lib/chart/benchmarkScore.ts",          // admin only — GET /admin/chart/benchmark labels
  "/lib/startup/envChecklist.ts",          // operator/dev — startup env-var checklist notes
  "/lib/governance/effectiveGovernance.ts",// admin/owner — governance control labels
  "/lib/live/operatorFundedPilotConfig.ts",// operator — funded-pilot config disclosure
  // Internal command PARSER (parses user INPUT, emits no user-facing prose;
  // its only "Ruby" is a comment). Its regex-heavy body is not fully
  // modelled by the comment/string tokenizer, so scanning it would false-
  // positive; allowlisted as an internal, non-copy-emitting surface.
  "/lib/assistant/parseTradeCommand.ts",
  // ── Pure domain library (lib/domain/src) — internal registries + admin/
  //    operator diagnostics. The user-facing projections built ABOVE these
  //    (e.g. AACI /me endpoints, meAssistant Ruby block) return only clean
  //    labels/tone/userFacingExplanation and never these detail strings. ──
  "/domain/src/aaci/conflicts.ts",   // admin/operator — AaciConflict.detail is documented "admin diagnostics"; systems[] are typed AaciHandshakeSystem identifiers
  "/domain/src/aaci/types.ts",       // internal — "Ruby" is a typed AaciHandshakeSystem union member (identifier, not copy)
  "/domain/src/agent-system/constitution/agentConstitution.ts", // internal agent-governance registry text
  "/domain/src/agent-system/coreAgents.ts",                     // internal agent registry (agentKey/name pairs)
  "/domain/src/handshake/handshake.types.ts",                   // admin-monitor label→code map
  "/domain/src/handshake/handshakeRegistry.ts",                 // admin-monitor readiness labels
];

// Backend user-facing routes: admin/operator/dev route files keep the
// internal name, mirroring the frontend admin exclusions above.
const ASSISTANT_SCAN_EXCLUDE = [
  ...ADMIN_DEV_EXCLUDE,
  ...ASSISTANT_LIB_INTERNAL_ALLOWLIST,
  "/routes/admin",
  "/routes/operator",
  "/routes/dev",
];

// Exported for the regression test: proves the admin/operator/dev
// library allowlist excludes exactly the intended files and nothing else.
export function isAssistantScanExcluded(file: string): boolean {
  return ASSISTANT_SCAN_EXCLUDE.some((frag) => file.includes(frag));
}

// Test/spec/story files exercise internal names deliberately.
function isTestFile(file: string): boolean {
  return (
    /\.(test|spec)\.[cm]?tsx?$/.test(file) ||
    file.includes("/__tests__/") ||
    file.includes("/__qa__/") ||
    file.includes(".stories.")
  );
}

// A deliberate name-swap line (e.g. `.replace(/Ruby/g, name)`) is the
// mechanism that fixes leaks, not a leak itself.
function isNameSwapLine(rawLine: string): boolean {
  return rawLine.includes(".replace(/Ruby/") || rawLine.includes("/Ruby/g");
}

/**
 * Replace every comment character with a space (newlines preserved) so
 * that line and column numbers of the surviving code/string characters
 * are unchanged. String and template literals are kept verbatim because
 * their content is exactly the user-facing copy we want to inspect.
 *
 * Exported for the regression test.
 */
export function stripComments(src: string): string {
  let out = "";
  let state: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const c2 = i + 1 < src.length ? src[i + 1] : "";
    switch (state) {
      case "code":
        if (c === "/" && c2 === "/") { out += "  "; i++; state = "line"; }
        else if (c === "/" && c2 === "*") { out += "  "; i++; state = "block"; }
        else if (c === "'") { out += c; state = "sq"; }
        else if (c === '"') { out += c; state = "dq"; }
        else if (c === "`") { out += c; state = "tpl"; }
        else out += c;
        break;
      case "line":
        if (c === "\n") { out += "\n"; state = "code"; }
        else out += " ";
        break;
      case "block":
        if (c === "*" && c2 === "/") { out += "  "; i++; state = "code"; }
        else out += c === "\n" ? "\n" : " ";
        break;
      case "sq":
      case "dq":
      case "tpl": {
        const term = state === "sq" ? "'" : state === "dq" ? '"' : "`";
        if (c === "\\") { out += c; if (c2) { out += c2; i++; } }
        else { out += c; if (c === term) state = "code"; }
        break;
      }
    }
  }
  return out;
}

/**
 * Return `path:line:col: <trimmed source line>` for every standalone
 * `Ruby` in user-facing copy (after comments are stripped). Pure — takes
 * source text, does no IO. Exported for the regression test.
 */
export function findAssistantNameLeaksInSource(path: string, src: string): string[] {
  const stripped = stripComments(src);
  const strippedLines = stripped.split("\n");
  const rawLines = src.split("\n");
  const hits: string[] = [];
  for (let i = 0; i < strippedLines.length; i++) {
    const rawLine = rawLines[i] ?? "";
    if (isNameSwapLine(rawLine)) continue;
    const re = /\bRuby\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(strippedLines[i])) !== null) {
      hits.push(`${path}:${i + 1}:${m.index + 1}: ${rawLine.trim().slice(0, 160)}`);
    }
  }
  return hits;
}

// Candidate files: only those that contain the word at all (paths only —
// ripgrep -l output is not subject to the content-mangling that -n dumps
// can hit in this sandbox).
function listCandidateFiles(root: string): string[] {
  try {
    const out = execSync(
      `rg -l --no-heading -g'*.{ts,tsx}' -e '\\bRuby\\b' ${root} || true`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function scanAssistantNameLeaks(): string[] {
  const violations: string[] = [];
  for (const root of ASSISTANT_SCAN_ROOTS) {
    for (const file of listCandidateFiles(root)) {
      if (isAssistantScanExcluded(file)) continue;
      if (isTestFile(file)) continue;
      let src = "";
      try {
        src = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const hit of findAssistantNameLeaksInSource(file, src)) {
        violations.push(
          `[assistant-name-user-copy] raw internal assistant name "Ruby" in user-facing copy — ` +
            `route it through the name resolver (frontend useAssistantName().name / backend getAssistantDisplayName) — ${hit}`,
        );
      }
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

  // Task #809: comment/string-aware assistant-name leak scan.
  violations.push(...scanAssistantNameLeaks());

  if (violations.length === 0) {
    return {
      name: NAME,
      ok: true,
      violations: [],
      notes: [
        `0 internal-name leaks in user-facing UI (${PATTERNS.length} regex patterns over ${SCAN_ROOT}, ` +
          `plus a comment/string-aware "Ruby" scan over ${ASSISTANT_SCAN_ROOTS.join(" + ")}; ` +
          `${ADMIN_DEV_EXCLUDE.length} admin/dev frontend paths + backend admin/operator/dev routes + ` +
          `${ASSISTANT_LIB_INTERNAL_ALLOWLIST.length} admin/operator/dev library files excluded)`,
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
