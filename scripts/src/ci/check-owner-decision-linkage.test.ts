// Regression suite for the owner-decision linkage drift guard (#54).
//
// Exercises `analyzeOwnerDecisionLinkage` against synthetic registry/linkage
// states (unlinked ruling, orphaned link, title drift, dead anchor file,
// vanished anchor string, missing noAnchorReason, malformed and overdue
// review dates) and runs `checkOwnerDecisionLinkage` against the real repo,
// which must pass. Pure — filesystem access is injected for synthetic cases.

import {
  analyzeOwnerDecisionLinkage,
  checkOwnerDecisionLinkage,
  type RulingLinkage,
} from "./check-owner-decision-linkage.js";

export {};

const TODAY = "2026-08-29";

function doc(rulings: Array<[number, string]>): string {
  return rulings.map(([n, t]) => `## Ruling ${n} — ${t}\n\nDecision: body.\n`).join("\n");
}

function linkage(entries: Record<number, Partial<RulingLinkage>>): Record<number, RulingLinkage> {
  const out: Record<number, RulingLinkage> = {};
  for (const [n, e] of Object.entries(entries)) {
    out[Number(n)] = {
      title: e.title ?? "T",
      reviewBy: e.reviewBy ?? "2027-01-01",
      anchors: e.anchors ?? [],
      noAnchorReason: e.noAnchorReason,
    };
  }
  return out;
}

const FILES: Record<string, string> = {
  "src/impl.ts": "export const theRulingPredicate = true;",
};
const fileExists = (p: string) => p in FILES;
const fileRead = (p: string) => FILES[p] ?? null;

type Case = { name: string; violations: string[]; expect: number; mustMention?: string };

function run(
  docContent: string,
  lk: Record<number, RulingLinkage>,
  todayIso = TODAY,
): string[] {
  return analyzeOwnerDecisionLinkage({ docContent, linkage: lk, fileExists, fileRead, todayIso });
}

const okLinkage = linkage({
  1: { title: "T", anchors: [{ file: "src/impl.ts", mustContain: "theRulingPredicate" }] },
});

const cases: Case[] = [
  {
    name: "clean linked ruling passes",
    violations: run(doc([[1, "T"]]), okLinkage),
    expect: 0,
  },
  {
    name: "appended ruling with no linkage entry is flagged",
    violations: run(doc([[1, "T"], [2, "New ruling"]]), okLinkage),
    expect: 1,
    mustMention: "no entry in RULING_LINKAGE",
  },
  {
    name: "linkage entry whose ruling vanished from the doc is flagged",
    violations: run(doc([[1, "T"]]), linkage({
      1: { title: "T", anchors: [{ file: "src/impl.ts" }] },
      9: { title: "Ghost", noAnchorReason: "x" },
    })),
    expect: 1,
    mustMention: "no matching",
  },
  {
    name: "title drift is flagged",
    violations: run(doc([[1, "T changed"]]), okLinkage),
    expect: 1,
    mustMention: "title drift",
  },
  {
    name: "dead anchor file is flagged",
    violations: run(doc([[1, "T"]]), linkage({
      1: { title: "T", anchors: [{ file: "src/deleted.ts" }] },
    })),
    expect: 1,
    mustMention: "missing",
  },
  {
    name: "anchor string vanished from a live file is flagged",
    violations: run(doc([[1, "T"]]), linkage({
      1: { title: "T", anchors: [{ file: "src/impl.ts", mustContain: "renamedPredicate" }] },
    })),
    expect: 1,
    mustMention: "no longer contains",
  },
  {
    name: "no anchors and no noAnchorReason is flagged",
    violations: run(doc([[1, "T"]]), linkage({ 1: { title: "T" } })),
    expect: 1,
    mustMention: "noAnchorReason",
  },
  {
    name: "an explicit noAnchorReason satisfies an anchor-less ruling",
    violations: run(doc([[1, "T"]]), linkage({ 1: { title: "T", noAnchorReason: "process ruling" } })),
    expect: 0,
  },
  {
    name: "malformed review date is flagged",
    violations: run(doc([[1, "T"]]), linkage({
      1: { title: "T", noAnchorReason: "x", reviewBy: "someday" },
    })),
    expect: 1,
    mustMention: "not a YYYY-MM-DD",
  },
  {
    name: "overdue review date fails the build",
    violations: run(doc([[1, "T"]]), linkage({
      1: { title: "T", noAnchorReason: "x", reviewBy: "2026-08-28" },
    })),
    expect: 1,
    mustMention: "OVERDUE",
  },
  {
    name: "review due today is not yet overdue",
    violations: run(doc([[1, "T"]]), linkage({
      1: { title: "T", noAnchorReason: "x", reviewBy: TODAY },
    })),
    expect: 0,
  },
  {
    name: "duplicate ruling numbers are flagged",
    violations: run(doc([[1, "T"], [1, "T"]]), okLinkage),
    expect: 1,
    mustMention: "duplicate",
  },
];

const results: Array<{ name: string; ok: boolean }> = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok });
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// eslint-disable-next-line no-console
console.log("\nowner-decision-linkage guard — regression suite");
for (const c of cases) {
  const countOk = c.violations.length === c.expect;
  const mentionOk = !c.mustMention || c.violations.some((v) => v.includes(c.mustMention!));
  record(
    c.name,
    countOk && mentionOk,
    countOk && mentionOk
      ? `${c.violations.length} violation(s) as expected`
      : `expected ${c.expect} (mentioning ${c.mustMention ?? "-"}), got ${c.violations.length}: ${c.violations.join(" | ")}`,
  );
}

// The real registry + real anchors must pass end-to-end on a healthy checkout.
const real = checkOwnerDecisionLinkage();
record(
  "real docs/OWNER_DECISIONS.md passes checkOwnerDecisionLinkage",
  real.ok,
  real.ok ? (real.notes ?? []).join("; ") : real.violations.join(" | "),
);

const failed = results.filter((r) => !r.ok);
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
