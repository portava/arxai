// Source-scan render-proof — "approved live traders drag SL/TP price lines for
// their OWN open LIVE positions on the Scanner chart, and every drag routes ONLY
// through executeInstantTrade(source:"chart_drag", MODIFY_SL_TP)" (Task #764).
//
// ScannerChartPanel is a ~2.7k-line component that imports lightweight-charts
// (which cannot render headlessly here), so a full DOM render is impractical and
// brittle — the same constraint the sibling ScannerChartPanel.refresh-affordance
// and market-scanner.scan-feedback tests document. The behaviours T005 must lock
// are structural, so this test asserts the drag-modify source contract directly.
//
// It pins, on the REAL panel source:
//   1. The drag handles render only while a position is in modify mode, and the
//      ENTRY handle is never draggable (no pointer capture, pointer-events-none) —
//      only SL/TP legs can move.
//   2. The drop handler is honesty-gated on a confirmed-LIVE feed
//      (isLiveDisplayRef) BEFORE anything is sent, and runs side/min-distance
//      validation (validateModifyLevels) before send.
//   3. One-click ON ⇒ submit immediately on drop; OFF ⇒ raise the confirm panel
//      (no silent send).
//   4. The submit goes through executeInstantTrade tagged source "chart_drag" +
//      action "MODIFY_SL_TP" — the single sanctioned path — and relays the result.
//   5. The per-position affordance is LIVE-only AND feed-gated: a LIVE position on
//      a confirmed feed gets the "Adjust SL/TP" button; otherwise it shows the
//      locked "needs live feed" span. No draggable affordance for DEMO positions.
//
// Comment text is stripped before token assertions so a reworded code comment can
// never false-pass (or false-fail) these checks (see the
// "source-scan-test-false-pass" lesson).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, "ScannerChartPanel.tsx");

const raw = readFileSync(PANEL, "utf8");

// Strip block comments and line comments so token assertions only see
// executable code, never prose in comments.
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => (line.trim().startsWith("//") ? "" : line))
  .join("\n");

// Extract the JSX block for a given handle key (entry|sl|tp) inside the
// modify overlay so per-handle assertions can't leak across handles.
function modifyOverlayBlock(): string {
  const idx = code.indexOf('data-testid="scanner-chart-modify-overlay"');
  expect(idx, "the modify overlay must exist").toBeGreaterThan(-1);
  // The overlay maps over the three handle keys right below the testid.
  return code.slice(idx, idx + 1500);
}

