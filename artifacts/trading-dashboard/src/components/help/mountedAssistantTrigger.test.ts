// RANK 91 — the QA suite guarded a component that never mounts.
//
// THE DEFECT
//   knowledge/_qa-test.ts asserts the floating-assistant trigger exists "in
//   exactly ONE source location (FloatingHelpWidget.tsx)". FloatingHelpWidget
//   has ZERO importers anywhere in the app — AppLayout lazily mounts
//   ArxAssistantLivePanel instead. So the invariant passed, forever, while
//   measuring dead code, and the trigger that users actually press was covered
//   by nothing at all.
//
// THIS GUARD
//   Pins the MOUNTED assistant: exactly one component renders the live trigger,
//   AppLayout mounts it, and the retired widget stays unmounted (so nobody
//   re-introduces a second floating trigger by wiring the old one back in
//   without deciding which is canonical).
//
//   FloatingHelpWidget.tsx is deliberately NOT deleted here: _qa-test.ts reads
//   its source for ~10 other invariants (widget wiring, aria, reduced-motion,
//   safe-area, CSS tokens), so deleting the file would take those assertions
//   down with it. It is pinned as unmounted instead, which is the fact that
//   matters, and the deletion is recorded as follow-up work.
//
//   CORRECTION (review pass): an earlier version of this comment claimed the
//   _qa-test.ts lane "cannot be run in this sandbox (tsx needs listen(2))".
//   That was wrong — `pnpm exec tsx src/knowledge/_qa-test.ts` runs fine. It
//   was run, and it showed that adding THIS file flipped that lane's
//   "Single floating trigger (no duplicates)" invariant to FAIL, because its
//   walk() counted any file quoting the testid, test files included. The walk
//   now excludes non-rendering sources; see _qa-test.ts:isNonRenderingSource.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = resolve(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const FILES = walk(SRC).filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"));
const read = (p: string) => readFileSync(p, "utf8");

describe("the assistant trigger users actually press is unique and mounted", () => {
  const LIVE_TRIGGER = 'data-testid="arx-assistant-trigger"';

  it("exactly one component renders the live assistant trigger", () => {
    const hosts = FILES.filter(
      (p) => !p.includes("/knowledge/") && !p.includes("/uiElementRegistry") && read(p).includes(LIVE_TRIGGER),
    );
    expect(
      hosts.map((p) => p.replace(SRC, "")),
      "the live assistant trigger must exist in exactly one source file",
    ).toHaveLength(1);
    expect(hosts[0].endsWith("ArxAssistantLivePanel.tsx")).toBe(true);
  });

  it("AppLayout actually mounts it", () => {
    const layout = read(resolve(SRC, "components/layout/AppLayout.tsx"));
    expect(layout).toMatch(/ArxAssistantLivePanel/);
    expect(layout).toMatch(/<ArxAssistantLivePanel \/>/);
  });
});

describe("the retired FloatingHelpWidget is still unmounted", () => {
  it("has no importers", () => {
    const importers = FILES.filter(
      (p) => !p.endsWith("FloatingHelpWidget.tsx") && /from\s+["'][^"']*FloatingHelpWidget["']/.test(read(p)),
    );
    expect(
      importers.map((p) => p.replace(SRC, "")),
      "FloatingHelpWidget is retired — mounting it would put a SECOND floating " +
        "assistant trigger on every page. Decide which is canonical first.",
    ).toEqual([]);
  });

  it("its trigger testid does not appear in any mounted component", () => {
    // The old testid may still exist inside the retired widget itself. It must
    // not appear anywhere that renders.
    const hosts = FILES.filter(
      (p) =>
        !p.endsWith("FloatingHelpWidget.tsx") &&
        !p.includes("/knowledge/") &&
        !p.includes("/uiElementRegistry") &&
        !p.includes("/onboarding/") &&
        read(p).includes('data-testid="floating-help-trigger"'),
    );
    expect(hosts.map((p) => p.replace(SRC, ""))).toEqual([]);
  });
});
