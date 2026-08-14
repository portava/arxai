// Truth-lock unit test (pure, no DB). Verifies a locked prediction is
// immutable while appended reviews remain allowed.
//
// Run: pnpm --filter @workspace/scripts run test:agent-truth-lock

import {
  assertPredictionEditable,
  buildPredictionLock,
  buildReviewSkeleton,
  isLocked,
  TruthLockViolation,
  LOCKED_PREDICTION_FIELDS,
} from "@workspace/domain/agent-system";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`); failures++; }
}

console.log("Agent truth-lock test");

// 1. Unlocked prediction: any patch is allowed (no throw).
const unlocked = { predictionId: "p1", locked: false };
let threw = false;
try { assertPredictionEditable(unlocked, { confidenceScore: 90, decision: "approve" }); }
catch { threw = true; }
check("unlocked prediction accepts edits", threw === false);

// 2. buildPredictionLock locks it.
const lock = buildPredictionLock(new Date());
check("buildPredictionLock sets locked=true", lock.locked === true && lock.lockedAt instanceof Date);
check("isLocked reflects locked flag", isLocked({ locked: true }) && !isLocked({ locked: false }));

// 3. Locked prediction: editing a frozen field throws TruthLockViolation.
const locked = { predictionId: "p2", locked: true };
let violation: unknown = null;
try { assertPredictionEditable(locked, { confidenceScore: 10 }); }
catch (e) { violation = e; }
check("locked prediction rejects frozen-field edit", violation instanceof TruthLockViolation);
check(
  "violation names the offending field",
  violation instanceof TruthLockViolation && violation.attemptedFields.includes("confidenceScore"),
);

// 4. Every declared frozen field is actually rejected on a locked prediction.
let allFrozenRejected = true;
for (const field of LOCKED_PREDICTION_FIELDS) {
  let rejected = false;
  try { assertPredictionEditable(locked, { [field]: "x" }); }
  catch (e) { rejected = e instanceof TruthLockViolation; }
  if (!rejected) { allFrozenRejected = false; console.error(`    not rejected: ${field}`); }
}
check("all frozen fields rejected when locked", allFrozenRejected);

// 5. Lifecycle-only fields are allowed even when locked (outcome recording).
let lifecycleThrew = false;
try {
  assertPredictionEditable(locked, {
    locked: true, lockedAt: new Date(), outcomeStatus: "WIN", outcomeReviewedAt: new Date(),
  });
} catch { lifecycleThrew = true; }
check("locked prediction accepts lifecycle/outcome fields", lifecycleThrew === false);

// 6. Appending a review is always allowed (never edits the original).
const review = buildReviewSkeleton({ reviewId: "r1", predictionId: "p2", agentId: 7 });
check("review skeleton defaults to OUTCOME", review.reviewType === "OUTCOME" && review.predictionId === "p2");

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll truth-lock checks passed.");
