---
name: User-facing assistant name (Eleanor vs internal Eleanor)
description: Policy for the assistant's user-facing name and how to fix leaks of the internal "Eleanor" codename.
---

The assistant is **Eleanor** to users, **Eleanor** internally.

**Rule:** fix a user-visible "Eleanor" leak by interpolating `DEFAULT_ASSISTANT_NAME`
(from `@workspace/domain/assistant-name`) — the established pattern. Only
user-VISIBLE rendered copy changes.

**Never rename internal identifiers** — `Eleanor*` types/hooks/components, `eleanor_*`
tables and field keys, comments, `data-testid`s, CSS classes. Renaming these
breaks contracts and tests.

**Do NOT edit the operator-funded disclosure text for naming** — it is hash-pinned
to a disclosure version; changing it invalidates existing user acceptances and
requires a deliberate version bump + re-acceptance. That is a behavior change,
not a naming fix. Same for startup log strings (not user-rendered).

**Why:** the system prompt already injects the name, but scattered hardcoded
"Eleanor" literals in secondary surfaces (scalp text, LLM memory-context framing,
voice persona default) leak the codename and can make the assistant call itself
Eleanor, contradicting the Eleanor identity. The frontend already resolves per-user
names via a name hook; backend emitters without a name param use the default —
threading a per-user name through them would be a larger, separate change.
