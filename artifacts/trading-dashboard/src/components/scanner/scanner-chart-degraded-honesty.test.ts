// Source-scan guard — "a degraded chart feed never wears a healthy colour, and
// a silently-dead tick-stream never passes for a live one" (Theme C3.6).
//
// TWO REGRESSIONS THIS LOCKS
//
//   1. ARXNativeChart's Mirror Layer collapsed feed quality "delayed" and
//      "partial" into the green success "Mirrored" dot. The prominent feed
//      banner beneath it was honest about the degradation, so the strip's green
//      dot directly contradicted the banner two lines below it — a degraded
//      state wearing a healthy colour. Those qualities now carry their own
//      caution-toned "Delayed" state.
//
//   2. ScannerChartPanel's SSE tick-stream had no stall detection at all:
//      `es.onerror` was a no-op and there was no silence watchdog. A connection
//      that dies WITHOUT surfacing a browser error (proxy idle-timeout, sleeping
//      tab, network change) stays nominally OPEN while it stops delivering, so
//      the panel kept reading tick-live while real price motion had silently
//      degraded to the 15s reconciliation poll. The ARX native chart got the
//      watchdog + honest badge in C3.4/C3.5; the Scanner panel was never
//      retrofitted. It is now on the SAME hook, so what the user sees and what
//      the stream is doing cannot diverge.
//
// Both components import lightweight-charts and are 1.2k–2.9k lines, so a full
// DOM render is impractical and brittle here — the same constraint the sibling
// ScannerChartPanel.refresh-affordance test documents. The contracts are
// structural, so this test asserts them against the source directly.
//
// Comment text is stripped before every assertion so a reworded code comment can
// never false-pass (or false-fail) these checks.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCANNER_PANEL = join(HERE, "ScannerChartPanel.tsx");
const ARX_CHART = join(HERE, "..", "charts", "ARXNativeChart.tsx");

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line))
    .join("\n");
}

const arx = code(ARX_CHART);
const scanner = code(SCANNER_PANEL);

describe("ARX Mirror Layer — a degraded feed never wears the success colour", () => {
  it("maps delayed/partial to their own state, not to Mirrored", () => {
    // The mapping the regression introduced must be gone…
    expect(
      /"partial"\s*\)\s*return\s+"Mirrored"/.test(arx),
      'delayed/partial must not resolve to the green "Mirrored" state',
    ).toBe(false);
    // …and delayed/partial must resolve to the dedicated Delayed state.
    expect(
      /quality === "delayed" \|\| quality === "partial"\)\s*return\s+"Delayed"/.test(arx),
      "delayed/partial must resolve to the Delayed mirror state",
    ).toBe(true);
  });

  it("styles the Delayed state with the caution tone, never bg-success", () => {
    const idx = arx.indexOf("Delayed: {");
    expect(idx, "MIRROR_STYLE must carry a Delayed entry").toBeGreaterThan(-1);
    const block = arx.slice(idx, arx.indexOf("},", idx));
    expect(block).toMatch(/dot: "bg-warning"/);
    expect(block).toMatch(/text: "text-warning"/);
    expect(block).not.toMatch(/success/);
  });

  it("renders the mirror style's own label so Delayed reads honestly", () => {
    // The strip renders MIRROR_STYLE[...].label — the state name alone would
    // print a bare "Delayed" and lose the "Mirrored (delayed)" phrasing that
    // tells the user the mirror is working but behind.
    const idx = arx.indexOf('data-testid="arx-mirror-status"');
    expect(idx, "the mirror status label must exist").toBeGreaterThan(-1);
    expect(arx.slice(idx, idx + 200)).toMatch(/\{mirrorStyle\.label\}/);
    expect(arx).toMatch(/label: "Mirrored \(delayed\)"/);
  });
});

describe("Scanner tick-stream — a silent stream says so", () => {
  it("wires the shared tick-stream watchdog", () => {
    expect(scanner).toMatch(
      /import \{ useTickStreamWatchdog \} from "@\/components\/charts\/useTickStreamWatchdog"/,
    );
    expect(scanner).toMatch(/const streamWatchdog = useTickStreamWatchdog\(\)/);
  });

  it("notes stream open, every frame, and errors", () => {
    // noteStreamOpened starts the silence clock for the new EventSource;
    // noteFrame proves liveness on ANY frame (tip, feed_status, heartbeat);
    // noteError records a surfaced error instead of the old no-op.
    expect(scanner).toMatch(/streamWatchdog\.noteStreamOpened\(\)/);
    expect(scanner).toMatch(/streamWatchdog\.noteFrame\(\)/);
    expect(scanner).toMatch(/streamWatchdog\.noteError\(\)/);
  });

  it("records liveness before parsing, so an unrecognised frame still counts", () => {
    const onMsgIdx = scanner.indexOf("es.onmessage = (ev) => {");
    expect(onMsgIdx, "the SSE message handler must exist").toBeGreaterThan(-1);
    const frameIdx = scanner.indexOf("streamWatchdog.noteFrame()", onMsgIdx);
    const parseIdx = scanner.indexOf("JSON.parse(ev.data)", onMsgIdx);
    expect(frameIdx).toBeGreaterThan(onMsgIdx);
    expect(parseIdx).toBeGreaterThan(-1);
    expect(
      frameIdx,
      "noteFrame() must run before JSON.parse so a malformed frame still proves liveness",
    ).toBeLessThan(parseIdx);
  });

  it("rebuilds the stream on the watchdog's reconnect signal", () => {
    // Without `epoch` in the deps the watchdog can detect the stall but can
    // never actually reopen the dead stream.
    expect(scanner).toMatch(/\}, \[symbol, apiTf, streamWatchdog\.epoch\]\)/);
  });

  it("shows an honest reconnecting badge, suppressed by a closed market", () => {
    const idx = scanner.indexOf('data-testid="scanner-chart-stream-reconnecting"');
    expect(idx, "the stalled-stream badge must exist").toBeGreaterThan(-1);
    const openIdx = scanner.lastIndexOf("{streamWatchdog.stalled", idx);
    expect(openIdx, "the badge must be gated on the watchdog's stalled verdict").toBeGreaterThan(-1);
    // A legitimately closed market is the more specific explanation for the same
    // silence; showing both would imply a fault where there is none.
    expect(scanner.slice(openIdx, idx)).toMatch(/!marketFrozen/);
    expect(scanner.slice(idx, idx + 400)).toMatch(/Reconnecting — prices delayed/);
  });

  it("does not claim the browser will recover a silently-dead stream", () => {
    expect(
      /The browser auto-reconnects an EventSource; nothing to do/.test(
        readFileSync(SCANNER_PANEL, "utf8"),
      ),
      "the old no-op onerror rationale must be gone",
    ).toBe(false);
  });
});
