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

// ── Stored-calendar coverage ──────────────────────────────────────────────
// Every "upcoming events" read below comes from the economic_events table,
// which is filled ONLY by POST /economic-events/sync (no scheduler). A
// connected provider therefore says nothing about what the table holds: it
// may be empty (never synced) or end days ago. An empty result is only a
// real "no events" when the stored calendar runs at least to the end of the
// window asked about. Otherwise events cannot be ruled out, and the
// response says so instead of a bare empty list.

export interface StoredCalendarCoverage {
  source: "ECONOMIC_EVENTS_TABLE";
  /** A calendar provider is configured (it does not mean the table was synced). */
  providerConfigured: boolean;
  /** Rows in the stored calendar, all time. 0 = never synced. */
  storedEventCount: number;
  /** Latest event time held in the stored calendar (ISO), or null when empty. */
  coveredThrough: string | null;
  /** End of the window this read asked about (ISO). */
  windowEnd: string;
  /** True only when the stored calendar reaches the end of the window. */
  windowCovered: boolean;
  /** Plain statement when the window is not covered; null when it is. */
  note: string | null;
}

export async function readStoredCalendarCoverage(windowEnd: Date): Promise<StoredCalendarCoverage> {
  const providerConfigured = isCalendarProviderEnabled();
  const [agg] = await db.select({
    n: sql<number>`count(*)::int`,
    latest: sql<string | Date | null>`max(${economicEventsTable.eventTime})`,
  }).from(economicEventsTable);
  const storedEventCount = Number(agg?.n ?? 0);
  const latestMs = agg?.latest != null ? new Date(agg.latest).getTime() : NaN;
  const coveredThrough = Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : null;
  const windowCovered = storedEventCount > 0 && Number.isFinite(latestMs) && latestMs >= windowEnd.getTime();
  const how = providerConfigured
    ? "Sync events on the Economic Calendar page to refresh it."
    : "No economic-calendar provider is configured.";
  const note = windowCovered
    ? null
    : storedEventCount === 0 || coveredThrough === null
      ? `The stored economic calendar is empty (events have never been synced), so upcoming events cannot be ruled out. ${how}`
      : `The stored economic calendar only runs to ${coveredThrough}; events after that have not been synced, so they cannot be ruled out. ${how}`;
  return {
    source: "ECONOMIC_EVENTS_TABLE",
    providerConfigured,
    storedEventCount,
    coveredThrough,
    windowEnd: windowEnd.toISOString(),
    windowCovered,
    note,
  };
}

// ── Report age ────────────────────────────────────────────────────────────
// A persisted news-risk report is a scan from the past: its riskLevel and
// timeUntilEventMinutes were computed when the scan ran. A report older than
// this window is not the current risk (same window as the dashboard's
// NewsRiskCard, NEWS_RISK_REPORT_CURRENT_MAX_AGE_MS). Unknown or future-
// stamped (beyond the clock-skew allowance) ages are never current.
export const NEWS_RISK_REPORT_CURRENT_MAX_AGE_MS = 5 * 60_000;
const REPORT_AGE_SKEW_MS = 5_000;

export interface NewsRiskReportAge {
  /** When the scan ran (ISO), or null when its time is unusable. */
  generatedAt: string | null;
  /** Whole minutes since the scan; null when unknown or stamped in the future. */
  ageMinutes: number | null;
  /** True only when the scan is no older than maxCurrentAgeMinutes. */
  current: boolean;
  maxCurrentAgeMinutes: number;
  /** Plain-English statement when the report is not current; null when it is. */
  note: string | null;
}

