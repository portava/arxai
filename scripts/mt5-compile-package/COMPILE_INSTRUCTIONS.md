# ARX EA compile package — commit @COMMIT@

This package compiles the two ARX MetaTrader 5 EAs with MetaEditor. **It compiles only.** Do not start the MetaTrader 5 trading terminal, attach an EA to a chart, log in to or change any account, change terminal settings, or send any order for this step. Compiling needs no broker connection.

## What is in the package

| File | Purpose |
| --- | --- |
| `src/ReplitMT5BridgeEA_v131.mq5` | EA v1.31. Includes `ArxManagementTarget.mqh`, `ArxTradeResult.mqh`, `ArxDemoExecution.mqh` and `<Trade/Trade.mqh>`. |
| `src/ARX_AI_Universal_Agent_v154.mq5` | EA v1.54. Includes `ArxManagementTarget.mqh`, `ArxTradeResult.mqh` and `<Trade\Trade.mqh>`. |
| `src/ArxDemoExecution.mqh`, `src/ArxManagementTarget.mqh`, `src/ArxTradeResult.mqh` | Companion includes, resolved relative to the `.mq5` file. |
| `MANIFEST.sha256` | SHA-256 of each source file, byte-exact from commit `@COMMIT@`. |
| `COMMIT.txt` | Full commit hash, subject, date, and the standard-library includes the sources expect from MetaEditor's own `MQL5/Include`. |
| `CHANGES_SINCE_REFERENCE.txt` | Which EA files changed since the reference commit, with the commits, and a separate list of the non-EA changes in the same range. |
| `compile_mac_wine.sh` | Taken from commit `@COMMIT@`, like the sources. Runs the compile with an existing macOS MetaTrader 5 Wine installation and collects the evidence. |
| `pe_version.py` | Reads `metaeditor64.exe`'s version from its bytes, without running it. |
| `PACKAGE.sha256` | SHA-256 of every file in this package. |

`<Trade/Trade.mqh>` is part of the MQL5 standard library that ships with MetaTrader 5. It is not in the package.

## Three kinds of evidence: keep them separate

1. **Extracted-MQL C++ harness** (in the repository, `mt5-bridge/tests/`). This compiles extracted EA functions with g++ against a fake terminal. It is not MetaEditor.
2. **Native MetaEditor compile** (this package). The full sources compile in the real MQL5 compiler and produce `.ex5` files.
3. **Terminal run.** The compiled EA loads and runs in a terminal. This is **not** part of this step.

A compile under Wine on macOS is reported as **"MetaEditor under Wine on macOS"**. It is not Windows validation. A Windows compile, if one is done later, is recorded separately. EX5 hashes from Mac/Wine are not expected to match a Windows build: the sources are UTF-8 without a BOM and contain non-ASCII text, and how MetaEditor decodes them can depend on the Wine locale, which the script records.

## Mac with an existing MetaTrader 5 app (Wine)

