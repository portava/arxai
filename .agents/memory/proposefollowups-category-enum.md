---
name: proposeFollowUpTasks requires a category enum
description: The follow-up-tasks proposal callback's required `category` field and its allowed values.
---

`proposeFollowUpTasks({ tasks: [...] })` (the callback invoked at task completion via
code_execution) requires each task object to carry a **`category`** field in addition to
`title` and `description`. Omitting it throws a pydantic "Field required" error.

Allowed `category` enum values (exact strings):
- `incomplete_scope`
- `next_steps`
- `tech_debt`
- `test_gaps`
- `new_artifact`

**Why:** the `follow-up-tasks` SKILL.md file is NOT present on disk in this environment
(skillSearch returns only project_tasks), but the `proposeFollowUpTasks` /
`markFollowUpTaskObsolete` callbacks ARE registered and work. So the schema can't be read
from a skill file — discovered by probing (an invalid category echoes the enum).

**How to apply:** when proposing follow-ups, always include `category` from the list above.
The callback is one-shot per assigned project task; to retract a stale proposal use
`markFollowUpTaskObsolete` instead of re-calling propose.
