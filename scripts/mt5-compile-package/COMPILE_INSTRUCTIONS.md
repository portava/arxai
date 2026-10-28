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
| `CHANGES_SINCE_REFERENCE.txt` | Which EA files changed since the reference commit, with the commits. |
| `compile_mac_wine.sh` | Runs the compile with an existing macOS MetaTrader 5 Wine installation and collects the evidence. |
| `pe_version.py` | Reads `metaeditor64.exe`'s version from its bytes, without running it. |
| `PACKAGE.sha256` | SHA-256 of every file in this package. |

`<Trade/Trade.mqh>` is part of the MQL5 standard library that ships with MetaTrader 5. It is not in the package.

## Three kinds of evidence: keep them separate

1. **Extracted-MQL C++ harness** (in the repository, `mt5-bridge/tests/`). This compiles extracted EA functions with g++ against a fake terminal. It is not MetaEditor.
2. **Native MetaEditor compile** (this package). The full sources compile in the real MQL5 compiler and produce `.ex5` files.
3. **Terminal run.** The compiled EA loads and runs in a terminal. This is **not** part of this step.

A compile under Wine on macOS is reported as **"MetaEditor under Wine on macOS"**. It is not Windows validation. A Windows compile, if one is done later, is recorded separately.

## Mac with an existing MetaTrader 5 app (Wine)

Expected locations (the script's defaults):

- MetaEditor: `~/Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/metaeditor64.exe`
- Wine runtime: `/Applications/MetaTrader 5.app/Contents/SharedSupport/wine/`

Steps:

1. Unzip the package anywhere, for example `~/Downloads/ARX_MT5_compile_@SHORT@/`.
2. Check the package: `cd ~/Downloads/ARX_MT5_compile_@SHORT@ && shasum -a 256 -c PACKAGE.sha256`. Every line must say `OK`.
3. Quit MetaEditor if it is open. Do not open the MetaTrader 5 app.
4. Run `bash compile_mac_wine.sh`.

The script:
- verifies `MANIFEST.sha256`;
- finds the bundled `wine64` (or `wine`) and MetaEditor;
- records macOS, CPU, the Wine version, the Windows version Wine reports, and MetaEditor's file version and SHA-256;
- records whether a `terminal64.exe` process is running before and after (it never starts one);
- finds the one MQL5 folder that contains `Include/Trade/Trade.mqh`;
- copies the five sources into a **new** folder `MQL5/Experts/ARX_compile_@SHORT@_<UTC time>/`, and checks them against the manifest again;
- runs, for each EA:

  ```sh
  wine "C:\Program Files\MetaTrader 5\metaeditor64.exe" /compile:"<that folder>\<EA>.mq5" /include:"<MQL5 folder>" /log:"<that folder>\<EA>.compile.log"
  ```

- keeps each raw UTF-16 log, plus a UTF-8 copy, and copies each newly produced `.ex5` (newer than the compile start), with its size and SHA-256;
- writes `summary.txt` and zips everything as `result-<UTC time>.zip` next to the script.

If several MQL5 folders contain the standard library, the script stops and lists them. Rerun with `ARX_MQL5_DIR="<the one MetaEditor uses>" bash compile_mac_wine.sh`. Other overrides: `ARX_WINEPREFIX`, `ARX_WINE_DIR`, `ARX_COMPILE_TIMEOUT_S` (default 300).

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

The `result-<UTC time>.zip` from the script. It contains `summary.txt`, `environment.txt` (MetaEditor version and SHA-256, Wine version, macOS version, CPU), both raw and UTF-8 compile logs, the new `.ex5` files, the before/after terminal process check, and the full `run.txt` transcript.

Until those logs and the new `.ex5` files come back, the native compile result for commit `@COMMIT@` is **pending**.
