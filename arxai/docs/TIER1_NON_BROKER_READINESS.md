# Non-broker release readiness

Updated 2026-10-25. This work covers release features that can be verified without
placing DEMO or LIVE orders. The [architecture map](ARCHITECTURE_MAP.md) remains
the breakdown of the five domains, their responsibilities and boundaries.

## Password recovery

Reset links use trusted configuration in this order: `APP_PUBLIC_ORIGIN`,
`APP_BASE_URL`, then the first published `REPLIT_DOMAINS` entry. Development may
use its preview domain or localhost. Production rejects HTTP, credentials,
paths, query strings, fragments, localhost and Replit development previews.
Request headers never determine the reset destination.

Reset tokens are absent from responses and server logs in every environment.
The response remains neutral for existing and nonexistent users. Provider
errors are reduced to safe codes; upstream messages cannot leak recipients,
reset links or authentication material. A successful email response must carry
a valid provider message ID. That proves provider acceptance, not inbox delivery.

The shared mailer uses the existing Resend connector. `EMAIL_FROM` overrides the
configured sender. Ordinary connection metadata is tried first; settings-only
connections retain their existing compatibility lookup. That endpoint may
return secret settings, so only the sender is extracted and cached; the payload
and other settings are never logged or returned. Sends continue through the proxy.

Run `pnpm --filter @workspace/api-server run check:email-readiness` to inspect
configuration without sending email or generating reset tokens. Its report never
contains addresses or credentials. `deliveryVerified` remains false. A real
delivery/reset check needs a separately authorized recipient and user-controlled
password entry.

## Health checks

- `/api/healthz` remains process liveness.
- `/api/health/ready` runs a fixed, read-only `select 1`. It returns 200 when the
  database answers and 503 otherwise, with only status and observation time.
- The readiness probe has a two-second response bound, a five-second cache and
  one in-flight query. A hung dependency cannot accumulate a query per request.
- Personal `/api/me/system-health` still requires authentication. Database
  readiness does not establish market-data, broker or trading readiness.

## Portable initial production launcher

The repository now includes `scripts/release/` instead of relying only on
untracked hosting wrappers. From the repository root:

```sh
pnpm release:build:api
pnpm release:build:web
pnpm release:check
```

`release:check` validates configuration shape without starting the application.
Required configuration includes a PostgreSQL URL, session secret, registration
pepper, HTTPS `APP_BASE_URL` and valid port. An optional `APP_PUBLIC_ORIGIN` must
match the application origin. Reports contain check names and booleans only.

After a separately approved production release, `pnpm release:start` runs the
built API. It forces production mode, disables development authentication and
LIVE execution, requires invitations, and removes legacy broker/bootstrap
credentials from the child process. It refuses missing builds. Dashboard output
still needs the host's static routing arrangement; this command does not provision
hosting, deploy, run migrations or configure external monitoring.

## Verification and limits

The change adds 19 API regressions covering email transport/configuration,
trusted origins, readiness timeouts/concurrency and the actual HTTP routes with
fake dependencies, plus seven production-launcher regressions. They are included
in the repository CI command. Development validation also runs both type checks,
both production builds, all 87 architecture guards and scorecard unit tests.

This does not satisfy production deployment, real mail delivery, fresh provider
data, production database/control receipts or the seven real DEMO lifecycle
scenarios. No readiness threshold is lowered and no operational 100% is claimed.
