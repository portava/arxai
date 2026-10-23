import { Router } from "express";
import { db, watchlistsTable, watchlistItemsTable } from "@workspace/db";
import { CreateWatchlistBody, AddWatchlistItemBody } from "@workspace/api-zod";
import { and, eq, inArray } from "drizzle-orm";
import { resolveArxMarket, isApprovedArxMarket, arxFocusApprovedEnvelope } from "@workspace/domain/market";
import { runStrategyScan } from "../lib/strategyEngine.js";
import { getMarketData } from "../lib/data/dataManager.js";
import { newsRiskFrom, resolveNewsRiskEvents } from "../lib/news/calendar/newsRiskResolver.js";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();

async function enrichItems(items: typeof watchlistItemsTable.$inferSelect[]) {
  // Resolve the REAL calendar once per batch so every row's newsRisk badge sits
  // on one consistent snapshot. With no provider configured this yields an
  // honest unavailable read rather than a fabricated event set (Theme A1).
  const calendar = await resolveNewsRiskEvents();
  return Promise.all(items.map(async (it) => {
    let signal: string | null = null;
    let confidence: number | null = null;
    let trend: string | null = null;
    try {
      const raw = await getMarketData(it.symbol, "1m", 220);
      const candles = raw.map((c) => ({ ...c, volume: c.volume ?? 0 }));
      const sig = runStrategyScan(it.symbol, candles, 60);
      signal = sig.direction;
      confidence = sig.confidence;
      trend = sig.direction === "BUY" ? "up" : sig.direction === "SELL" ? "down" : "neutral";
    } catch { /* swallow */ }
    const news = newsRiskFrom(it.symbol, calendar);
    // Approved → carry the shared extended approved envelope per item. Additive
    // (nested key) — existing consumers of the item shape are unaffected. Items
    // reaching enrichItems are already approved (callers filter), so resolution
    // succeeds; fall back to omitting the key if it ever doesn't.
    const focusMarket = resolveArxMarket(it.symbol);
    return {
      id: it.id,
      watchlistId: it.watchlistId,
      symbol: it.symbol,
      marketType: it.marketType,
      favorite: it.favorite,
      signal,
      confidence,
      trend,
      spread: null,
      newsRisk: news.riskLevel,
      // Additive honesty marker: false ⇒ no calendar provider, so "none" means
      // UNKNOWN rather than clear. Existing consumers of `newsRisk` are
      // unaffected; new ones must not render "clear" on a false read.
      newsRiskAvailable: news.calendarAvailable,
      ...(focusMarket ? { arxFocus: arxFocusApprovedEnvelope(focusMarket) } : {}),
    };
  }));
}

// Seed default watchlists for a new user the first time they hit the page.
async function seedDefaultsForUser(userId: number) {
  // Seed only approved ARX Focus markets — every default symbol below resolves
  // via resolveArxMarket (Task #570). Unapproved categories (single-name stocks,
  // NAS100) were removed; Crypto replaces the old Stocks bucket.
  const seed = [
    { name: "Forex Majors", category: "Forex Majors" },
    { name: "Forex Minors", category: "Forex Minors" },
    { name: "Indices & Metals", category: "Indices & Metals" },
    { name: "Crypto", category: "Crypto" },
    { name: "Synthetic Volatility", category: "Synthetic Volatility" },
  ].map((w) => ({ ...w, userId }));
  const inserted = await db.insert(watchlistsTable).values(seed).returning();
  const map: Record<string, { symbol: string; marketType: string }[]> = {
    "Forex Majors": [
      { symbol: "EURUSD", marketType: "forex" },
      { symbol: "GBPUSD", marketType: "forex" },
      { symbol: "USDJPY", marketType: "forex" },
      { symbol: "AUDUSD", marketType: "forex" },
      { symbol: "USDCAD", marketType: "forex" },
    ],
    "Forex Minors": [
      { symbol: "EURJPY", marketType: "forex" },
      { symbol: "GBPJPY", marketType: "forex" },
    ],
    "Indices & Metals": [
      { symbol: "US30", marketType: "index" },
      { symbol: "SPX500", marketType: "index" },
      { symbol: "XAUUSD", marketType: "metal" },
    ],
    "Crypto": [
      { symbol: "BTCUSD", marketType: "crypto" },
      { symbol: "ETHUSD", marketType: "crypto" },
    ],
    "Synthetic Volatility": [
      { symbol: "V75", marketType: "synthetic" },
      { symbol: "V75_1S", marketType: "synthetic" },
      { symbol: "BOOM300", marketType: "synthetic" },
    ],
  };
  const defaultItems: { watchlistId: number; symbol: string; marketType: string }[] = [];
  for (const w of inserted) {
    for (const it of map[w.category] ?? []) defaultItems.push({ watchlistId: w.id, ...it });
  }
  if (defaultItems.length) await db.insert(watchlistItemsTable).values(defaultItems);
}

