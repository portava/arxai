// THEME G-FINISH — Post-Trade Debriefs: the reported defect did NOT reproduce.
//
// THE CLAIM
//   "Post-Trade Debriefs — reseed off a real source (it seeds from the removed
//    Paper Trading product)."
//
// WHAT IS ACTUALLY TRUE
//   The Paper Trading *frontend routes* were retired in Phase 3
//   (/paper-trading, /paper-testing-launch, /active-paper-session — see the
//   note in routeKnowledge.ts). The paper-execution *backend* was not: three
//   mounted routers still WRITE paper_orders —
//       lib/paperExecution/paperExecutionService.ts
//       routes/autoDebrief.ts
//       routes/paperTrading.ts
//   all reachable through routes/index.ts.
//
//   So autoDebriefService reads a table that is still actively fed. Debriefs
//   are not orphaned, and "reseeding" them would have meant migrating a working
//   pipeline off a live source onto a different one — a product change made on
//   a false premise.
//
// WHAT THIS SUITE IS FOR
//   The claim was plausible enough to audit, and the thing that would MAKE it
//   true is a future cut of paper execution. This pins the dependency so that
//   cut fails loudly here instead of silently starving debriefs of input.
//
// OPEN QUESTION FOR THE OWNER (not a defect, a product call): debriefs are
// built from PAPER orders. If the product's centre of gravity is live trading,
// debriefing only paper activity is a coverage gap — but that is a decision
// about what a debrief should cover, not a bug to patch.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

const WRITERS = [
  "artifacts/api-server/src/lib/paperExecution/paperExecutionService.ts",
  "artifacts/api-server/src/routes/autoDebrief.ts",
  "artifacts/api-server/src/routes/paperTrading.ts",
];

describe("G-FINISH — the debrief source is still fed", () => {
  it("autoDebriefService reads paper_orders", () => {
    const svc = read("artifacts/api-server/src/lib/autoDebriefService.ts");
    assert.ok(/paperOrdersTable/.test(svc), "the debrief builder reads paper orders");
  });

  it("paper_orders still has live writers", () => {
    const writers = WRITERS.filter((rel) => /\.insert\(paperOrdersTable\)/.test(read(rel)));
    assert.deepEqual(
      writers,
      WRITERS,
      "every known writer must still insert — losing them starves debriefs of input",
    );
  });

  it("those writers are reachable (their routers are mounted)", () => {
    const index = read("artifacts/api-server/src/routes/index.ts");
    for (const router of ["paperTradingRouter", "autoDebriefRouter", "paperExecutionRouter"]) {
      assert.ok(
        new RegExp(`router\\.use\\(${router}\\)`).test(index),
        `${router} must stay mounted for the debrief source to receive writes`,
      );
    }
  });
});

describe("G-FINISH — the debrief surface itself is intact", () => {
  it("the routes still exist", () => {
    const route = read("artifacts/api-server/src/routes/postTradeDebriefs.ts");
    assert.ok(/\/post-trade-debriefs/.test(route));
  });

  it("no speculative source migration was performed", () => {
    // The claim did not reproduce, so the pipeline is deliberately untouched.
    const svc = read("artifacts/api-server/src/lib/autoDebriefService.ts");
    assert.ok(
      /paperOrdersTable/.test(svc),
      "the source is unchanged on purpose — migrating it on a false premise " +
        "would have moved a working pipeline off a live feed",
    );
  });
});
