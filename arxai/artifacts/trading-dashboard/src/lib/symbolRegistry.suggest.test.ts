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

// The registry is static, so resolution is memoized (Task: scanner click
// latency). The memo must be invisible: identical results, keyed by every input
// that can change the answer, and identity-stable so memoized consumers hold.
describe("memoized symbol resolution", () => {
  it("returns the same resolved object for repeated resolves of one query", () => {
    const first = resolveSymbol("EURUSD");
    expect(first?.canonicalSymbol).toBe("EURUSD");
    expect(resolveSymbol("EURUSD")).toBe(first);
    expect(resolveSymbol(" eurusd ")).toBe(first);
    expect(resolveSymbol("GBPUSD")).not.toBe(first);
  });

  it("keeps the exact-canonical shortcut identical to the ranked search", () => {
    for (const query of SYMBOL_REGISTRY.map((entry) => entry.canonicalSymbol)) {
      const single = resolveSymbol(query);
      const ranked = searchSymbols(query);
      expect(single).toEqual(ranked[0]);
      expect(single?.canonicalSymbol).toBe(query);
    }
    expect(resolveSymbol("EURUSD")?.matchSource).toBe("exact");
    expect(resolveSymbol("xauusd")?.matchSource).toBe("exact");
    expect(resolveSymbol("volatility 75")?.matchSource).not.toBe("exact");
    expect(resolveSymbol("volatility 75")).toEqual(searchSymbols("volatility 75", { limit: 1 })[0]);
  });

  it("hands out a fresh result array so callers cannot corrupt the memo", () => {
    const a = searchSymbols("75");
    const b = searchSymbols("75");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    a.length = 0;
    expect(searchSymbols("75")).toEqual(b);
    expect(searchSymbols("75", { limit: 2 })).toEqual(b.slice(0, 2));
  });

  it("keys the memo on the feed-availability option", () => {
    const configured = resolveSymbol("V75", { derivFeedConfigured: true });
    const missing = resolveSymbol("V75", { derivFeedConfigured: false });
    expect(configured?.unavailableReason).toBeNull();
    expect(missing?.unavailableReason).toBe("DERIV_FEED_NOT_CONFIGURED");
    expect(resolveSymbol("V75")?.unavailableReason).toBeNull();
  });
});
