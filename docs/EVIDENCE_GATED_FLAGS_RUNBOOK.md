# Evidence-gated flags — the runbook

**Two flags are held OFF, and neither is held because code is missing.** They
are held because nobody could SEE whether the arming bar was met. This document
is how you look, and what the single remaining press would do in each case.

| Flag | Capability | Report | Press |
|---|---|---|---|
| `ARX_CONFORMAL_GATE_ENABLED` | #4 conformal authority | `GET /api/admin/evidence-gates/conformal-coverage` | an environment variable — **owner only** |
| execution-policy promotion | #27 shadow chooser | `GET /api/admin/evidence-gates/execution-policy-promotion` | `POST /api/admin/execution-policy/enable` |

Both reports are rendered on **Admin → Governance** (`/admin/governance`).
Both endpoints are **read-only**: they SELECT and return data. Producing a
report cannot arm a flag, unlock a press, refresh the promotion ladder, or
write any row — a report that could change what it reports on would not be
evidence.

---

## The verdict vocabulary

Both reports answer with exactly one of four words. There is no fifth, and no
"probably".

| Verdict | Meaning |
|---|---|
| `INSUFFICIENT_HISTORY` | Not enough evidence to judge the bar. **A zero sample lands here.** |
| `BAR_NOT_MET` | Enough evidence to judge, and it does not clear the bar. |
| `BAR_MET` | Enough evidence to judge, and it clears the bar. The press is the owner's. |
| `SOURCE_UNREADABLE` | The evidence could not be read. **Not the same as empty** — `sampleSize` is `null`, never `0`. |

Three reading rules follow from that, and the surface enforces them:

1. **A measurement that was never taken renders as `NOT MEASURED` with the
   reason** — never as `0`, an empty bar, or a dash. `value: null` is the
   honest typed null; substituting a plausible zero is the failure this whole
   surface exists to prevent.
2. **`0` with `feed.writerWired: false` means "nothing writes this feed"**, not
   "quiet week". Both feeds are in that state today (see below), so their
   samples cannot grow on their own.
3. **`barMet` is derived from the verdict**, in one constructor
   (`buildEvidenceGateReport`). No caller can hand-set a met flag or present an
   unmet bar as pressable.
4. **`sampleSize` is NOT the number the bar judges.** It counts the whole feed;
   `bar.requiredSampleSize` bars something narrower — for #4 the *later*
   chronological evaluation window, for #27 the *qualifying* subset. So a
   report can read "200 journaled" against a requirement of 200 and still be
   `INSUFFICIENT_HISTORY`, because the barred quantity is 100. Each report
   names both (`sampleLabel`, `bar.requiredSampleLabel`) and points at the
   measurement carrying the barred one
   (`bar.requiredSampleMeasurementKey`), and the card renders **that** value
   against the requirement. Read the line under the sample, not the sample.

---

## A) Conformal authority — `ARX_CONFORMAL_GATE_ENABLED`

### What the bar is

Empirical coverage within **±0.05** of the declared **0.9**, measured on a
**later chronological window of at least 200** labeled predictions. That is the
same proof the authority path itself requires (`proveConformalCoverage`,
`CONFORMAL_MIN_EVALUATION_WINDOW = 200`), so the report cannot be more
permissive than the gate.

The report splits the journaled predictions chronologically (never shuffled — a
shuffled split leaks the future into calibration and overstates coverage),
calibrates the absolute-residual quantile on the earlier half, and measures how
many realized outcomes on the later half landed inside the calibrated interval.

### Today's answer: `INSUFFICIENT_HISTORY`, sample 0

Not "few predictions". **No writer.** `applyConformalAuthority` has no
production call site (the confidence gate has no live assembler in the
api-server), and `lib/validation`'s `conformalGate` / `calibrateConformal` have
no caller outside tests. Nothing appends to the
`CONFORMAL_ADVISORY_PREDICTION` feed, so the sample will not grow on its own.

Both facts are **source-pinned constants**
(`CONFORMAL_ADVISORY_FEED_WRITER_WIRED`, `CONFORMAL_AUTHORITY_CALL_SITE_WIRED`
in `artifacts/api-server/src/lib/conformal/conformalCoverageSource.ts`) and the
proof suite greps the tree for a writer/call site: the day one appears, the
test fails RED and forces the constants to be updated with it.

### What arming would change — TODAY: nothing

Setting `ARX_CONFORMAL_GATE_ENABLED=true` today changes **no behavior**. The
boot log says `conformal_gate_flag_SET_NOT_WIRED` and that is the honest state.

Once a production consumer of `runConfidenceGate` calls
`applyConformalAuthority`, arming would mean:

- **Tighten-only**: an `admissible: false` verdict could demote an APPROVED
  result (`approved: true` / `ENTER`) to `approved: false` / `WAIT` and append a
  `[CONFORMAL]` warning. Nothing else changes.
- It can **never** approve, re-approve, raise a score, or remove a blocker.
  `admissible: true` changes nothing at all.
- Even armed, the veto stays inert until coverage is **proven** — this report is
  that proof.
