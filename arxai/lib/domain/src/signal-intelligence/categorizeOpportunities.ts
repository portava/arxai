// categorizeOpportunities — turns a set of normalized scanner rows into a
// categorized opportunity map (Ready Now / Forming Soon / Watch After News /
// Too Late / Avoid / No Clean Setup) plus best scalp / retest / momentum /
// reversal picks, and a best-vs-selected comparison.
//
// PURE & deterministic: no IO, no Date.now(). It NEVER fabricates — rows with
// no live data can never land in READY_NOW; they collapse to NO_CLEAN_SETUP with
// an honest "awaiting live data" reason. The categorizer only re-shapes inputs
// the service already derived from REAL scanner reads (never simulator).

import type {
  BestVsSelected,
  OpportunityBestPicks,
  OpportunityCategory,
  OpportunityInput,
  OpportunityKind,
  OpportunityMapResult,
  OpportunityMapRow,
} from "./signalIntelligence.types.js";

const CATEGORY_ORDER: OpportunityCategory[] = [
  "READY_NOW",
  "FORMING_SOON",
  "WATCH_AFTER_NEWS",
  "TOO_LATE",
  "AVOID",
  "NO_CLEAN_SETUP",
];

function classifyKind(setupType: string): OpportunityKind {
  const s = setupType.toLowerCase();
  if (/reversal|sweep|liquidity|exhaustion|range|chop|fade/.test(s)) return "REVERSAL";
  if (/pullback|retest|continuation|break of structure|\bbos\b/.test(s)) return "RETEST";
  if (/trend|momentum|expansion|breakout|impulse/.test(s)) return "MOMENTUM";
  return "OTHER";
}

function categoryOf(r: OpportunityInput): OpportunityCategory {
  // 1. No live data → can never be called READY; honest awaiting state.
  if (!r.hasLiveData) return "NO_CLEAN_SETUP";
  // 2. Already chased → too late regardless of edge.
  if (r.isLate) return "TOO_LATE";
  // 3. News dominates safety: a high/critical event window means wait it out.
  if (r.newsRisk === "high" || r.newsRisk === "critical") return "WATCH_AFTER_NEWS";
  // 4. Scanner rejected, or edge too thin → avoid.
  if (r.recommendedAction === "REJECT" || r.edgeScore < 35) return "AVOID";
  // 5. Clean, ready-to-act setup.
  if (
    (r.recommendedAction === "BUY" || r.recommendedAction === "SELL") &&
    r.direction !== "NEUTRAL" &&
    r.edgeScore >= 55 &&
    r.entryQuality >= 50
  ) {
    return "READY_NOW";
  }
  // 6. Directional but not yet entry-ready.
  if (r.direction !== "NEUTRAL" && r.edgeScore >= 40) return "FORMING_SOON";
  // 7. Nothing clean.
  return "NO_CLEAN_SETUP";
}

function stageLabelOf(category: OpportunityCategory): string {
  switch (category) {
    case "READY_NOW": return "Ready now";
    case "FORMING_SOON": return "Forming soon";
    case "WATCH_AFTER_NEWS": return "Watch after news";
    case "TOO_LATE": return "Too late";
    case "AVOID": return "Avoid";
    case "NO_CLEAN_SETUP": return "No clean setup";
  }
}

function bestActionOf(r: OpportunityInput, category: OpportunityCategory): string {
  const side = r.direction === "BUY" ? "buy" : r.direction === "SELL" ? "sell" : "trade";
  switch (category) {
    case "READY_NOW":
      return `Entry is open — consider a ${side} and manage risk to the stop.`;
    case "FORMING_SOON":
      return "Watch — let the setup mature before acting.";
    case "WATCH_AFTER_NEWS":
      return "Wait for the news window to clear before acting.";
    case "TOO_LATE":
      return "Do not chase — wait for a pullback or the next setup.";
    case "AVOID":
      return "Skip — no clean edge here right now.";
    case "NO_CLEAN_SETUP":
      return r.hasLiveData
        ? "Nothing to do yet — keep watching."
        : "Awaiting live data before this market can be read.";
  }
}

function toRow(r: OpportunityInput): OpportunityMapRow {
  const category = categoryOf(r);
  return {
    ...r,
    category,
    kind: classifyKind(r.setupType),
    bestAction: bestActionOf(r, category),
    stageLabel: stageLabelOf(category),
  };
}

