---
name: Offline network guard — provable, non-vacuous offline proof
description: How to make an in-process test deterministic by blocking external providers, and why an "escapedCount" metric inside a fetch wrapper is a tautology.
---

# Offline network guard for in-process tests

A parity/determinism test that boots the app in-process and exercises a read
path which enriches from rate-limited third-party providers (market/news APIs)
will FLAKE in batch runs even though it PASSES in isolation: global per-key quota
is drained by the live workflow + sibling lanes, so two reads ms apart get a
non-deterministic 200/429 mix → different enrichment → byte-parity breaks. The
primary data (e.g. MT5 candle push) is already deterministic; only enrichment is
external.

**Fix pattern:** swap `globalThis.fetch` with a guard that allows
loopback/relative and answers every external host itself with a deterministic
provider-unavailable response (503 empty-JSON) the read path already fail-soft
degrades on. Install AFTER the in-memory data push, wrap the reads in
`try/finally` to always `restore()` (run() may be aggregated into a shared
process), restore BEFORE the offline assertion.

**Why:** isolates the contract under test from live-quota nondeterminism without
weakening any assertion; the verifiable read derives solely from the
deterministic in-memory push.

## The key trap: "escapedCount() === 0" is structurally vacuous

A counter for "external calls that reached the network", read from inside a
`fetch` wrapper, can NEVER become non-zero by design (the wrapper never forwards
external requests). Asserting it `=== 0` proves nothing. Worse, a real bypass —
a captured pre-install `fetch` reference, or a non-fetch transport (node:http,
undici) — is invisible to the wrapper, so it cannot detect the very thing it
claims to.

**How to apply:** assert the POSITIVE, observable invariant instead —
`attemptCount() > 0 && blockedHosts().length > 0` proves the guard was actually
exercised (enrichment fanout was intercepted offline). If enrichment had reached
the live network instead, both would be 0. To prove the WHOLE process touched no
network, use an out-of-band pass-through fetch logger preloaded via
`NODE_OPTIONS="--import file:///tmp/netprobe.mjs"` (a no-EXTERNAL-line run is the
real egress proof) — not an in-wrapper counter.

Scripts package has no DOM lib: don't reference `RequestInfo`/`RequestInit`; use
`Parameters<typeof originalFetch>` for the forward types.
