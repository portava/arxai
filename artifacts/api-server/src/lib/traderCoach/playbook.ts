// Build II — Playbook Generator.
//
// SAFETY: read CC strategy edges + mistake patterns and turn them into
// playbook entries. Pure persistence + idempotent upsert. NEVER places
// trades, NEVER calls MT5, NEVER recommends live trading.

import { randomUUID } from "node:crypto";
import {
  db,
  tradingPlaybookEntriesTable,
  strategyEdgesTable,
  mistakePatternsTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";

export type PlaybookStatus = "ACTIVE" | "WATCHLIST" | "AVOID" | "REVIEW";
export type ConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";

export interface PlaybookEntry {
  playbook_entry_id: string;
  title: string;
  status: PlaybookStatus;
  symbol: string;
  timeframe: string;
  setupName: string;
  actionBias: string;
  conditionsRequired: string[];
  entryRules: string[];
  riskRules: string[];
  invalidationRules: string[];
  marketDataRequirements: string[];
  sniperEntryRequirements: string[];
  mistakeWarnings: string[];
  confidenceLevel: ConfidenceLevel;
  sampleSize: number;
  winRate: number;
  avgPnl: number;
  edgeScore: number;
  lastUpdated: string;
  source: "SYSTEM_GENERATED";
}

export interface PlaybookUpdateSummary {
  playbook_entry_id: string;
  title: string;
  status: PlaybookStatus;
  symbol: string;
  setupName: string;
  actionBias: string;
  changeType: "CREATED" | "UPDATED";
  edgeScore: number;
  sampleSize: number;
  winRate: number;
}

interface Logger {
  info: (m: string, x?: Record<string, unknown>) => void;
  warn: (m: string, x?: Record<string, unknown>) => void;
  error: (m: string, x?: Record<string, unknown>) => void;
}
const NOOP_LOG: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function classifyEdge(args: { sampleCount: number; winRate: number; edgeScore: number }): { status: PlaybookStatus; confidence: ConfidenceLevel } {
  const { sampleCount, winRate, edgeScore } = args;
  // Rules:
  //  - Small sample is always WATCHLIST regardless of win rate.
  //  - Negative edge with enough sample is REVIEW or AVOID.
  //  - Strong positive edge with large sample is ACTIVE.
  if (sampleCount < 5) return { status: "WATCHLIST", confidence: "LOW" };
  if (edgeScore <= -25 && sampleCount >= 10) return { status: "AVOID", confidence: "MEDIUM" };
  if (edgeScore < 0) return { status: "REVIEW", confidence: sampleCount >= 20 ? "MEDIUM" : "LOW" };
  if (edgeScore >= 30 && winRate >= 55 && sampleCount >= 30) return { status: "ACTIVE", confidence: "HIGH" };
  if (edgeScore >= 15 && sampleCount >= 15) return { status: "ACTIVE", confidence: "MEDIUM" };
  return { status: "WATCHLIST", confidence: sampleCount >= 10 ? "MEDIUM" : "LOW" };
}

interface GeneratePlaybookOpts {
  edges?: { symbol: string; signalName: string; action: string; sampleCount: number; winCount: number; lossCount: number; netPnl: number; avgPnl: number; edgeScore: number }[];
  mistakes?: { tag: string; symbol: string; action: string; count: number; severityScore: number; recommendedGuardrail: string }[];
  log?: Logger;
}

export async function generatePlaybook(opts: GeneratePlaybookOpts = {}): Promise<PlaybookUpdateSummary[]> {
  const log = opts.log ?? NOOP_LOG;
  let edges = opts.edges ?? [];
  let mistakes = opts.mistakes ?? [];
  if (!opts.edges) {
    try { edges = await db.select().from(strategyEdgesTable); }
    catch (err) { log.warn("Build II playbook: strategy_edges unavailable, returning safe-empty", { err: String(err) }); return []; }
  }
  if (!opts.mistakes) {
    try { mistakes = await db.select().from(mistakePatternsTable); }
    catch (err) { log.warn("Build II playbook: mistake_patterns unavailable, continuing without warnings", { err: String(err) }); mistakes = []; }
  }

  log.info("Build II playbook: generation started", { edges: edges.length, mistakes: mistakes.length });

  const summaries: PlaybookUpdateSummary[] = [];

  for (const e of edges) {
    if (!e.symbol || !e.signalName || !e.action) continue;
    const setupName = e.signalName;
    const actionBias = e.action;
    const symbol = e.symbol;
    const winRate = e.sampleCount > 0 ? Number(((e.winCount / e.sampleCount) * 100).toFixed(2)) : 0;

    const { status, confidence } = classifyEdge({
      sampleCount: e.sampleCount,
      winRate,
      edgeScore: e.edgeScore ?? 0,
    });

    const title = `${symbol} — ${setupName} (${actionBias})`;

    const conditionsRequired = [
      `Symbol must be ${symbol}`,
      `Action bias is ${actionBias}`,
      `Signal "${setupName}" must be present in the AA decision payload`,
      "Risk Governor must currently allow paper trading",
      "Market data quality must be GOOD",
    ];
    const entryRules = [
      "AA decision shouldTrade must be true",
      "AI decision confidence must meet your minimum threshold",
      "Sniper score must pass the configured threshold",
      "No active per-symbol cooldown for this symbol",
    ];
    const riskRules = [
      "Stop loss is mandatory",
      "Take profit is mandatory",
      "Risk score must be below your configured maximum",
      "Position size must respect risk_settings.maxOpenTrades",
    ];
    const invalidationRules = [
      "Edge score drops below 0 over the next 10 paper trades",
      "Cumulative P&L for this setup turns negative for 5 consecutive trades",
      "Mistake pattern recurrence on this symbol/action exceeds severity 50",
    ];
    const marketDataRequirements = [
      "Market data mode is read_only",
      "No FALLBACK_ONLY or FAILED data quality flag",
      "Spread is acceptable for the symbol",
    ];
    const sniperEntryRequirements = [
      "Sniper score >= configured threshold",
      "Trade window is GOOD per the trading calendar",
      "No conflicting open paper trade on this symbol",
    ];

    // Mistake warnings: pull any mistake pattern matching this symbol or any (action match preferred).
    const matchingMistakes = mistakes.filter(m =>
      (m.symbol === symbol || m.symbol === "") &&
      (m.action === actionBias || m.action === "")
    );
    const mistakeWarnings = matchingMistakes.slice(0, 5).map(m =>
      `${m.tag}${m.symbol ? ` on ${m.symbol}` : ""} (${m.count}× / severity ${m.severityScore.toFixed(1)}): ${m.recommendedGuardrail || "Pause and re-check the playbook before proceeding."}`
    );

    const playbookEntryId = `pbk_${symbol}_${setupName}_${actionBias}`.replace(/[^A-Za-z0-9_]/g, "_");

    // Idempotent upsert by (symbol, setupName, actionBias).
    const existing = await db.select().from(tradingPlaybookEntriesTable)
      .where(and(
        eq(tradingPlaybookEntriesTable.symbol, symbol),
        eq(tradingPlaybookEntriesTable.setupName, setupName),
        eq(tradingPlaybookEntriesTable.actionBias, actionBias),
      )).limit(1);

    const baseValues = {
      title,
      status,
      symbol,
      timeframe: "",
      setupName,
      actionBias,
      conditionsRequired: conditionsRequired as unknown as Record<string, unknown>[],
      entryRules: entryRules as unknown as Record<string, unknown>[],
      riskRules: riskRules as unknown as Record<string, unknown>[],
      invalidationRules: invalidationRules as unknown as Record<string, unknown>[],
      marketDataRequirements: marketDataRequirements as unknown as Record<string, unknown>[],
      sniperEntryRequirements: sniperEntryRequirements as unknown as Record<string, unknown>[],
      mistakeWarnings: mistakeWarnings as unknown as Record<string, unknown>[],
      confidenceLevel: confidence,
      sampleSize: e.sampleCount,
      winRate,
      avgPnl: e.avgPnl,
      edgeScore: e.edgeScore,
      source: "SYSTEM_GENERATED" as const,
      updatedAt: new Date(),
    };

    if (existing[0]) {
      await db.update(tradingPlaybookEntriesTable)
        .set(baseValues)
        .where(eq(tradingPlaybookEntriesTable.id, existing[0].id));
      summaries.push({
        playbook_entry_id: existing[0].playbookEntryId,
        title, status, symbol, setupName, actionBias,
        changeType: "UPDATED", edgeScore: e.edgeScore, sampleSize: e.sampleCount, winRate,
      });
    } else {
      const newId = playbookEntryId || `pbk_${randomUUID()}`;
      await db.insert(tradingPlaybookEntriesTable).values({
        playbookEntryId: newId,
        ...baseValues,
      });
      summaries.push({
        playbook_entry_id: newId,
        title, status, symbol, setupName, actionBias,
        changeType: "CREATED", edgeScore: e.edgeScore, sampleSize: e.sampleCount, winRate,
      });
    }
  }

  log.info("Build II playbook: generation completed", {
    created: summaries.filter(s => s.changeType === "CREATED").length,
    updated: summaries.filter(s => s.changeType === "UPDATED").length,
  });
  return summaries;
}

export async function listPlaybookEntries(limit = 100) {
  return db.select().from(tradingPlaybookEntriesTable)
    .orderBy(desc(tradingPlaybookEntriesTable.edgeScore))
    .limit(limit);
}

export async function getPlaybookEntry(id: string) {
  const rows = await db.select().from(tradingPlaybookEntriesTable)
    .where(eq(tradingPlaybookEntriesTable.playbookEntryId, id)).limit(1);
  return rows[0] ?? null;
}
