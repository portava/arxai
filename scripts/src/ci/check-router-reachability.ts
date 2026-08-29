// ── Router reachability guard ───────────────────────────────────────────────
//
// WHY THIS EXISTS
//
// A mounted Express router looks delivered. It appears in routes/index.ts, it
// typechecks, its tests pass, and it is counted as a shipped capability — but
// if no screen ever calls it and it is not in the API contract, no human can
// reach it. An audit of this repository found ~47 such routers, including
// /me/authority, whose absence turned a documented mission-promotion blocker
// message ("obtain an authority grant") into a dead end.
//
// This guard makes that state impossible to reach silently. Every router
// mounted in artifacts/api-server/src/routes/index.ts must be EITHER:
//
//   (a) reachable — at least one of its route paths appears in the dashboard
//       source (a fetch/useQuery call site) or in lib/api-spec/openapi.yaml, or
//   (b) justified — listed in docs/API_SURFACE_JUSTIFICATIONS.md with an
//       explicit category and a reason.
//
// The doc is the honest half. A router parked under NOT_DELIVERED is written
// down as NOT delivered, so nobody counts it as shipped; a router under
// EA_BRIDGE / WEBHOOK / CI_ONLY / INTERNAL_TOOLING is written down as
// deliberately having no browser consumer. Either way a person made a decision
// and it is on the record.
//
// The guard also fails on drift in the other direction: a justification entry
// naming a module that is no longer a mounted router is stale and must go.
//
// Pure source analysis: no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const ROUTES_INDEX = join(ROOT, "artifacts/api-server/src/routes/index.ts");
const ROUTES_DIR = join(ROOT, "artifacts/api-server/src/routes");
const DASHBOARD_SRC = join(ROOT, "artifacts/trading-dashboard/src");
const OPENAPI = join(ROOT, "lib/api-spec/openapi.yaml");
const JUSTIFICATIONS = join(ROOT, "docs/API_SURFACE_JUSTIFICATIONS.md");

/** The only categories a justification may claim. A new category is a
 *  deliberate decision and should be added here on purpose, not typed into the
 *  doc in passing. */
export const JUSTIFICATION_CATEGORIES = [
  /** Polled by the MT5 EA / bridge process, never by a browser. */
  "EA_BRIDGE",
  /** Called by an external system (webhooks, broker callbacks). */
  "WEBHOOK",
  /** Exercised only by CI / QA lanes. */
  "CI_ONLY",
  /** Operator tooling driven by a CLI or script, not a page. */
  "INTERNAL_TOOLING",
  /** HONEST ADMISSION: built, mounted, and reachable by NO human. Recorded so
   *  it is never counted as a delivered capability. */
  "NOT_DELIVERED",
] as const;

export type JustificationCategory = (typeof JUSTIFICATION_CATEGORIES)[number];

// ── Parsing ─────────────────────────────────────────────────────────────────

/** PURE — the local route modules imported by routes/index.ts. */
export function parseMountedModules(indexSrc: string): string[] {
  const out = new Set<string>();
  const rx = /import\s+(?:[\w{},\s*]+?)\s+from\s+"\.\/([A-Za-z0-9_./-]+?)(?:\.js)?"/g;
  for (const m of indexSrc.matchAll(rx)) out.add(m[1]);
  return [...out].sort();
}

