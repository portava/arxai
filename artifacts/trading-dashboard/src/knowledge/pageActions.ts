/**
 * Page-category quick-action chips for the assistant.
 * Categorises the current route and returns a tailored set of chips, layered
 * on top of the route's own questions.
 */
import { resolveRoute } from "./routeKnowledge";

export type PageCategory = "help" | "trade" | "risk" | "ai" | "mt5" | "more" | "default";

export function categorizeRoute(routePath: string): PageCategory {
  const r = routePath.toLowerCase();
  if (r === "/help" || r.startsWith("/help-") || r === "/playbook") return "help";
  if (r.startsWith("/risk")) return "risk";
  if (r.includes("mt5") || r.includes("bridge") || r.includes("broker")) return "mt5";
  if (r.includes("ai-") || r.includes("coach") || r.includes("autopilot") || r.includes("mentor")) return "ai";
  if (
    r.includes("trade") || r.includes("ticket") || r === "/scanner" || r === "/orders" ||
    r.startsWith("/orders/") || r.startsWith("/positions") || r === "/manual-trade-ticket" ||
    r === "/demo-trading"
  ) return "trade";
  if (r === "/" || r === "/dashboard" || r === "/more") return "more";
  return "default";
}

const CATEGORY_CHIPS: Record<PageCategory, string[]> = {
  help: [
    "What am I looking at?",
    "Why am I blocked?",
    "Explain current badges",
    "What should I do next?",
  ],
  trade: [
    "Why is live trading disabled?",
    "Can I place a demo trade?",
    "What is blocking execution?",
    "Explain order safety",
  ],
  risk: [
    "What does Risk protect?",
    "Why did risk block me?",
    "What is my safest next step?",
    "Explain account protection",
  ],
  ai: [
    "What does the AI coach do?",
    "Can AI place trades?",
    "What does autopilot blocked mean?",
    "What does ARX analyze?",
  ],
  mt5: [
    "What is heartbeat?",
    "Why is MT5 deferred?",
    "How do I connect MT5?",
    "Why is broker read-only?",
  ],
  more: [
    "What is under More?",
    "Where is broker setup?",
    "Where is replay?",
    "Where is data?",
    "Where is emergency stop?",
  ],
  default: [
    "What am I looking at?",
    "Why am I blocked?",
    "Explain current badges",
    "What should I do next?",
  ],
};

export function pageActionChips(routePath: string): string[] {
  const cat = categorizeRoute(routePath);
  const chips = [...CATEGORY_CHIPS[cat]];
  // Mix in route-specific questions if present (deduped, capped at 6).
  const r = resolveRoute(routePath);
  for (const q of r?.questions ?? []) if (!chips.includes(q)) chips.push(q);
  return chips.slice(0, 6);
}