Expected locations (the script's defaults):

- MetaEditor: `~/Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/metaeditor64.exe`
- Wine runtime: `/Applications/MetaTrader 5.app/Contents/SharedSupport/wine/`

Steps:

0. Before unzipping, compare `shasum -a 256 ARX_MT5_compile_@SHORT@.zip` with the zip SHA-256 sent in chat for commit `@COMMIT@`. After unzipping, compare `MANIFEST.sha256` with the manifest sent in chat. `PACKAGE.sha256` is inside the zip, so on its own it only shows the files are consistent with each other.
1. Unzip the package anywhere, for example `~/Downloads/ARX_MT5_compile_@SHORT@/`.
2. Check the package: `cd ~/Downloads/ARX_MT5_compile_@SHORT@ && shasum -a 256 -c PACKAGE.sha256`. Every line must say `OK`.
3. Quit MetaEditor if it is open. Do not open the MetaTrader 5 app. The script stops if `metaeditor64.exe` or `terminal64.exe` is running. If the trading terminal is running, do not close it without the owner's agreement.
4. Run `bash compile_mac_wine.sh`.

The script:
- checks that `src/` holds exactly the files in `MANIFEST.sha256` and that they match it;
- finds the bundled `wine64` (or `wine`) and MetaEditor;
- stops if `terminal64.exe` or `metaeditor64.exe` is running, and records whether a `wineserver` was already running (it never starts the terminal);
- finds the one MQL5 folder that contains `Include/Trade/Trade.mqh`;
- starts Wine once with `cmd /c ver` under a 120 s limit, so that a prefix update or a dialog stops the run instead of hanging it;
- records macOS, CPU, the Wine binary's architecture (an x86_64 Wine on an arm64 Mac runs under Rosetta 2), the Wine version, the Windows version Wine reports, the locale, MetaEditor's file version and SHA-256, the MQL5 folder and the SHA-256 of the standard-library files `<Trade/Trade.mqh>` pulls in;
- copies the five sources named in the manifest into a **new** folder `MQL5/Experts/ARX_compile_@SHORT@_<UTC time>/`, and checks them against the manifest again;
- runs, for each EA:

  ```sh
  wine "C:\Program Files\MetaTrader 5\metaeditor64.exe" /compile:"<that folder>\<EA>.mq5" /include:"<MQL5 folder>" /log:"<that folder>\<EA>.compile.log"
  ```

  The folders are given in Wine's 8.3 short form (for example `C:\PROGRA~1\...`), so no argument holds a space: Wine re-quotes an argument with a space as a whole, which is not the documented `/compile:"..."` form. If that gives neither a log nor a new `.ex5`, the script tries once more with the long paths. Each attempt has a time limit (`ARX_COMPILE_TIMEOUT_S`, default 300 s); on a timeout it stops that MetaEditor process;
- keeps each raw log, plus a UTF-8 copy decoded by its byte-order mark, and copies each newly produced `.ex5` (newer than the compile start), with its size and SHA-256;
- lists every warning and error line, the include lines in the log, and any log line naming a path outside the MQL5 folder;
- checks afterwards that no `terminal64.exe` or `metaeditor64.exe` is left running and that `metaeditor64.exe` did not change, and lists every file in the Wine prefix that changed during the run (`prefix-writes.txt`), flagging anything under `Config/`, any `.ini`, `accounts.dat`, `terminal64.exe` or `metaeditor64.exe`;
- writes `summary.txt` and zips everything as `result-<UTC time>.zip` next to the script, also when it stops early.

The script itself writes only the new folder under `MQL5/Experts`. Wine and MetaEditor may also update their own logs, config and registry files in the prefix; `prefix-writes.txt` shows what actually changed. Nothing in this step touches account or trading settings. The new folder is left in place; delete it once the result zip has been sent back.

The meaning of `/include` is not confirmed (some sources use `/inc`, and it may mean the MQL5 folder or its parent). Until a returned log shows which standard-library paths MetaEditor resolved, treat the standard library actually used as unconfirmed; the include lines and the outside-path list in `summary.txt` are there to check it.

If several MQL5 folders contain the standard library, the script stops and lists them. Rerun with `ARX_MQL5_DIR="<the one MetaEditor uses>" bash compile_mac_wine.sh`. Other overrides: `ARX_WINEPREFIX`, `ARX_WINE_DIR` (a Wine build other than the app's own may upgrade the app's prefix; the script warns), `ARX_COMPILE_TIMEOUT_S` (default 300).

If you would rather compile by hand in the MetaEditor window: copy the five `src/` files side by side into a new folder under `MQL5/Experts/`, open each `.mq5`, press **Compile (F7)**, and save the **Errors** tab text. Record the build from MetaEditor **Help > About**.

## Windows

Same files and the same rule. Copy the five `src/` files into a new folder under `<Data Folder>\MQL5\Experts\` (**File > Open Data Folder** in MetaEditor), then:

```bat
"C:\Program Files\MetaTrader 5\metaeditor64.exe" /compile:"<folder>\ReplitMT5BridgeEA_v131.mq5" /include:"<Data Folder>\MQL5" /log:"<folder>\ReplitMT5BridgeEA_v131.compile.log"
"C:\Program Files\MetaTrader 5\metaeditor64.exe" /compile:"<folder>\ARX_AI_Universal_Agent_v154.mq5" /include:"<Data Folder>\MQL5" /log:"<folder>\ARX_AI_Universal_Agent_v154.compile.log"
```

## Pass rule

- Each log ends with `Result: 0 errors, N warnings`, **and** a new `.ex5` exists for that EA.
- MetaEditor's exit code is not a dependable success signal. Use the log and the new `.ex5`.
- Warnings do not fail the compile, but every warning is recorded verbatim. Look in particular for type-conversion warnings in volume, price and ticket code, and for anything in `ArxManagementTarget.mqh` or `ArxTradeResult.mqh`, which have never been compiled natively.
- Any error fails. Record the file, line, column and message. Do not edit the sources to make them compile; a fix goes through a reviewed commit and a new package.

## Send back

The `result-<UTC time>.zip` from the script. It contains `summary.txt` (per EA: path form, exit code, timeout, Result line, new `.ex5`, warnings and errors, and whether it meets the pass rule, pending human review), `environment.txt` (MetaEditor version and SHA-256, Wine version and binary type, macOS version, CPU, locale, MQL5 folder and standard-library hashes), both raw and UTF-8 compile logs, the new `.ex5` files, the before/after process checks, `prefix-writes.txt`, and the full `run.txt` transcript.

Until those logs and the new `.ex5` files come back, the native compile result for commit `@COMMIT@` is **pending**.
