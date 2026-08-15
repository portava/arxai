// Regression suite for the fabrication-ban CI guard.
//
// A guard that only ever passes is indistinguishable from no guard at all, so
// this suite plants the exact shapes the guard exists to catch and asserts it
// goes red on each one:
//
//   - an invented VIX / price / confidence landing in a PROTECTED honest-data
//     surface (the P0-4 regression, in the file it regressed in);
//   - a `Date.now()` freshness stamp in the same surfaces — an empty payload
//     that timestamps itself "now" forges freshness the way Math.random()
//     forges a reading;
//   - a brand-new fabricating module that nobody quarantined;
//   - quarantine drift in BOTH directions: a pinned file that GREW (fabrication
//     spread) and one that SHRANK (a stale pin silently re-opening budget).
//
// And it asserts the guard does NOT fire on the things it must tolerate, or the
// history gets deleted to make CI green:
//
//   - `Math.random()` inside COMMENTS — the P0-4 fix deliberately documents the
//     formulas it removed, and that prose is the most valuable text in those
//     files;
//   - the two narrow identifier shapes (base36 / hex), which cannot produce a
//     quantity.
//
// Pure source analysis over in-memory fixtures — no DB, no network, no disk
// writes, and it never mutates a real repo file.

import {
  analyzeProtected,
  analyzeSwept,
  blankComments,
  findHits,
  isIdShaped,
  checkNoFabrication,
  RNG_TOKEN,
  CLOCK_TOKEN,
} from "./check-no-fabrication.js";

export {};

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function expect(name: string, ok: boolean, detail?: string) {
  record(name, ok, detail);
}

// eslint-disable-next-line no-console
console.log("\nno-fabrication guard — regression suite");

// ── 1. The P0-4 regression, replanted ───────────────────────────────────────
// eslint-disable-next-line no-console
console.log("\n  Rule 1 — PROTECTED honest-data surfaces");

const PLANTED_VIX = `
export function getIndicesIntelligence() {
  const vixEstimate = 14 + Math.random() * 8;
  return { providerConnected: false, vixEstimate };
}`;
{
  const v = analyzeProtected([
    { path: "artifacts/api-server/src/lib/indicesIntelligence.ts", src: PLANTED_VIX },
  ]);
  expect(
    "a replanted invented VIX is caught",
    v.length === 1 && v[0].includes(RNG_TOKEN) && v[0].includes(":3"),
    v[0] ?? "no violation raised",
  );
}

const PLANTED_CLOCK = `
export function getForexIntelligence() {
  return { providerConnected: false, asOf: new Date(Date.now()).toISOString() };
}`;
{
  const v = analyzeProtected([
    { path: "artifacts/api-server/src/lib/forexIntelligence.ts", src: PLANTED_CLOCK },
  ]);
  expect(
    "a Date.now() freshness stamp is caught (forged freshness)",
    v.length === 1 && v[0].includes(CLOCK_TOKEN),
    v[0] ?? "no violation raised",
  );
}

{
  // The real shape of today's honest modules: no RNG, clock taken as an
  // injectable parameter. Must stay clean or the guard is unusable.
  const HONEST = `
export function detectForexSession(now: Date = new Date()): string {
  return now.getUTCHours() < 8 ? "ASIA" : "LONDON";
}
export function getForexIntelligence() {
  return { providerConnected: false, pairs: [], safetyNote: "No live FX provider is connected." };
}`;
  const v = analyzeProtected([
    { path: "artifacts/api-server/src/lib/forexIntelligence.ts", src: HONEST },
  ]);
  expect("today's honest module shape stays clean", v.length === 0, v[0]);
}

{
  const v = analyzeProtected([
    { path: "artifacts/api-server/src/lib/indicesIntelligence.ts", src: null },
  ]);
  expect(
    "a deleted PROTECTED surface is a finding, not a silent pass",
    v.length === 1 && v[0].includes("missing"),
    v[0] ?? "no violation raised",
  );
}

// ── 2. Comments must survive ────────────────────────────────────────────────
// eslint-disable-next-line no-console
console.log("\n  Comment handling — the P0-4 documentation must not be punished");

const DOCUMENTED = `// The defect this file fixed:
//   - VIX was invented: \`14 + Math.random() * 8\`, published as an estimate
/* the 10Y yield was invented too:
     4.45 + (Math.random() - 0.5) * 0.3
     and Date.now() stamped it fresh */
export function getIndicesIntelligence() {
  return { providerConnected: false, indices: [] };
}`;
{
  const v = analyzeProtected([
    { path: "artifacts/api-server/src/lib/indicesIntelligence.ts", src: DOCUMENTED },
  ]);
  expect(
    "Math.random()/Date.now() in prose does not fire the guard",
    v.length === 0,
    v[0],
  );
}
{
  const withUrl = `const doc = "https://example.com//notacomment"; const x = Math.random();`;
  expect(
    "a // inside a string literal is not treated as a comment",
    findHits(withUrl, RNG_TOKEN).length === 1,
    `${findHits(withUrl, RNG_TOKEN).length} hit(s)`,
  );
}
{
  const src = "line1\n// x\nconst v = Math.random();\n";
  const hits = findHits(src, RNG_TOKEN);
  expect(
    "line numbers survive comment blanking",
    hits.length === 1 && hits[0].line === 3,
    hits.length ? `reported line ${hits[0].line}, expected 3` : "no hit",
  );
}
{
  const src = "/* a\n   b */\nconst v = 1;\n";
  expect(
    "blanking preserves the line count exactly",
    blankComments(src).split("\n").length === src.split("\n").length,
    `${blankComments(src).split("\n").length} vs ${src.split("\n").length}`,
  );
}

