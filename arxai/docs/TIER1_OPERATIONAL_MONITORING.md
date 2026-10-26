# Operational rate-cap monitoring

The order guard's operational cap counts approved commands in a rolling 24-hour
window. It remains distinct from the Risk Governor's daily trade limit. This
monitor observes an existing refusal; it cannot approve, submit or retry an
order, change a cap, or release a stop.

After the order guard persists a `REJECTED` audit row with the exact
`OPERATIONAL_RATE_CAP_REACHED:<cap>_APPROVED_COMMANDS_PER_ROLLING_24H` reason:

1. The API emits a warning-level structured `OPERATIONAL_RATE_CAP_REACHED`
   event with user ID, audit row ID, mode, cap, 24-hour window and observation
   time. No symbol, account number, request payload, token or raw error is logged.
2. The affected user's existing dashboard notification system receives an
   `operational_rate_cap` warning. It explains that an order request was rejected
   at the operational cap, without claiming a trade occurred or recommending a
   retry. The canonical alert writer deduplicates by user, alert type and UTC-hour
   bucket. Reading or dismissing an alert does not reset this hourly deduplication.

Other refusals, approved outcomes and missing/invalid audit or user identities
produce neither event nor alert. Notifications are asynchronous. One delivery
may be in flight per user, with a maximum of 256 users per API process. A hung
delivery retains its slot until the database operation settles; repeated refusals
cannot accumulate more writes for that user. Every persisted refusal still emits
its audit-correlated monitoring event. The database remains the cross-process
authority for alert deduplication.

After two seconds, a pending delivery emits
`OPERATIONAL_RATE_CAP_ALERT_UNAVAILABLE` with reason `DELIVERY_TIMEOUT`.
Other safe reasons are `DELIVERY_FAILED` and `CAPACITY_REACHED`. Timeout means
delivery is uncertain: a later database completion can still create the alert.
No raw database/provider error is included. Failures in either monitoring channel
never change the order guard's decision or delay its response.

## Operator verification before production release

- Keep production JSON logs enabled and collect warning-level events.
- Configure the existing monitoring service to match the exact structured
  `event` field. Group repeated cap events by user and mode; correlate incidents
  with `auditLogId`. Treat alert-unavailable events as notification-health issues.
- Confirm the affected user's dashboard can display the warning and another
  user's dashboard cannot. The existing alert API enforces owner scope.
- Verify external monitoring receipt through the owner's normal test facility;
  do not place a broker order or relax a cap merely to manufacture an alert.

Run `pnpm --filter @workspace/api-server run test:operational-rate-cap-monitoring`
for offline behavioral checks of the actual guard/monitor wiring, identity and
reason filtering, notification failures, timeout/capacity and concurrency. These
tests use fake dependencies and do not insert real alerts or audit rows.

This adds in-app notifications and structured logs only. It sends no email, SMS
or push messages and provisions no external alert destination. An external
monitor's actual receipt and production operation still need owner evidence.
The operational deployment gate remains incomplete until that evidence exists.