describe("ScannerChartPanel drag-modify — entry never draggable, SL/TP movable (Task #764)", () => {
  it("renders the SL/TP drag overlay only while a position is in modify mode", () => {
    // The overlay is conditional on the posModify state (only present mid-edit).
    expect(code).toMatch(/posModify\s*&&\s*\(\s*<div[^>]*scanner-chart-modify-overlay/);
  });

  it("never makes the ENTRY line draggable (no pointer capture, pointer-events-none)", () => {
    const block = modifyOverlayBlock();
    // Entry leg is inert: no pointer events, and the drag start handler is
    // explicitly undefined for the entry key.
    expect(block).toContain('isEntry ? "pointer-events-none"');
    expect(block).toMatch(/onPointerDown=\{isEntry \? undefined :/);
  });

  it("only the SL/TP legs arm a drag (set the drag key on pointer down)", () => {
    const block = modifyOverlayBlock();
    expect(block).toContain('posDragKeyRef.current = key as "sl" | "tp"');
    expect(block).toContain("cursor-ns-resize");
  });
});

describe("ScannerChartPanel drag-modify — honesty + one-click gates (Task #764)", () => {
  it("blocks the drop when the live feed isn't confirmed (isLiveDisplay) BEFORE any send", () => {
    // The drop handler must short-circuit on an unconfirmed feed.
    expect(code).toMatch(/handleModifyDrop[\s\S]{0,200}?if \(!isLiveDisplayRef\.current\)/);
  });

  it("validates side / min-distance before sending", () => {
    expect(code).toMatch(/handleModifyDrop[\s\S]{0,400}?validateModifyLevels\(/);
  });

  it("submits immediately on drop only when one-click is armed; otherwise raises the confirm panel", () => {
    expect(code).toMatch(/oneClickArmedRef\.current\)\s*void submitModify\(m\)/);
    expect(code).toMatch(/else setModifyArmed\(true\)/);
  });

  it("re-checks the confirmed-LIVE feed at SEND time so a Confirm click can't fire on a dropped feed", () => {
    // The drop handler gate alone isn't enough: the feed can go unconfirmed
    // between the drag and a later Confirm click, so submitModify itself must
    // re-check isLiveDisplay before reaching executeInstantTrade.
    const idx = code.indexOf("const submitModify");
    expect(idx, "submitModify must exist").toBeGreaterThan(-1);
    const head = code.slice(idx, idx + 700);
    const gateIdx = head.indexOf("if (!isLiveDisplayRef.current)");
    const sendIdx = head.indexOf("executeInstantTrade(");
    expect(gateIdx, "submitModify must re-check isLiveDisplay before send").toBeGreaterThan(-1);
    // The feed gate must appear BEFORE the executeInstantTrade call.
    expect(sendIdx === -1 || gateIdx < sendIdx).toBe(true);
  });

  it("re-checks live-trading entitlement (canTrade) at SEND time before reaching the router", () => {
    // Task #769: entitlement can be revoked / the account frozen between the drag
    // and a later Confirm click. submitModify must re-check canTrade (via the
    // fresh canTradeRef) BEFORE executeInstantTrade, mirroring the feed gate.
    expect(code).toMatch(/useEffect\(\s*\(\)\s*=>\s*\{\s*canTradeRef\.current\s*=\s*canTrade;?\s*\}\s*,\s*\[canTrade\]\s*\)/);
    const idx = code.indexOf("const submitModify");
    expect(idx, "submitModify must exist").toBeGreaterThan(-1);
    const head = code.slice(idx, idx + 700);
    const gateIdx = head.indexOf("if (!canTradeRef.current)");
    const sendIdx = head.indexOf("executeInstantTrade(");
    expect(gateIdx, "submitModify must re-check canTrade before send").toBeGreaterThan(-1);
    expect(sendIdx === -1 || gateIdx < sendIdx).toBe(true);
  });
});

describe("ScannerChartPanel drag-modify — single sanctioned execution path (Task #764)", () => {
  function submitBlock(): string {
    const idx = code.indexOf("const submitModify");
    expect(idx, "submitModify must exist").toBeGreaterThan(-1);
    return code.slice(idx, idx + 1000);
  }

  it("routes the submit through executeInstantTrade tagged source \"chart_drag\"", () => {
    const block = submitBlock();
    expect(block).toContain("executeInstantTrade(");
    expect(block).toContain('source: "chart_drag"');
    expect(block).toContain('action: "MODIFY_SL_TP"');
  });

  it("relays the dispatch result honestly (no fabricated success)", () => {
    const block = submitBlock();
    expect(block).toMatch(/relay\("Adjust SL\/TP", res\)/);
    // Only clears the editor on a real ok result.
    expect(block).toMatch(/if \(res\.ok\)/);
  });

  it("never reaches a raw bypass (legacy close / broker command queue / order-send)", () => {
    expect(code).not.toContain("/api/me/trades/close");
    expect(code).not.toContain("/api/mt5/command-result");
    expect(code).not.toContain("placeLiveOrderGuarded");
  });
});

describe("ScannerChartPanel drag-modify — per-position affordance is LIVE-only + feed-gated (Task #764)", () => {
  it("offers the Adjust SL/TP button only for a LIVE position on a confirmed feed", () => {
    // The button is wrapped in: LIVE accountMode AND isLiveDisplay.
    expect(code).toMatch(/p\.accountMode === "LIVE" && \(isLiveDisplay \?/);
    expect(code).toContain('data-testid={`scanner-chart-modify-${p.brokerTicket}`}');
    expect(code).toMatch(/onClick=\{\(\) => startPosModify\(p\)\}/);
  });

  it("shows a locked 'needs live feed' span for a LIVE position when the feed is unconfirmed", () => {
    expect(code).toContain('data-testid={`scanner-chart-modify-locked-${p.brokerTicket}`}');
    expect(code).toContain("SL/TP edit needs live feed");
  });

  it("exposes the confirm panel with submit + cancel controls", () => {
    expect(code).toContain('data-testid="scanner-chart-modify-confirm"');
    expect(code).toContain('data-testid="scanner-chart-modify-submit"');
    expect(code).toContain('data-testid="scanner-chart-modify-cancel"');
  });
});
