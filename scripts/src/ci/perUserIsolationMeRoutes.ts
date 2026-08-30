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

// ─────────────────────────────────────────────────────────────────────────────
// EXTENSION — per-user-isolation-scoped-surfaces
//
// The guard above only sees route files that declare a `/me/*` path. Nine
// routers and their service libs present per-trader data on NON-/me paths
// (/weekly-reviews, /analytics/*, /mentor/*, /skill/*, /edge/*, /onboarding/*,
// /paper-sessions/*, /trader-coach/*, /security/*, /tester-data/*). Every one
// of them shipped with zero `requireUser` and zero `eq(<table>.userId, …)`, so
// one trader's weekly P&L, skill level, edge reports, mentor briefing,
// onboarding acknowledgements and paper sessions were served to every other
// trader. This extension pins the fix so a single forgotten predicate cannot
// silently re-open it.
//
// Rules:
//   R3. Every `router.<verb>(` handler in a covered ROUTE file must name an
//       approved auth/permission gate in its declaration (`requireUser`, or
//       the file's own documented gate — see COVERED_ROUTE_FILES).
//   R4. In every covered file, any Drizzle statement touching a USER_OWNED
//       table must mention `userId` somewhere in that same statement. This is
//       what stops `db.select().from(paperOrdersTable)` (no predicate) from
//       coming back.
//
// R4 escape hatch: a line `// isolation-ok: <reason>` immediately above the
// `.from(...)` / `.insert(...)` waives that one statement. The reason is
// mandatory — an unexplained waiver does not parse and still fails.

const API_SRC = join(ROUTES_DIR, "..");

/** Route files + the gate token each handler must carry. */
const COVERED_ROUTE_FILES: Record<string, readonly string[]> = {
  // Standard per-user surfaces.
  "routes/aiMentor.ts": ["requireUser"],
  "routes/traderSkill.ts": ["requireUser"],
  "routes/edgeDiscovery.ts": ["requireUser"],
  "routes/weeklyReviews.ts": ["requireUser"],
  "routes/analytics.ts": ["requireUser"],
  "routes/paperSessions.ts": ["requireUser"],
  "routes/traderCoach.ts": ["requireUser"],
  "routes/onboarding.ts": ["requireUser"],
  // ── Sibling routers that read the SAME per-trader tables ────────────────
  // These were not in the original list, and the guard therefore reported
  // PASS over a live hole: routes/tradeDecision.ts read analytics_snapshots,
  // trader_skill_profiles, ai_mentor_sessions and trading_readiness_checks
  // with `.orderBy(desc(...)).limit(1)` and no predicate, then told the
  // caller "<symbol> is your WEAKEST symbol"; routes/tradingReadiness.ts took
  // the newest weekly_performance_reviews row platform-wide. Coverage is by
  // TABLE, not by page: any router touching a user-owned table belongs here.
  "routes/tradeDecision.ts": ["requireUser"],
  "routes/tradingReadiness.ts": ["requireUser"],
  "routes/ruleContracts.ts": ["requireUser"],
  "routes/postTradeDebriefs.ts": ["requireUser"],
  "routes/paperExecution.ts": ["requireUser"],
  // Security posture is role-gated, not user-scoped: the reads expose the
  // admin role×permission matrix, event log and access logs, so the gate is
  // `security:read` (OWNER/ADMIN only) rather than "any signed-in user".
  "routes/security.ts": ["requireSecurityRead", "checkPermission"],
  // Both tester-data routes are covered by a router-level `requireAdmin`
  // mount (`router.use("/tester-data", requireAdmin)`), which no per-handler
  // token can express — hence its own gate name here.
  "routes/testerData.ts": ["requireAdmin", "ROUTER_LEVEL_REQUIRE_ADMIN"],
};

/** Service/lib files covered by R4 only (they have no routes of their own). */
const COVERED_LIB_FILES: readonly string[] = [
  "lib/onboarding/state.ts",
  "lib/traderCoach/coach.ts",
  "lib/traderCoach/weekly.ts",
  "lib/paperSession/manager.ts",
  "lib/riskGovernor/governor.ts",
  "lib/paperExecution/paperExecutionService.ts",
  "lib/paperAutopilot/autopilotService.ts",
];

