# MT5 native compile handoff — 28 October 2026

**Update, 28 October 2026, 10:39 a.m. New York:** both EAs compiled with MetaEditor 5.0.0.6230 under Wine on macOS: zero errors and warnings, fresh EX5 files. [Verified result and raw evidence](MT5_MAC_WINE_COMPILE_RESULT_2026_10_28.md). The cloud-container limitation below is historical. Windows-host and terminal/broker validation remain open; the instructions are retained for reproducing those separate checks.

Compiling needs **no broker connection, no account login, and no trading permission**. MetaEditor compiles source offline. Do not log in to a live account for this step.

## Three kinds of evidence, kept separate

| Evidence | What it proves | Status |
| --- | --- | --- |
| **Extracted-MQL C++ harness** (`mt5-bridge/tests/run_demo_core.py`, `run_management_target.py`, `run_management_target.py --result-evidence`) | The handler functions extracted from the EA source behave correctly when compiled as C++ (g++) against a fake offline terminal. | Passes (56 + 105 + 674 checks). Not a MetaEditor compile. |
| **Native MetaEditor compile** (this handoff) | The full `.mq5` source, with its `.mqh` companions and the MQL5 standard library, compiles in the real MQL5 compiler and produces an `.ex5`. | **Pass under Mac/Wine**, build 6230, exact `6f9e364` source; Windows host not tested. |
| **Terminal run** (Strategy Tester or a chart in a terminal) | The compiled EA loads, starts, and behaves as expected in a terminal. A connectivity check needs a DEMO account; `WebRequest` does not run in the Strategy Tester. | **Not run.** Out of scope here, and no live or demo order may be sent without separate owner approval. |

A successful compile closes only the second row. It does not prove the terminal run or any broker behaviour.

## Why it was not run here

Checked on 2026-10-28 from the cloud container:

- The container is Linux (no Windows). No Wine, MetaEditor, `metaeditor64.exe` or `terminal64.exe` is installed (`find / -iname 'metaeditor*'` finds nothing).
- The MetaTrader 5 installer and MetaQuotes hosts are refused by the environment's network policy. `download.mql5.com`, `www.metatrader5.com` and `c.mql5.com` all fail with `CONNECT tunnel failed, response 403` at the egress proxy. `dl.winehq.org` is also refused. The Ubuntu archive is reachable, so Wine packages could be installed, but without the MetaEditor binary that does not help.
- MetaEditor is not redistributed through any package registry the container can reach (npm, PyPI, crates, Go proxy).

Allowing `download.mql5.com` in the environment's network settings would make a Wine-based attempt possible. Even then, MetaEditor under Wine is community-supported rather than official, so a compile on Windows is the authoritative result.

## Compile package

`scripts/mt5-compile-package/build-package.sh <commit> <output-dir>` builds a downloadable zip from an exact commit. It holds both EAs and every companion include, `MANIFEST.sha256`, the full commit hash, the EA changes since `cd44c73` (with the non-EA changes listed separately), `COMPILE_INSTRUCTIONS.md`, and `compile_mac_wine.sh`, all byte-exact from `git show` of that commit. That script compiles with an existing macOS MetaTrader 5 Wine installation. It stops if the terminal or MetaEditor is already running and never starts the terminal. It zips the logs, the new `.ex5` files, the MetaEditor and Wine versions, the standard-library hashes, and a list of every file in the Wine prefix that changed during the run. A Mac/Wine compile is recorded as such, never as Windows validation. The result stays pending until those logs and `.ex5` files are returned.

## Exact source to compile

Commit: PR #99 head `cd44c73` (`codex/platform-evidence-integration`). PR #100 (`claude/self-trading-improvements`) changes no file under `mt5-bridge/`: `git diff --stat cd44c73 <PR100 head> -- mt5-bridge` is empty. Check that is still true for the commit you compile.

These are the EAs changed relative to `main` (`76cdbdc`), so each must be compiled:

