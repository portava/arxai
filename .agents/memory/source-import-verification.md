---
name: Source import verification
description: Keep remote import inspection bounded and distinguish source integrity from served transformed code.
---

Filter GitHub tree/compare replies before returning them to the persistent
notebook. Retain only needed paths, blobs and scoped text; save larger evidence
to ignored files instead of keeping raw replies across turns.

**Why:** Retained import payloads exceeded the notebook's 32 MiB limit and reset
its state. A reset also cancels pending notebook jobs.

**How to apply:** Filter inside the impure network helper, especially when
compare replies include documentation logs. Keep job references and source
receipts small, and store durable evidence before starting browser jobs.

Verify served transformed modules using executable sequences, not comments.

**Why:** Vite can remove source comments; their absence caused a false-negative
runtime-source probe despite the intended executable code being served.

**How to apply:** Use blob/hash checks for source integrity and executable
anchors for served-source checks. Neither substitutes for rendered acceptance.