router.get("/watchlists", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const lists = await db.select().from(watchlistsTable).where(eq(watchlistsTable.userId, userId));
  if (lists.length === 0) {
    await seedDefaultsForUser(userId);
  }

  const allLists = await db.select().from(watchlistsTable).where(eq(watchlistsTable.userId, userId));
  const allListIds = allLists.map((l) => l.id);
  const storedItems = allListIds.length
    ? await db.select().from(watchlistItemsTable).where(inArray(watchlistItemsTable.watchlistId, allListIds))
    : [];
  // Focus-Lock (Task #570): hide saved items whose symbol is outside the
  // approved universe. The rows stay in the DB (never deleted) — they are just
  // not surfaced in the active UI.
  const allItems = storedItems.filter((i) => isApprovedArxMarket(i.symbol));
  const result = await Promise.all(allLists.map(async (w) => ({
    id: w.id, name: w.name, category: w.category,
    items: await enrichItems(allItems.filter((i) => i.watchlistId === w.id)),
  })));
  res.json(result);
});

router.post("/watchlists", requireUser, async (req, res) => {
  try {
    const userId = req.authUser!.id;
    const body = CreateWatchlistBody.parse(req.body);
    const inserted = await db.insert(watchlistsTable).values({ userId, name: body.name, category: body.category }).returning();
    const w = inserted[0];
    res.json({ id: w.id, name: w.name, category: w.category, items: [] });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid watchlist" });
  }
});

router.delete("/watchlists/:id", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const id = Number(req.params["id"]);
  // Verify ownership before any cascade.
  const owned = await db.select().from(watchlistsTable)
    .where(and(eq(watchlistsTable.id, id), eq(watchlistsTable.userId, userId)))
    .limit(1);
  if (!owned[0]) { res.status(404).json({ error: "Watchlist not found" }); return; }
  await db.delete(watchlistItemsTable).where(eq(watchlistItemsTable.watchlistId, id));
  const r = await db.delete(watchlistsTable)
    .where(and(eq(watchlistsTable.id, id), eq(watchlistsTable.userId, userId)))
    .returning({ id: watchlistsTable.id });
  res.json({ deleted: r.length });
});

router.post("/watchlists/:id/items", requireUser, async (req, res) => {
  try {
    const userId = req.authUser!.id;
    const id = Number(req.params["id"]);
    // Verify ownership of parent watchlist.
    const owned = await db.select().from(watchlistsTable)
      .where(and(eq(watchlistsTable.id, id), eq(watchlistsTable.userId, userId)))
      .limit(1);
    if (!owned[0]) { res.status(404).json({ error: "Watchlist not found" }); return; }
    const body = AddWatchlistItemBody.parse(req.body);
    // Top-250 lock: a watchlist item must resolve into the approved market
    // universe. Without this gate a user could add an arbitrary "custom"
    // symbol that enrichItems() would then scan (getMarketData +
    // runStrategyScan) — a scan escape hatch outside the approved list.
    // We store the canonical standard symbol so downstream surfaces stay
    // consistent with the rest of the app.
    const resolved = resolveArxMarket(body.symbol);
    if (!resolved) {
      res.status(400).json({
        error: "SYMBOL_NOT_IN_APPROVED_LIST",
        message: `"${body.symbol}" isn't in the approved market list. Only approved markets can be added to a watchlist.`,
      });
      return;
    }
    const inserted = await db.insert(watchlistItemsTable).values({ watchlistId: id, symbol: resolved.canonicalSymbol, marketType: body.marketType }).returning();
    // enrichItems augments the approved item with the shared arxFocus envelope.
    const enriched = await enrichItems(inserted);
    res.json(enriched[0]);
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid watchlist item" });
  }
});

router.delete("/watchlists/items/:id", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const id = Number(req.params["id"]);
  // Verify ownership via parent watchlist.
  const item = await db.select().from(watchlistItemsTable).where(eq(watchlistItemsTable.id, id)).limit(1);
  if (!item[0]) { res.json({ deleted: 0 }); return; }
  const parent = await db.select().from(watchlistsTable)
    .where(and(eq(watchlistsTable.id, item[0].watchlistId), eq(watchlistsTable.userId, userId)))
    .limit(1);
  if (!parent[0]) { res.status(404).json({ error: "Item not found" }); return; }
  const r = await db.delete(watchlistItemsTable).where(eq(watchlistItemsTable.id, id)).returning({ id: watchlistItemsTable.id });
  res.json({ deleted: r.length });
});

router.post("/watchlists/items/:id/favorite", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const id = Number(req.params["id"]);
  const cur = await db.select().from(watchlistItemsTable).where(eq(watchlistItemsTable.id, id)).limit(1);
  if (!cur[0]) { res.status(404).json({ error: "Item not found" }); return; }
  const parent = await db.select().from(watchlistsTable)
    .where(and(eq(watchlistsTable.id, cur[0].watchlistId), eq(watchlistsTable.userId, userId)))
    .limit(1);
  if (!parent[0]) { res.status(404).json({ error: "Item not found" }); return; }
  const updated = await db.update(watchlistItemsTable).set({ favorite: cur[0].favorite ? 0 : 1 }).where(eq(watchlistItemsTable.id, id)).returning();
  const enriched = await enrichItems(updated);
  res.json(enriched[0]);
});

export default router;
