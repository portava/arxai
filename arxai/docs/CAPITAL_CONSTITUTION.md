# ARX Capital Constitution

Blueprint Part II #53, Phase 0 governance artifact. These articles are the
rules that ordinary configuration, AI reasoning, and future features may never
weaken. Changing this document requires an explicit owner ruling recorded in
the Owner Decision Registry (`docs/OWNER_DECISIONS.md`, `owner_decisions`
table). A CI guard (`scripts/src/ci/check-capital-constitution.ts`) pins every
article heading and the central rule; a silent edit fails the build.

## Article I — The Central Rule

More intelligence does not automatically earn more authority. Every added component must improve measured decisions, remain reproducible, preserve deterministic risk, and be removable without endangering positions or economic truth.

## Article II — Authority Hierarchy

Deterministic risk rules > AI reasoning > strategy > execution. Capital
exposure is controlled by deterministic permissions, data-health checks, risk
authorization, broker capability checks, and audited execution — never by
model confidence.

## Article III — Refusal Is a Valid Result

WAIT, SUSPEND, UNKNOWN, and COMPLIANCE_HOLD are correct outputs. When
evidence, permission, settings, or system state are insufficient, the system
refuses or returns empty-with-reason. It never fabricates data, defaults, or
authority.

## Article IV — Authority Is Earned by Evidence

Every capability is promoted only to the maximum authority its evidence
package supports, expires unless the evidence remains current, and green CI
alone never grants live authority.

## Article V — Truth Is Append-Only

Decision, trade, audit, and ruling ledgers are append-only. History is never
rewritten; corrections are forward-fixes that name what they supersede.

## Article VI — Owner Authority

Expanding owner limits, enabling real money, or weakening any article requires
the owner's explicit governance procedure. Agents and AI may surface, explain,
and propose — they may not silently replace an owner decision.

## Article VII — Immediate Decisions and Holds

Quoted verbatim from Blueprint Part V:

> Real money remains OFF until evidence, demo execution, reconciliation, recovery and owner authorization gates pass.
>
> MT5 requires a terminal-side EA or another certified connector when the broker exposes no suitable direct API.
>
> Broker-native market data is primary; no fabricated candles or guessed symbol identifiers.
>
> Self-Trading is the first complete product mode. Managed Allocation follows only after account isolation and compliance are proven.
>
> Shared live netting among assigned users remains prohibited unless true broker-native subaccounts or equivalent isolation exist.
>
> Outside-client discretionary management remains COMPLIANCE_HOLD pending jurisdiction-specific counsel and broker approval.
>
> The original trade-count and dollar targets remain objectives/capacity ideas, never quotas or evidence of available edge.

## Article VIII — Amendment Procedure

An amendment is valid only when (1) an owner ruling authorizing it is appended
to the Owner Decision Registry, and (2) the pinned heading list in
`check-capital-constitution.ts` is updated in the same reviewed change.
Removal of an article is a constitutional event, never a cleanup.
