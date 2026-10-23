// (N) Build N — News & Economic Calendar Risk Filter routes.
//
// Composes:
//   - newsProvider.pickNewsProvider() (mock-by-default, replaceable)
//   - @workspace/domain/news-risk     (pure rules engine)
//   - economic_events / news_risk_reports tables
//   - alertManager.createAlert        (CRITICAL alert when NO_TRADE_WINDOW)
//   - vault BEHAVIOR audit            (every sync + report)
//
// Routes (all under /api):
//   GET  /economic-calendar/events?symbol=&daysAhead= — live provider-agnostic snapshot (TE or FRED)
//   POST /economic-events/sync         — pull from provider, upsert to DB
//   GET  /economic-events?currency=&impact=&days=
//   GET  /economic-events/upcoming?hours=N&minImpact=  — high-impact next N hrs
//   POST /news-risk/generate           — { symbol } → persisted report
//   GET  /news-risk/latest?symbol=     — most recent report for symbol
//
// Existing /news/calendar + /news/risk are preserved untouched.
//
// SAFETY: The CRITICAL alert generated on NO_TRADE_WINDOW bypasses every
// preference (per Build L contract). The trade-plan validate hook (added to
// tradePlans.ts) consults the latest report and surfaces it as a checklist
// item. Execution authority is unchanged — safetyCore is not touched here.

import { Router } from "express";
import { db, economicEventsTable, newsRiskReportsTable, vaultEventsTable } from "@workspace/db";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  scoreNewsRisk,
  detectVolatilitySpike,
  type ImpactLevel,
  type EconomicEventInput,
} from "@workspace/domain/news-risk";
import { pickNewsProvider } from "../lib/news/calendar/newsProvider.js";
import { createAlert } from "../lib/alerts/alertManager.js";
import {
  isCalendarProviderEnabled,
  getEnrichedCalendarEvents,
} from "../lib/news/economicCalendarProvider.js";
import {
  validateCalendarDateRange,
  runEconomicEventsSync,
} from "../lib/news/calendar/tradingEconomicsCore.js";
import { readNewsProvider } from "../lib/heat/marketHeatProviderStatus.js";

const router = Router();

async function vaultBehavior(kind: string, payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity: "INFO", source: "SYSTEM", truthDomain: "BEHAVIOR",
    summary: kind, payload, reasons: [], blockers: [],
    generatedAtIso: new Date().toISOString(),
  }).catch(() => { /* non-fatal */ });
}

function serializeEvent(r: typeof economicEventsTable.$inferSelect) {
  return { ...r, eventTime: r.eventTime.toISOString(), createdAt: r.createdAt.toISOString() };
}
function serializeReport(r: typeof newsRiskReportsTable.$inferSelect) {
  return { ...r, createdAt: r.createdAt.toISOString() };
}

function rowToEventInput(r: typeof economicEventsTable.$inferSelect): EconomicEventInput {
  return {
    id: r.id, eventName: r.eventName, currency: r.currency,
    impactLevel: r.impactLevel as ImpactLevel,
    eventTimeIso: r.eventTime.toISOString(),
    forecast: r.forecast, actual: r.actual,
    volatilityFlag: r.volatilityFlag === 1,
    affectedSymbols: r.affectedSymbols ?? null,
  };
}

// ── GET /economic-calendar/events ────────────────────────────────────────
// Query params:
//   symbol      — scope to one ARX symbol (optional)
//   daysAhead   — look-ahead window in days (default 7, max 30)
//   from        — ISO date lower bound (e.g. "2025-01-15"); overrides daysAhead start
//   to          — ISO date upper bound; overrides daysAhead end
//   currencies  — comma-separated currency codes to filter (e.g. "USD,EUR")
//   impact      — minimum impact level: "low" | "medium" | "high"
//   symbols     — comma-separated ARX symbols (additional symbol scope)
const LiveCalendarQuery = z.object({
  symbol:    z.string().optional(),
  daysAhead: z.coerce.number().int().min(1).max(30).default(7),
  from:      z.string().optional(),
  to:        z.string().optional(),
  currencies: z.string().optional(),
  impact:    z.enum(["low", "medium", "high"]).optional(),
  symbols:   z.string().optional(),
});