/**
 * Drizzle table symbols whose physical table carries a `user_id` column AND
 * whose rows are presented to a trader as their own. A statement touching one
 * of these without naming `userId` is a cross-user read or an unowned write.
 */
const USER_OWNED_TABLES: readonly string[] = [
  "aiMentorSessionsTable",
  "mentorActionItemsTable",
  "traderSkillProfilesTable",
  "skillLevelHistoryTable",
  "edgeDiscoveryReportsTable",
  "edgeWarningsTable",
  "weeklyPerformanceReviewsTable",
  "weeklyImprovementGoalsTable",
  "analyticsSnapshotsTable",
  "analyticsHeatmapsTable",
  "paperAccountsTable",
  "paperOrdersTable",
  "paperSessionsTable",
  "postTradeDebriefsTable",
  "tradeJournalTable",
  "tradeJournalEntriesTable",
  "tradesTable",
  "tradePlansTable",
  "tradingRuleContractsTable",
  "tradingRuleViolationsTable",
  "tradingReadinessChecksTable",
  "userOnboardingProgressTable",
  "riskSettingsTable",
  "riskLocksTable",
  "livePositionsTable",
  "performanceDailyTable",
  "performanceDailySnapshotsTable",
  "strategyEdgesTable",
  "mistakePatternsTable",
  "learningEventsTable",
  "tradeDecisionLogsTable",
  "autopilotCyclesTable",
  "traderCoachReportsTable",
  // Added with the sibling-router coverage above.
  "paperExecutionsTable",
  "sessionCommitmentsTable",
];

const WAIVER = /\/\/\s*isolation-ok:\s*\S+/;

/**
 * Return the source span of the Drizzle statement containing `idx`.
 *
 * Walks back to the nearest `db.` / `tx.` chain start and forward to the first
 * `;` OR `,` that sits outside any bracket opened since. Deliberately
 * conservative: if it cannot find a terminator it returns the rest of the
 * file, which errs toward PASSING rather than inventing a violation.
 *
 * The depth-0 COMMA terminator is load-bearing, not cosmetic. Without it a
 * statement inside a `Promise.all([...])` array ran to the array's closing
 * `;`, so ONE element naming `userId` waived every sibling element in the same
 * block — which is exactly the shape of the defect this guard exists to catch:
 *
 *   const [snapRows, skillRows, …] = await Promise.all([
 *     db.select().from(analyticsSnapshotsTable).orderBy(…).limit(1),   // unscoped
 *     db.select().from(edgeDiscoveryReportsTable).where(eq(…, userId)),
 *   ]);
 *
 * Commas nested inside any bracket (argument lists, object literals,
 * `and(…, …)` predicates) are at depth > 0 and do not terminate a span.
 */
function statementSpan(raw: string, idx: number): string {
  let start = idx;
  for (const marker of ["db.", "tx."]) {
    const p = raw.lastIndexOf(marker, idx);
    if (p >= 0 && p > start - 400) start = Math.min(start, p);
  }
  // Fall back to the start of the line when no db./tx. is close by.
  const lineStart = raw.lastIndexOf("\n", idx) + 1;
  start = Math.min(start, lineStart);

  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if ((ch === ";" || ch === ",") && depth <= 0) return raw.slice(start, i + 1);
  }
  return raw.slice(start);
}

function lineNumberAt(raw: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i++) if (raw[i] === "\n") n++;
  return n;
}

function lineAbove(raw: string, idx: number): string {
  const lineStart = raw.lastIndexOf("\n", idx - 1);
  if (lineStart <= 0) return "";
  const prevStart = raw.lastIndexOf("\n", lineStart - 1);
  return raw.slice(prevStart + 1, lineStart);
}

export interface ScopedSurfaceScan {
  violations: string[];
  handlersChecked: number;
  statementsChecked: number;
}

