---
name: CI text-scan guard comment-stripping must preserve line/col
description: Why a no-direct-execution-style source-scan guard must blank comments in place, never delete lines.
---

A text-scan CI guard that strips comments before scanning MUST blank them
*in place* — never delete lines — or every reported `line` below a comment
drifts from the real source and the guard points at the wrong code.

**Rule:** block comments → replace each non-newline char with a space
(`m.replace(/[^\n]/g," ")`, keeps newline count); whole-line `//` comments →
map to `""` (keep the empty line), never `.filter` them out. Then report
`:line:col` via `rx.exec(line)` (`m.index+1`) + the exact matched token
`m[0].trim()` — not just `rx.test` + the trimmed line.

**Why:** the original `stripComments` used a multiline block-comment
`.replace(...,"")` plus a `.filter` that removed `//` lines, so line indices
no longer matched the file. Column-preserving blanking also keeps `m.index`
equal to the real source column, so editor-jumpable `file:line:col` is exact.

**How to apply:** any guard in `scripts/src/ci/` that splits source into lines
and reports `i+1`. The provenance helpers (parseNamedImports/parseReexports/
definesSymbol) are unaffected — they are content-based and spaces are safe
token separators. Tests must NOT assert the violation-string format unless
they intend to lock it; the assistant/chart tests assert `flags.length`, so
message enrichment is safe.