router.get("/economic-calendar/events", async (req, res): Promise<void> => {
  try {
    const q = LiveCalendarQuery.parse(req.query);
    // Strict from/to validation — reject malformed/inverted ranges with a 400
    // BEFORE any provider call. Never silently coerce an invalid date.
    const dateCheck = validateCalendarDateRange(q.from, q.to);
    if (!dateCheck.ok) {
      res.status(400).json({ error: dateCheck.error });
      return;
    }
    if (!isCalendarProviderEnabled()) {
      res.json({
        connected: false,
        provider: "none",
        configured: false,
        eventCount: 0,
        lastFetchAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
        freshnessStatus: "unavailable",
        events: [],
      });
      return;
    }
    const symbol = q.symbol ?? "";
    const filters = {
      from: q.from,
      to:   q.to,
      currencies: q.currencies ? q.currencies.split(",").map((c) => c.trim()).filter(Boolean) : undefined,
      impact: q.impact,
      symbols: q.symbols ? q.symbols.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    };
    const enriched = await getEnrichedCalendarEvents(symbol, Date.now(), q.daysAhead * 86400_000, filters);
    res.json({
      connected: enriched.connected,
      provider: enriched.provider,
      configured: true,
      eventCount: enriched.events.length,
      lastFetchAt: enriched.liveness.lastFetchAt,
      lastErrorAt: enriched.liveness.lastErrorAt,
      lastErrorMessage: enriched.liveness.lastErrorMessage,
      freshnessStatus: enriched.liveness.freshnessStatus,
      events: enriched.events,
    });
  } catch (err) {
    // ZodError from query parsing → 400 (client-side contract mismatch, not a server fault).
    const isZodError = err != null && typeof err === "object" && "issues" in err;
    if (isZodError) {
      res.status(400).json({ error: "Invalid query parameters" });
      return;
    }
    req.log.error({ err: String(err) }, "GET /economic-calendar/events failed");
    res.status(500).json({ error: "Failed to fetch live calendar events" });
  }
});

// ── POST /economic-events/sync ────────────────────────────────────────────
const SyncBody = z.object({ daysAhead: z.number().int().min(1).max(30).default(7) });

router.post("/economic-events/sync", async (req, res): Promise<void> => {
  try {
    const { daysAhead } = SyncBody.parse(req.body ?? {});
    // When no provider is configured the orchestrator short-circuits with an
    // explicit not_configured result and NEVER invokes `syncFromProvider` —
    // so no external fetch is attempted and no fake success is returned.
    const { status, body } = await runEconomicEventsSync({
      enabled: isCalendarProviderEnabled(),
      daysAhead,
      onError: (err) => req.log.error({ err: String(err) }, "POST /economic-events/sync provider fetch failed"),
      syncFromProvider: async () => {
        const provider = pickNewsProvider();
        const events = await provider.fetchEvents(daysAhead);
        let upserted = 0;
        for (const e of events) {
          const volatility = detectVolatilitySpike(e.actual, e.forecast) ? 1 : 0;
          await db.insert(economicEventsTable).values({
            externalId: e.externalId, eventName: e.eventName, country: e.country,
            currency: e.currency, impactLevel: e.impactLevel,
            forecast: e.forecast, previous: e.previous, actual: e.actual,
            eventTime: e.eventTime, source: e.source,
            affectedSymbols: e.affectedSymbols, volatilityFlag: volatility,
          }).onConflictDoUpdate({
            target: [economicEventsTable.source, economicEventsTable.externalId],
            set: {
              forecast: e.forecast, previous: e.previous, actual: e.actual,
              impactLevel: e.impactLevel, eventTime: e.eventTime,
              volatilityFlag: volatility,
            },
          });
          upserted++;
        }
        return { provider: provider.name, upserted };
      },
    });
    if (status === 200) {
      await vaultBehavior("ECONOMIC_EVENTS_SYNCED", {
        provider: body.provider, providerState: body.providerState,
        upserted: body.upserted, daysAhead,
      });
    }
    res.status(status).json(body);
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /economic-events/sync failed");
    res.status(500).json({ error: "Failed to sync economic events" });
  }
});

// ── GET /economic-events?currency=&impact=&days= ──────────────────────────
const ListQuery = z.object({
  currency: z.string().optional(),
  impact: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  days: z.coerce.number().int().min(1).max(30).default(7),
});

router.get("/economic-events", async (req, res): Promise<void> => {
  try {
    const q = ListQuery.parse(req.query);
    const since = new Date();
    const until = new Date(Date.now() + q.days * 86400000);
    const conds = [
      gte(economicEventsTable.eventTime, since),
      lte(economicEventsTable.eventTime, until),
    ];
    if (q.currency) conds.push(eq(economicEventsTable.currency, q.currency));
    if (q.impact)   conds.push(eq(economicEventsTable.impactLevel, q.impact));
    const rows = await db.select().from(economicEventsTable)
      .where(and(...conds))
      .orderBy(economicEventsTable.eventTime)
      .limit(500);
    res.json({ events: rows.map(serializeEvent) });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /economic-events failed");
    res.status(400).json({ error: "Invalid request" });
  }
});

// ── GET /economic-events/upcoming?hours=N&minImpact= ──────────────────────
const UpcomingQuery = z.object({
  hours: z.coerce.number().int().min(1).max(168).default(24),
  minImpact: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("HIGH"),
});

router.get("/economic-events/upcoming", async (req, res): Promise<void> => {
  try {
    const q = UpcomingQuery.parse(req.query);
    const ranks = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
    const allowed = ranks.slice(ranks.indexOf(q.minImpact));
    const since = new Date();
    const until = new Date(Date.now() + q.hours * 3600 * 1000);
    const rows = await db.select().from(economicEventsTable)
      .where(and(
        gte(economicEventsTable.eventTime, since),
        lte(economicEventsTable.eventTime, until),
      ))
      .orderBy(economicEventsTable.eventTime);
    const filtered = rows.filter((r) => allowed.includes(r.impactLevel));
    res.json({ events: filtered.map(serializeEvent), windowHours: q.hours, minImpact: q.minImpact });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /economic-events/upcoming failed");
    res.status(400).json({ error: "Invalid request" });
  }
});

