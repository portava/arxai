// RANK 75 — the sidebar and the Ctrl/Cmd+K palette were two independent menu
// indexes that disagreed about who may reach what.
//
// THE DEFECT
//   14 entries carried a different access tier in each index. The palette
//   over-gated six surfaces the sidebar shows to approved traders (AI Coach,
//   Strategy Lab, Testing Lab, Trade Review, Market Bias, …) — so a trader who
//   could SEE "AI Coach" in their own menu got "No matches" typing it into the
//   search box. It also under-gated four surfaces the sidebar marks adminOnly
//   (/orders, /positions, /risk-profile, /shadow-journal), offering an approved
//   non-admin a jump to a page whose every fetch 403s. Its only "Journal" entry
//   pointed at the admin-gated /shadow-journal while the trader's real journal
//   at /journal had no entry at all.
//
// THE GUARD
//   A tier must be declared ONCE per surface. Deriving the palette wholesale
//   from buildNavGroups() is not possible — the palette indexes ~20 surfaces
//   with no sidebar entry (tab deep links, aliases, operator tools) — so
//   instead this test makes the two indexes provably agree on every href they
//   BOTH carry, and fails the build the moment they drift again.
//
//   The nav tier for an item is the STRICTER of its group flag and its own
//   flag: an item inside an `approvedOnly` group that itself carries
//   `adminOnly: true` is admin. That item-vs-group distinction is precisely
//   what the palette got wrong for /orders and /positions.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { COMMAND_PALETTE_ITEMS } from "./CommandPalette";

const HERE = dirname(fileURLToPath(import.meta.url));
const navSrc = readFileSync(resolve(HERE, "AppLayout.tsx"), "utf8");

type Tier = "everyone" | "approved" | "admin";

/**
 * Parse buildNavGroups() out of AppLayout source into { href -> tier }.
 *
 * Source parsing (rather than importing the component) keeps this guard free of
 * the whole lucide-react / wouter / hooks module graph, matching how
 * navAccessTier.test.ts already reads the same file.
 */
