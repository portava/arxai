/**
 * ARX deterministic answer engine.
 *
 * No external API key required. Given a question + page context, the engine:
 *   1. expands aliases / synonyms in the query
 *   2. scores every knowledge entry by keyword + alias overlap
 *   3. boosts entries related to the current route
 *   4. falls back to the route's own knowledge entry
 *   5. final fallback: a safe "not documented yet" answer that logs the miss
 *
 * The engine NEVER returns an empty / "no topics" response.
 */

import { ARX_KNOWLEDGE, expandAliases, type KnowledgeEntry } from "./arxAppKnowledge";
import { resolveRoute, type RouteKnowledge } from "./routeKnowledge";
import { checkSafetyRefusal } from "./safetyRefusal";
import { blockersToAnswer, diagnoseBlockers } from "./blockerDiagnostics";
import { pageActionChips } from "./pageActions";
import { findElement } from "./uiElementRegistry";
import { safestNextStep } from "./safestNextStep";
import { findGlossary } from "./glossary";

function tryGlossaryAnswer(question: string): Answer | undefined {
  const m = question.match(/^\s*(?:what\s+(?:does|is|are)\s+|define\s+|what\s+do\s+you\s+mean\s+by\s+)(.+?)(?:\s+mean)?[?.!]*\s*$/i);
  const phrase = (m?.[1] ?? question).trim();
  if (!phrase) return undefined;
  const g = findGlossary(phrase);
  if (!g) return undefined;
  return {
    answer: `${g.term} — ${g.definition}`,
    sourceId: g.id,
    matchType: "kb",
    confidence: 0.95,
  };
}

export interface AskContext {
  /** Current path, e.g. "/" or "/mt5-bridge". */
  route: string;
  /** Current page title from the route registry. */
  pageTitle?: string;
  /** Visible safety statuses from the topbar (e.g. ["MOCK","RUNNING","MT5:deferred"]). */
  safetyStatuses?: string[];
  /**
   * UI-visible role hint. NEVER trusted for permission checks — server enforces.
   * Used only to soften / detail-toggle the answer copy.
   */
  uiRoleHint?: "user" | "tester" | "admin" | "owner";
  /** "paper" | "simulator" | "broker-readonly" | "live" — best-effort UI hint. */
  tradingModeHint?: string;
  /** "deferred" | "connected" | "disconnected" — best-effort UI hint. */
  mt5Hint?: string;
  /**
   * Last few assistant exchanges (for pronoun follow-ups like "how do I fix it").
   * Capped to ~5 by the caller. NEVER persisted across sessions.
   */
  recentExchanges?: { q: string; topic?: string }[];
}

export interface Answer {
  /** Direct answer in plain language. */
  answer: string;
  /** Optional longer detail. */
  detail?: string;
  /** Optional safety reminder. */
  safety?: string;
  /** Source entry id for analytics / "rate this". */
  sourceId: string;
  /** "kb" = matched knowledge base; "route" = fell back to current route; "miss" = nothing matched. */
  matchType: "kb" | "route" | "miss" | "look";
  /** Confidence 0..1 — only used for UI hinting. */
  confidence: number;
  /** Suggested next routes the user can jump to. */
  related?: { label: string; route: string }[];
  /** Suggested next action label, e.g. "Open Readiness Checklist". */
  nextAction?: { label: string; route: string };
}

const STOP = new Set([
  "the","a","an","is","are","was","were","be","been","being","do","does","did","i","me","my",
  "you","your","we","our","it","its","of","in","on","at","to","for","with","and","or","but",
  "what","why","how","when","where","which","who","whom","whose","this","that","these","those",
  "can","could","should","would","may","might","will","shall","not","no","yes","there","here",
  "as","by","from","into","than","then","so","if","about","just","like","want","know","tell",
  "explain","mean","means","does","do",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && t.length > 1 && !STOP.has(t));
}

function scoreEntry(entry: KnowledgeEntry, qTokens: string[], qExpanded: string): number {
  if (qTokens.length === 0) return 0;
  let score = 0;
  const titleTokens = tokenize(entry.title);
  const titleSet = new Set(titleTokens);
  const kwSet = new Set(entry.keywords.flatMap((k) => tokenize(k)));

  for (const t of qTokens) {
    if (kwSet.has(t)) score += 3;
    if (titleSet.has(t)) score += 2;
    if (entry.answer.toLowerCase().includes(t)) score += 1;
  }
  // Whole-phrase keyword boost
  for (const k of entry.keywords) {
    if (qExpanded.includes(k)) score += 4;
  }
  return score;
}

