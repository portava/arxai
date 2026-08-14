/**
 * ARX Knowledge Compiler — composes every assistant-facing registry into a
 * single normalized index the assistant (and the audit) can search.
 *
 * Inputs (all deterministic, no network, no DOM):
 *   - routeKnowledge.ts           (route registry)
 *   - uiElementRegistry.ts        (UI element registry)
 *   - statusRegistry.ts           (status / badge registry)
 *   - blockerDiagnostics.ts       (blocker catalog)
 *   - setupChecklist.ts           (setup checklist builders)
 *   - walkthroughs.ts             (guided flows)
 *   - actionRouter.ts             (safe + forbidden intents)
 *   - safetyRefusal.ts            (refusal categories)
 *   - glossary.ts                 (term definitions)
 *   - arxAppKnowledge.ts          (free-form KB topics)
 *
 * Output:
 *   - a flat list of `CompiledItem`s (uniform shape, easy to score)
 *   - `auditKnowledge()` — coverage stats + 0..100 score
 *
 * Hard rules:
 *   - Never reads env vars, secrets, or server state.
 *   - Never claims a route exists unless `resolveRoute` confirms it.
 */
import { ROUTE_KNOWLEDGE, resolveRoute } from "./routeKnowledge";
import { UI_ELEMENTS } from "./uiElementRegistry";
import { STATUS_REGISTRY } from "./statusRegistry";
import { WALKTHROUGHS, validateWalkthrough } from "./walkthroughs";
import { ARX_KNOWLEDGE } from "./arxAppKnowledge";
import { GLOSSARY } from "./glossary";
import { SAFETY_REFUSALS } from "./safetyRefusal";
import { SAFE_ACTION_KINDS, FORBIDDEN_INTENTS } from "./actionRouter";

export type CompiledKind =
  | "route" | "element" | "badge" | "blocker" | "workflow"
  | "safety" | "setup" | "troubleshooting" | "command" | "glossary";

export interface CompiledItem {
  id: string;
  title: string;
  category: string;
  type: CompiledKind;
  aliases: string[];
  /** Plain-English explanation suitable for end users. */
  explanation: string;
  /** Optional technical explanation reserved for tester/admin views. */
  technical?: string;
  relatedRoutes: string[];
  relatedElements: string[];
  relatedStatuses: string[];
  allowedActions: string[];
  forbiddenActions: string[];
  safetyNote?: string;
  /** Source registry / file the item was compiled from. */
  source: string;
  /** 0..1 — completeness heuristic (presence of optional fields). */
  completeness: number;
}

const FORBIDDEN_LABELS: string[] = FORBIDDEN_INTENTS.slice();
const SAFE_LABELS = SAFE_ACTION_KINDS as readonly string[];

