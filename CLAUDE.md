# CLAUDE.md — permanent operating rules for this repository

**ARX AI — Analyze. Risk. eXecute.** A pnpm monorepo containing an AI trading
platform with real broker execution paths. Safety-critical code lives here.
Treat every change as if it can move money, because some of it can.

---

## 0. Read this before doing any work

Read these, in this order, before touching anything:

1. **`CLAUDE.md`** (this file) — operating rules and verification requirements.
2. **`docs/PROJECT_STATE.md`** — current architecture, phase, HEAD, what is
   built, what is blocked, what is next.
3. **`docs/HANDOFF.md`** — the concise current handoff.
4. **`docs/DECISIONS.md`** — confirmed owner/product/architecture rulings and
   standing holds. Never contradict a standing hold.
5. **`docs/CERTIFICATIONS.md`** — what is certified, with the evidence.
6. **`docs/OWNER_DECISIONS.md`** — the full append-only owner decision registry
   (`docs/DECISIONS.md` is a curated index of it, not a replacement).
7. **`docs/CAPITAL_CONSTITUTION.md`** — the eight articles ordinary work may
   never weaken.
8. **`docs/SAFETY_NOTES.md`** — inviolable invariants and untouchable surfaces.
9. **`.agents/memory/MEMORY.md`** — index of 297 topic memory files under
   `.agents/memory/`. Grep it before re-deriving anything about a subsystem;
   most sharp edges in this codebase are already written down there.

These five files (`CLAUDE.md`, `docs/PROJECT_STATE.md`, `docs/DECISIONS.md`,
`docs/HANDOFF.md`, `docs/CERTIFICATIONS.md`) are the **canonical shared memory**
for continuing this project without access to any prior conversation. If your
work changes what they assert, update them in the same change.

---

## 1. The governing invariant

> **ARX may be conservative, but it may never be falsely certain.**

Everything below follows from that sentence.

- `WAIT`, `SUSPEND`, `UNKNOWN`, `COMPLIANCE_HOLD` and empty-with-reason are
  **correct outputs**. Refusal is a valid result (Capital Constitution
  Article III).
- Never fabricate data, defaults, prices, candles, symbols, or authority.
- Never convert `UNKNOWN` into success or failure without venue evidence.
- Venue-proven evidence dominates local inference. Where they disagree, the
  venue wins **and the disagreement is reported**
  (`docs/DERIV_EXECUTION_STATE_MODEL.md`).
- Fail **closed** on missing or unreadable safety state. Not being able to read
  the stop button is not permission to trade.

---

## 2. Repository conventions

### Tooling
- **pnpm only.** `preinstall` in the root `package.json` deletes
  `package-lock.json` / `yarn.lock` and refuses non-pnpm agents.
- Node 24, TypeScript 5.9, Express 5, React 19 + Vite, Drizzle ORM + PostgreSQL,
  Zod (`zod/v4`).
- Workspaces: `artifacts/*`, `lib/*`, `lib/integrations/*`, `scripts`.

### Layout
| Path | Contents |
|---|---|
| `artifacts/api-server/` | Express API (port 8080, `/api/*`) |
| `artifacts/trading-dashboard/` | React frontend (port 24210) |
| `artifacts/mockup-sandbox/` | Component preview environment, dev only |
| `lib/api-spec/openapi.yaml` | API contract — **source of truth** |
| `lib/api-zod/`, `lib/api-client-react/` | **Generated. Do not hand-edit.** |
| `lib/db/src/schema/`, `lib/db/src/repositories/` | Drizzle tables + repos |
| `lib/domain/src/safety-contracts/` | Inviolable safety contracts |
| `scripts/src/ci/` | Invariant guards (`run-all.ts`) |
| `.agents/memory/` | Topic memory files + `MEMORY.md` index |

### Codegen
After editing `lib/api-spec/openapi.yaml`:
```bash
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck:libs      # rebuild DB/domain declarations after schema changes
```

### Schema changes
- **This repository has no migration system.** Schema reaches the database by
  owner-run `drizzle-kit push` or a hand-written additive SQL file under
  `docs/` (see `docs/phase6-additive-schema.sql`,
  `docs/phase6-additive-schema-2.sql`).
- Schema changes must be **additive**. No destructive migrations.
- Adding a table to `lib/db/src/schema/` does **not** create it in any database.
  Verify with `information_schema` before assuming a table exists.

### Identity
Internal identity is the integer primary key used in foreign keys; external /
client-facing identity is a separate `publicId` (Owner Ruling 3). New tables
follow both.

### Append-only ledgers
`audit_events`, `vault_events`, `state_transitions`, `execution_events`,
`owner_decisions` are append-only. Enforcement is **CI, not database ACL** — the
app connects as a superuser, so `REVOKE` would enforce nothing (Owner Ruling
12). The guard is `scripts/src/ci/check-vault-mutations.ts`. Never add an
`UPDATE`/`DELETE` against these, in Drizzle or raw SQL.

`docs/OWNER_DECISIONS.md` is itself append-only: a wrong ruling is corrected by
**appending a new ruling that names the one it supersedes**, never by editing.

---

## 3. Safety rules that are never negotiable

- **Do not weaken, bypass, or "temporarily disable" a gate.** The live path is
  default-deny behind a 23-gate evaluator
  (`lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts`). Passing
  fabricated facts to satisfy a gate is prohibited — it is a lie recorded in the
  audit log.
