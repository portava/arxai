---
name: rg/grep matched-content mangling in this sandbox
description: bash ripgrep/grep can corrupt matched text in this env; use read tool or -l/-n for locations only
---

In this Replit sandbox, `rg`/`grep` content output run through the bash tool can
arrive **corrupted**: stretches of matched/printed text get replaced by a literal
`"n"`. Seen replacing many unrelated tokens in one pass (identifiers, string
literals, column names, enum values) — it is NOT a secret-redaction and NOT
keyword-specific, so the mangled content is untrustworthy.

Observed: a multi-file `rg -rn -i "a|b|c..."` source search came back heavily
mangled, while a `grep -c` over shell variables in the same session was clean —
so it is intermittent, not 100% reproducible.

**How to apply:**
- Never trust the *matched content* from a bash `rg`/`grep` dump for correctness
  decisions (diffs, "is token X present", code reading).
- Locations survive: `rg -l` (filenames) and `rg -n` (line numbers — the matched
  text may show as `"n"` but the line numbers are correct) are safe for *finding*.
- For actual content, use the `read` tool (handles output cleanly), or compare via
  a script that does the logic in-process and prints only a verdict, not raw lines.
