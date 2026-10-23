// Cross-card source-scan guard — "no scanner read card may ship a manual
// refresh / reload / retry button that a user can double-tap while a load is
// already in flight" (Task #545, generalizing the single-card Task #544 guard).
//
// Task #544 fixed the one outlier (ScannerChartPanel's reload button) and
// standardized every scanner read card on the same affordance: the busy/in-flight
// flag drives BOTH the spinner AND a `disabled` guard, so a refresh control can
// never double-fire its fetch. That fix was locked by a card-specific test. This
// test closes the *forward* gap: if someone adds a NEW scanner card (or edits an
// existing one) with a refresh-type button that lacks a disabled-while-busy guard,
// this test fails — before the double-fire bug can reach users.
//
// Why a source scan (not a DOM render): several of these cards are large and/or
// import lightweight-charts, which cannot render headlessly here. The contract we
// must lock is structural ("the button carries a disabled guard"), so we assert it
// against the component source directly — the same approach the sibling
// ScannerChartPanel.refresh-affordance and market-scanner.scan-feedback tests use.
//
// Detection is intentionally BROADER than any single testid-naming convention, so
// it keeps working as new cards arrive: a <Button> is treated as a refresh control
// when its data-testid contains refresh / reload / retry / rescan OR it renders one
// of the shared refresh-affordance icons (RefreshCw / RefreshCcw / RotateCw /
// RotateCcw). Comment text is stripped before any token assertion so a reworded
// comment can never false-pass or false-fail the checks (see the
// "source-scan-test-false-pass" lesson).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// Strip block comments and whole-line `//` comments so token assertions only see
// executable code, never prose.
function stripComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line))
    .join("\n");
}

interface ButtonBlock {
  file: string;
  testId: string | null;
  block: string;
}

// Extract every <Button ...>...</Button> region. These cards contain no
// self-closing <Button/> and no nested <Button> (asserted below as a tripwire),
// so pairing each "<Button" with the next "</Button>" is exact.
function buttonBlocks(file: string, code: string): ButtonBlock[] {
  const CLOSE = "</Button>";
  const out: ButtonBlock[] = [];
  let from = 0;
  for (;;) {
    const open = code.indexOf("<Button", from);
    if (open === -1) break;
    const close = code.indexOf(CLOSE, open);
    if (close === -1) break;
    const block = code.slice(open, close + CLOSE.length);
    const m = block.match(/data-testid="([^"]+)"/);
    out.push({ file, testId: m ? m[1] : null, block });
    from = close + CLOSE.length;
  }
  return out;
}

const REFRESH_TESTID = /(refresh|reload|retry|rescan)/i;
const REFRESH_ICON = /\b(RefreshCw|RefreshCcw|RotateCw|RotateCcw)\b/;

function isRefreshControl(b: ButtonBlock): boolean {
  if (b.testId && REFRESH_TESTID.test(b.testId)) return true;
  return REFRESH_ICON.test(b.block);
}

// A meaningful disabled guard: disabled={<expr>} where <expr> is a real
// busy/in-flight expression — not empty, and not a hard-coded literal. We reject
// `false`/`undefined` (defeats the guard outright) AND `true` (always-disabled is
// not "busy-driven" and would mask a button that never actually fetches).
function hasBusyDisabledGuard(block: string): boolean {
  const m = block.match(/disabled=\{([^}]+)\}/);
  if (!m) return false;
  const expr = m[1].trim();
  return (
    expr.length > 0 &&
    expr !== "false" &&
    expr !== "true" &&
    expr !== "undefined"
  );
}

// Discover every scanner card component (exclude test files); future cards are
// picked up automatically.
const cardFiles = readdirSync(HERE)
  .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
  .sort();

const allButtons = cardFiles.flatMap((f) =>
  buttonBlocks(f, stripComments(readFileSync(join(HERE, f), "utf8"))),
);
const refreshControls = allButtons.filter(isRefreshControl);

// Known refresh controls that MUST be discovered by the scan. Their presence
// proves the extraction + detection actually work (so the "all guarded" check can
// never vacuously pass). Update this list only when a card is intentionally
// added or removed.
const KNOWN_REFRESH_TESTIDS = [
  "opportunity-map-refresh",
  "timing-intelligence-refresh",
  "scanner-chart-reload",
  "ruby-market-read-refresh",
  "ruby-scalp-focus-refresh",
  "ruby-scalp-baskets-refresh",
  "ruby-scalp-reviews-refresh",
  "recent-scanner-trades-retry",
  "btn-refresh-symbol",
  "scalp-rank-scan",
  "ruby-chart-read-ask",
] as const;

describe("scanner cards — every refresh/reload/retry button disables while busy", () => {
  it("pairs <Button> tags exactly (no self-closing / nested Button blocks)", () => {
    for (const f of cardFiles) {
      const code = readFileSync(join(HERE, f), "utf8");
      const opens = code.match(/<Button\b/g)?.length ?? 0;
      const closes = code.match(/<\/Button>/g)?.length ?? 0;
      expect(opens, `${f}: <Button> open/close tags must balance`).toBe(closes);
    }
  });

  it("actually discovers the known scanner refresh controls", () => {
    const found = new Set(
      refreshControls.map((b) => b.testId).filter((t): t is string => t !== null),
    );
    const missing = KNOWN_REFRESH_TESTIDS.filter((t) => !found.has(t));
    expect(missing, `refresh controls not seen by the scan: ${missing.join(", ")}`).toEqual([]);
    // Sanity floor: the named controls plus at least the testid-less header
    // refresh button in RecentScannerTrades.
    expect(refreshControls.length).toBeGreaterThanOrEqual(KNOWN_REFRESH_TESTIDS.length + 1);
  });

  it("renders every refresh control with a busy-driven disabled guard (no double-fire)", () => {
    const offenders = refreshControls
      .filter((b) => !hasBusyDisabledGuard(b.block))
      .map((b) => `${b.file} [${b.testId ?? "no-testid"}]`);
    expect(
      offenders,
      `these scanner refresh buttons can double-fire (missing disabled={busy}): ${offenders.join("; ")}`,
    ).toEqual([]);
  });
});
