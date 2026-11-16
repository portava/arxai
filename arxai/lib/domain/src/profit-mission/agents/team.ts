// ── Profit Mission Phase 3 — agent team roster (pure data + mapping) ─────────
//
// PLANNING / ADVISORY ONLY. This module defines the specialist agent team a
// mission scouts the market with. It is pure data + classification helpers; it
// composes the EXISTING advisory/shadow agent ecosystem (lib/agent-system) by
// mapping each mission role onto a registry agentKey. Nothing here executes,
// gates, or forks strategy logic — proposals are analysis artifacts only.

/** Asset class a symbol belongs to (used to scope which agent proposes on it). */
export type AssetClass =
  | "forex"
  | "metals"
  | "synthetic"
  | "indices"
  | "stocks"
  | "crypto";

/** Constrained team-role vocabulary (mirrors mission_agents.agent_key). */
export type MissionAgentKey =
  | "SCALPER"
  | "TREND"
  | "REVERSAL"
  | "GOLD"
  | "SYNTHETIC"
  | "FOREX"
  | "RISK"
  | "JUDGE";

/** What the agent does in a scan: scout setups, review risk, or select. */
export type MissionAgentKind = "proposer" | "risk" | "judge";

export interface MissionAgentDef {
  agentKey: MissionAgentKey;
  name: string;
  role: string;
  kind: MissionAgentKind;
  /**
   * Registry agent (agents.agent_key) this mission role COMPOSES onto, so the
   * mission team reuses the existing ecosystem rather than inventing a parallel
   * one. null = a pure mission coordination role.
   */
  registryAgentKey: string | null;
  /**
   * Asset-class the proposer is scoped to. null = style-based (proposes across
   * all of the mission's allowed symbols regardless of asset class).
   */
  assetClassFocus: AssetClass | null;
  description: string;
}

/**
 * The fixed Phase 3 mission agent team: six proposers (style- or
 * asset-class-scoped), a Risk reviewer, and an Execution Judge. Order is the
 * canonical seed + display order.
 */
export const MISSION_AGENT_TEAM: readonly MissionAgentDef[] = [
  {
    agentKey: "SCALPER",
    name: "Scalper",
    role: "Scalp Momentum Specialist",
    kind: "proposer",
    registryAgentKey: "SCALP_AI",
    assetClassFocus: null,
    description: "Scouts fast, short-horizon momentum setups across allowed symbols.",
  },
  {
    agentKey: "TREND",
    name: "Trend",
    role: "Trend & Structure Specialist",
    kind: "proposer",
    registryAgentKey: "STRUCT",
    assetClassFocus: null,
    description: "Reads market structure and trades with the dominant directional bias.",
  },
  {
    agentKey: "REVERSAL",
    name: "Reversal",
    role: "Reversal & Timing Specialist",
    kind: "proposer",
    registryAgentKey: "PRECISION",
    assetClassFocus: null,
    description: "Spots exhaustion/turn setups and refines entry timing.",
  },
  {
    agentKey: "GOLD",
    name: "Gold",
    role: "Metals Specialist",
    kind: "proposer",
    registryAgentKey: "SCANNER_AI",
    assetClassFocus: "metals",
    description: "Scouts gold and other metals among the mission's allowed symbols.",
  },
  {
    agentKey: "SYNTHETIC",
    name: "Synthetic",
    role: "Synthetic Indices Specialist",
    kind: "proposer",
    registryAgentKey: "SCANNER_AI",
    assetClassFocus: "synthetic",
    description: "Scouts synthetic indices among the mission's allowed symbols.",
  },
  {
    agentKey: "FOREX",
    name: "Forex",
    role: "Forex Specialist",
    kind: "proposer",
    registryAgentKey: "SCANNER_AI",
    assetClassFocus: "forex",
    description: "Scouts FX pairs among the mission's allowed symbols.",
  },
  {
    agentKey: "RISK",
    name: "Risk",
    role: "Risk Governor (advisory)",
    kind: "risk",
    registryAgentKey: "RISK",
    assetClassFocus: null,
    description: "Reviews every proposal and attaches a veto/objection when capital is at risk.",
  },
  {
    agentKey: "JUDGE",
    name: "Execution Judge",
    role: "Execution Judge (selection only)",
    kind: "judge",
    registryAgentKey: "EXEC",
    assetClassFocus: null,
    description: "Marks a single best candidate or 'no trade'. Selection only — never executes.",
  },
] as const;

export const MISSION_AGENT_COUNT = MISSION_AGENT_TEAM.length; // 8

/** Lookup a team definition by its role key. */
export function getMissionAgentDef(agentKey: string): MissionAgentDef | null {
  return MISSION_AGENT_TEAM.find((a) => a.agentKey === agentKey) ?? null;
}

/**
 * Classify a symbol into an asset class from its ticker shape. Pure + best
 * effort; unknown shapes fall back to "forex" (the safest, most common class).
 */
export function classifyAssetClass(symbol: string): AssetClass {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^(XAU|XAG|XPT|XPD|GOLD|SILVER)/.test(s)) return "metals";
  if (/(BOOM|CRASH|VOLATILITY|^V\d|^R_|STEP|JUMP|RANGEBREAK|SYNTH)/.test(s)) return "synthetic";
  if (/(BTC|ETH|LTC|XRP|DOGE|SOL|ADA|USDT|USDC)/.test(s)) return "crypto";
  if (/(US30|US100|US500|NAS100|SPX|GER40|DAX|UK100|JP225|NDX|DJI|^SPX500)/.test(s)) return "indices";
  // Six-letter pairs of fiat codes → forex.
  if (/^[A-Z]{6}$/.test(s)) return "forex";
  // Anything else with letters but not a 6-letter pair → treat as a stock.
  if (/^[A-Z]{1,5}$/.test(s)) return "stocks";
  return "forex";
}

/**
 * Does this agent scout the given symbol? Proposers with an assetClassFocus
 * only propose on matching symbols; style-based proposers (null focus) propose
 * on all. Risk/Judge agents never propose (they review/select).
 */
export function agentProposesOn(agent: MissionAgentDef, symbol: string): boolean {
  if (agent.kind !== "proposer") return false;
  if (agent.assetClassFocus === null) return true;
  return classifyAssetClass(symbol) === agent.assetClassFocus;
}
