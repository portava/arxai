---
name: Text-scan import-boundary guard escape ladder
description: How to make a CI text-scan "module X must NEVER import forbidden module Y" guard actually robust, and what is provably out of scope.
---

# Text-scan import-boundary guard — the escape ladder

When a CI guard enforces "fenced execution/safety modules must NEVER acquire
forbidden module Y (e.g. a display-only contract)", a naive "no `import … from
"Y"`" regex is trivially bypassable. A determined caller can reach a bundled
global `require` through unbounded callee/argument syntaxes. Do NOT chase callee
shapes one by one — anchor on the only ALLOWED context and ban the two
capabilities.

**Robust invariant set (all four needed):**
1. **Ban the forbidden specifier LITERAL in every position except a genuine
   static `from` source.** Match a string literal whose WHOLE content is the
   forbidden specifier, then flag it unless it is the source of `import … from` /
   `export … from`. This single rule kills call-arg, array-element,
   object-literal-property (`{0:"Y"}` array-like for `apply`), variable-stash
   (`const S="Y"`), and side-effect `import "Y"` forms at once.
2. **A genuine static `from` source is ALWAYS quote-delimited (`'`/`"`), NEVER
   backtick.** `` from`Y` `` is a TAGGED-TEMPLATE call on an identifier merely
   named `from` (`const from=(s)=>import(s[0]); await from`Y``), not an import.
   So require BOTH quoted AND preceded-by-`from`; flag backtick literals
   unconditionally. (`from "Y"` quoted with no operator between is grammatically
   valid ONLY as import syntax — identifiers can't juxtapose a quoted string.)
3. **Ban the `require`/`createRequire` IDENTIFIER** (run on comment+string-
   stripped code) — catches `require(x)`, `globalThis.require`, `module.require`,
   `.require.cache`, even with a VARIABLE specifier.
4. **Ban bracket-string `["require"]` access** — the bundler-injected global
   require (and its `.cache`) hides the token inside a string that the identifier
   scan in (3) strips. (3)+(4) together cover every way to NAME `require`.

**Accepted OUT-OF-SCOPE for a text scan (do NOT try to detect — brittle false
positives):** pure runtime reflection that names NEITHER the specifier literal
NOR the require capability — `Reflect.get(globalThis, computedKey)`, walking a
require cache populated by other non-fenced code, member reached by computed
access — and split-string / char-code construction (`"@scope/" + "pkg"`). These
construct nothing statically resolvable and belong to the architectural
fenced-dir boundary + code review, not a regex.

**Why:** chasing callee/argument syntax is unbounded; recognising the one
allowed context (quoted `from` source) plus the two capabilities (specifier
literal anywhere else, `require` named as identifier or bracket-string) is
finite and complete within static text scope. Keep the named-import/whole-
namespace/dynamic-import detectors too — they vet WHAT is imported in genuine
`from` positions (the literal-position rule defers to them there).

**Alias-resolution layer (for a "module X must NOT use forbidden SYMBOL"
name-scan, e.g. assistant-no-direct-execution):** a pure literal name-scan is
beaten by importing the forbidden symbol under another name. Two alias vectors
ARE tractable and should be closed in-scope: (1) LOCAL alias — parse X's own
import specifiers, map every `Sym as Alias` whose Sym is forbidden, ban the local
`Alias` too (table⇒bare-ident needle, fn⇒call-site needle); (2) CROSS-FILE
one-hop re-export — walk the relevant source roots for `export { Sym as Alias }`
of a forbidden Sym and ban those `Alias` bindings in X.

**Provenance-aware re-export (upgrade over pure name-based):** pure name-based
re-export matching over-bans an unrelated module's same-named export (false
positive). The fix is to resolve provenance ONE hop and decide by a curated
forbidden-origin map (per-symbol files + specifiers), integrity-checked at
runtime so curation rot fails LOUDLY.

**The hard, non-obvious part is the exemption rule — get it wrong and you ship a
laundering bypass.** "The resolved file declares a same-named symbol" is NOT
proof of independence: `import {Sym as t} from "@forbidden"; export const Sym = t`
declares Sym but merely re-exports the forbidden value. The durable principle:
**exempt a same-name re-export ONLY on POSITIVE proof the value is freshly
constructed; default fail-closed.** Do NOT decide by tracing the import graph
(namespace `import * as`, default, renamed multi-hop all defeat import-parsing
without recursion) — decide by HOW the symbol is bound in the resolved file:
- a `function`/`class`/arrow/function-expression binding = definitionally fresh
  → exempt;
- a `const/let/var` binding is fresh ONLY when its initializer is a
  positively-recognised construction (a curated builder call such as
  `pgTable(...)`, or a fresh function value). A bare/parenthesised identifier,
  dotted OR bracket member-access, type-asserted ref, an ARBITRARY call (`id(t)`),
  or `new X(t)` are all (potential) re-binds → FAIL CLOSED.
Symbols with no in-repo origin (e.g. `orderSend`) can never be proven unrelated →
always strict. **Why a positive allowlist, not a "not-an-alias" blocklist:** a
blocklist invites an endless escape ladder (`(t)`, `db["x"]`, `t as any`, `id(t)`,
`new W(t)`, `[t][0]`…); only "exempt nothing unless it matches a known-fresh
shape" converges.

Still OUT-of-scope (review, not regex; codify as explicit test policy so the
boundary isn't accidental): a wrapper function/arrow whose BODY calls a forbidden
primitive (indistinguishable by text scan from every legitimate helper, incl. the
REQUIRED executeInstant), pathological IIFE / computed-reflection / char-code
launders, and any bypass buried in a third-file helper that X merely calls.

**How to apply:** any "never import X" / "never use SYMBOL" CI guard for a safety
boundary. Keep a big regression suite of escape cases wired into the guards lane;
each architect escape becomes a permanent flag-case. Anchor closure on an
explicit scope boundary and get the reviewer to confirm it, or the review loop
never converges.

**Env note:** typecheck the `scripts` package with a heap cap
(`NODE_OPTIONS=--max-old-space-size=2560 pnpm --filter @workspace/scripts run
typecheck`); the full workspace `typecheck:ci` OOMs in this sandbox.