/** PURE — the literal route paths a router file registers. */
export function parseRoutePaths(routerSrc: string): string[] {
  const out: string[] = [];
  const rx = /\.(?:get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  for (const m of routerSrc.matchAll(rx)) out.push(m[1]);
  return out;
}

/**
 * PURE — is `path` referenced by a consumer?
 *
 * Dynamic segments become a wildcard, so the Express path
 * `/me/positions/control/:brokerTicket/takeover` matches the template-literal
 * call site `/api/me/positions/control/${encodeURIComponent(t)}/takeover`.
 * Matching a router by ANY ONE of its paths is deliberate: this guard exists
 * to catch a router with NO consumer at all, not to police per-handler
 * coverage. A false alarm that trains people to edit an allowlist reflexively
 * would be worse than the gap it closes.
 */
export function pathIsReferenced(path: string, haystacks: readonly string[]): boolean {
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return true; // a bare "/" mount tells us nothing
  const body = segments
    .map((s) => (s.startsWith(":") ? "[^\"'`\\s]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  const rx = new RegExp(`/${body}`);
  return haystacks.some((h) => rx.test(h));
}

/** PURE — parse the justification doc into module → {category, reason}. */
export function parseJustifications(docSrc: string): Map<string, { category: string; reason: string }> {
  const out = new Map<string, { category: string; reason: string }>();
  const rx = /^[-*]\s+`([A-Za-z0-9_./-]+)`\s*[—-]\s*([A-Z_]+)\s*:\s*(.+?)\s*$/gm;
  for (const m of docSrc.matchAll(rx)) {
    out.set(m[1], { category: m[2], reason: m[3] });
  }
  return out;
}

// ── Check ───────────────────────────────────────────────────────────────────

export function checkRouterReachability(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];

  if (!existsSync(ROUTES_INDEX)) {
    return {
      name: "router-reachability",
      ok: false,
      violations: [`${rel(ROUTES_INDEX)}: routes/index.ts not found — the guard cannot verify anything`],
    };
  }

  const modules = parseMountedModules(readFileSync(ROUTES_INDEX, "utf8"));

  // Consumer corpus: every dashboard source file, plus the API contract.
  const haystacks: string[] = [];
  for (const f of walk(DASHBOARD_SRC, { exts: [".ts", ".tsx"] })) {
    try { haystacks.push(readFileSync(f, "utf8")); } catch { /* unreadable file cannot prove reachability */ }
  }
  if (existsSync(OPENAPI)) {
    try { haystacks.push(readFileSync(OPENAPI, "utf8")); } catch { /* ditto */ }
  }
  // A corpus that failed to load would make EVERY router look orphaned and
  // produce a wall of false violations. Refuse instead of crying wolf.
  if (haystacks.length < 50) {
    return {
      name: "router-reachability",
      ok: false,
      violations: [
        `consumer corpus is only ${haystacks.length} file(s) — the dashboard source could not be read, so reachability cannot be judged`,
      ],
    };
  }

  const justifications = existsSync(JUSTIFICATIONS)
    ? parseJustifications(readFileSync(JUSTIFICATIONS, "utf8"))
    : new Map<string, { category: string; reason: string }>();

  const withHandlers = new Set<string>();
  let orphanCount = 0;

  for (const mod of modules) {
    const file = join(ROUTES_DIR, `${mod}.ts`);
    if (!existsSync(file)) continue; // barrel / type-only import
    let src: string;
    try { src = readFileSync(file, "utf8"); } catch { continue; }
    const paths = parseRoutePaths(src);
    if (paths.length === 0) continue; // composes other routers; nothing to reach
    withHandlers.add(mod);

    const reachable = paths.some((p) => pathIsReferenced(p, haystacks));
    const justified = justifications.get(mod);

    if (reachable) {
      if (justified) {
        notes.push(`${mod}: now has a consumer — its ${justified.category} justification can be removed`);
      }
      continue;
    }

    orphanCount++;
    if (!justified) {
      violations.push(
        `${mod}: mounted with ${paths.length} handler(s) (e.g. ${paths[0]}) but no dashboard call site, no OpenAPI path, `
        + `and no entry in ${rel(JUSTIFICATIONS)}. Ship a surface, unmount it, or record why it has no consumer.`,
      );
      continue;
    }
    if (!(JUSTIFICATION_CATEGORIES as readonly string[]).includes(justified.category)) {
      violations.push(
        `${mod}: justification category "${justified.category}" is not one of ${JUSTIFICATION_CATEGORIES.join(", ")}`,
      );
      continue;
    }
    if (justified.reason.trim().length < 10) {
      violations.push(`${mod}: justification reason is too short to be a reason`);
    }
  }

  // Drift the other way: a justification for something that is no longer a
  // mounted router with handlers.
  for (const mod of justifications.keys()) {
    if (!withHandlers.has(mod)) {
      violations.push(
        `${rel(JUSTIFICATIONS)} lists \`${mod}\`, which is not a mounted route module with handlers — remove the stale entry`,
      );
    }
  }

  return {
    name: "router-reachability",
    ok: violations.length === 0,
    violations,
    notes: [
      `route modules with handlers: ${withHandlers.size}`,
      `without a consumer: ${orphanCount} (all must be justified)`,
      `justification entries: ${justifications.size}`,
      ...notes,
    ],
  };
}

// ── Standalone runner ────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkRouterReachability();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