| Source | Includes | SHA-256 at `cd44c73` |
| --- | --- | --- |
| `mt5-bridge/ReplitMT5BridgeEA_v131.mq5` (v1.31, 1813 lines) | `<Trade/Trade.mqh>`, `"ArxManagementTarget.mqh"`, `"ArxTradeResult.mqh"`, `"ArxDemoExecution.mqh"` (at line 1270) | `e0d8b6c6aa722ba1542e4e8a3ff9522b78073b5e1c77e027dcf831c4780fcc40` |
| `mt5-bridge/ARX_AI_Universal_Agent_v154.mq5` (v1.54, 1969 lines) | `<Trade\Trade.mqh>`, `"ArxManagementTarget.mqh"`, `"ArxTradeResult.mqh"` | `f3b9d147c09927e27f0558f5b84cfc4a2e4fe7179ca779db920c8c0ed046d057` |
| `mt5-bridge/ArxManagementTarget.mqh` (new on PR #99) | — | `664024eda73cb0ee38d7b6a3b084fa49359ee9723e39713a63f32e93fbe8d06b` |
| `mt5-bridge/ArxTradeResult.mqh` (new on PR #99) | — | `1ab6036e4c4a35fa77debd60dee20f37c4f03d9c5dc0b6104677bc1d306c34b0` |
| `mt5-bridge/ArxDemoExecution.mqh` (unchanged from `main`, included by v1.31) | — | `e81aa17fd95b242c9d0785357bbb8bc827df9a773d1a048d95a55d819156900d` |

PR #99 commits that touch these files: `b3b2720` (exact terminal targets for automatic management), `d0caf28` (terminal-result evidence, marked WIP in its message), `4a16a29` (exact entry volume, v1.54 market-entry aliases), `05f9833` (one pickup per entry, unproven claims held, expiry in GMT).

Verify the hashes before compiling (PowerShell: `Get-FileHash -Algorithm SHA256 <file>`; Linux/macOS: `sha256sum`). A mismatch means you are compiling a different source; record the hashes you actually compiled.

## Steps

1. Install MetaTrader 5 from the official MetaQuotes installer. Any broker's branded build works. On first start, cancel the account dialog: no login is needed to compile.
2. In MetaEditor (or the terminal), open **File → Open Data Folder**. Create `MQL5\Experts\ARX\`.
3. Copy all five files above into that one folder, side by side. Quoted includes (`"Arx….mqh"`) resolve relative to the `.mq5` file; `<Trade\Trade.mqh>` comes from the standard library in `MQL5\Include\Trade\`, which the installer provides.
4. Compile each EA. Either open it in MetaEditor and press **F7 (Compile)**, or use the command line (paths in quotes, no space after the colon):

   ```bat
   set MT5="C:\Program Files\MetaTrader 5"
   set DATA=%APPDATA%\MetaQuotes\Terminal\<terminal-id>\MQL5

   %MT5%\metaeditor64.exe /compile:"%DATA%\Experts\ARX\ReplitMT5BridgeEA_v131.mq5" /include:"%DATA%" /log:"%DATA%\Experts\ARX\v131-compile.log"
   %MT5%\metaeditor64.exe /compile:"%DATA%\Experts\ARX\ARX_AI_Universal_Agent_v154.mq5" /include:"%DATA%" /log:"%DATA%\Experts\ARX\v154-compile.log"
   ```

   `<terminal-id>` is the long hexadecimal folder name that **Open Data Folder** shows. The exact meaning of `/include` is not confirmed (some sources use `/inc`); check the include paths the log reports.
5. Read each log. MetaEditor writes the log in UTF-16; open it in an editor rather than `type`. The last line reads `Result: N errors, M warnings`. **Do not rely on the process exit code**, which is not a dependable success signal for MetaEditor; use the log and the presence of the `.ex5`.

## Expected outputs and pass rule

- `ReplitMT5BridgeEA_v131.ex5` and `ARX_AI_Universal_Agent_v154.ex5` appear next to their sources.
- Each log ends with `Result: 0 errors`.
- Warnings do not fail the compile, but record every one verbatim. Pay particular attention to: implicit numeric conversions (`possible loss of data due to type conversion`) in volume, price and ticket code; `deprecated behavior`; and anything in `ArxManagementTarget.mqh` or `ArxTradeResult.mqh`, which have never been natively compiled.
- Any error fails the step. Record the exact diagnostic (file, line, column, message). Do not edit the source to make it compile without a reviewed change on the branch.

## What to send back

1. The MetaTrader 5 / MetaEditor build number (**Help → About**).
2. The SHA-256 of each source file actually compiled.
3. Both compile logs, unedited.
4. Whether each `.ex5` was produced, with its size.
5. Windows or Wine (and the Wine version if Wine).

Record the result in `docs/SELF_TRADING_RELEASE_VALIDATION_*.md` under "MT5 EA: native MetaEditor compile", and in `mt5-bridge/BRIDGE_TESTING_CHECKLIST.md` item 1. Keep the terminal-run row open until a terminal run happens.

## Checklist

- [ ] MT5 installed from the official installer; no account logged in.
- [ ] Five files copied side by side into `MQL5\Experts\ARX\`; SHA-256 recorded.
- [x] v1.31 compiled under Mac/Wine; raw log and new `.ex5` saved; 0 errors, 0 warnings.
- [x] v1.54 compiled under Mac/Wine; raw log and new `.ex5` saved; 0 errors, 0 warnings.
- [x] MetaEditor build 6230 recorded from the compiler binary version.
- [x] Results written into the validation report. Terminal run still marked open.