// ── POST /news-risk/generate ──────────────────────────────────────────────
const GenerateBody = z.object({ symbol: z.string().min(1) });

export async function generateNewsRiskForSymbol(symbol: string) {
  // Pull events in a +/- 24h window (covers all spec rules).
  const since = new Date(Date.now() - 2 * 3600 * 1000);
  const until = new Date(Date.now() + 24 * 3600 * 1000);
  const eventRows = await db.select().from(economicEventsTable)
    .where(and(
      gte(economicEventsTable.eventTime, since),
      lte(economicEventsTable.eventTime, until),
    ));
  const result = scoreNewsRisk({
    symbol, events: eventRows.map(rowToEventInput),
  });

  const inserted = await db.insert(newsRiskReportsTable).values({
    symbol, relatedCurrency: result.relatedCurrency,
    eventId: result.event?.id ?? null,
    riskLevel: result.riskLevel,
    timeUntilEventMinutes: result.timeUntilEventMinutes,
    tradeWarning: result.tradeWarning,
    aiSummary: result.aiSummary,
    inputsSnapshot: JSON.stringify({ reasons: result.reasons, eventCount: eventRows.length }),
  }).returning();

  // (L+N) Surface as alert — CRITICAL when NO_TRADE_WINDOW (bypasses
  // preferences), HIGH on HIGH_RISK, MEDIUM on CAUTION.
  if (result.riskLevel !== "CLEAR") {
    const priority = result.riskLevel === "NO_TRADE_WINDOW" ? "CRITICAL"
                   : result.riskLevel === "HIGH_RISK" ? "HIGH" : "MEDIUM";
    const severity = result.riskLevel === "NO_TRADE_WINDOW" ? "danger"
                   : result.riskLevel === "HIGH_RISK" ? "warning" : "warning";
    void createAlert({
      type: "NEWS_RISK", priority, severity,
      title: `News risk: ${result.riskLevel.replace(/_/g, " ")} for ${symbol}`,
      message: result.tradeWarning ?? result.aiSummary,
      symbol,
      actionRequired: result.blockTrading,
      dedupeKey: `news-risk:${symbol}:${result.riskLevel}:${result.event?.id ?? "none"}`,
    });
  }

  await vaultBehavior("NEWS_RISK_REPORT_GENERATED", {
    id: inserted[0]!.id, symbol, label: result.riskLevel,
    eventId: result.event?.id ?? null, blockTrading: result.blockTrading,
  });

  return { row: inserted[0]!, result };
}

router.post("/news-risk/generate", async (req, res): Promise<void> => {
  try {
    const { symbol } = GenerateBody.parse(req.body);
    const { row, result } = await generateNewsRiskForSymbol(symbol);
    res.json({ ...serializeReport(row), reasons: result.reasons, blockTrading: result.blockTrading });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /news-risk/generate failed");
    res.status(400).json({ error: "Failed to generate news risk report" });
  }
});

// ── GET /news-risk/latest?symbol= ─────────────────────────────────────────
router.get("/news-risk/latest", async (req, res): Promise<void> => {
  try {
    const symbol = z.string().min(1).parse(req.query.symbol);
    const rows = await db.select().from(newsRiskReportsTable)
      .where(eq(newsRiskReportsTable.symbol, symbol))
      .orderBy(desc(newsRiskReportsTable.createdAt))
      .limit(1);
    if (!rows[0]) { res.status(404).json({ error: "No news risk report for symbol" }); return; }
    // Surface the SAME severity-ranked driving headlines as the Global Market
    // Heat card (via the shared `readNewsProvider` seam → `selectTopNewsHeadlines`)
    // so users get consistent, explainable risk on the per-symbol view too.
    // Fail-closed: a disconnected provider yields connected:false + empty
    // headlines — never a fabricated headline/source. Decision-support only.
    let news: {
      connected: boolean;
      provider: string;
      itemCount: number;
      highImpactCount: number;
      topHeadlines: Awaited<ReturnType<typeof readNewsProvider>>["topHeadlines"];
      updatedAt: string | null;
    };
    try {
      const newsRead = await readNewsProvider();
      news = {
        connected: newsRead.connected,
        provider: newsRead.provider,
        itemCount: newsRead.itemCount,
        highImpactCount: newsRead.highImpactCount,
        topHeadlines: newsRead.topHeadlines,
        updatedAt: newsRead.updatedAt,
      };
    } catch (newsErr) {
      // Honest: a probe failure is NOT an all-clear — report disconnected.
      req.log.warn({ err: String(newsErr) }, "news provider probe failed for /news-risk/latest");
      news = {
        connected: false,
        provider: "none",
        itemCount: 0,
        highImpactCount: 0,
        topHeadlines: [],
        updatedAt: null,
      };
    }
    res.json({ ...serializeReport(rows[0]), news });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /news-risk/latest failed");
    res.status(400).json({ error: "Invalid request" });
  }
});

void sql; // keep import used if future query needs it
export default router;
