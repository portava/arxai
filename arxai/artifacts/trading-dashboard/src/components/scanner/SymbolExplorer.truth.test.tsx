// The symbol search must only advertise markets that exist in the approved
// ARX Focus registry (43 markets: forex, metals, indices, crypto, Deriv
// synthetics). It used to suggest "nas" (no Nasdaq market exists), and the
// Symbols tab promised "stocks" and "STEP" indices, which do not exist.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SymbolExplorer, SYMBOL_SEARCH_EXAMPLES, approvedMarketScopeText } from "./SymbolExplorer";
import { SYMBOL_REGISTRY, searchSymbols } from "@/lib/symbolRegistry";

afterEach(() => { cleanup(); window.localStorage.clear(); });

describe("Symbol search copy names only approved markets", () => {
  it("every example in the search placeholder resolves to an approved market", () => {
    render(<SymbolExplorer activeSymbol="EURUSD" onSelect={() => {}} showDiagnostics={false} />);
    const placeholder = (screen.getByTestId("input-symbol-search") as HTMLInputElement).placeholder;
    expect(placeholder.toLowerCase()).not.toContain("nas");
    for (const ex of SYMBOL_SEARCH_EXAMPLES) {
      expect(placeholder).toContain(ex);
      expect(searchSymbols(ex, { limit: 1 }).length, `example "${ex}" must resolve`).toBe(1);
    }
  });

  it("typing a placeholder example never lands on 'isn't in the approved market list'", () => {
    render(<SymbolExplorer activeSymbol="EURUSD" onSelect={() => {}} showDiagnostics={false} />);
    for (const ex of SYMBOL_SEARCH_EXAMPLES) {
      fireEvent.change(screen.getByTestId("input-symbol-search"), { target: { value: ex } });
      expect(screen.queryByTestId("symbol-no-match"), ex).toBeNull();
    }
  });

  it("the scope text lists only categories and synthetic families that exist", () => {
    const text = approvedMarketScopeText();
    expect(text).toContain(`${SYMBOL_REGISTRY.length} approved markets`);
    expect(text).not.toMatch(/stocks/i);
    expect(text).not.toMatch(/\bstep\b/i);
    expect(text).toContain("forex pairs");
    expect(text).toContain("Deriv synthetics");
    expect(text).toContain("Boom/Crash");
    expect(text).toContain("Jump");
  });

  it("renders the registry-derived scope line with the caller's note", () => {
    render(<SymbolExplorer activeSymbol="EURUSD" onSelect={() => {}} showDiagnostics={false} scopeNote="Pick one." />);
    const scope = screen.getByTestId("symbol-explorer-scope").textContent ?? "";
    expect(scope).toBe(`${approvedMarketScopeText()} Pick one.`);
    expect(scope).not.toMatch(/stocks|\bstep\b/i);
  });

  it("the Market Scanner Symbols tab uses that scope line, not a hard-coded market list", () => {
    const src = readFileSync(resolve(__dirname, "../../pages/market-scanner.tsx"), "utf8");
    expect(src).not.toMatch(/BOOM\/CRASH\/STEP/);
    expect(src).not.toMatch(/crypto, stocks,/);
    expect(src).toMatch(/<SymbolExplorer\b[\s\S]{0,300}?scopeNote="/);
  });
});
