---
name: Source import verification
description: Keep remote import inspection bounded and distinguish source integrity from served transformed code.
---

Filter GitHub tree/compare replies before returning them to the persistent
notebook. Retain only needed paths, blobs and scoped text; save larger evidence
to ignored files instead of keeping raw replies across turns.

**Why:** Retained import payloads exceeded the notebook's 32 MiB limit and reset
its state. A reset also cancels pending notebook jobs.

Bulk file callbacks also have a combined per-block serialized-byte budget.
Do not assume raw file lengths equal that budget or that bindings from a failed
block remain available.

**Why:** Several retained JSON receipts exceeded the 3 MB file-operation budget;
the block failed and a follow-up reference to its binding was unavailable.

**How to apply:** For large connector receipts, fetch and save inside a small
impure filesystem helper and return only compact integrity metadata. Otherwise
split bounded operations into independent blocks.

**How to apply:** Filter inside the impure network helper, especially when
compare replies include documentation logs. Keep job references and source
receipts small, and store durable evidence before starting browser jobs.

Verify served transformed modules using executable sequences, not comments.

**Why:** Vite can remove source comments; their absence caused a false-negative
runtime-source probe despite the intended executable code being served.

**How to apply:** Use blob/hash checks for source integrity and executable
anchors for served-source checks. Neither substitutes for rendered acceptance.
