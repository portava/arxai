---
name: Ruby trade-parser percent-token boundary
description: Why percent figures need special boundary handling in the trade-command parser's numeric extractors
---

# Ruby trade-parser percent-token boundary

In the assistant trade-command parser, any extractor that reads a `%`/`percent`/`pct`
figure has two recurring traps. One is safety-critical.

- **A bare digit before `%` must not be read as a lot.** "risking 1%" should size by
  risk, not place a 1-lot order. The lot/volume extractor needs a negative lookahead so
  a number immediately followed by a percent token is rejected as a lot (a real lot is
  never followed by `%`, so "explicit lot wins over risk%" still holds).

- **Percent extractors must end with `(?!\w)`, never a trailing `\b`.** `%` is a
  non-word char, so `\b` after it fails at end-of-string / before a space; the bug only
  shows for the `%` form ("close 50%"), while the spelled-out "50 percent" form works.

**Why:** when the partial-close fraction extractor returned null for "close 50%", the
command fell through to a FULL close instead of a partial — an unintended-liquidation
risk on a live-trading intent surface.

**How to apply:** any new `%`-aware extractor uses `(?!\w)` (matches EOS + non-word,
still rejects "1percentage"), plus a parser-test case with the figure at end-of-string.