export function compileKnowledge(): CompiledItem[] {
  const out: CompiledItem[] = [];

  for (const r of ROUTE_KNOWLEDGE) {
    const related = (r.related ?? []).filter((p) => !!resolveRoute(p));
    out.push({
      id: `route:${r.route}`,
      title: r.title,
      category: r.route.startsWith("/admin") ? "admin" : "navigation",
      type: "route",
      aliases: [r.route, r.title.toLowerCase()],
      explanation: r.purpose,
      technical: r.controls?.length ? `Controls: ${r.controls.join(", ")}.` : undefined,
      relatedRoutes: related,
      relatedElements: [],
      relatedStatuses: [],
      allowedActions: ["navigate"],
      forbiddenActions: [],
      safetyNote: r.safety,
      source: "routeKnowledge.ts",
      completeness: scoreFields([r.purpose, r.safety, r.controls?.join(","), related.length > 0]),
    });
  }

  for (const e of UI_ELEMENTS) {
    const related = e.relatedRoute && resolveRoute(e.relatedRoute) ? [e.relatedRoute] : [];
    out.push({
      id: `element:${e.id}`,
      title: e.label,
      category: e.type === "badge" || e.type === "safety-lock" ? "status" : e.type,
      type: e.type === "badge" ? "badge" : e.type === "safety-lock" ? "safety" : "element",
      aliases: [e.label.toLowerCase(), ...(e.aliases ?? []).map((a) => a.toLowerCase())],
      explanation: e.explanation,
      technical: `${e.whatItDoes} | NOT: ${e.whatItDoesNot}`,
      relatedRoutes: related,
      relatedElements: [],
      relatedStatuses: e.type === "badge" || e.type === "safety-lock" ? [e.label] : [],
      allowedActions: e.safeNextAction ? [e.safeNextAction] : [],
      forbiddenActions: e.disabledReasons ?? [],
      safetyNote: e.safetyNote,
      source: "uiElementRegistry.ts",
      completeness: scoreFields([e.explanation, e.safetyNote, e.safeNextAction, related.length > 0, e.aliases?.length]),
    });
  }

  for (const s of STATUS_REGISTRY) {
    const related = s.related && resolveRoute(s.related.route) ? [s.related.route] : [];
    out.push({
      id: `status:${s.id}`,
      title: s.label,
      category: "status",
      type: "badge",
      aliases: [s.label.toLowerCase()],
      explanation: s.explanation,
      technical: `Severity: ${s.severity}. Blocks: ${(s.blocks ?? []).join(", ") || "—"}. Allows: ${(s.allows ?? []).join(", ") || "—"}.`,
      relatedRoutes: related,
      relatedElements: [],
      relatedStatuses: [s.label],
      allowedActions: s.allows ?? [],
      forbiddenActions: s.blocks ?? [],
      safetyNote: s.safetyReason,
      source: "statusRegistry.ts",
      completeness: scoreFields([s.explanation, s.safetyReason, s.safeNextStep, related.length > 0]),
    });
  }

  for (const w of WALKTHROUGHS) {
    const v = validateWalkthrough(w);
    const related = w.steps.map((st) => st.route).filter((r): r is string => !!r && !!resolveRoute(r));
    out.push({
      id: `workflow:${w.id}`,
      title: w.title,
      category: "workflow",
      type: "workflow",
      aliases: [w.id, w.title.toLowerCase()],
      explanation: w.intro,
      technical: `Steps: ${w.steps.length}. Completion: ${w.completion}`,
      relatedRoutes: related,
      relatedElements: [],
      relatedStatuses: [],
      allowedActions: w.steps.map((s) => s.title),
      forbiddenActions: [],
      safetyNote: v.ok ? undefined : `INVALID: ${v.missing.join("; ")}`,
      source: "walkthroughs.ts",
      completeness: v.ok ? 1 : 0.4,
    });
  }

  for (const g of GLOSSARY) {
    out.push({
      id: g.id,
      title: g.term,
      category: "glossary",
      type: "glossary",
      aliases: [g.term.toLowerCase(), ...(g.aliases ?? []).map((a) => a.toLowerCase())],
      explanation: g.definition,
      relatedRoutes: [],
      relatedElements: [],
      relatedStatuses: [],
      allowedActions: [],
      forbiddenActions: [],
      source: "glossary.ts",
      completeness: scoreFields([g.definition, g.aliases?.length]),
    });
  }

  for (const r of SAFETY_REFUSALS) {
    out.push({
      id: r.id,
      title: r.id.replace(/^refusal:/, "Safety refusal — "),
      category: "safety",
      type: "safety",
      aliases: [],
      explanation: r.reply,
      technical: `${r.patterns.length} regex patterns.`,
      relatedRoutes: ["/readiness-checklist", "/risk-governor"].filter((p) => !!resolveRoute(p)),
      relatedElements: [],
      relatedStatuses: [],
      allowedActions: [],
      forbiddenActions: FORBIDDEN_LABELS,
      safetyNote: "This refusal is enforced before any other handler.",
      source: "safetyRefusal.ts",
      completeness: 1,
    });
  }

  for (const k of ARX_KNOWLEDGE) {
    out.push({
      id: `kb:${k.id}`,
      title: k.title,
      category: (k.category ?? "general").toLowerCase(),
      type: "troubleshooting",
      aliases: (k.keywords ?? []).map((a) => a.toLowerCase()),
      explanation: k.answer,
      technical: k.detail,
      relatedRoutes: (k.related ?? []).map((r) => r.route).filter((p) => !!resolveRoute(p)),
      relatedElements: [],
      relatedStatuses: [],
      allowedActions: SAFE_LABELS.slice(),
      forbiddenActions: [],
      safetyNote: k.safety,
      source: "arxAppKnowledge.ts",
      completeness: scoreFields([k.answer, k.detail, k.safety, k.related?.length]),
    });
  }

  return out;
}

