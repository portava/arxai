// Test: slow-horizon direction research (momentum and carry on 55 years of FX).
//
// Claims (docs/SLOW_DIRECTION_RESULTS.md):
//   1. THE METHOD CAN SEE AN EDGE: a planted monthly momentum (phi 0.15) and a
//      planted carry effect each survive discovery AND confirmation.
//   2. IT DOES NOT INVENT ONE: driftless seeded panels yield no survivor.
//   3. THE FIXTURE IS THE PINNED ONE: a changed byte or a changed pin refuses to load.
//   4. THE REAL RESULT IS THE PUBLISHED ONE: 53 pre-registered hypotheses,
//      17 discoveries before 2000, 0 survive confirmation from 2000 on.
//   5. The doc is exactly what the code measures.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runOnPanel, seededPanel, runSlowDirectionResearch, renderSlowDirectionMarkdown } from "./research/slowDirectionResearch.js";
import { loadVerifiedSlowFixture, SLOW_FIXTURE_DIR_NAME, PINNED_SLOW_DATASET_HASH } from "./research/slowHistoryFixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");
const DOC = join(HERE, "..", "..", "docs", "SLOW_DIRECTION_RESULTS.md");
/** Pinned from the one run on the pinned fixture. Change only on purpose. */
const PINNED = { family: 53, discoveries: 17, survivors: 0, resultHash: "89e4b75bde2fff9745ce1f2aa34dd9f824148c6868b36e61966790afb2569bc2" };

let passed = 0;
const t = (name: string, fn: () => void) => { fn(); passed++; console.log(`ok - ${name}`); };

t("positive control: planted monthly momentum (phi 0.15) survives on every seed", () => {
  for (const seed of [3, 17, 101]) {
    const r = runOnPanel(seededPanel(seed, { phi: 0.15 }));
    assert.ok(r.rows.find((x) => x.key === "portfolio TSMOM_1")!.survives, `seed ${seed}`);
  }
});

t("positive control: a planted carry effect survives on every seed", () => {
  for (const seed of [3, 17, 101]) {
    const r = runOnPanel(seededPanel(seed, { carryBeta: 1 }));
    assert.ok(r.rows.find((x) => x.key === "portfolio CARRY")!.survives, `seed ${seed}`);
  }
});

t("negative control: driftless panels yield no survivor", () => {
  for (const seed of [3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 101]) assert.equal(runOnPanel(seededPanel(seed)).survivors, 0, `seed ${seed}`);
});

t("the fixture refuses to load if a byte or the pin changes", () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "slow-fixture-"));
  try {
    cpSync(join(FIXTURES, SLOW_FIXTURE_DIR_NAME), join(root, SLOW_FIXTURE_DIR_NAME), { recursive: true });
    assert.equal(loadVerifiedSlowFixture(root).manifest.datasetHash, PINNED_SLOW_DATASET_HASH);
    assert.throws(() => loadVerifiedSlowFixture(root, "0".repeat(64)), /not the pinned/);
    const f = join(root, SLOW_FIXTURE_DIR_NAME, "DEXUSUK.1d.csv");
    writeFileSync(f, readFileSync(f, "utf8").replace("1971-01-04,2.3938", "1971-01-04,2.3939"));
    assert.throws(() => loadVerifiedSlowFixture(root), /sha256/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const r = runSlowDirectionResearch();

t("real FX, 1971-2026: the pinned result (17 discoveries before 2000, none confirmed after)", () => {
  assert.equal(r.family, PINNED.family);
  assert.equal(r.discoveries, PINNED.discoveries);
  assert.equal(r.survivors, PINNED.survivors);
  assert.equal(r.resultHash, PINNED.resultHash);
  assert.equal(r.coverage.length, 9);
  for (const c of r.coverage) assert.ok(c.months >= 300, `${c.ccy}: ${c.months} months`);
});

t("the doc is exactly what the code measures", () => {
  assert.equal(readFileSync(DOC, "utf8").split("\n## Reading these results")[0]!.trimEnd(), renderSlowDirectionMarkdown(r).trimEnd());
});

console.log(`\n${passed} passed`);
