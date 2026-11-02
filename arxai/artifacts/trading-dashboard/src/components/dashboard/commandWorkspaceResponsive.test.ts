import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "command-workspace.css"), "utf8");

describe("command workspace responsive layout rules", () => {
  it("keeps a three-column desk through embedded desktop widths", () => {
    const block = css.match(/@media \(max-width: 1200px\) and \(min-width: 768px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(block).toContain("grid-template-columns: minmax(180px,.75fr) minmax(320px,1.4fr) minmax(205px,.88fr)");
    expect(block).toContain(".arx-col-right { grid-column: auto; display: flex; flex-direction: column; }");
    expect(block).toContain(".arx-refresh-control > div > label > span { display: none; }");
  });

  it("switches to a compact two-column and summary-row arrangement below 1024px", () => {
    const block = css.match(/@media \(max-width: 1023px\) and \(min-width: 768px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(block).toContain("grid-template-columns: minmax(175px,.72fr) minmax(0,1.3fr)");
    expect(block).toContain(".arx-col-right { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); }");
    expect(block).toContain(".arx-clock-compact-times { display: grid;");
  });

  it("keeps hidden tool panels out of narrow layouts without clipping the focused chart", () => {
    expect(css).toContain(".arx-panel[hidden] { display: none !important; }");
    expect(css).toContain(".arx-mobile-focus-hint { display: block;");
    expect(css).toContain(".arx-mobile-tray button[aria-pressed=\"true\"]");
    expect(css).toContain(".arx-chart-panel > .arx-panel-body { height: auto; max-height: none; overflow: visible; }");
  });
});
