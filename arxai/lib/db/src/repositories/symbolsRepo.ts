import { eq } from "drizzle-orm";
import { db } from "../index";
import { symbolsTable, type SymbolRow, type InsertSymbol } from "../schema/symbols";

export const symbolsRepo = {
  list(): Promise<SymbolRow[]> {
    return db.select().from(symbolsTable);
  },
  byMarketType(marketType: string): Promise<SymbolRow[]> {
    return db.select().from(symbolsTable).where(eq(symbolsTable.marketType, marketType));
  },
  async get(symbol: string): Promise<SymbolRow | undefined> {
    const rows = await db.select().from(symbolsTable).where(eq(symbolsTable.symbol, symbol)).limit(1);
    return rows[0];
  },
  async upsert(input: InsertSymbol): Promise<SymbolRow> {
    const existing = await this.get(input.symbol);
    if (existing) {
      const [row] = await db.update(symbolsTable).set(input).where(eq(symbolsTable.symbol, input.symbol)).returning();
      return row;
    }
    const [row] = await db.insert(symbolsTable).values(input).returning();
    return row;
  },
};
