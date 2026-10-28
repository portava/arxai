# Follow-up evidence index

Use `latest-summary.json` for the final functional checkpoint: application
`e011f25aca6dfd2913dda134ca59c86a5b124a95`, build `c4d30f0544b392e4`.
`final-scanner-e011.json.gz` is USER coverage; `final-pages-e011.json.gz` is
explicit synthetic ADMIN coverage. All writes are blocked. `e011-build-info.json`
contains the immutable build/asset hashes. The manifest hashes each retained file.

The generic `final-scanner*` and `final-build-info.json` files predate the mobile
correction and identify their earlier 8e87e55d source internally. `final-pages*`
failed/retry receipts remain; rerun4's 142 functional checks are explicitly
VISUALLY_INCOMPLETE, superseded by the e011 functional result. Interrupted retry2
is not acceptance. Read the summary rather than inferring success from filenames.

Timing is a separate 23698959 → cc7ad0e0 comparison. Both complete reports retain
FAIL/partial verdicts because style inputs have zero samples. All raw observations,
outliers and failures are kept in gzip JSON; p50/p95/p99/max are not substituted
for missing controls. The idle diagnostic's work counts are not latency.

Full original CLI logs remain in the local scanner-performance-20261028 directory.
No production, broker, architecture-completion or competitive-parity claim is made.
