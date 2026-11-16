---
name: Drizzle sql.raw expression-column gotcha
description: Building dynamic SQL clauses (EXISTS/joins) over configurable anchor columns breaks when a column is actually an expression.
---

When generating dynamic SQL with `sql.raw(...)` over a configurable list of
"anchor" sources (e.g. a retention/protection policy that matches snapshots
against several trade/decision tables by symbol + timestamp), do NOT store a
bare column name and then prefix the table alias at build time
(`src.${sql.raw(timeColumn)}`). That silently produces invalid SQL the moment a
source's time column is an expression rather than a plain column — e.g.
`coalesce(opened_at, created_at)` becomes `src.coalesce(opened_at, created_at)`,
which Postgres parses as `src.coalesce` and errors at runtime (a generic 500;
typecheck never catches it because it's a runtime string).

**Why:** TypeScript can't see inside a raw SQL string; the alias-prefix
assumption only holds for single bare columns.

**How to apply:** store each source's symbol/time as a **fully-qualified SQL
expression** already referencing the subquery alias
(`symbolExpr: "src.symbol"`, `timeExpr: "coalesce(src.opened_at, src.created_at)"`)
and emit it verbatim with one `sql.raw(expr)`. Always exercise the dynamic SQL
against the real DB once (an authed smoke call), since this class of bug is
invisible to typecheck and CI guards.
