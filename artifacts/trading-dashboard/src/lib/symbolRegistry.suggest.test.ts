import { describe, it, expect } from "vitest";
import { suggestApprovedSymbols, isCanonical, resolveSymbol, SYMBOL_REGISTRY } from "./symbolRegistry";

/**
 * Task #423 — near-match suggestions must surface ONLY approved markets, and
 * only for a typed token that did not resolve to a single approved market.
 */
describe("suggestApprovedSymbols", () => {
  it("surfaces the approved candidates for an ambiguous alias", () => {
    // "oil" / "crude" map to both WTI (USOIL) and Brent (UKOIL) in the universe.
    for (const q of ["oil", "crude", "crude oil", "  OIL  "]) {
      const out = suggestApprovedSymbols(q);
      const syms = out.map((s) => s.canonicalSymbol);
      expect(syms).toContain("USOIL");
      expect(syms).toContain("UKOIL");
    }
  });

  it("only ever returns approved, registry-visible markets", () => {
    const out = suggestApprovedSymbols("oil");
    expect(out.length).toBeGreaterThan(0);
    for (const s of out) {
      expect(isCanonical(s.canonicalSymbol)).toBe(true);
      expect(SYMBOL_REGISTRY.some((e) => e.canonicalSymbol === s.canonicalSymbol)).toBe(true);
    }
  });

  it("returns no duplicates", () => {
    const syms = suggestApprovedSymbols("oil").map((s) => s.canonicalSymbol);
    expect(new Set(syms).size).toBe(syms.length);
  });

  it("returns [] when the input resolves cleanly to a single market", () => {
    // These resolve to exactly one approved market — not a dead end.
    for (const q of ["EURUSD", "gold", "V75", "btc"]) {
      expect(resolveSymbol(q)).not.toBeNull();
      expect(suggestApprovedSymbols(q)).toEqual([]);
    }
  });

  it("returns [] for empty / whitespace / genuinely-unknown input", () => {
    for (const q of ["", "   ", "zzzznotamarket", "qwertyuiop"]) {
      expect(suggestApprovedSymbols(q)).toEqual([]);
    }
  });
});
