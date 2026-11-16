---
name: Auth query cancellation
description: Keep private responses from restoring query data after sign-out without blocking sign-out itself.
---

On explicit sign-out, publish the signed-out `/api/me` value while its observer is still active, then initiate `cancelQueries()` and clear the cache without awaiting the cancellation promise.

**Why:** TanStack Query marks requests cancelled synchronously, preventing their results from updating query state. Waiting for the network promise can block logout navigation when a response is slow or deliberately held.

**How to apply:** Preserve this ordering when changing logout or adding delayed-response tests. Verify the active auth gate redirects and that a response released after another account signs in cannot overwrite that account's private UI.
