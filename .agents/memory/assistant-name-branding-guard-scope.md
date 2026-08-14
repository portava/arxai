---
name: Assistant-name branding guard scope
description: Where user-facing "Ruby"→resolved-name copy lives, how the source-scan guard must be scoped, and how to classify library hits (allowlist vs fix).
---

# Assistant-name branding guard scope

The user-facing assistant-name guard (`scripts/src/ci/check-no-internal-names-user-ui.ts`)
is a **source scan** for the literal codename in user-facing copy. Getting its
scan roots wrong = silent leaks.

## Scan every layer that composes user copy
The guard must scan ALL of: `artifacts/trading-dashboard/src`,
`artifacts/api-server/src/routes`, `artifacts/api-server/src/lib`, AND
`lib/domain/src`. A frontend+routes-only scope is a trap — user-facing copy is
also assembled in the api-server library and in the **pure domain library**.
`lib/domain/src/signal-intelligence/explainMarketRead.ts` composes the
scanner/assistant market-read sentence surfaced at `GET /me/market-edge`.

**Why:** a FE+routes-only scan scope silently misses user-facing copy that is
composed inside libraries — both an api-server lib surface (chart
decision-event summaries) and a pure `lib/domain` surface (the market-read
lifecycle sentence) can leak the codename until the scan roots are widened.

## Domain code is pure/sync — reword, don't thread the resolver
Backend routes/lib resolve the name via `getAssistantDisplayName(userId)`
(fail-closed → "Eleanor"); FE uses `useAssistantName().name`. But `lib/domain`
is pure/sync with **no userId in scope** — do NOT import the async resolver
there. Neutralize a codename by rewording impersonally (precedent:
`featureMap.ts` uses "the assistant"; the WATCHING string became
"there is no active setup yet — just watching this market").

## Classifying a library hit: allowlist vs fix
Allowlist ONLY genuinely admin/operator/dev-internal surfaces (the brief keeps
internal naming there). Verify the **runtime projection**, not just a type
comment, before allowlisting:
- AACI (`lib/domain/src/aaci/*`): `conflict.detail`/`systems[]` are
  admin-only. `/me/aaci/*` returns only `userFacingExplanation` =
  `buildUserExplanation(action, hardGate.userMessages)` — it NEVER reads
  `cohesion.conflicts`; `systemConflicts` = `conflicts.map(c=>c.code)` (machine
  codes, not `.detail`). `systems: ["Ruby",...]` are typed `AaciHandshakeSystem`
  identifiers (renaming forbidden). → allowlist, don't change.
- Agent-system (`coreAgents.ts`, `constitution/agentConstitution.ts`) and
  handshake (`handshake.types.ts`, `handshakeRegistry.ts`) are internal
  registries / admin-monitor labels. → allowlist.
- `assistant/parseTradeCommand.ts` parses INPUT, emits no prose; its only hit is
  a comment the regex tokenizer can't fully model. → allowlist.

Everything else repo-wide that still contains the codename is out of scope by
construction: DB columns (`lib/db/src/schema/*`), generated types
(`lib/api-zod`, `lib/api-client-react`), OpenAPI schema names, `ruby_*` event
sources, and code comments — all internal identifiers the task must not rename.

## Prove completeness
Re-measure by walking the target roots through the guard's own
`findAssistantNameLeaksInSource` + `isAssistantScanExcluded` and assert zero
non-allowlisted hits; then run the regression suite + `ci:guards`. A repo-wide
`rg -w Ruby` (files/counts only — content can mangle in this env) confirms
nothing user-facing hides outside the scan roots.
