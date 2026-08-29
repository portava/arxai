// RANK 92 — the Watchlists page offered markets the server refuses.
//
// THE DEFECT
//   Two hand-written lists sat next to a registry that is the declared single
//   source of truth:
//     const CATEGORIES   = [... "Stocks" ...];
//     const MARKET_TYPES = ["forex", "index", "stock", "synthetic", "crypto"];
//   The server accepts only the 43 approved ARX Focus markets, which contain no
//   equities — so a user could create a "Stocks" watchlist and then have every
//   symbol they tried to add refused, with nothing explaining why the category
//   was on offer. MARKET_TYPES also omitted "metals" although the server seeds
//   XAUUSD with that type, and used singular spellings ("index", "stock") that
//   do not match the registry's plural ones at all.
//
// THE GUARD
//   Both lists are derived from SYMBOL_REGISTRY now, so this test asserts the
//   derivation rather than a copy of it: every offered market type must have at
//   least one approved symbol behind it, and no market type ARX supports may be
//   missing.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SYMBOL_REGISTRY, groupByMarketType, type MarketType } from "@/lib/symbolRegistry";

const HERE = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(resolve(HERE, "watchlists.tsx"), "utf8");

const populated = (Object.entries(groupByMarketType(SYMBOL_REGISTRY)) as [MarketType, unknown[]][])
  .filter(([, entries]) => entries.length > 0)
  .map(([t]) => t)
  .sort();

describe("the ARX Focus registry is the single source of truth (non-vacuous)", () => {
  it("is a real, non-trivial registry", () => {
    expect(SYMBOL_REGISTRY.length).toBeGreaterThan(20);
    expect(populated.length).toBeGreaterThan(2);
  });

  it("contains no equities — the market the page used to advertise", () => {
    // This is the fact that made "Stocks" a guaranteed dead end.
    expect(populated).not.toContain("stocks");
  });

  it("does contain metals — the market the page used to omit", () => {
    expect(populated).toContain("metals");
    expect(SYMBOL_REGISTRY.some((e) => e.marketType === "metals")).toBe(true);
  });
});

describe("the page derives its options instead of hand-listing them", () => {
  it("no hard-coded MARKET_TYPES array survives", () => {
    expect(page).not.toMatch(/const MARKET_TYPES = \["forex", "index", "stock"/);
    expect(page).toMatch(/const MARKET_TYPES: MarketType\[\] = \(Object\.entries\(groupByMarketType\(SYMBOL_REGISTRY\)\)/);
  });

  it("no hard-coded CATEGORIES array survives", () => {
    expect(page).not.toMatch(/const CATEGORIES = \["Forex Majors"/);
    expect(page).toMatch(/const CATEGORIES = \["Custom", \.\.\.MARKET_TYPES/);
  });

  it("every market type has a human label", () => {
    const labels = /const MARKET_TYPE_LABEL: Record<string, string> = \{([\s\S]*?)\};/.exec(page)?.[1] ?? "";
    for (const t of populated) {
      expect(labels, `MARKET_TYPE_LABEL is missing "${t}"`).toMatch(new RegExp(`\\b${t}:`));
    }
  });
});

describe("the empty state exists", () => {
  it("a user with no watchlists gets an explanation, not a void", () => {
    expect(page).toMatch(/watchlists-empty/);
    expect(page.replace(/\s+/g, " ")).toMatch(/You have no watchlists yet/);
    // …and it says what can actually be added, so the next step is not a refusal.
    expect(page.replace(/\s+/g, " ")).toMatch(/only ARX-approved markets can be added/i);
  });
});
