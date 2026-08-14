/**
 * Coverage validators for the ARX App Brain.
 *
 * Two checks:
 *   1. routeCoverage(declared)  — every visible route has an entry, and each
 *      entry has the structural fields the spec calls for.
 *   2. badgeCoverage()          — every required status badge has an entry
 *      in the BADGE category of the global KB.
 *
 * Used by the QA test (`scripts/src/qa/assistant-qa.ts`) and importable
 * inside the app for the dev-only diagnostics panel.
 */

import { ARX_KNOWLEDGE, type KnowledgeEntry } from "./arxAppKnowledge";
import { ROUTE_KNOWLEDGE, resolveRoute, type RouteKnowledge } from "./routeKnowledge";

export interface RouteCoverageReport {
  total: number;
  covered: number;
  missing: string[];
  duplicates: string[];
  weak: { route: string; reasons: string[] }[];
}

const WEAK_PURPOSE_LEN = 40;

export function routeCoverage(declaredRoutes: string[]): RouteCoverageReport {
  const seen = new Map<string, number>();
  for (const r of ROUTE_KNOWLEDGE) seen.set(r.route, (seen.get(r.route) ?? 0) + 1);
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);

  const missing: string[] = [];
  const weak: RouteCoverageReport["weak"] = [];
  for (const path of declaredRoutes) {
    const entry = resolveRoute(path);
    if (!entry) {
      missing.push(path);
      continue;
    }
    const reasons = weakReasons(entry);
    if (reasons.length > 0) weak.push({ route: path, reasons });
  }
  return {
    total: declaredRoutes.length,
    covered: declaredRoutes.length - missing.length,
    missing,
    duplicates,
    weak,
  };
}

function weakReasons(e: RouteKnowledge): string[] {
  const reasons: string[] = [];
  if (!e.purpose || e.purpose.length < WEAK_PURPOSE_LEN) reasons.push("short-purpose");
  if (!e.controls || e.controls.length === 0) reasons.push("no-controls");
  if (!e.safety) reasons.push("no-safety");
  if (!e.questions || e.questions.length === 0) reasons.push("no-questions");
  if (!e.related || e.related.length === 0) reasons.push("no-related");
  return reasons;
}

export interface BadgeCoverageReport {
  required: string[];
  covered: string[];
  missing: string[];
}

/** Status badges the spec requires explanations for. */
export const REQUIRED_BADGES = [
  "FULL TESTER ACCESS",
  "LIVE BROKER EXECUTION DISABLED",
  "MT5 DEFERRED",
  "SIMULATOR MODE",
  "SIM ENGINE",
  "FX:EURUSD",
  "INTENTS",
  "DEMO ONLY",
  "LIVE TRADING DISABLED",
  "BROKER READ-ONLY",
  "AUTOPILOT BLOCKED",
  "EMERGENCY STOP",
  "READINESS",
];

export function badgeCoverage(): BadgeCoverageReport {
  const covered: string[] = [];
  const missing: string[] = [];
  for (const b of REQUIRED_BADGES) {
    if (findBadgeEntry(b)) covered.push(b);
    else missing.push(b);
  }
  return { required: REQUIRED_BADGES, covered, missing };
}

function findBadgeEntry(badge: string): KnowledgeEntry | null {
  const norm = badge.toLowerCase();
  const tokens = norm.split(/[\s:·.]+/).filter(Boolean);
  return (
    ARX_KNOWLEDGE.find((e) => {
      const t = e.title.toLowerCase();
      if (t.includes(norm)) return true;
      if (tokens.every((tok) => t.includes(tok) || e.keywords.some((k) => k.includes(tok)))) return true;
      return e.keywords.some((k) => norm.includes(k) && k.length >= 4);
    }) ?? null
  );
}
