---
name: App-wide wiring-audit false positives
description: Recurring "defects" a wiring audit flags that are actually intentional/harmless — verify before editing.
---

# Wiring-audit false positives (verify before acting)

When running a broad ARX wiring/leak audit (esp. via explore subagents), these
get flagged repeatedly but are NOT real defects. Always verify before changing.

- **`x-security-role: ADMIN/OWNER` client header** in many `pages/*.tsx` fetches
  is NOT a privilege-escalation leak. The server **ignores** it in production
  (`api-server/src/lib/security/middleware.ts` — "the x-security-role request
  header is IGNORED"); it's a DEV-ONLY back-compat fallback in
  `security/session.ts`. The session cookie is authoritative. Removing it across
  ~40 files is a large no-benefit refactor — don't.

- **"Missing page" routes** (e.g. release-status, release-notes, feedback-center,
  strategy-tournament, strategy-promotion): an explorer's file-tree search can
  miss them; they exist under `trading-dashboard/src/pages/`. If the app builds
  and typechecks, the lazy imports resolve — the routes are live, not dead.

- **Stale lib `.d.ts` ⇒ phantom "no exported member" typecheck error.** A
  dashboard import of a generated hook (e.g. `useBulkPostAdminInvestorPerformance`)
  can fail typecheck while the hook clearly exists in
  `lib/api-client-react/src/generated/api.ts`. Cause is a stale composite-lib
  build, not codegen drift. Fix: run `pnpm run typecheck:libs` first, then the
  per-package typecheck. (Pairs with typecheck-oom-this-env.)

- **`Cannot find module '@workspace/X'` (TS2307) ⇒ missing node_modules symlink,
  not a missing dep.** When a `@workspace/*` lib import fails to resolve AND the
  downstream file sprouts cascading implicit-`any` / missing-return errors, check
  `artifacts/<app>/node_modules/@workspace/` for the symlink before touching code.
  The dep is usually already declared (`"workspace:*"`) but the symlink is absent
  from a stale install. Fix: run `pnpm install` (it relinks even when it prints
  "Already up to date" / "Lockfile is up to date"). The cascading implicit-any
  errors vanish once the module resolves — don't "fix" them individually.

**Why:** these three eat audit time and tempt unsafe edits. The agent-ecosystem
engines ARE wired (advisory-only) into scanner ranking / Ruby explain-signal /
scalp; live execution is fail-closed (no fake fills). The genuine gaps are the
agent-ecosystem admin *frontend dashboard* + background runner (manual-only
promotion/outcomes) and the pending-order snapshot no-op stub.
