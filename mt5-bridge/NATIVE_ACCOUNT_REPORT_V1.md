# Native account report v1 — development source

The v154 EA now uses the existing Bridge v2 ingest endpoint for `ACCOUNT_SNAPSHOT` / `ACCOUNT_NATIVE_V1`. This is read-only account telemetry. It changes no order action, trading permission, broker setting or execution gate.

The report includes direct native balance, equity, profit, credit, margin and free margin as fixed decimal strings using `ACCOUNT_CURRENCY_DIGITS`. It preserves zero and negative profit/free margin, rejects invalid reads and unsupported precision, and never substitutes equity minus balance for `ACCOUNT_PROFIT`. Currency remains the exact nonblank broker text (1–8 UTF-16 units, no ASCII control characters). Margin level is not part of this version.

Account binding is lowercase SHA-256 over UTF-8 bytes, without a trailing NUL:

```
ARX_ACCOUNT_V1\n<positive decimal ACCOUNT_LOGIN>\n<exact ACCOUNT_SERVER>
```

Neither the raw login/server nor credentials enter the native report. The producer instance is an opaque hexadecimal hash. Account identity, currency and precision are checked again after reading all six values. This does not make the individual terminal reads atomic.

Capture uses `TimeGMT()` with `TERMINAL_UTC_UNVERIFIED`, never a broker-clock fallback. A disconnected terminal, invalid UTC time, changed identity/units, invalid native value or capture longer than five seconds withholds the report. Source continuity and clock accuracy remain unverified by this EA change.

The existing one-second timer calls the native pump after existing command/market work. Captures use monotonic elapsed time. Changed values, any account transaction (including external/manual activity), or a 15-second unchanged-value keepalive produce a report. An acknowledged unchanged fingerprint avoids a database receipt every second. This is source-level coalescing, not a measured delivery guarantee.

There is one pending immutable envelope. Retries reuse its exact sequence, idempotency key, timestamp and body. A native request has a 1000 ms timeout and no immediate retry loop. After three attempts or five seconds pending, the next due attempt replaces the old report with a new capture and emits a generic diagnostic; it does not claim the old report arrived. A new transaction generation cannot be cleared by acknowledgement of an older capture. Pending data cannot cross an account-identity change.

The response must be valid bounded JSON with exactly one matching result: message type, stream key, sequence and idempotency key all match. Only `ACCEPTED`, or `DUPLICATE` with `exactReplay:true`, retires the report. A generic HTTP 200, malformed response, sequence duplicate or conflicting idempotency key does not. The backend must implement this correlated receipt contract before deployment.

Native account sequence values are limited to 0–2147483647 to fit the existing receipt gap counter. Exhaustion withholds new native reports; it does not reset or wrap the shared sequence authority.

A dedicated sequence-registry slot is reserved for the native account stream. Existing market symbol/timeframe caps and bar/tick registry capacities remain unchanged.

## Offline checks and limits

`python3 mt5-bridge/tests/run_native_account_report.py` compiles extracted production functions against an offline terminal double. It checks precision 0/2/3/16, UTF-8 SHA-256 against Python hashlib, exact native property mapping, invalid/changed captures, Unicode currency, external transaction dirty marking, immutable retries, strict acknowledgement parsing, coalescing and maximum market-stream capacity. `--emit-file` writes synthetic fixture payloads for backend/consumer contract tests.

On macOS the harness uses CommonCrypto; other platforms require the compiler's OpenSSL headers/library. There is no silent skip. Terminal conversion APIs are test doubles, so actual MQL formatting, compilation, callback delivery and transport behavior still require separate native MetaEditor and authorized terminal acceptance. Existing blocking EA operations can delay the new pump. This is not proof of atomic account data, current verified funds, real-time broker delivery or complete architecture.

## Official references checked

- [Account properties](https://www.mql5.com/en/docs/constants/environment_state/accountinformation) and [MetaTrader build 1880](https://www.metatrader5.com/en/releasenotes/terminal/1880): native account fields and integer currency precision.
- [DoubleToString](https://www.mql5.com/en/docs/convert/doubletostring): fixed decimal formatting for precision 0–16.
- [GetLastError](https://www.mql5.com/en/docs/check/getlasterror): errors are not automatically reset; each native read resets and checks explicitly.
- [StringToCharArray](https://www.mql5.com/en/docs/convert/stringtochararray) and [CryptEncode](https://www.mql5.com/en/docs/common/cryptencode): explicit UTF-8 conversion, terminator removal and SHA-256 byte-array hashing.
- [OnTradeTransaction](https://www.mql5.com/en/docs/event_handlers/ontradetransaction): account transactions include manual requests and server-side operations. Callback only marks dirty; it performs no network request.
