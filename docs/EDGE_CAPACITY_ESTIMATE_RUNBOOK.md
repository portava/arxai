# Runbook — recording an edge capacity estimate (foundation gate #23)

Branch: `hold/capacity-estimates` · base `746e764` (`phase6/guided-mode`)

## What this is about

Foundation gate #23 (`EDGE_CAPACITY_EXCEEDED`) refuses **every driver-placed
live entry** on an edge that has no recorded capacity estimate. That is the
correct behaviour — deny by default — and today it applies to every edge in
`production_edges`, because no estimate has ever been recorded on any of them.

Before this branch that refusal was invisible: entries simply did not happen and
nothing said why. This branch adds three things, in the order an operator meets
them:

1. **A readout** of what gate #23 does to each edge right now, and why.
2. **A proposal** of what the ruin/capacity simulator would say, derived from
   evidence this system actually recorded — or an explicit
   `INSUFFICIENT_EVIDENCE` naming exactly what is missing.
3. **The press**, which stays the owner's. Nothing here records itself.

## The press boundary

Everything up to the press is built. The press itself is not automated and
cannot be:

- A proposal has **no write path**. The evidence collector and the proposals
  route contain no `db.insert` / `db.update` / `db.delete`, pinned by
  `test:edge-capacity-proposal`.
- The **USD deployable ceiling is never proposed**, on any evidence. The
  simulator answers in planned-risk R; converting R into a cumulative USD
  ceiling needs a capital basis attached to the edge, which this system does not
  hold. Inventing one would be a learned output setting a size. It is the
  owner's number.
- A recorded estimate is stamped **admin-authored** in
  `capacity_evidence_json.authorship` alongside `capacity_recorded_by_admin_id`,
  so a later reader never has to infer authorship from a bare integer.
- What the proposal said at the moment of the press is recorded beside it as
  `proposalAtPressTime` — **context, never authority**. No branch in the
  recording route reads it.

## Prerequisite (may already be done)

The `capacity_*` columns on `production_edges` come from campaign-3's pending
migration `docs/migrations-pending/build-tenant-capacity-gates.sql` (all
additive, all `IF NOT EXISTS`). **This branch adds no schema of its own.** If
that file has not been applied to the target database, the proposals route
returns `503 EDGE_LIBRARY_UNAVAILABLE` with a message saying so — an unreadable
state, deliberately not an empty one.

## The owner's presses, in order

### 1. Look at the readout

Admin → **Edge capacity**. The first card answers "what does gate #23 do right
now". Expect, today, on every edge:

> Gate #23 currently refuses a driver-placed live entry on ALL N edge(s). N of
> them are waiting on an admin press, not on more data.

with per-edge blocker `NO_ESTIMATE_RECORDED` and the gate's own refusal text.

Read the blocker code before doing anything else — it tells you whether a press
would even help:

| Blocker | What it means | Does a press fix it? |
|---|---|---|
| `NO_ESTIMATE_RECORDED` | Nothing was ever recorded. | Yes — this runbook. |
| `NO_PRESSED_USD_CEILING` | An `ESTIMATED` verdict exists with no ceiling. | Yes — press a ceiling. |
| `STATUS_NOT_ESTIMATED` | The simulator found no safe capacity. | **No.** Better inputs or a better edge. |
| `DEPLOYED_SIZE_UNKNOWN` | Deployed USD could not be established. | No — fix the missing spec/price first. |
| `CEILING_ALREADY_FULL` | The edge is at its ceiling. | Only by raising the ceiling deliberately. |

### 2. Read the proposal

The second card shows, per edge, either a proposed `capacity_risk_r` with the
inputs it used, or `INSUFFICIENT_EVIDENCE` with a list of gaps. Each gap says
what is missing **and what would settle it**.

Today every edge is expected to read `INSUFFICIENT_EVIDENCE` with at least:

- `NO_CLOSED_TRADES_ATTRIBUTED` — nothing has traded under this edge.
- `NO_RESOLVED_DISPATCHES` — no command carrying this edge has ever resolved,
  so the fill probability is unknown, and an unknown fill probability is **not**
  100%.
- `SLIPPAGE_NOT_MEASURED` — slippage only ever lowers capacity, so assuming zero
  would overstate the answer.

That is the honest answer, not a failure. It means the machine has nothing to
contribute yet and the press, if made, is entirely the owner's judgement.

### 3. Press record — deliberately

`POST /api/admin/learning/edges/:id/capacity`, or the third card on the page.

Fill in the distribution (win rate, average win in R, average loss in R as a
negative) and, if you intend the edge to admit anything, the **USD deployable
ceiling**. Nothing is pre-filled. If a proposal exists you may press *Copy these
inputs into the form below* — that is its own visible press, and the page then
states that the inputs were copied and are still yours to change or abandon.

What the server does with it:

- Runs the seeded ruin/capacity simulator on **exactly** what you sent.
- Honours the USD ceiling **only** behind an `ESTIMATED` verdict; on
  `NO_SAFE_CAPACITY` / `DEGENERATE_INPUT` it stores `null` and gate #23 keeps
  refusing.
- Writes `capacity_*` columns only. It cannot touch the promotion ladder —
  `status`, `liveAllowed`, `adminApproved`, `shadowValidated`, the evidence
  hashes — pinned by `test:tenant-capacity-gates`.

Two things that are easy to get wrong:

- **An estimate without a pressed ceiling admits nothing.** An `ESTIMATED`
  verdict alone is not permission; the readout will still say
  `NO_PRESSED_USD_CEILING`.
- **A recorded estimate is not a promotion.** Gate #23 is AND-ed after every
  other cap. Clearing it changes nothing about `liveAllowed`, which remains the
  owner's separate press on a separate surface.

### 4. Recheck the readout

Press *Recheck gate #23*. The pressed edge should flip to **WOULD ADMIT AN
ENTRY** with a ceiling, a deployed figure and a headroom. Every other edge is
unchanged — the press is per-edge and never fleet-wide.

## Verification on this branch

| Check | Result |
|---|---|
| `pnpm --filter @workspace/api-server run test:edge-capacity-proposal` | 19/19 pass |
| `pnpm run typecheck` | exit 0 |
| `pnpm run ci:guards` | 69/69 pass |
| Neighbours: `test:tenant-capacity-gates`, `test:ruin-capacity`, `test:foundation-gates`, `test:edge-promotion`, `test:mission-autonomy-gates`, `test:execution-policy-promotion` | 122/122 pass |
| Dashboard: `test:unwired-capabilities`, `test:promotion-refusal`, `test:admin-hub-routes` | 59/59 pass |

Mutation evidence (both run against a compiling tree, both restored):

- Making an `INSUFFICIENT_EVIDENCE` proposal carry `0` / `"ESTIMATED"` instead
  of `null` → 3 tests red.
- Making the readout treat a missing estimate as passing → 4 tests red.
