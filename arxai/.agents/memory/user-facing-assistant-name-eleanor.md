---
name: User-facing assistant name (Eleanor vs internal Ruby)
description: Policy for the assistant's user-facing name and how to fix leaks of the internal "Ruby" codename.
---

The assistant is **Eleanor** to users, **Ruby** internally.

**Rule:** fix a user-visible "Ruby" leak by interpolating `DEFAULT_ASSISTANT_NAME`
(from `@workspace/domain/assistant-name`) — the established pattern. Only
user-VISIBLE rendered copy changes.

**Never rename internal identifiers** — `Ruby*` types/hooks/components, `ruby_*`
tables and field keys, comments, `data-testid`s, CSS classes. Renaming these
breaks contracts and tests.

**Do NOT edit the operator-funded disclosure text for naming** — it is hash-pinned
to a disclosure version; changing it invalidates existing user acceptances and
requires a deliberate version bump + re-acceptance. That is a behavior change,
not a naming fix. Same for startup log strings (not user-rendered).

**Why:** the system prompt already injects the name, but scattered hardcoded
"Ruby" literals in secondary surfaces (scalp text, LLM memory-context framing,
voice persona default) leak the codename and can make the assistant call itself
Ruby, contradicting the Eleanor identity. The frontend already resolves per-user
names via a name hook; backend emitters without a name param use the default —
threading a per-user name through them would be a larger, separate change.
