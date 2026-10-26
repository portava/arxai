import { describe, it, expect } from "vitest";
import { resolveUserMarketInput } from "@workspace/markets";
import { suggestApprovedSymbols, searchSymbols, isCanonical, resolveSymbol, SYMBOL_REGISTRY } from "./symbolRegistry";

// The upstream Top250 directory has oil ambiguities, but Focus43 deliberately
// excludes both oil markets. Test that real boundary rather than adding markets
// to satisfy an obsolete fixture. Approved multi-match search remains useful.
describe("approved symbol suggestions and multi-match search", () => {
  it("filters real upstream oil ambiguity to an empty approved Focus result", () => {
    for (const query of ["oil", "crude", "crude oil", "  OIL  "]) {
      const upstream = resolveUserMarketInput(query);
      expect(upstream.status).toBe("ambiguous");
      expect(upstream.candidates.map((market) => market.standardSymbol)).toEqual(["USOIL", "UKOIL"]);
      expect(suggestApprovedSymbols(query)).toEqual([]);
    }
    expect(SYMBOL_REGISTRY).toHaveLength(43);
    for (const outside of ["USOIL", "UKOIL"]) {
      expect(isCanonical(outside)).toBe(false);
      expect(SYMBOL_REGISTRY.some((entry) => entry.canonicalSymbol === outside)).toBe(false);
    }
  });

  it("keeps both genuinely approved 75 variants discoverable and distinct", () => {
    for (const query of ["75", "volatility 75", "  V75  "]) {
      const matches = searchSymbols(query);
      expect(matches.map((entry) => entry.canonicalSymbol)).toEqual(expect.arrayContaining(["V75", "V75_1S"]));
      for (const entry of matches) {
        expect(isCanonical(entry.canonicalSymbol)).toBe(true);
        expect(SYMBOL_REGISTRY.some((approved) => approved.canonicalSymbol === entry.canonicalSymbol)).toBe(true);
      }
    }
    expect(resolveSymbol("V75")?.canonicalSymbol).toBe("V75");
    expect(resolveSymbol("V75_1S")?.canonicalSymbol).toBe("V75_1S");
  });

  it("returns deterministic, nonempty multi-match search without duplicate markets", () => {
    const symbols = searchSymbols("75").map((entry) => entry.canonicalSymbol);
    expect(symbols.length).toBeGreaterThan(1);
    expect(new Set(symbols).size).toBe(symbols.length);
    expect(searchSymbols("75").map((entry) => entry.canonicalSymbol)).toEqual(symbols);
  });

  it("returns no ambiguous suggestions for a resolved approved market", () => {
    for (const query of ["EURUSD", "gold", "V75", "btc"]) {
      expect(resolveSymbol(query)).not.toBeNull();
      expect(suggestApprovedSymbols(query)).toEqual([]);
    }
  });

  it("returns no suggestions for empty, unknown or outside-Focus symbols", () => {
    for (const query of ["", "   ", "zzzznotamarket", "qwertyuiop", "USOIL", "UKOIL", "AAPL"]) {
      expect(suggestApprovedSymbols(query)).toEqual([]);
    }
  });
});
