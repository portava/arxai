#!/bin/bash
# Compile the ARX EAs in this package with an existing MetaEditor that runs under
# the MetaTrader 5 macOS app's bundled Wine runtime.
#
# Compile only. This script never starts terminal64.exe, never attaches an EA,
# never logs in, and never changes account or terminal settings. Its only write
# inside the Wine prefix is one new folder under MQL5/Experts holding copies of
# the package sources and the .ex5 files MetaEditor produces from them.
#
# A Mac/Wine result is not a Windows result. Report it as "MetaEditor under Wine
# on macOS" with the build and Wine version this script records.
#
# Overrides: ARX_WINEPREFIX, ARX_WINE_DIR, ARX_MQL5_DIR, ARX_COMPILE_TIMEOUT_S.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
PREFIX=${ARX_WINEPREFIX:-"$HOME/Library/Application Support/net.metaquotes.wine.metatrader5"}
WINE_DIR=${ARX_WINE_DIR:-"/Applications/MetaTrader 5.app/Contents/SharedSupport/wine"}
EDITOR_UNIX="$PREFIX/drive_c/Program Files/MetaTrader 5/metaeditor64.exe"
EDITOR_WIN='C:\Program Files\MetaTrader 5\metaeditor64.exe'
TIMEOUT_S=${ARX_COMPILE_TIMEOUT_S:-300}
EAS="ReplitMT5BridgeEA_v131 ARX_AI_Universal_Agent_v154"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$HERE/result-$STAMP"
mkdir -p "$OUT"
exec > >(tee "$OUT/run.txt") 2>&1

fail() { echo "STOPPED: $*"; echo "Nothing was compiled after this point. Send back $OUT as it is."; exit 1; }

echo "ARX MetaEditor compile (Mac/Wine), started $STAMP"
echo "Package: $(head -n 1 "$HERE/COMMIT.txt")"
echo

# 1. Sources must match the manifest byte for byte.
echo "== 1. Verify SHA-256 manifest"
( cd "$HERE/src" && shasum -a 256 -c ../MANIFEST.sha256 ) || fail "a source file does not match MANIFEST.sha256"
echo

# 2. Locate the bundled Wine and the existing MetaEditor.
echo "== 2. Locate Wine and MetaEditor"
WINE=""
for name in wine64 wine; do
  if [ -x "$WINE_DIR/bin/$name" ]; then WINE="$WINE_DIR/bin/$name"; break; fi
done
[ -n "$WINE" ] || fail "no wine64 or wine binary under $WINE_DIR/bin"
[ -f "$EDITOR_UNIX" ] || fail "metaeditor64.exe not found at $EDITOR_UNIX"
export WINEPREFIX="$PREFIX" WINEDEBUG=-all
echo "Wine binary: $WINE"
echo "Wine prefix: $PREFIX"
echo "MetaEditor:  $EDITOR_UNIX"
echo

# 3. Record the environment.
echo "== 3. Environment"
{
  echo "macOS: $(sw_vers -productVersion 2>/dev/null) ($(sw_vers -buildVersion 2>/dev/null))"
  echo "Machine: $(uname -m)"
  echo "Wine: $("$WINE" --version 2>&1)"
  echo "Windows version reported by Wine: $("$WINE" cmd /c ver 2>/dev/null | tr -d '\r' | grep -v '^$')"
  if command -v python3 >/dev/null 2>&1; then
    echo "MetaEditor file version:"; python3 "$HERE/pe_version.py" "$EDITOR_UNIX" 2>&1 | sed 's/^/  /'
  else
    echo "MetaEditor file version: python3 not available; read the build from MetaEditor Help > About"
  fi
  echo "metaeditor64.exe SHA-256: $(shasum -a 256 "$EDITOR_UNIX" | cut -d' ' -f1)"
} | tee "$OUT/environment.txt"
echo

# 4. The trading terminal must not be started by this step. Record whether one is already running.
echo "== 4. Terminal process check (before)"
pgrep -fl terminal64.exe > "$OUT/terminal-before.txt" 2>&1 || true
if [ -s "$OUT/terminal-before.txt" ]; then
  echo "A terminal64.exe process was already running before this step (not started by this script):"
  cat "$OUT/terminal-before.txt"
else
  echo "No terminal64.exe process running."
fi
echo

# 5. Find the MQL5 folder that holds the standard library (<Trade/Trade.mqh>).
echo "== 5. Locate the MQL5 standard library"
find "$PREFIX/drive_c" -path '*/MQL5/Include/Trade/Trade.mqh' 2>/dev/null > "$OUT/trade-mqh-candidates.txt"
cat "$OUT/trade-mqh-candidates.txt"
if [ -n "${ARX_MQL5_DIR:-}" ]; then
  MQL5_DIR="$ARX_MQL5_DIR"
else
  [ -s "$OUT/trade-mqh-candidates.txt" ] || fail "no MQL5/Include/Trade/Trade.mqh under $PREFIX/drive_c"
  [ "$(wc -l < "$OUT/trade-mqh-candidates.txt")" -eq 1 ] \
    || fail "several MQL5 folders found; rerun with ARX_MQL5_DIR set to the one MetaEditor uses (listed above)"
  MQL5_DIR=$(dirname "$(dirname "$(dirname "$(cat "$OUT/trade-mqh-candidates.txt")")")")
