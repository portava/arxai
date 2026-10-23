---
name: getUserModeScope ⇄ computeAccountShell ⇄ buildInvestorLiveBalanceSnapshot cycle
description: The canonical mode resolver must never trigger the investor-balance snapshot, or the whole account path hangs.
---

# Rule

`getUserModeScope` → `computeAccountShell` → `buildInvestorLiveBalanceSnapshot` → `getUserModeScope`
is a closed mutual-recursion triangle. Because every hop is `async`/`await`, it
does **not** overflow the stack or throw — `getUserModeScope`'s try/catch→PAPER
fallback never fires; it just recurses forever doing DB queries and **hangs**
(no error, no timeout). This silently breaks `/api/me/account`, the balance SSE
stream, Ruby, and the risk engine — anything that resolves a mode or builds the
canonical balance.

**Why:** `buildInvestorLiveBalanceSnapshot` needs the resolved account mode and
resolves it via `getUserModeScope`; `computeAccountShell` (the canonical
`/my-account` shell) embeds the snapshot in its `live` field; and
`getUserModeScope` builds the shell to read mode-precedence inputs.
`computeAccountShell` is *upstream* of the mode resolution, so it cannot pass a
canonical mode down to break the cycle — the break must happen by **not building
the snapshot at all** when the shell is requested by the resolver.

**How to apply:** `getUserModeScope` only reads `accountShell.tradingMode`,
`.tradingStatus`, and `.notes` — never `.live`. So it calls
`computeAccountShell(userId, { skipInvestorSnapshot: true })`, which sets
`inv = null` and emits honest unavailable defaults in the `live` block (caller
discards it). Never let `getUserModeScope`'s shell call build the investor
snapshot. If you add a new caller into `computeAccountShell` from inside the
mode-resolution path, pass the same skip flag or you reintroduce the hang.

**Detecting this class of bug:** an endpoint that times out with no error/log,
plus a function whose async call graph forms a cycle. Confirm with a depth
counter (a temporary `console.error` at the suspected node) run against a real
user — unbounded growth = cycle. tsx probes in `scripts/src/` must wrap the body
in an async IIFE/`main()` (CJS output rejects top-level await).

**Now enforced by CI:** `check-mode-scope-no-investor-snapshot` (wired into
`pnpm run ci:guards`) fails the build if the resolver calls `computeAccountShell`
without `skipInvestorSnapshot: true`, if the resolver references
`buildInvestorLiveBalanceSnapshot`, or if `computeAccountShell` stops gating its
snapshot build behind `opts.skipInvestorSnapshot ? null : …`. The static guard
covers code-level re-introduction; it does not catch a brand-new cycle through a
different function.