function navTiers(): Map<string, Tier> {
  const start = navSrc.indexOf("const buildNavGroups");
  const end = navSrc.indexOf("const INVESTOR_NAV_GROUPS");
  expect(start, "buildNavGroups must exist in AppLayout").toBeGreaterThan(-1);
  expect(end, "INVESTOR_NAV_GROUPS must follow buildNavGroups").toBeGreaterThan(start);
  const body = navSrc.slice(start, end);

  const out = new Map<string, Tier>();
  // Split on group boundaries: each group opens with `label: "…"` at depth 1.
  const groupChunks = body.split(/\n  \{\n/).slice(1);
  for (const chunk of groupChunks) {
    const groupAdmin = /^\s*adminOnly:\s*true/m.test(chunk.split("items:")[0] ?? "");
    const groupApproved = /^\s*approvedOnly:\s*true/m.test(chunk.split("items:")[0] ?? "");
    const itemsPart = chunk.slice(chunk.indexOf("items:"));
    for (const m of itemsPart.matchAll(/\{\s*href:\s*"([^"]+)"([^}]*)\}/g)) {
      const href = m[1];
      const rest = m[2];
      const itemAdmin = /adminOnly:\s*true/.test(rest);
      const itemApproved = /approvedOnly:\s*true/.test(rest);
      const tier: Tier =
        groupAdmin || itemAdmin ? "admin"
          : groupApproved || itemApproved ? "approved"
            : "everyone";
      // First declaration wins; a duplicate href across groups is itself caught
      // by the duplicate assertion below.
      if (!out.has(href)) out.set(href, tier);
    }
  }
  return out;
}

function paletteTier(item: { admin?: boolean; approvedOnly?: boolean }): Tier {
  if (item.admin) return "admin";
  if (item.approvedOnly) return "approved";
  return "everyone";
}

describe("the nav parser sees a real menu (non-vacuous)", () => {
  const tiers = navTiers();

  it("parses a substantial number of nav entries", () => {
    expect(tiers.size).toBeGreaterThan(40);
  });

  it("resolves all three tiers, so the comparison can actually fail", () => {
    const values = new Set(tiers.values());
    expect(values.has("everyone")).toBe(true);
    expect(values.has("approved")).toBe(true);
    expect(values.has("admin")).toBe(true);
  });

  it("an item's own adminOnly overrides a looser group flag", () => {
    // /positions and /orders live in approvedOnly groups but are adminOnly
    // items — the exact distinction the palette used to lose.
    expect(tiers.get("/positions")).toBe("admin");
    expect(tiers.get("/orders")).toBe("admin");
    // …while a sibling in the same group stays approved.
    expect(tiers.get("/trade-command-room")).toBe("approved");
  });
});

describe("nav-tier === palette-tier for every shared href", () => {
  const tiers = navTiers();
  const shared = COMMAND_PALETTE_ITEMS.filter((i) => tiers.has(i.href));

  it("the two indexes actually overlap", () => {
    expect(shared.length).toBeGreaterThan(20);
  });

  it("no shared surface is declared at two different tiers", () => {
    const mismatches = shared
      .filter((i) => paletteTier(i) !== tiers.get(i.href))
      .map((i) => `${i.href} (palette=${paletteTier(i)}, nav=${tiers.get(i.href)})`);
    expect(
      mismatches,
      `command palette and sidebar disagree on access tier — declare it once:\n  ${mismatches.join("\n  ")}`,
    ).toEqual([]);
  });
});

describe("rank 75 — the specific entries that were wrong", () => {
  const byHref = (href: string) => COMMAND_PALETTE_ITEMS.filter((i) => i.href === href);

  it("Journal points at the trader's own journal, not the shadow journal", () => {
    const journal = COMMAND_PALETTE_ITEMS.find((i) => i.label === "Journal");
    expect(journal).toBeDefined();
    expect(journal!.href).toBe("/journal");
    expect(journal!.admin).toBeFalsy();
  });

  it("the shadow journal keeps its own, honestly admin-gated entry", () => {
    const shadow = byHref("/shadow-journal");
    expect(shadow).toHaveLength(1);
    expect(shadow[0].label).toBe("Shadow Journal");
    expect(shadow[0].admin).toBe(true);
  });

  it("every /orders and /positions entry is admin-gated", () => {
    for (const item of [...byHref("/orders"), ...byHref("/positions")]) {
      expect(item.admin, `${item.label} → ${item.href} must be admin`).toBe(true);
    }
  });
});

describe("rank 6 — no palette entry calls a live surface a simulator", () => {
  const LIVE_INTENT_ROUTES = [
    "/trade-command-room",
    "/live-trading",
    "/live-manual",
    "/live-ai-assist",
    "/live-ai-auto-test",
    "/live-intent-queue",
    "/live-trading-control",
  ];
  const SIMULATION_WORDS = /\b(simulator|simulated|demo|paper|practice|sandbox)\b/i;

  it("the entry that read 'Demo Trading — Simulator' no longer points at the live room", () => {
    const demoish = COMMAND_PALETTE_ITEMS.filter(
      (i) => SIMULATION_WORDS.test(i.label) || SIMULATION_WORDS.test(i.hint ?? ""),
    );
    // There is still at least one demo-flavoured entry (searching "demo" must
    // find something real) …
    expect(demoish.length).toBeGreaterThan(0);
    // … but none of them lands on a live-intent surface.
    for (const item of demoish) {
      expect(
        LIVE_INTENT_ROUTES,
        `"${item.label}" (${item.hint ?? "no hint"}) uses simulation language but targets ${item.href}`,
      ).not.toContain(item.href);
    }
  });

  it("/trade-command-room is only ever labelled as the live command room", () => {
    for (const item of COMMAND_PALETTE_ITEMS.filter((i) => i.href === "/trade-command-room")) {
      expect(SIMULATION_WORDS.test(item.label)).toBe(false);
      expect(SIMULATION_WORDS.test(item.hint ?? "")).toBe(false);
    }
  });
});