fi
[ -f "$MQL5_DIR/Include/Trade/Trade.mqh" ] || fail "$MQL5_DIR/Include/Trade/Trade.mqh does not exist"
echo "Using MQL5 folder: $MQL5_DIR"
echo

# 6. Copy the sources, side by side, into a new folder of their own.
SHORT=$(head -n 1 "$HERE/COMMIT.txt" | awk '{print substr($NF,1,10)}')
TARGET="$MQL5_DIR/Experts/ARX_compile_${SHORT}_$STAMP"
echo "== 6. Copy sources to $TARGET"
[ -e "$TARGET" ] && fail "$TARGET already exists"
mkdir -p "$TARGET" || fail "cannot create $TARGET"
cp "$HERE"/src/* "$TARGET"/ || fail "copy failed"
( cd "$TARGET" && shasum -a 256 -c "$HERE/MANIFEST.sha256" ) || fail "copied sources do not match the manifest"
touch "$OUT/.compile-start"
sleep 1  # filesystems with 1 s timestamps must still see the .ex5 as newer than this marker
echo

MQL5_WIN=$("$WINE" winepath -w "$MQL5_DIR" 2>/dev/null | tr -d '\r')
[ -n "$MQL5_WIN" ] || fail "winepath could not convert $MQL5_DIR"

# 7. Compile each EA. The exit code is recorded but is not the pass signal: the log and the new .ex5 are.
for ea in $EAS; do
  echo "== 7. Compile $ea.mq5"
  SRC_WIN=$("$WINE" winepath -w "$TARGET/$ea.mq5" 2>/dev/null | tr -d '\r')
  LOG_UNIX="$TARGET/$ea.compile.log"
  LOG_WIN=$("$WINE" winepath -w "$LOG_UNIX" 2>/dev/null | tr -d '\r')
  echo "Command: wine \"$EDITOR_WIN\" /compile:\"$SRC_WIN\" /include:\"$MQL5_WIN\" /log:\"$LOG_WIN\""
  "$WINE" "$EDITOR_WIN" "/compile:$SRC_WIN" "/include:$MQL5_WIN" "/log:$LOG_WIN" &
  pid=$!
  waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$TIMEOUT_S" ]; then
      echo "MetaEditor still running after ${TIMEOUT_S}s; stopping it (result: TIMEOUT)"
      kill "$pid" 2>/dev/null
      break
    fi
    sleep 1; waited=$((waited + 1))
  done
  wait "$pid" 2>/dev/null; code=$?
  echo "Exit code: $code (not used as the pass signal); ${waited}s"

  if [ -f "$LOG_UNIX" ]; then
    cp "$LOG_UNIX" "$OUT/$ea.compile.raw.log"
    # MetaEditor writes UTF-16 logs; keep the raw file and add a UTF-8 copy.
    iconv -f UTF-16 -t UTF-8 "$LOG_UNIX" > "$OUT/$ea.compile.log" 2>/dev/null || cp "$LOG_UNIX" "$OUT/$ea.compile.log"
    echo "Log result line: $(grep -a 'Result:' "$OUT/$ea.compile.log" | tail -n 1 | tr -d '\r')"
  else
    echo "No compile log was written."
  fi

  if [ -f "$TARGET/$ea.ex5" ] && [ "$TARGET/$ea.ex5" -nt "$OUT/.compile-start" ]; then
    cp "$TARGET/$ea.ex5" "$OUT/"
    echo "New EX5: $ea.ex5, $(wc -c < "$TARGET/$ea.ex5" | tr -d ' ') bytes, SHA-256 $(shasum -a 256 "$TARGET/$ea.ex5" | cut -d' ' -f1)"
  else
    echo "No new $ea.ex5 was produced."
  fi
  echo
done

# 8. Confirm this step did not start the terminal.
echo "== 8. Terminal process check (after)"
pgrep -fl terminal64.exe > "$OUT/terminal-after.txt" 2>&1 || true
if [ -s "$OUT/terminal-after.txt" ]; then cat "$OUT/terminal-after.txt"; else echo "No terminal64.exe process running."; fi
echo

# 9. Summary.
{
  echo "Package commit: $(head -n 1 "$HERE/COMMIT.txt")"
  echo "Compiled at (UTC): $STAMP"
  echo "Environment: MetaEditor under Wine on macOS (not Windows)"
  cat "$OUT/environment.txt"
  for ea in $EAS; do
    line=$(grep -a 'Result:' "$OUT/$ea.compile.log" 2>/dev/null | tail -n 1 | tr -d '\r')
    if [ -f "$OUT/$ea.ex5" ]; then ex5="new EX5 produced"; else ex5="NO new EX5"; fi
    echo "$ea: ${line:-no Result line in log}; $ex5"
  done
} > "$OUT/summary.txt"
cat "$OUT/summary.txt"
rm -f "$OUT/.compile-start"
( cd "$HERE" && zip -qr "result-$STAMP.zip" "result-$STAMP" ) && echo && echo "Send back: $HERE/result-$STAMP.zip"
