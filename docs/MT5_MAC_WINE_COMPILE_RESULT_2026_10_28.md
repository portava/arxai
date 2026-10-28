# MT5 compiler result — 28 October 2026

**PASS: MetaEditor under Wine on macOS, compile only.**
The run started at 10:39 a.m. New York time (14:39 UTC).
This is not Windows-host validation or terminal/broker execution.

| EA | Compiler result | New EX5 | SHA-256 |
|---|---|---:|---|
| v1.31 | 0 errors, 0 warnings | 151,956 bytes | `0c80e360b57e6fe899ac4cd6d5c28b74ab80bb7556ad33b308f3ced44d7f0c90` |
| v1.54 | 0 errors, 0 warnings | 203,430 bytes | `fc6238683e5af1a6fed5279671dcadc81b19303320b7adefdc97909a5747f3fb` |

The exact package source is `6f9e3641c53e4d9cf316e6c8c380d5455b52d91d`.
All five EA/include hashes also match `cd44c73` and PR #102's `15b2dcb6`.
No source edits were needed. Compiler: MetaEditor **5.0.0.6230**, bundled
Wine **10.0**, macOS **26.6.2**, Apple M4 Pro; target **X64 Regular**.

Both MetaEditor processes returned exit code 1. Per the handoff, that code is
not the pass signal: both complete raw logs report zero errors, both new EX5
files were produced after compilation began, and neither run timed out.
The UTF-16 logs were decoded, read and compared with their readable copies.
Includes stayed within the selected MQL5 tree. ZIP contents and checksums were
verified. The compiler binary was unchanged. The runner's Windows-version
summary parser missed the string; the preserved raw file reports
`Microsoft Windows 10.0.19043` under Wine, not the host operating system.

[Download the raw result package](validation/mt5-mac-wine-20261028-143927Z/result-20261028T143927Z.zip)
contains both EX5 files, unedited logs, environment and prefix-change evidence.
ZIP SHA-256: `1cdd3fca4fe9499dbdfa919fd1b0ec43d6481e00317fe5777a520ddf8781d53e`.
[Machine-readable receipt](validation/mt5-mac-wine-20261028-143927Z/receipt.json)
and [source manifest](validation/mt5-mac-wine-20261028-143927Z/SOURCE_MANIFEST.sha256).

No terminal was running before or after the check, and the script never started
one. No EA was loaded or attached, no broker test or order was performed, and no trading,
worker, deployment, database or main-merge action occurred. Outside the new
compile folder, only two directory timestamps and `logs/metaeditor.log` changed;
no account/config file was flagged. The compile folder remains isolated under
`MQL5/Experts/ARX_compile_6f9e3641c5_20261028T143927Z`.

This supersedes the earlier terminal-running preflight blocker. Historical
failed/preflight records remain preserved. Only the Mac/Wine compilation gap
closes; terminal loading, Windows-host validation, broker behavior and the
broader release remain unproven.
