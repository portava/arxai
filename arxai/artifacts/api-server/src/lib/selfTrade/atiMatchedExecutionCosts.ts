import type { readAtiExecutionCosts } from "./atiExecutionCosts.js";
import { ATI_FLEET_ENGINE } from "./atiFleetDefinition.js";
import { reportAtiEntryStrategies } from "./atiRoundTrips.js";

export type AtiReviewedPositions = Awaited<ReturnType<typeof readAtiExecutionCosts>>["live"]["roundTrips"]["positions"];
export type AtiEntryIdentity = { agentId: number; revision: string; symbol: string; timeframe: string; setup: string; decisionSettingsHash: string };

/** Every opening fill must belong to a selected native decision, including scale-ins. */
export function costsForEntryDecisions(positions: AtiReviewedPositions, decisions: ReadonlySet<number>, identity: AtiEntryIdentity) {
  const matched: AtiReviewedPositions = [];
  const linked = new Set<number>();
  const reconciled = new Set<number>();
  let unresolvedPositionsWithLinkedEntry = 0, positionsWithOtherOpeningDecisions = 0;
  for (const position of positions) {
    const entries = position.deals.filter(row => row.leg === "ENTRY");
    const scoped = entries.flatMap(row => {
      const admission = row.entryStrategy;
      if (!admission || !decisions.has(admission.decisionId)) return [];
      const strategy = admission.strategy;
      return strategy.engine === ATI_FLEET_ENGINE && strategy.revision === identity.revision &&
        strategy.agentId === identity.agentId && strategy.symbol === identity.symbol && strategy.timeframe === identity.timeframe &&
        strategy.setup === identity.setup && strategy.decisionSettingsHash === identity.decisionSettingsHash ? [admission.decisionId] : [];
    });
    if (!scoped.length) continue;
    for (const id of scoped) linked.add(id);
    if (position.state !== "OBSERVED_BROKER_ROUND_TRIP") unresolvedPositionsWithLinkedEntry++;
    else if (position.attribution !== "VERIFIED_ENTRY_STRATEGY" || scoped.length !== entries.length) positionsWithOtherOpeningDecisions++;
    else {
      matched.push(position);
      for (const id of scoped) reconciled.add(id);
    }
  }
  return { decisionsWithLinkedOpeningFill: linked.size,
    decisionsWithReconciledPosition: reconciled.size, reconciledPositions: matched.length,
    unresolvedPositionsWithLinkedEntry, positionsWithOtherOpeningDecisions,
    byEntryStrategy: reportAtiEntryStrategies(matched).byEntryStrategy };
}