// ── 3. Identifier shapes vs quantities ──────────────────────────────────────
// eslint-disable-next-line no-console
console.log("\n  ID shapes — narrow enough that none can yield a quantity");

const ID_OK = [
  'const id = `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;',
  'const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");',
];
for (const line of ID_OK) {
  expect(`id-shaped: ${line.slice(0, 52)}…`, isIdShaped(line) === true);
}

const ID_NOT = [
  "const change = (Math.random() - 0.48) * price * vol;",
  "const vix = 14 + Math.random() * 8;",
  "const confidence = base + Math.random() * 10;",
  "const volume = Math.floor(Math.random() * 500 + 100);",
  "const lots = Math.random() * 0.5;",
  "const pick = arr[Math.floor(Math.random() * arr.length)];",
  // base36 on something that is NOT the RNG must not launder the RNG next to it
  "const size = Math.random() * 2; const id = n.toString(36);",
];
for (const line of ID_NOT) {
  expect(`NOT id-shaped: ${line.slice(0, 52)}…`, isIdShaped(line) === false);
}

{
  // THE LAUNDERING HOLE. Classification must be per-occurrence: a legitimate
  // id call sharing a line with an invented price must not exempt the price.
  // A line-level `isIdShaped` passes every other case in this file and still
  // lets this through — which is how the guard was first written, and how this
  // suite caught it.
  const src = 'const px = 100 + Math.random() * 5; const id = Math.random().toString(36);';
  const hits = findHits(src, RNG_TOKEN);
  expect(
    "an id shape on the same line does NOT launder an invented price",
    hits.length === 2 && hits[0].idShape === null && hits[1].idShape === "base36-id",
    hits.map((h) => `${h.idShape ?? "QUANTITY"}`).join(","),
  );
}
{
  // The hex shape requires its Math.floor( prefix — the tail alone is not enough.
  const bare = "const n = Math.random() * 0x10000).toString(16);";
  expect("hex id shape requires its Math.floor( prefix", isIdShaped(bare) === false);
}

// ── 4. The sweep and the ratchet ────────────────────────────────────────────
// eslint-disable-next-line no-console
console.log("\n  Rule 2 — sweep + quarantine ratchet");

const QUAR = {
  "artifacts/api-server/src/lib/pinned.ts": { count: 2, why: "test pin" },
};

{
  // A brand-new fabricating module nobody quarantined.
  const v = analyzeSwept(
    [
      {
        path: "artifacts/api-server/src/lib/cryptoIntelligence.ts",
        src: "export const btc = () => 60000 + Math.random() * 5000;",
      },
      { path: "artifacts/api-server/src/lib/pinned.ts", src: "a(Math.random());b(Math.random());" },
    ],
    QUAR,
  );
  expect(
    "an unquarantined new fabricator fails the build",
    v.length === 1 && v[0].includes("cryptoIntelligence.ts") && v[0].includes("not id-shaped"),
    v.join(" | ") || "no violation raised",
  );
}

{
  // Fabrication spread inside a pinned file.
  const v = analyzeSwept(
    [
      {
        path: "artifacts/api-server/src/lib/pinned.ts",
        src: "a(Math.random());b(Math.random());c(Math.random());",
      },
    ],
    QUAR,
  );
  expect(
    "quarantine pin catches fabrication GROWING (3 > 2)",
    v.length === 1 && v[0].includes("GREW"),
    v.join(" | ") || "no violation raised",
  );
}

{
  // A cleanup that left the pin loose — the budget must not stay open.
  const v = analyzeSwept(
    [{ path: "artifacts/api-server/src/lib/pinned.ts", src: "a(Math.random());" }],
    QUAR,
  );
  expect(
    "quarantine pin catches a STALE pin (1 < 2)",
    v.length === 1 && v[0].includes("stale"),
    v.join(" | ") || "no violation raised",
  );
}

{
  const v = analyzeSwept([], QUAR);
  expect(
    "a quarantined file that vanished is reported",
    v.length === 1 && v[0].includes("Remove the QUARANTINE entry"),
    v.join(" | ") || "no violation raised",
  );
}

{
  // Test fixtures randomise on purpose and must not be swept.
  const v = analyzeSwept(
    [
      {
        path: "artifacts/api-server/src/lib/__qa__/thing.test.ts",
        src: "const t = 1 + Math.random() * 5;",
      },
      { path: "artifacts/api-server/src/lib/pinned.ts", src: "a(Math.random());b(Math.random());" },
    ],
    QUAR,
  );
  expect("test fixtures are excluded from the sweep", v.length === 0, v.join(" | "));
}

{
  // Exact pin match, id shapes ignored entirely.
  const v = analyzeSwept(
    [
      {
        path: "artifacts/api-server/src/lib/pinned.ts",
        src: "a(Math.random());b(Math.random());const id = Math.random().toString(36);",
      },
      {
        path: "artifacts/api-server/src/lib/oms.ts",
        src: 'const id = `o_${Math.random().toString(36).slice(2, 8)}`;',
      },
    ],
    QUAR,
  );
  expect("an exactly-pinned file with id shapes alongside is clean", v.length === 0, v.join(" | "));
}

// ── 5. The guard against the REAL repo must be green ────────────────────────
// eslint-disable-next-line no-console
console.log("\n  Live repo state");
{
  const r = checkNoFabrication();
  expect(
    "checkNoFabrication() passes against HEAD",
    r.ok,
    r.ok ? `${r.notes?.[1] ?? ""}` : r.violations.slice(0, 5).join(" | "),
  );
}

const failed = results.filter((r) => !r.ok).length;
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed}/${results.length} no-fabrication cases passed`);
process.exit(failed === 0 ? 0 : 1);