/** True when a row is a genuine, live, non-avoided candidate for a "best" pick. */
function isCandidate(row: OpportunityMapRow): boolean {
  return (
    row.hasLiveData &&
    row.direction !== "NEUTRAL" &&
    (row.category === "READY_NOW" || row.category === "FORMING_SOON")
  );
}

function pickByKind(
  rows: OpportunityMapRow[],
  kind: OpportunityKind,
): OpportunityMapRow | null {
  const pool = rows.filter((r) => isCandidate(r) && r.kind === kind);
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => b.edgeScore - a.edgeScore)[0]!;
}

export function categorizeOpportunities(
  inputs: OpportunityInput[],
): OpportunityMapResult {
  const rows = inputs.map(toRow);

  const categories = Object.fromEntries(
    CATEGORY_ORDER.map((c) => [c, [] as OpportunityMapRow[]]),
  ) as Record<OpportunityCategory, OpportunityMapRow[]>;
  for (const row of rows) categories[row.category].push(row);
  // Within each bucket, strongest edge first.
  for (const c of CATEGORY_ORDER) {
    categories[c].sort((a, b) => b.edgeScore - a.edgeScore);
  }

  const candidates = rows.filter(isCandidate);
  const bestScalp =
    candidates.length > 0
      ? [...candidates].sort((a, b) => b.entryQuality - a.entryQuality)[0]!
      : null;

  const best: OpportunityBestPicks = {
    bestScalp,
    bestRetest: pickByKind(rows, "RETEST"),
    bestMomentum: pickByKind(rows, "MOMENTUM"),
    bestReversal: pickByKind(rows, "REVERSAL"),
  };

  return {
    rows,
    categories,
    best,
    scannedCount: rows.length,
    liveCount: rows.filter((r) => r.hasLiveData).length,
  };
}

/** Edge margin (points) by which an alternative must beat the selected to surface. */
const CLEANER_MARGIN = 12;

export function compareBestVsSelected(
  result: OpportunityMapResult,
  selectedSymbol: string | null,
): BestVsSelected {
  const selected = selectedSymbol
    ? result.rows.find((r) => r.symbol === selectedSymbol) ?? null
    : null;
  // Display-honesty cap: only expose the selected symbol's edge when it has live
  // data. A no-live-data symbol's edge is simulator-derived, so it must NEVER be
  // surfaced on the Opportunity Map (incl. the "vs <edge>" banner copy or the
  // selectedEdge DTO). With no comparable baseline the banner falls through to
  // the standalone "cleaner opportunity" wording instead.
  const selectedEdge = selected && selected.hasLiveData ? selected.edgeScore : null;

  // The strongest live, ready/forming alternative (READY_NOW preferred via edge).
  const ranked = result.rows
    .filter((r) => r.symbol !== selectedSymbol && isCandidate(r))
    .sort((a, b) => {
      const ra = a.category === "READY_NOW" ? 1 : 0;
      const rb = b.category === "READY_NOW" ? 1 : 0;
      if (ra !== rb) return rb - ra;
      return b.edgeScore - a.edgeScore;
    });
  const best = ranked[0] ?? null;

  if (!best) {
    return {
      hasCleanerAlternative: false,
      selectedSymbol,
      selectedEdge,
      best: null,
      message: null,
    };
  }

  const beatsSelected =
    selectedEdge == null ? best.edgeScore >= 55 : best.edgeScore - selectedEdge >= CLEANER_MARGIN;

  if (!beatsSelected) {
    return {
      hasCleanerAlternative: false,
      selectedSymbol,
      selectedEdge,
      best,
      message: null,
    };
  }

  const vs =
    selectedEdge == null
      ? `${best.displayName} looks like a cleaner opportunity (edge ${Math.round(best.edgeScore)}/100).`
      : `${best.displayName} looks cleaner than ${selected?.displayName ?? selectedSymbol} right now (edge ${Math.round(best.edgeScore)} vs ${Math.round(selectedEdge)}).`;

  return {
    hasCleanerAlternative: true,
    selectedSymbol,
    selectedEdge,
    best,
    message: vs,
  };
}
