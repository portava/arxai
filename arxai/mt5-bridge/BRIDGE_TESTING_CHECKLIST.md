# ARX read-only DEMO connection checklist

Use `README_SETUP.md` and the supplied profile. Leave unobserved items unchecked.

- [ ] Exact target ARX workspace/origin and intended connection owner verified.
- [ ] MT5 terminal account verified as DEMO; no account credentials recorded here.
- [ ] Packaged `ReplitMT5BridgeEA_v131.mq5` compiled in MetaEditor; actual result recorded.
- [ ] Profile loaded before private URL/token entry; all trading arms remain off.
- [ ] Automated trading remains disabled; only the reviewed origin is allowlisted.
- [ ] Active per-user token belongs to this connection; no token in shared evidence.
- [ ] ARX reports this user's connection, EA version 1.31 and DEMO account type.
- [ ] Heartbeat receive time advances; age stays below 15 seconds while connected.
- [ ] Fresh account and complete position snapshots match the terminal, including an empty position list when applicable.
- [ ] Broker symbol names and minimum/step sizes are observed, including any suffix.
- [ ] Quote bid/ask observation times and candle coverage are checked separately; stale or absent data remains unready.
- [ ] Disconnect/reconnect is observed without placing orders; stale status is not displayed as fresh.
- [ ] Platform safety state, operator live arm and broker execution controls remain unchanged.
- [ ] No DEMO or LIVE orders, modifications or closes were created during setup.

Record compiler status, masked connection identity, EA version, receive times,
account type, safety flags and the reason for each outstanding item. Do not copy
account numbers, balances, tokens or raw account payloads into public evidence.

## Separate broker lifecycle validation

**Not yet broker-validated.** v1.31 is offline-tested and requires DEMO hedging.
Verify the account's margin mode, the actual compiled source and a fresh owned
connection, then obtain explicit order approval before the seven lifecycle
scenarios. A read-only connection does not pass those scenarios. Never inject
queue rows or bypass server gates to make a test pass. A FAILED/uncertain command
must be reconciled against broker truth, not retried under a new command ID.
See `docs/TIER1_OWNER_RUNBOOK.md`, section 5, in the ARX repository.