- Unsetting the variable disarms immediately.

### The press (owner only — not taken by any code here)

1. Read the report; confirm the verdict is `BAR_MET`.
2. Confirm the boot log no longer says `conformal_gate_flag_SET_NOT_WIRED`.
   **If it still does, the press does nothing — do not treat the flag as
   protection.**
3. Set `ARX_CONFORMAL_GATE_ENABLED=true` in the deployment environment.
   Nothing in this repository sets it; CI runs with it unset.
4. Verify the boot log states the veto is armed.

See `docs/CONFORMAL_GATE_AUTHORITY.md` for the full authority contract.

---

## B) Execution-policy promotion — capability #27

### What the bar is

- ≥ **50** journaled shadow recommendations whose fill quality was measured for
  **both** execution shapes (each at ≥ `MIN_FILL_SAMPLE` fills), **and**
- ≥ **25** of those with a **non-tie measured fill-quality advantage** (lower
  median adverse slippage for one shape), **and**
- ≥ **70%** of those favoring the **same** shape — a chooser whose evidence
  flip-flops has proven nothing.

### Today's answer: `INSUFFICIENT_HISTORY`, sample 0

Again: **no writer.** `recordExecutionPolicyShadowRecommendation`
(`artifacts/api-server/src/lib/execution/executionPolicyShadow.ts`) is the only
writer of the `EXECUTION_POLICY_SHADOW_RECOMMENDATION` journal and has no caller
outside tests. Scheduling the shadow chooser is a separate reviewed change.
Pinned by `SHADOW_JOURNAL_WRITER_WIRED` plus a grep in the proof suite.

### What the press would change — TODAY: nothing observable

Pressing records `ENABLED` on the promotion ladder. That is the whole change.
**No dispatch path consumes `ENABLED`** — `resolveExecutionPolicyMode` has no
execution-path caller — so the chooser stays observably shadow. Wiring the first
consumer is a separate reviewed change.

Nothing auto-enables: automatic refresh can only move `SHADOW ↔ PRESS_UNLOCKED`
(both shadow-mode), and the return type of `decideAutomaticTransition` forbids
`ENABLED`.

### The press

1. Read the report; confirm the verdict is `BAR_MET`.
2. Open **Admin → Governance → Execution-policy promotion (#27)**.
3. Note the ladder status. If it is still `SHADOW`, load
   `GET /api/admin/execution-policy` once — that read refreshes the ladder and
   unlocks the press seam. `PRESS_UNLOCKED` **grants nothing**; it only makes
   the seam willing to accept a press.
4. Type a reason (written to the admin audit log) and type `ENABLE` to arm the
   button.
5. Press **ENABLE**. The server re-collects and re-verifies the evidence **at
   press time** and refuses if it no longer holds.
6. Reverting to `SHADOW` is always accepted — authority only shrinks on the way
   back.

---

## Where the code is

| Piece | Path |
|---|---|
| Shared report vocabulary (pure) | `lib/domain/src/evidence-gate/evidenceGateReport.types.ts` |
| Coverage report engine (pure) | `lib/domain/src/confidence-gate/conformalCoverageReport.engine.ts` |
| Promotion report engine (pure) | `lib/domain/src/execution-policy/executionPolicyPromotionReport.engine.ts` |
| Coverage evidence source (read-only IO) | `artifacts/api-server/src/lib/conformal/conformalCoverageSource.ts` |
| Promotion evidence source (read-only IO) | `artifacts/api-server/src/lib/execution/executionPolicyPromotionReport.ts` |
| Read-only routes | `artifacts/api-server/src/routes/adminEvidenceGates.ts` |
| Surface | `artifacts/trading-dashboard/src/components/admin/EvidenceGateReportCard.tsx`, rendered on `src/pages/admin/governance.tsx` |

## Proof suites

```bash
pnpm --filter @workspace/api-server       run test:conformal-coverage-report
pnpm --filter @workspace/api-server       run test:execution-policy-promotion-report
pnpm --filter @workspace/trading-dashboard run test:evidence-gate-card
pnpm --filter @workspace/api-server       run test:evidence-gate-source-io
```

All four are wired into the root `ci` chain. Between them they pin: the
verdict is `INSUFFICIENT_HISTORY` below the bar (zero sample, short window, and
a vacuous unbounded interval alike); a synthetic fixture **at** the bar reads
`BAR_MET`; an unreadable source is `null`, never `0`; the number rendered
against the arming bar is the barred quantity, not the feed total; no report
path can flip the flag, write a row, or move the ladder; and the feeds' missing
writers stay missing (or the grep pins fail red).

`test:evidence-gate-source-io` is the end-to-end half: it runs the real IO
adapters and the real route handlers against a fake `@workspace/db` whose
query builder can be made to THROW, so "an outage is a null, never a zero" is
proven where the decision is actually made, not only at the pure engines. It
also executes the route's admin gate (401 anonymous / 403 non-admin / 200 for
ADMIN and OWNER) rather than string-grepping it.