function routeBoost(entry: KnowledgeEntry, route: RouteKnowledge | null): number {
  if (!route) return 0;
  const routeText = `${route.title} ${route.purpose}`.toLowerCase();
  let boost = 0;
  for (const k of entry.keywords) {
    if (routeText.includes(k)) boost += 1;
  }
  // If the route lists this question, big boost.
  for (const q of route.questions ?? []) {
    if (entry.title.toLowerCase().includes(q.toLowerCase().slice(0, 12))) boost += 3;
  }
  return boost;
}

/** Heuristic: if the question is a short follow-up referring to "it/them/this",
 * prepend the most recent topic to anchor the search. */
function applyFollowUpContext(question: string, ctx: AskContext): string {
  const lower = question.toLowerCase().trim();
  if (lower.length > 80) return question;
  const pronouns = /\b(it|them|that|this|those)\b/;
  if (!pronouns.test(lower)) return question;
  const last = ctx.recentExchanges?.slice(-1)[0];
  if (!last?.topic) return question;
  return `${last.topic} — ${question}`;
}

export function ask(question: string, ctx: AskContext): Answer {
  // 0) Safety refusal pre-filter — never answer trade-advice / bypass questions.
  const refusal = checkSafetyRefusal(question, ctx);
  if (refusal) return refusal;

  // 0a-element) UI element queries: "What is X?" / "What does X do?" / "Why is X disabled?"
  const elemAns = tryElementAnswer(question, ctx);
  if (elemAns) return elemAns;

  // 0a-glossary) "What does X mean?" / "Define X" / "What is X?" — glossary lookup.
  const glossAns = tryGlossaryAnswer(question);
  if (glossAns) return glossAns;

  // 0a-screen) "Explain this screen" — composed multi-section briefing.
  if (/\bexplain\s+(this\s+)?screen\b/i.test(question)) {
    return explainScreen(ctx);
  }

  // 0b) "What am I looking at?" — composed page-aware briefing.
  if (/\bwhat\s+(am\s+i\s+(looking\s+at|on)|is\s+this\s+page)\b/i.test(question)) {
    return whatAmILookingAt(ctx);
  }
  // 0c) "Why am I blocked?" — composed live-state diagnosis.
  if (/\bwhy\s+(am\s+i\s+blocked|is\s+this\s+blocked|can.?t\s+i)\b/i.test(question)) {
    return blockersToAnswer(ctx);
  }

  const followUpQ = applyFollowUpContext(question, ctx);
  const route = resolveRoute(ctx.route);
  const qExpanded = expandAliases(followUpQ);
  const qTokens = tokenize(qExpanded);

  // 1) Score the global KB.
  const ranked = ARX_KNOWLEDGE.map((e) => ({
    e,
    score: scoreEntry(e, qTokens, qExpanded) + routeBoost(e, route),
  }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length > 0 && ranked[0].score >= 3) {
    const top = ranked[0].e;
    const confidence = Math.min(1, ranked[0].score / 12);
    const rawRelated = top.related ?? (route?.related ?? []).map((r) => ({ label: r, route: r }));
    const related = filterValidRoutes(rawRelated);
    return {
      answer: top.answer,
      detail: top.detail,
      safety: top.safety,
      sourceId: top.id,
      matchType: "kb",
      confidence,
      related,
      nextAction: related[0],
    };
  }

  // 2) Route fallback — use the page's own knowledge entry.
  if (route) {
    const safety = route.safety;
    const related = filterValidRoutes((route.related ?? []).map((r) => ({ label: r, route: r })));
    return {
      answer: `${route.title} — ${route.purpose}`,
      detail: route.controls?.length ? `Main controls: ${route.controls.join(", ")}.` : undefined,
      safety,
      sourceId: `route:${route.route}`,
      matchType: "route",
      confidence: 0.4,
      related,
      nextAction: related[0],
    };
  }

  // 3) Final safe fallback. Never empty. Logs the miss for review.
  void logKnowledgeMiss(question, ctx);
  return {
    answer:
      "I don't have a page-specific note for this exact area yet, but here's what I know from the ARX app system: ARX is demo-only by default, the kill switch stays ON, and the MT5 bridge is deferred until you intentionally connect it. For anything not yet documented, the Help Center has the full library — and your question has been logged so it can be added.",
    detail:
      "Try rephrasing with a specific term (e.g. 'demo session', 'MT5 heartbeat', 'risk governor', 'emergency stop') or open the Help Center.",
    safety:
      "Even when a topic isn't documented, ARX safety locks remain on. The assistant never authorizes live trading.",
    sourceId: "fallback:miss",
    matchType: "miss",
    confidence: 0,
    related: [{ label: "Help Center", route: "/help" }, { label: "Readiness Checklist", route: "/readiness-checklist" }],
    nextAction: { label: "Help Center", route: "/help" },
  };
}

/** Quick-question chips to surface for the current route.
 * Now category-aware (Help / Trade / Risk / AI / MT5 / More) via pageActionChips.
 */
export function chipsForRoute(routePath: string): string[] {
  // Re-export the category-aware version so existing callers stay working.
  return pageActionChips(routePath);
}

/** "Why am I blocked?" — composed live-state diagnosis. */
export function whyBlocked(ctx: AskContext): Answer {
  return blockersToAnswer(ctx);
}

/** "Explain current status badges" — composed answer from badge KB. */
/** "Explain this screen" — registry-grounded composed briefing. */
export function explainScreen(ctx: AskContext): Answer {
  const route = resolveRoute(ctx.route);
  const visible = (ctx.safetyStatuses ?? [])
    .map((s) => findElement(s) ?? findElement(s.toLowerCase().replace(/\s+/g, "-")))
    .filter((m): m is NonNullable<typeof m> => !!m)
    .map((m) => m.element);
  const blockers = diagnoseBlockers(ctx);
  const safest = safestNextStep(ctx);
  const sections: string[] = [];
  if (route) sections.push(`Page: ${route.title} — ${route.purpose}`);
  if (visible.length) sections.push(`Visible badges: ${visible.map((v) => v.label).join(", ")}.`);
  if (blockers.length) sections.push(`Active blockers: ${blockers.map((b) => b.what).join("; ")}.`);
  sections.push(`Safest next step: ${safest.step}`);
  return {
    answer: sections.join(" "),
    detail: visible.length
      ? visible.map((v) => `• ${v.label} — ${v.explanation}`).join("\n")
      : undefined,
    safety: route?.safety ?? "Live trading remains unavailable; safety locks remain on.",
    sourceId: `screen:${ctx.route}`,
    matchType: "look",
    confidence: 0.85,
    related: [safest.openRoute],
    nextAction: safest.openRoute,
  };
}

/** UI element answer for "what is/does X" or "why is X disabled". */
function tryElementAnswer(question: string, ctx: AskContext): Answer | undefined {
  const q = question.trim();
  // crude extraction: "what is the X badge", "what does X do", "why is X disabled"
  const m = q.match(
    /\b(?:what\s+is|what\s+does|what.?s|why\s+is|why\s+can.?t\s+i\s+(?:press|use|click))\s+(?:the\s+)?(?:blue|red|green|amber|yellow|purple|orange|grey|gray)?\s*([\w\s:-]{2,40}?)\s*(?:badge|button|tab|menu|chip|control|element|do|mean|disabled|blocked|gated|here)?\??$/i,
  );
  const phrase = m?.[1]?.trim();
  if (!phrase || phrase.length < 4) return undefined;
  const match = findElement(phrase, ctx.route);
  if (!match) return undefined;
  // Only intercept on a confident label/alias/id hit, OR when the question
  // explicitly names an element-pointer word (badge / button / tab / etc.).
  const hasPointer = /\b(badge|button|tab|chip|menu|control|element)\b/i.test(q);
  if (match.via === "fuzzy" && !hasPointer) return undefined;
  const e = match.element;
  const isWhyDisabled = /disabled|blocked|gated|press|click/i.test(q);
  const detailLines = [
    `What it does: ${e.whatItDoes}`,
    `What it does not do: ${e.whatItDoesNot}`,
    e.requiredPermissions?.length ? `Required role: ${e.requiredPermissions.join(", ")}.` : null,
    isWhyDisabled && e.disabledReasons?.length ? `Common blockers: ${e.disabledReasons.join("; ")}.` : null,
    `Safe next: ${e.safeNextAction}`,
  ].filter(Boolean) as string[];
  const related = e.relatedRoute && resolveRoute(e.relatedRoute)
    ? [{ label: e.label, route: e.relatedRoute }]
    : [];
  return {
    answer: `${e.label} — ${e.explanation}`,
    detail: detailLines.join("\n"),
    safety: e.safetyNote,
    sourceId: `element:${e.id}`,
    matchType: "look",
    confidence: match.confidence,
    related,
    nextAction: related[0],
  };
}

export function explainBadges(ctx: AskContext): Answer {
  const a = ask("Explain current status badges", ctx);
  // Append any visible badges with one-line explanations.
  const visible = ctx.safetyStatuses ?? [];
  if (visible.length > 0) {
    const lines = visible
      .map((b) => {
        const match = ARX_KNOWLEDGE.find((e) =>
          e.keywords.some((k) => b.toLowerCase().includes(k.split(" ")[0])),
        );
        return match ? `• ${b} — ${match.answer}` : `• ${b} — (no entry)`;
      })
      .join("\n");
    return { ...a, detail: `${a.detail ?? ""}\n\nVisible right now:\n${lines}`.trim() };
  }
  return a;
}

/** "What should I do next?" — pinned safe-next-step answer. */
export function whatsNext(ctx: AskContext): Answer {
  return ask("What's the safest next step?", ctx);
}

/** Drop any related-route suggestion whose path doesn't actually exist. */
function filterValidRoutes(items: { label: string; route: string }[]): { label: string; route: string }[] {
  return items.filter((r) => !!resolveRoute(r.route));
}

/** "What am I looking at?" — composed briefing using route + badges + blockers. */
export function whatAmILookingAt(ctx: AskContext): Answer {
  const r = resolveRoute(ctx.route);
  const blockers = diagnoseBlockers(ctx);
  const badges = ctx.safetyStatuses ?? [];

  const lines: string[] = [];
  if (r) {
    lines.push(`You are on **${r.title}**.`);
    lines.push(`Purpose: ${r.purpose}`);
  } else {
    lines.push(`You are on the route \`${ctx.route}\` (no dedicated page entry yet).`);
  }
  if (badges.length) lines.push(`Visible status badges: ${badges.join(" · ")}`);
  if (r?.controls?.length) lines.push(`Main controls: ${r.controls.join(", ")}.`);
  lines.push(
    `Currently blocked: ${blockers.slice(0, 3).map((b) => b.what).join(" ")} ` +
    `These are protective — live trading remains unavailable until MT5 is connected and readiness is green.`,
  );
  lines.push(`Safest next step: stay in demo / simulator, run the readiness checklist, and review one replay.`);

  const related = filterValidRoutes(
    [
      ...(r?.related ?? []).map((x) => ({ label: x, route: x })),
      ...blockers.map((b) => b.openRoute).filter((x): x is { label: string; route: string } => !!x),
      { label: "Help Center", route: "/help" },
    ].filter((v, i, a) => a.findIndex((y) => y.route === v.route) === i),
  ).slice(0, 5);

  return {
    answer: lines.join("\n\n"),
    detail: r?.controls?.length ? `On this page you can: ${r.controls.join(", ")}.` : undefined,
    safety: r?.safety ?? "Safety locks remain enforced server-side regardless of what you click.",
    sourceId: r ? `look:${r.route}` : "look:unknown-route",
    matchType: "kb",
    confidence: 0.9,
    related,
    nextAction: related[0],
  };
}

/** Best-effort fire-and-forget miss logger. Never throws. */
async function logKnowledgeMiss(question: string, ctx: AskContext): Promise<void> {
  try {
    const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
    await fetch(`${BASE}/api/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: `[KB-MISS] ${question.slice(0, 80)}`,
        category: "OTHER",
        severity: "low",
        route: ctx.route,
        whatHappened: `Assistant could not answer:\n${question}\n\nRoute: ${ctx.route}\nMode: ${ctx.tradingModeHint ?? "n/a"}\nMT5: ${ctx.mt5Hint ?? "n/a"}\nBadges: ${(ctx.safetyStatuses ?? []).join(", ")}`,
        currentMode: "BETA_TESTER",
        mt5Status: ctx.mt5Hint ?? "deferred",
        context: {
          kind: "kb-miss",
          ts: new Date().toISOString(),
          badges: ctx.safetyStatuses ?? [],
          // Note: short-term follow-up memory (recentExchanges) is intentionally
          // NOT persisted — it must remain in-memory only for the tab session.
        },
      }),
    });
  } catch {
    /* swallow — assistant must keep working offline */
  }
}