/**
 * The whole analysis, over ONE source string. Exported so the QA suite can
 * feed it a deliberately-broken snippet and prove the guard goes RED — a
 * guard nobody has seen fail is not evidence of anything.
 *
 * `gates` is undefined for service/lib files (R4 only).
 */
export function scanScopedSurfaceSource(
  rel: string,
  raw: string,
  gates?: readonly string[],
): ScopedSurfaceScan {
  const violations: string[] = [];
  let handlersChecked = 0;
  let statementsChecked = 0;
  {
    const lines = raw.split("\n");

    // ── R3 — handler gates (route files only) ──────────────────────────────
    if (gates) {
      const routerLevelAdmin = /router\.use\(\s*["'`][^"'`]+["'`]\s*,\s*requireAdmin\s*\)/.test(raw);
      lines.forEach((line, i) => {
        if (!/^\s*router\.(get|post|put|patch|delete)\(/.test(line)) return;
        handlersChecked++;
        const head = lines.slice(i, Math.min(i + 3, lines.length)).join("\n");
        const gated = gates.some((g) =>
          g === "ROUTER_LEVEL_REQUIRE_ADMIN" ? routerLevelAdmin : head.includes(g));
        if (!gated) {
          violations.push(
            `${rel}:${i + 1} [R3-handler-not-gated] expected one of ${gates.join(" | ")} — ${line.trim().slice(0, 90)}`,
          );
        }
      });
    }

    // ── R4 — user-owned tables must be scoped ──────────────────────────────
    for (const table of USER_OWNED_TABLES) {  // eslint-disable-line
      for (const verb of ["from", "insert", "update", "delete"] as const) {
        const re = new RegExp(`\\.${verb}\\(\\s*${table}\\b|\\b${verb}\\(\\s*${table}\\b`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(raw)) !== null) {
          const idx = m.index;
          // Skip matches inside a line comment.
          const lineStart = raw.lastIndexOf("\n", idx) + 1;
          if (raw.slice(lineStart, idx).trimStart().startsWith("//")) continue;
          statementsChecked++;
          if (WAIVER.test(lineAbove(raw, idx))) continue;
          const span = statementSpan(raw, idx);
          if (!/userId/i.test(span)) {
            violations.push(
              `${rel}:${lineNumberAt(raw, idx)} [R4-unscoped-user-owned-table] ${table} touched without a userId predicate`,
            );
          }
        }
      }
    }
  }
  return { violations, handlersChecked, statementsChecked };
}

export function checkPerUserIsolationScopedSurfaces(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];
  let handlersChecked = 0;
  let statementsChecked = 0;

  const allFiles = [...Object.keys(COVERED_ROUTE_FILES), ...COVERED_LIB_FILES];

  for (const rel of allFiles) {
    let raw: string;
    try {
      raw = readFileSync(join(API_SRC, rel), "utf-8");
    } catch {
      // A covered file that vanished is itself a finding: the guard must never
      // pass by quietly scanning nothing.
      violations.push(`${rel} [R0-covered-file-missing] file listed in the isolation guard does not exist`);
      continue;
    }
    const scan = scanScopedSurfaceSource(rel, raw, COVERED_ROUTE_FILES[rel]);
    violations.push(...scan.violations);
    handlersChecked += scan.handlersChecked;
    statementsChecked += scan.statementsChecked;
  }

  notes.push(
    `covered ${Object.keys(COVERED_ROUTE_FILES).length} route file(s) + ${COVERED_LIB_FILES.length} service file(s); `
    + `${handlersChecked} handler(s) gate-checked, ${statementsChecked} user-owned-table statement(s) scope-checked`,
  );

  return {
    name: "per-user-isolation-scoped-surfaces",
    ok: violations.length === 0,
    violations,
    notes,
  };
}

/** Exported for the QA suite so it can assert the covered set never shrinks. */
export const SCOPED_SURFACE_COVERAGE = {
  routeFiles: Object.keys(COVERED_ROUTE_FILES),
  libFiles: COVERED_LIB_FILES,
  userOwnedTables: USER_OWNED_TABLES,
} as const;