- **No 5th kill switch and no 6th limit store** (Owner Ruling 4). Compose from
  the existing primitives.
- **The only kill-switch bypass** is the emergency-CLOSE exemption pinned to
  `killSwitchCloseBypassApplies`
  (`artifacts/api-server/src/lib/live/killSwitchBypass.ts`) (Owner Ruling 6).
- **Only two files may call a venue adapter's `deliver()`**:
  `artifacts/api-server/src/lib/live/liveCommandPipeline.ts` and
  `artifacts/api-server/src/lib/phase6/guidedDispatchEntry.ts`. Enforced by
  `scripts/src/ci/check-phase6-execution-safety.ts` (rule R1).
- **Only `guidedDispatchEntry.ts` may read `ARX_EXECUTION_TIER` from the
  environment**, and only
  `lib/domain/src/safety-contracts/executionTier.ts` may decide what a tier
  value means (rule R2). No code path may escalate a tier from the mere
  presence of an environment variable.
- **Any handler touching `approvalTicketsRepo` must resolve an authenticated
  user** (rule R3).
- Per-user isolation: every query reading MT5 / demo / live / assistant data is
  scoped by `userId`. No row from user A ever reaches user B.
- No endpoint returns raw bridge tokens, `apiKeyHash`, session secrets, IP
  addresses, account numbers, or gate-snapshot blobs to non-privileged callers.
- Legacy server-wide `MT5_BRIDGE_TOKEN` env value is **rejected everywhere**.
  Per-user bridge tokens only; server stores SHA-256 hashes.
- Auto-close is `ALERT_ONLY`. The system never closes a position on a user's
  behalf.
- **Read `docs/SAFETY_NOTES.md` before modifying** `lib/safetyCore.ts`, vault
  tables, MT5 routes, `strategyEngine.ts`, anything under
  `lib/domain/src/safety-contracts/`, or the Phase B live pipeline.

---

## 4. Secrets

- Never commit, print, echo, log, or paste into a document: API keys, tokens,
  passwords, PATs, session secrets, `DATABASE_URL` values, raw bridge tokens, or
  full broker account identifiers.
- Describing a credential's **shape** (length, prefix class, "alphanumeric app
  id") is acceptable evidence; the value never is.
- The registration-key pepper in circulation before 2026-08-19 is **burned**
  (Owner Ruling 9). Never reintroduce it.
  `scripts/src/ci/check-no-committed-pepper.ts` guards this.

---

## 5. Verification requirements

**Nothing is "done" because it compiles.** Green CI alone never grants live
authority (Capital Constitution Article IV).

### Before every commit
```bash
pnpm run typecheck        # full workspace; must exit 0
pnpm run ci:guards        # invariant guards; currently 65/65
```

### The canonical pre-commit gate
```bash
pnpm run ci               # typecheck:ci + guards + the full named test list
```
`pnpm run ci` runs several hundred named suites (the list is inline in the root
`package.json`). It is long. Run it before proposing a merge; run the targeted
suites during iteration.

### Memory-constrained environments
`pnpm run typecheck` can OOM in the Replit sandbox. Use the serial lane:
```bash
pnpm run typecheck:ci     # one process per unit
```
See `.agents/memory/typecheck-oom-this-env.md`.

### DB-backed suites
Safety tests that need PostgreSQL do **not** run in the offline `ci` lane. They
run in `ci:integration` (`ARX_REQUIRE_INTEGRATION_DB=true pnpm run ci:integration`).
See `.agents/memory/integration-ci-lane.md`.

### Registering a new suite
Every new test script must be wired into the root `ci` script; the guard
`scripts/src/ci/check-test-scripts-wired.ts` fails the build otherwise.

### Evidence standard for a safety claim
A claim that a safety behaviour holds requires **all** of:
1. a deterministic test that asserts it,
2. **proof the test fails red** when the behaviour is removed (mutation), run
   against a **compiling** tree — a killed mutation on a broken tree proves
   nothing,
3. a CI guard when the claim is about code that must not exist anywhere (a unit
   test cannot see a second implementation that does not import it),
4. `pnpm run ci:guards` green.

Record the evidence in `docs/CERTIFICATIONS.md`.

### Honesty about results
Report what actually happened. If a suite fails, say so and quote the output.
If a check was skipped, say it was skipped. **A skipped check is not a passed
check** (commit `f8bba89`).

---

## 6. Working discipline

- **Read the code before writing any.** Documentation in this repository is
  frequently stale by design (the older audit reports are historical records).
  **Repository, code and git evidence outrank documentation.**
- Prefer forward-fixes that name what they supersede over silent edits.
- Do not run destructive git operations. Replit Agent bulk merges are a retired
  integration path (Owner Ruling 1); a stale export replayed over newer work is
  the single most likely way this repository loses truth.
- Commit messages in this repository explain **what was wrong and why the fix is
  correct**, not just what changed. Match that.
- Do not commit or push unless asked.
- Do not modify application behaviour as part of a documentation task.

---

## 7. When something cannot be established

Write **UNKNOWN**, and say what evidence would settle it. Do not guess, do not
infer a decision that no one made, and do not promote a plausible reading to a
fact. An invented certainty in these files is worse than a gap, because the next
agent will build on it.
