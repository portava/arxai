import { describe, it, expect } from "vitest";
import { suggestApprovedSymbols, resolveSymbol } from "./symbolRegistry";
import { resolveArxMarket } from "@workspace/domain/market";

/**
 * Task #423 — near-match suggestions must surface ONLY approved markets, and
 * only for a typed token that did not resolve to a single approved market.
 *
 * RULING (2026-08-29, D3b instrument-passport front) — USOIL/UKOIL are OUT of
 * the approved universe, DELIBERATELY, so "oil" suggestions are [].
 *
 * History, investigated before changing these assertions:
 *   - This file originally asserted "oil" → [USOIL, UKOIL]. It was written for
 *     Task #423, when `suggestApprovedSymbols` sourced candidates from the
 *     Top-250 universe (`@workspace/markets`), where USOIL/UKOIL exist.
 *   - The ARX Focus lock then fixed the approved universe: the owner's Phase-1
 *     command (attached_assets/replit-command-arx-focus-market-lock-phase1_
 *     1781498411073.md) enumerates ALL 36 approved markets by name — no oil
 *     market is on the list. Task #570 later extended the registry to 43 by
 *     adding seven Deriv synthetics (Jump 10..100, Boom/Crash 300) — again no
 *     oil. `git log -S "USOIL" -- lib/domain/src/market/arxFocusMarkets.ts`
 *     shows USOIL/UKOIL were NEVER in the Focus registry: this was not an
 *     accidental drop but an exclusion present since the universe was locked.
 *   - Task #558 rewired suggestions to filter through the Focus registry, so
 *     unapproved candidates are dropped by design ("this never surfaces a
 *     non-approved market"). The old oil expectations contradicted the very
 *     invariant the function documents.
 *
 * The honest behaviour under the lock: "oil" is a dead end ([]), answered by
 * the locked refusal copy — NOT a redirect to a market ARX must not touch.
 * If the owner ever re-admits oil to the Focus registry, the `oil-exclusion`
 * test below fails and must be flipped back to the Task #423 expectations.
 */
describe("suggestApprovedSymbols", () => {
  it("oil-exclusion ruling: USOIL/UKOIL are (still) outside the approved universe", () => {
    // Guards the premise of this file. If this fails, oil was re-admitted:
    // restore the original "oil → USOIL/UKOIL suggestions" expectations.
    expect(resolveArxMarket("USOIL")).toBeNull();
    expect(resolveArxMarket("UKOIL")).toBeNull();
    expect(resolveSymbol("USOIL")).toBeNull();
    expect(resolveSymbol("UKOIL")).toBeNull();
  });

  it("returns [] for oil/crude — ambiguous but with NO approved candidate", () => {
    // "oil"/"crude" are ambiguous in the Top-250 (USOIL vs UKOIL), but neither
    // candidate is an approved Focus market, so the suggestion list is empty:
    // a suggestion may never surface a non-approved market.
    for (const q of ["oil", "crude", "crude oil", "  OIL  "]) {
      expect(suggestApprovedSymbols(q)).toEqual([]);
    }
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
