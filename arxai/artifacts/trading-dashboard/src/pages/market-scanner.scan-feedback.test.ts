// Source-scan guard — "the Scanner scan button never silently fails" (Task #505).
//
// The market-scanner page is a 738-line component that imports ~30 heavy child
// surfaces (including lightweight-charts, which cannot render headlessly here),
// so a full DOM render is impractical and brittle. The failure mode we must
// prevent is structural, so this test asserts the source contract directly:
//
//   1. The user-facing scanner page sends NO spoofed role header. The header is
//      dead code (rejected in production, superseded by the real session
//      cookie), so its presence is an auth-bypass smell.
//   2. The shared `api()` helper checks `r.ok` and THROWS — it must never parse
//      and silently discard a 403 body.
//   3. The non-admin Scan path falls through to the USER-allowed `load()` read
//      (the admin-gated engine POST is behind `realIsAdmin`), so a non-admin tap
//      produces a real, visible refresh instead of a hidden 403.
//   4. Every scanner trigger (scan/start/stop/changeUniverse) has a `catch` that
//      surfaces the failure into the `err` state → the existing CompactAlert.
//
// Comment text is stripped before token assertions so a reworded code comment
// can never false-pass (or false-fail) these checks (see the
// "source-scan-test-false-pass" lesson).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "market-scanner.tsx");

const raw = readFileSync(PAGE, "utf8");

// Strip block comments and line comments so token assertions only see
// executable code, never prose in comments.
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) return "";
    return line;
  })
  .join("\n");

describe("market-scanner scan button — never silently fails", () => {
  it("sends no spoofed role header anywhere in executable code", () => {
    expect(code.toLowerCase()).not.toContain("x-security-role");
  });

  it("the api() helper checks r.ok and throws (no silent 403 discard)", () => {
    expect(code).toContain("async function api(");
    expect(code).toContain("if (!r.ok)");
    expect(code).toMatch(/if \(!r\.ok\)[\s\S]*?throw /);
  });

  it("keeps automatic universe scans operator-only and manual scans explicit", () => {
    const change = code.slice(code.indexOf("async function changeUniverse("), code.indexOf("async function sendToIntent("));
    expect(change).toContain('if (realIsAdmin) await runScan(next, "scanner.changeUniverse")');
    const manual = code.slice(code.indexOf("async function scan("), code.indexOf("async function changeUniverse("));
    expect(manual).toContain('await runScan(universe, "scanner.scan")');
  });

  it("shared scan and engine action handlers surface current errors", () => {
    for (const fn of ["async function start(", "async function stop(", "async function runScan("]) {
      const start = code.indexOf(fn);
      expect(start, `${fn} should exist`).toBeGreaterThan(-1);
      const end = code.indexOf("async function", start + fn.length);
      const body = code.slice(start, end < 0 ? undefined : end);
      expect(body, `${fn} must have a catch`).toMatch(/catch\s*\(/);
      expect(body, `${fn} must surface the error`).toContain("reportErr(e)");
      expect(body, `${fn} must ignore obsolete errors`).toContain("action.current()");
    }
  });

  it("renders the failure through the existing CompactAlert error surface", () => {
    expect(code).toMatch(/err\s*&&\s*\(?\s*<CompactAlert/);
    expect(code).toContain('testId="scanner-error"');
  });

  it("renders the degraded banner exactly once, at page scope (not tab-trapped)", () => {
    // FIX 1: the honest degraded banner must show on EVERY tab (including the
    // default Focus tab) during a scanner outage, not only on Broad Scan. It is
    // hoisted to the page return and must appear exactly once so it never
    // double-renders.
    const matches = code.match(/testId="scanner-error"/g) ?? [];
    expect(matches.length, "scanner-error banner must render exactly once").toBe(1);

    // The single banner must sit at page scope — after the header summary and
    // ABOVE the PageTabs — so it is independent of the active tab.
    const bannerIdx = code.indexOf('testId="scanner-error"');
    const headerIdx = code.indexOf("<ScannerHeaderSummary");
    const tabsIdx = code.indexOf("<PageTabs");
    expect(headerIdx).toBeGreaterThan(-1);
    expect(tabsIdx).toBeGreaterThan(-1);
    expect(bannerIdx).toBeGreaterThan(headerIdx);
    expect(bannerIdx).toBeLessThan(tabsIdx);
  });

  it("disables the operator engine controls for non-admins with an honest reason", () => {
    expect(code).toMatch(/realIsAdmin\s*\?/);
    expect(code).toContain("operator-controlled");
    expect(code).toContain('data-testid="scanner-btn-start-disabled"');
  });
});