export function newsRiskReportAge(createdAt: Date | string | null | undefined, nowMs: number): NewsRiskReportAge {
  const ms = createdAt == null ? NaN : new Date(createdAt).getTime();
  const maxCurrentAgeMinutes = NEWS_RISK_REPORT_CURRENT_MAX_AGE_MS / 60_000;
  if (!Number.isFinite(ms) || ms > nowMs + REPORT_AGE_SKEW_MS) {
    return {
      generatedAt: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
      ageMinutes: null, current: false, maxCurrentAgeMinutes,
      note: "When this news-risk scan ran could not be confirmed, so it is not the current risk. Run a new scan for a current read.",
    };
  }
  const ageMs = Math.max(0, nowMs - ms);
  const ageMinutes = Math.floor(ageMs / 60_000);
  const current = ageMs <= NEWS_RISK_REPORT_CURRENT_MAX_AGE_MS;
  const ago = ageMinutes < 120 ? `${ageMinutes} minute${ageMinutes === 1 ? "" : "s"} ago`
    : ageMinutes < 2880 ? `${Math.floor(ageMinutes / 60)} hours ago` : `${Math.floor(ageMinutes / 1440)} days ago`;
  return {
    generatedAt: new Date(ms).toISOString(),
    ageMinutes,
    current,
    maxCurrentAgeMinutes,
    note: current
      ? null
      : `This news-risk scan ran ${ago} (at ${new Date(ms).toISOString()}), so it is not the current risk. Its risk level and minutes-to-event are from scan time. Run a new scan for a current read.`,
  };
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

// ── GET /economic-events?currency=&impact=&days=&pastHours= ───────────────
// Window: eventTime in [now - pastHours, now + days*24h]. The window is rolling
// hours from now, not calendar days. `pastHours` (additive, default 0) lets a
// caller include events already released earlier today.
const ListQuery = z.object({
  currency: z.string().optional(),
  impact: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  days: z.coerce.number().int().min(1).max(30).default(7),
  pastHours: z.coerce.number().int().min(0).max(48).default(0),
});

router.get("/economic-events", async (req, res): Promise<void> => {
  try {
    const q = ListQuery.parse(req.query);
    const nowMs = Date.now();
    const since = new Date(nowMs - q.pastHours * 3600_000);
    const until = new Date(nowMs + q.days * 86400000);
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
  // Optional look-back so a caller can keep showing an event that has JUST
  // released (its post-release volatility window is still active). Default 0
  // keeps the original "eventTime >= now" semantics for every other caller.
  pastMinutes: z.coerce.number().int().min(0).max(120).default(0),
});

router.get("/economic-events/upcoming", async (req, res): Promise<void> => {
  try {
    const q = UpcomingQuery.parse(req.query);
    const ranks = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
    const allowed = ranks.slice(ranks.indexOf(q.minImpact));
    const since = new Date(Date.now() - q.pastMinutes * 60 * 1000);
    const until = new Date(Date.now() + q.hours * 3600 * 1000);
    const rows = await db.select().from(economicEventsTable)
      .where(and(
        gte(economicEventsTable.eventTime, since),
        lte(economicEventsTable.eventTime, until),
      ))
      .orderBy(economicEventsTable.eventTime);
    const filtered = rows.filter((r) => allowed.includes(r.impactLevel));
    const calendarCoverage = await readStoredCalendarCoverage(until);
    res.json({
      events: filtered.map(serializeEvent),
      windowHours: q.hours,
      minImpact: q.minImpact,
      pastMinutes: q.pastMinutes,
      checkedAt: new Date().toISOString(),
      calendarCoverage,
    });
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
    const calendarCoverage = await readStoredCalendarCoverage(new Date(Date.now() + 24 * 3600 * 1000));
    res.json({
      ...serializeReport(row), reasons: result.reasons, blockTrading: result.blockTrading, calendarCoverage,
      reportAge: newsRiskReportAge(row.createdAt, Date.now()),
    });
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
    // The report scored the stored calendar's next 24h; say whether that
    // calendar actually reaches that far, so a CLEAR from an empty or
    // out-of-date table is not read as an all-clear.
    const calendarCoverage = await readStoredCalendarCoverage(new Date(Date.now() + 24 * 3600 * 1000));
    res.json({ ...serializeReport(rows[0]), news, calendarCoverage, reportAge: newsRiskReportAge(rows[0].createdAt, Date.now()) });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /news-risk/latest failed");
    res.status(400).json({ error: "Invalid request" });
  }
});

export default router;