function scoreFields(fields: (unknown | null | undefined)[]): number {
  let n = 0, hits = 0;
  for (const f of fields) {
    n++;
    if (f === undefined || f === null) continue;
    if (typeof f === "string" && f.trim().length === 0) continue;
    if (typeof f === "number" && f === 0) continue;
    if (typeof f === "boolean" && !f) continue;
    hits++;
  }
  return n === 0 ? 1 : Math.round((hits / n) * 100) / 100;
}

export interface KnowledgeAudit {
  totalRoutes: number;
  routesCovered: number;
  routesMissing: string[];
  totalElements: number;
  elementsWithRoute: number;
  invalidElementRoutes: string[];
  totalBadges: number;
  badgesCovered: number;
  badgesMissing: string[];
  totalWalkthroughs: number;
  walkthroughsValid: number;
  walkthroughIssues: string[];
  weakItems: { id: string; completeness: number }[];
  duplicateIds: string[];
  invalidLinks: string[];
  /** 0..100 overall knowledge score. */
  score: number;
}

const REQUIRED_BADGE_LABELS = [
  "DEMO ONLY", "LIVE TRADING DISABLED", "MT5 DEFERRED", "SIMULATOR MODE",
  "EMERGENCY STOP", "BROKER READ-ONLY", "INTENTS", "FX:EURUSD",
];

export function auditKnowledge(): KnowledgeAudit {
  const items = compileKnowledge();
  const ids = new Map<string, number>();
  for (const it of items) ids.set(it.id, (ids.get(it.id) ?? 0) + 1);
  const duplicateIds = [...ids.entries()].filter(([, n]) => n > 1).map(([k]) => k);

  // Routes
  const routeIds = new Set(items.filter((i) => i.type === "route").map((i) => i.id));
  const routesMissing: string[] = [];
  for (const r of ROUTE_KNOWLEDGE) if (!routeIds.has(`route:${r.route}`)) routesMissing.push(r.route);

  // Elements
  const elementItems = items.filter((i) => i.type === "element" || i.type === "badge" || i.type === "safety");
  const elementsWithRoute = items.filter((i) => i.id.startsWith("element:") && i.relatedRoutes.length > 0).length;
  const invalidElementRoutes = UI_ELEMENTS
    .filter((e) => e.relatedRoute && !resolveRoute(e.relatedRoute))
    .map((e) => `${e.id} → ${e.relatedRoute}`);

  // Badges
  const badgeLabels = new Set(elementItems.map((i) => i.title));
  const badgesMissing = REQUIRED_BADGE_LABELS.filter((l) => !badgeLabels.has(l));

  // Walkthroughs
  const walkthroughIssues = WALKTHROUGHS.flatMap((w) => {
    const v = validateWalkthrough(w);
    return v.ok ? [] : v.missing.map((m) => `${w.id}: ${m}`);
  });

  // Invalid links: any compiled item referencing a route that doesn't resolve
  const invalidLinks: string[] = [];
  for (const it of items) {
    for (const p of it.relatedRoutes) {
      if (!resolveRoute(p)) invalidLinks.push(`${it.id} → ${p}`);
    }
  }

  // Weak items: completeness < 0.5
  const weakItems = items.filter((i) => i.completeness < 0.5).map((i) => ({ id: i.id, completeness: i.completeness }));

  // Score: weighted blend
  const w = {
    routes: ROUTE_KNOWLEDGE.length === 0 ? 1 : 1 - routesMissing.length / ROUTE_KNOWLEDGE.length,
    badges: 1 - badgesMissing.length / REQUIRED_BADGE_LABELS.length,
    walks: WALKTHROUGHS.length === 0 ? 1 : 1 - walkthroughIssues.length / WALKTHROUGHS.length,
    elementRoutes: invalidElementRoutes.length === 0 ? 1 : 0,
    duplicates: duplicateIds.length === 0 ? 1 : 0,
    weak: items.length === 0 ? 1 : 1 - weakItems.length / items.length,
    invalidLinks: invalidLinks.length === 0 ? 1 : Math.max(0, 1 - invalidLinks.length / Math.max(1, items.length)),
  };
  const score = Math.round(
    (w.routes * 25 + w.badges * 20 + w.walks * 15 + w.elementRoutes * 15 +
      w.duplicates * 10 + w.weak * 10 + w.invalidLinks * 5),
  );

  return {
    totalRoutes: ROUTE_KNOWLEDGE.length,
    routesCovered: ROUTE_KNOWLEDGE.length - routesMissing.length,
    routesMissing,
    totalElements: UI_ELEMENTS.length,
    elementsWithRoute,
    invalidElementRoutes,
    totalBadges: REQUIRED_BADGE_LABELS.length,
    badgesCovered: REQUIRED_BADGE_LABELS.length - badgesMissing.length,
    badgesMissing,
    totalWalkthroughs: WALKTHROUGHS.length,
    walkthroughsValid: WALKTHROUGHS.length - walkthroughIssues.length,
    walkthroughIssues,
    weakItems,
    duplicateIds,
    invalidLinks,
    score,
  };
}

