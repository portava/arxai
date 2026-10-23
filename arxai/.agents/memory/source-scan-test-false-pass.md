---
name: Source-scanning acceptance tests false-pass off comments
description: Regex/substring tests that read a component's source can match doc-comment text, not rendered copy — assert absence too.
---

A QA test that reads a frontend file as a string and asserts an exact
user-facing sentence with a regex will also match that sentence if it appears
in the file's **doc-comment header**. Removing the rendered copy then leaves
the test green while the UI no longer shows it.

**Why:** the scanner master-live banner test asserted
`/Master live trading requires admin approval\./.test(guard)`. The rendered
sentence was removed, but the same sentence in the file's top doc comment kept
the test passing — a silent false pass.

**How to apply:** when a copy change is the point of the task, update the
source-scan test to (a) assert the NEW phrasing is present AND (b) assert the
OLD phrasing is ABSENT (`!/old/.test(...)`), and strip the old verbatim
strings from doc comments too. Pair presence + absence checks so the test
actually tracks rendered behavior, not incidental comment text.

## Forbidden-token guards must be narrow when the token lives in legit CODE
A `mustNotContain` needle that blacklists a stale phrase will false-POSITIVE if the same token legitimately appears in CODE (not just a stripped comment). When deriving the assistant safety state, the AUTHORITATIVE prompt block intentionally uses words like "system-locked" / "paper-only" in code *to instruct Ruby NOT to make that claim*. Blacklist the exact stale sentence (`/live remains system-locked/i`), never the bare word. A blanket `/system-locked/i` is only safe where every code occurrence was removed and the token survives solely in a stripped doc-comment (true for tools.ts, false for systemPrompt.ts).

**Also:** the system prompt builder CONSUMES the per-user envelope as a param (`buildSafetyStateBlock(envelope)`) — it does NOT call `deriveAssistantEnvelope` itself (callers do). A `mustContain: deriveAssistantEnvelope` on systemPrompt.ts is wrong; assert `buildSafetyStateBlock` + the derived branch consts instead.

## Literal-scan guards go stale on centralization
When a safety guard scans for an inline literal (e.g. `isNull(arxLivePositionsTable.reconcileState)`) in specific files, centralizing those reads onto a shared predicate (e.g. `openLiveExposureCondition`) removes the literal and trips the guard even though safety is intact/stronger. Fix = update the guard to (a) assert the canonical predicate itself enforces every required filter, and (b) assert each consumer delegates to it (accept helper-call OR legacy inline literal). Do NOT re-inline the literal to appease the scan — that regresses the centralization.

**Counterpart (false-FAIL off comments):** a static lock that asserts a
forbidden call token is ABSENT from a source file (e.g. `\banalyzeMarket\(`
must not appear in the scanner) will also match the token inside an
explanatory comment describing the removal — the guard fails on its own
documentation. When adding a "token must be gone" lock, reword any comment
that quotes the forbidden call verbatim (describe it without the literal
`name(` shape), or the lock can never pass.
