/**
 * ARX glossary — canonical short definitions for every term the assistant
 * may be asked to explain. Used by `findGlossary()` and surfaced in the
 * Assistant Manual + Knowledge Console.
 *
 * Definitions are deliberately short and source-of-truth. They never claim
 * live trading is enabled.
 */
export interface GlossaryEntry {
  /** Stable id used in source attribution. */
  id: string;
  term: string;
  aliases?: string[];
  definition: string;
  related?: string[];
}

export const GLOSSARY: GlossaryEntry[] = [
  { id: "g-arx", term: "ARX AI", aliases: ["ARX", "the app"], definition: "AI trading command center built around three disciplines: Analyze, Risk, eXecute. Paper-first by design." },
  { id: "g-tagline", term: "Analyze. Risk. eXecute.", aliases: ["arx tagline", "brand tagline"], definition: "ARX brand promise. Each screen reflects one of those three steps." },
  { id: "g-cockpit", term: "Cockpit", aliases: ["dashboard"], definition: "Primary at-a-glance view: balance, P&L, win rate, drawdown, latest signals." },
  { id: "g-trade", term: "Trade", aliases: ["trade tab", "trading workspace"], definition: "Trade Command Room — manual ticket, positions, scanner shortcuts. Demo-only by default." },
  { id: "g-risk", term: "Risk", aliases: ["risk tab"], definition: "Risk Command Center — caps, governor rules, kill-switch access. Server-enforced." },
  { id: "g-ai-coach", term: "AI Coach", aliases: ["coach"], definition: "Post-trade coaching surface — analyses recent paper trades for feedback." },
  { id: "g-replay", term: "Replay", aliases: ["replay simulator"], definition: "Replays historical candles so strategies can be tested against past data." },
  { id: "g-data", term: "Data", aliases: ["data import", "my data"], definition: "Data import + quality view — load CSV candle data and inspect rows." },
  { id: "g-readiness", term: "Readiness", aliases: ["readiness checklist"], definition: "Aggregate of every gate that must be green before live operation can even be considered." },
  { id: "g-mt5", term: "MT5", aliases: ["metatrader", "metatrader 5"], definition: "MetaTrader 5 — the broker platform ARX optionally talks to via a bridge." },
  { id: "g-bridge", term: "Bridge", aliases: ["mt5 bridge"], definition: "The connector between ARX and MT5. Off by default; requires the MT5_BRIDGE_TOKEN secret." },
  { id: "g-heartbeat", term: "Heartbeat", aliases: ["bridge heartbeat"], definition: "Recent ping from the MT5 EA proving the bridge is alive with the right token." },
  { id: "g-ea", term: "Expert Advisor", aliases: ["ea"], definition: "MT5 script (the EA) that pings the bridge and forwards events. You install it inside MT5 yourself." },
  { id: "g-simulator", term: "Simulator Mode", aliases: ["sim mode"], definition: "Strategy scans run against synthetic candles instead of real market data." },
  { id: "g-sim-engine", term: "Sim Engine", aliases: ["engine"], definition: "The 5-second simulator scan loop that re-evaluates synthetic candles." },
  { id: "g-demo-only", term: "Demo Mode", aliases: ["demo", "demo mode"], definition: "Trades route to your per-user MT5 demo account once you're VERIFIED_DEMO and armed. No live broker is touched." },
  { id: "g-live-disabled", term: "Live Trading Disabled", aliases: ["live disabled"], definition: "Server-enforced lock that blocks every live trading code path. Cannot be toggled by the assistant or client." },
  { id: "g-live-broker-exec", term: "Live Broker Execution Disabled", aliases: ["broker execution disabled"], definition: "Order router will not forward orders even if a bridge is connected. Two-layer guard with the bridge." },
  { id: "g-broker-readonly", term: "Broker Read-Only", aliases: ["read-only broker"], definition: "Broker connection (when present) accepts no orders — reads only." },
  { id: "g-autopilot-blocked", term: "Autopilot Blocked", aliases: ["autopilot off"], definition: "AI Autopilot will not start because one or more readiness gates are failing." },
  { id: "g-intent", term: "Intent", aliases: ["setup intent", "intents"], definition: "A candidate trading setup the engine has identified — not an order, just a flagged opportunity." },
  { id: "g-emergency-stop", term: "Emergency Stop", aliases: ["kill switch"], definition: "Hard stop that halts paper, sim, and any live flow immediately. Always wins. Must be cleared manually." },
  { id: "g-safety-lock", term: "Safety Lock", aliases: ["lock"], definition: "Any server-enforced guard (kill switch, risk lock, live-disabled, broker read-only) that cannot be bypassed from the UI." },
  { id: "g-blocker", term: "Blocker", aliases: [], definition: "A specific reason an action cannot run right now — surfaced by the blocker diagnostic engine with a fix path." },
  { id: "g-checklist", term: "Setup Checklist", aliases: ["setup"], definition: "Ordered onboarding items the assistant tracks; never auto-completed without real evidence from app state." },
  { id: "g-knowledge-gap", term: "Knowledge Gap", aliases: ["kb miss"], definition: "A user question the assistant could not answer — logged so missing knowledge can be added." },
  { id: "g-tester", term: "Full Tester Access", aliases: ["tester role"], definition: "TESTER-level visibility unlocks diagnostics + feedback + console pages, but not destructive admin actions." },
];

const ALIAS_MAP: Map<string, GlossaryEntry> = (() => {
  const m = new Map<string, GlossaryEntry>();
  for (const g of GLOSSARY) {
    m.set(g.term.toLowerCase(), g);
    for (const a of g.aliases ?? []) m.set(a.toLowerCase(), g);
  }
  return m;
})();

export function findGlossary(query: string): GlossaryEntry | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  if (ALIAS_MAP.has(q)) return ALIAS_MAP.get(q);
  // tolerate trailing punctuation
  const cleaned = q.replace(/[?.!,]+$/g, "").trim();
  if (ALIAS_MAP.has(cleaned)) return ALIAS_MAP.get(cleaned);
  return undefined;
}