/**
 * Generate a draft knowledge entry suggestion for an audit gap. Always
 * marked `status: "draft"` — never auto-published into a real registry.
 */
export interface KnowledgeSuggestion {
  status: "draft";
  type: CompiledKind;
  suggestedTitle: string;
  detected: string;
  draftExplanation: string;
  draftSafety: string;
  draftAliases: string[];
  draftRelatedRoute?: string;
  reason: string;
}

export function suggestForGap(
  kind: "route" | "element" | "badge" | "walkthrough",
  identifier: string,
): KnowledgeSuggestion {
  return {
    status: "draft",
    type: kind === "walkthrough" ? "workflow" : (kind as CompiledKind),
    suggestedTitle: identifier,
    detected: identifier,
    draftExplanation: `[DRAFT] Describe what ${identifier} does in plain English.`,
    draftSafety: "[DRAFT] Confirm this surface does not enable live trading or bypass any safety lock.",
    draftAliases: [identifier.toLowerCase()],
    draftRelatedRoute: kind === "route" ? identifier : undefined,
    reason: `Audit flagged ${kind} ${identifier} as missing from compiled knowledge.`,
  };
}

/** Map a sourceId prefix to a user-visible source label. */
export function sourceLabelFor(sourceId: string): string {
  if (sourceId.startsWith("element:")) return "From UI Element Registry";
  if (sourceId.startsWith("status:")) return "From Status Badge Registry";
  if (sourceId.startsWith("route:")) return "From Route Registry";
  if (sourceId.startsWith("blockers:")) return "From Blocker Diagnostic System";
  if (sourceId.startsWith("checklist:")) return "From Setup Checklist";
  if (sourceId.startsWith("workflow:") || sourceId.startsWith("walkthrough:")) return "From Walkthrough Registry";
  if (sourceId.startsWith("g-")) return "From Glossary";
  if (sourceId.startsWith("refusal:")) return "From Safety Refusal Registry";
  if (sourceId.startsWith("screen:")) return "From Compiled Screen Context";
  if (sourceId.startsWith("look:") || sourceId === "next-step" || sourceId === "badge-explain-all") return "From ARX App Knowledge";
  if (sourceId.startsWith("fallback:")) return "Safe fallback (no exact match)";
  if (sourceId.startsWith("kb:")) return "From ARX App Knowledge";
  return "From ARX App Knowledge";
}
