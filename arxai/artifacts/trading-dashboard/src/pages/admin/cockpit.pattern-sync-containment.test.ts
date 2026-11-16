import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Pattern Sync containment proof (Task #752, step 4).
 *
 * The Pattern Sync Command Center is ADMIN/OWNER-ONLY and ADVISORY. It must
 * never surface on a trader-facing page or component. (Per the task deviation,
 * Task #751's trader-facing Pattern Sync was never merged into this env, so the
 * step is satisfied by construction — this test LOCKS that going forward.)
 *
 * We scan every .ts/.tsx source file under src/ and assert that the two
 * Pattern-Sync identifiers — the <PatternSyncSection /> component and the
 * generated useGetAdminCockpitPatternSync hook — appear ONLY inside the
 * admin cockpit directory. Any reference from a trader surface fails the build.
 */

const SRC = path.resolve(__dirname, "../../");
const COCKPIT_DIR = path.join(SRC, "components", "admin", "cockpit");

// Identifiers that, if found outside the admin cockpit, would mean Pattern Sync
// has leaked into a non-admin surface.
const PATTERN_SYNC_TOKENS = [
  "PatternSyncSection",
  "useGetAdminCockpitPatternSync",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function isInsideCockpit(file: string): boolean {
  return file.startsWith(COCKPIT_DIR + path.sep);
}

// The admin cockpit page itself legitimately imports the section.
const COCKPIT_PAGE = path.join(SRC, "pages", "admin", "cockpit.tsx");

describe("Pattern Sync containment", () => {
  const files = walk(SRC).filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

  it("references Pattern Sync ONLY from the admin cockpit (never a trader surface)", () => {
    const offenders: { file: string; token: string }[] = [];
    for (const file of files) {
      if (isInsideCockpit(file) || file === COCKPIT_PAGE) continue;
      const text = readFileSync(file, "utf8");
      for (const token of PATTERN_SYNC_TOKENS) {
        if (text.includes(token)) {
          offenders.push({ file: path.relative(SRC, file), token });
        }
      }
    }
    expect(
      offenders,
      `Pattern Sync leaked into non-admin surfaces: ${JSON.stringify(offenders, null, 2)}`,
    ).toEqual([]);
  });

  it("confirms the Pattern Sync section lives inside the admin cockpit (proof is not vacuous)", () => {
    const sectionFile = path.join(COCKPIT_DIR, "PatternSyncSection.tsx");
    const text = readFileSync(sectionFile, "utf8");
    expect(text.includes("PatternSyncSection")).toBe(true);
    expect(text.includes("useGetAdminCockpitPatternSync")).toBe(true);
    // And the cockpit page mounts it.
    const pageText = readFileSync(COCKPIT_PAGE, "utf8");
    expect(pageText.includes("PatternSyncSection")).toBe(true);
  });
});
