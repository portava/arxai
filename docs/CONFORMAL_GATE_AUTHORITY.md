# Conformal Gate Authority — `ARX_CONFORMAL_GATE_ENABLED`

**Status: DEFAULT OFF. Flipping this flag is an OWNER PRESS.**

## What exists

Capability #4 (Conformal Decision Bounds) is built in three layers:

1. **`lib/validation/src/conformal.ts`** — pure split-conformal machinery:
   chronological calibration, interval / prediction-set construction,
   empirical-coverage validation on a later window, and the advisory
   `conformalGate` verdict (`admissible` + `advisoryOnly: true`).
2. **`lib/domain/src/confidence-gate/`** — the verdict rides confidence-gate
   results as journal/display evidence (`attachConformalAdvisory`), and the
   staged authority integration lives in `conformalAuthority.engine.ts`
   (`applyConformalAuthority`).
3. **`artifacts/api-server/src/lib/conformal/conformalGateFlag.ts`** — the
   single reader of `ARX_CONFORMAL_GATE_ENABLED`.

## The authority contract (tighten-only, doubly gated)

`applyConformalAuthority` lets an `admissible: false` verdict **veto** an
approved confidence-gate result — demoting `approved: true / ENTER` to
`approved: false / WAIT` — **only when BOTH hold**:

1. **The owner has pressed the flag**: `ARX_CONFORMAL_GATE_ENABLED` is set to
   an explicit affirmative (`1`/`true`/`yes`/`on`). Absent or anything else
   → the verdict stays advisory (`ADVISORY_FLAG_OFF`).
2. **Empirical coverage is PROVEN**: `proveConformalCoverage` requires a
   coverage validation that **passed**, on a **later chronological window of
   at least `CONFORMAL_MIN_EVALUATION_WINDOW` (200) records**, with a finite
   measured empirical coverage. Anything less → advisory
   (`ADVISORY_COVERAGE_UNPROVEN`).

Even when armed, the integration is **tighten-only**:

- `admissible: true` changes **nothing** (`NO_ACTION_ADMISSIBLE`) —
  admissibility is never a source of confidence;
- an already-blocked/unapproved result changes **nothing**
  (`NO_ACTION_ALREADY_RESTRICTED`) — the veto can never loosen, re-approve,
  raise a score, or remove a blocker;
- the veto writes exactly: `approved: false`, `recommendation: "WAIT"`, and an
  appended `[CONFORMAL]` warning. No other field changes.

This is deliberately **not** a new gate key in the live gate wall — the
venue-parity contract (`derivDemoGateParity`) makes gate keys a certification
surface, and conformal authority is staged as a tighten-only demotion on the
confidence-gate result instead.

## How the owner arms it (the press)

1. Verify coverage evidence exists: a `validateCoverage` run over ≥ 200
   later-window records that **passes** at the declared coverage/tolerance.
   (Until a persistent labeled-prediction feed accumulates that window, the
   honest state of this flag is OFF.)
2. Set `ARX_CONFORMAL_GATE_ENABLED=true` in the deployment environment.
3. On boot/first use, the api-server logs `conformal_gate_ARMED` (once,
   loudly). No code change is involved; unsetting the variable disarms it
   immediately.

Nothing in the codebase sets this variable. CI runs with it unset, so every
test asserts the default-off behavior. The proof tests live in the
`test:conformal-authority` lane
(`artifacts/api-server/src/lib/__qa__/conformalAuthority.test.ts`).
