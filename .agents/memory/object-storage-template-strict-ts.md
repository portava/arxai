---
name: Object-storage template needs a cast under strict TS
description: The copied objectStorage.ts helper fails typecheck in this repo until response.json() is cast.
---

The Replit object-storage template (`objectStorage.ts`, copied via the
object-storage skill) signs URLs with `const { signed_url } = await response.json()`.

This repo's strict tsconfig types `response.json()` (and `fetch`) as `unknown`,
so the bare destructure fails with TS2339 "Property 'signed_url' does not exist
on type 'unknown'".

**Fix:** cast the parsed body, e.g.
`(await response.json()) as { signed_url: string }`.

**Why:** the template ships assuming a looser tsconfig than `@workspace/*`
packages use. Any future copy of a Replit storage/template helper into this
monorepo should expect the same `unknown`-from-`json()` friction.
