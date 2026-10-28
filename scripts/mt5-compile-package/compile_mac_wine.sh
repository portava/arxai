#!/bin/bash
# Compile the ARX EAs in this package with an existing MetaEditor that runs under
# the MetaTrader 5 macOS app's bundled Wine runtime.
#
# Compile only. This script never starts terminal64.exe, never attaches an EA,
# never logs in, and never changes account or terminal settings. It stops if
# terminal64.exe or metaeditor64.exe is already running.
#
# Intended writes inside the Wine prefix: the script itself creates one new
# folder under MQL5/Experts holding copies of the package sources, their logs
# and the .ex5 files MetaEditor produces from them. Wine and MetaEditor may also
# update their own logs, config and registry files in the prefix. Every file in
# the prefix that changed during the run is listed in prefix-writes.txt.
#
# A Mac/Wine result is not a Windows result. Report it as "MetaEditor under Wine
# on macOS" with the build and Wine version this script records.
#
# Written for macOS /bin/bash 3.2: no associative arrays, no timeout(1).
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

fail() { echo "STOPPED: $*"; echo "Nothing was compiled after this point."; exit 1; }

# Run a command in the background with a time limit (macOS has no timeout(1)).
# Sets RUN_CODE, RUN_WAITED (seconds) and RUN_TIMED_OUT (yes/no).
run_limited() {
  limit=$1; shift
  "$@" &
  pid=$!
  RUN_WAITED=0; RUN_TIMED_OUT=no
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$RUN_WAITED" -ge "$limit" ]; then RUN_TIMED_OUT=yes; kill "$pid" 2>/dev/null; break; fi
    sleep 1; RUN_WAITED=$((RUN_WAITED + 1))
  done
  wait "$pid" 2>/dev/null; RUN_CODE=$?
}

# Windows path for an existing Unix path. Prefers Wine's 8.3 short form so that
# the MetaEditor arguments hold no spaces: Wine re-quotes any argument with a
# space as a whole ("/compile:C:\Program Files\..."), which is not the documented
# /compile:"C:\..." form. Sets WIN_LONG and WIN_SHORT (empty if unavailable).
to_win() {
  WIN_LONG=$("$WINE" winepath -w "$1" 2>/dev/null | tr -d '\r')
  WIN_SHORT=""
  [ -n "$WIN_LONG" ] || return 1
  WIN_SHORT=$("$WINE" winepath -s "$WIN_LONG" 2>/dev/null | tr -d '\r')
  case "$WIN_SHORT" in *" "*) WIN_SHORT="" ;; esac
  return 0
}

# Convert a MetaEditor log to UTF-8 by its byte-order mark. Prints the encoding found.
# The raw file is kept separately; it is never copied over the UTF-8 file.
decode_log() {
  bom=$(head -c 2 "$1" | od -An -tx1 | tr -d ' \n')
  case "$bom" in
    fffe) enc=UTF-16LE; skip=3 ;;
    feff) enc=UTF-16BE; skip=3 ;;
    ??00) enc=UTF-16LE; skip=1 ;;  # no BOM, but the first character is ASCII in UTF-16LE
    *) enc=UTF-8; skip=1 ;;
  esac
  if [ "$enc" = UTF-8 ]; then
    cp "$1" "$2"
  elif ! tail -c +"$skip" "$1" | iconv -f "$enc" -t UTF-8 > "$2" 2>/dev/null; then
    echo "(iconv could not convert this log from $enc; read the .raw.log file)" > "$2"
    enc="$enc, conversion failed"
  fi
  echo "$enc"
}

main() {
echo "ARX MetaEditor compile (Mac/Wine), started $STAMP"
echo "Package: $(head -n 1 "$HERE/COMMIT.txt")"
echo
touch "$OUT/.run-start"  # before anything starts Wine, for the prefix-writes list
sleep 1                  # filesystems with 1 s timestamps must still see later writes as newer

# 1. Sources must match the manifest byte for byte, and src/ must hold nothing else.
echo "== 1. Verify SHA-256 manifest"
SOURCES=$(awk '{print $NF}' "$HERE/MANIFEST.sha256" | sed 's/^\*//')
[ "$(ls "$HERE/src" | sort)" = "$(printf '%s\n' "$SOURCES" | sort)" ] \
  || fail "src/ does not hold exactly the files listed in MANIFEST.sha256"
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
if [ -n "${ARX_WINE_DIR:-}" ]; then
  echo "WARNING: ARX_WINE_DIR is set. A Wine build other than the app's own may upgrade the app's prefix."
fi
echo

# 3. Nothing from MetaTrader may be running: the trading terminal stays out of this
#    step, and an open MetaEditor could take over the command-line compile.
echo "== 3. Process check (before)"
pgrep -fl terminal64.exe > "$OUT/terminal-before.txt" 2>&1 || true
pgrep -fl metaeditor64.exe > "$OUT/metaeditor-before.txt" 2>&1 || true
pgrep -fl wineserver > "$OUT/wineserver-before.txt" 2>&1 || true
if [ -s "$OUT/terminal-before.txt" ]; then
  cat "$OUT/terminal-before.txt"
  fail "terminal64.exe is running. This step must not run alongside the trading terminal. Do not close it without the owner's agreement; rerun once it is not running."
fi
if [ -s "$OUT/metaeditor-before.txt" ]; then
  cat "$OUT/metaeditor-before.txt"
  fail "metaeditor64.exe is already running. Quit MetaEditor and rerun."
fi
echo "No terminal64.exe or metaeditor64.exe process running."
if [ -s "$OUT/wineserver-before.txt" ]; then
  echo "A wineserver was already running (this run did not start the Wine session):"
  cat "$OUT/wineserver-before.txt"
else
  echo "No wineserver running before this step."
fi
echo

# 4. Find the MQL5 folder that holds the standard library (<Trade/Trade.mqh>).
echo "== 4. Locate the MQL5 standard library"
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

# 5. First Wine start, with a time limit: a prefix update or a dialog must not hang the run.
echo "== 5. Environment"
run_limited 120 "$WINE" cmd /c ver > "$OUT/wine-cmd-ver.txt" 2>&1
[ "$RUN_TIMED_OUT" = no ] \
  || fail "Wine did not answer 'cmd /c ver' within 120 s; it may be updating the prefix or showing a dialog. Close any Wine dialog without changing settings."
WIN_VER=$(tr -d '\r' < "$OUT/wine-cmd-ver.txt" | grep -i 'version' | tail -n 1)
to_win "$MQL5_DIR" || fail "winepath could not convert $MQL5_DIR"
MQL5_LONG=$WIN_LONG; MQL5_SHORT=$WIN_SHORT
PE_VER=""
PY=$(command -v python3 2>/dev/null)
# /usr/bin/python3 is only a stub that asks to install the developer tools when they are missing.
if [ -n "$PY" ] && { [ "$PY" != /usr/bin/python3 ] || xcode-select -p >/dev/null 2>&1; }; then
  PE_VER=$("$PY" "$HERE/pe_version.py" "$EDITOR_UNIX" 2>&1)
fi
EDITOR_SHA_BEFORE=$(shasum -a 256 "$EDITOR_UNIX" | cut -d' ' -f1)
{
  echo "macOS: $(sw_vers -productVersion 2>/dev/null) ($(sw_vers -buildVersion 2>/dev/null))"
  echo "Machine: $(uname -m); CPU: $(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
  echo "Wine binary type: $(file -b "$WINE" 2>&1)"
  echo "Wine bin folder: $(ls "$WINE_DIR/bin" 2>&1 | tr '\n' ' ')"
  echo "Wine: $("$WINE" --version 2>&1)"
  echo "Windows version reported by Wine: ${WIN_VER:-not reported (see wine-cmd-ver.txt)}"
  echo "Locale: LANG=${LANG:-unset} LC_ALL=${LC_ALL:-unset} LC_CTYPE=${LC_CTYPE:-unset}"
  case "$PE_VER" in
    *FileVersion=*) echo "MetaEditor file version:"; echo "$PE_VER" | sed 's/^/  /' ;;
    *) echo "MetaEditor file version: not read (${PE_VER:-python3 not usable}); read the build from MetaEditor Help > About" ;;
  esac
  echo "metaeditor64.exe SHA-256: $EDITOR_SHA_BEFORE"
  echo "MQL5 folder: $MQL5_DIR"
  echo "MQL5 folder (Windows): $MQL5_LONG${MQL5_SHORT:+ (short form $MQL5_SHORT)}"
  echo "Standard library files used by <Trade/Trade.mqh> (SHA-256):"
  ( cd "$MQL5_DIR/Include" && shasum -a 256 Trade/*.mqh Object.mqh StdLibErr.mqh 2>&1 ) | sed 's/^/  /'
} | tee "$OUT/environment.txt"
echo

# 6. Copy the sources, side by side, into a new folder of their own.
SHORT=$(head -n 1 "$HERE/COMMIT.txt" | awk '{print substr($NF,1,10)}')
TARGET="$MQL5_DIR/Experts/ARX_compile_${SHORT}_$STAMP"
echo "== 6. Copy sources to $TARGET"
[ -e "$TARGET" ] && fail "$TARGET already exists"
mkdir -p "$TARGET" || fail "cannot create $TARGET"
for f in $SOURCES; do cp "$HERE/src/$f" "$TARGET/" || fail "copy of $f failed"; done
( cd "$TARGET" && shasum -a 256 -c "$HERE/MANIFEST.sha256" ) || fail "copied sources do not match the manifest"
to_win "$TARGET" || fail "winepath could not convert $TARGET"
TARGET_LONG=$WIN_LONG; TARGET_SHORT=$WIN_SHORT
touch "$OUT/.compile-start"
sleep 1  # filesystems with 1 s timestamps must still see the .ex5 as newer than this marker
echo

# 7. Compile each EA. The exit code is recorded but is not the pass signal: the log and the new .ex5 are.
#    First with short (space-free) folder paths; if that gives neither a log nor a new .ex5,
#    once more with the long paths. File names are kept long so the .ex5 keeps its name.
FORMS="long"
[ -n "$MQL5_SHORT" ] && [ -n "$TARGET_SHORT" ] && FORMS="short long"
for ea in $EAS; do
  echo "== 7. Compile $ea.mq5"
  LOG_UNIX="$TARGET/$ea.compile.log"
  for form in $FORMS; do
    if [ "$form" = short ]; then dir_win=$TARGET_SHORT; inc_win=$MQL5_SHORT; else dir_win=$TARGET_LONG; inc_win=$MQL5_LONG; fi
    echo "Command ($form paths): wine \"$EDITOR_WIN\" /compile:\"$dir_win\\$ea.mq5\" /include:\"$inc_win\" /log:\"$dir_win\\$ea.compile.log\""
    # Wine's own output goes to a file: a process left behind must not hold the run.txt pipe open.
    run_limited "$TIMEOUT_S" "$WINE" "$EDITOR_WIN" "/compile:$dir_win\\$ea.mq5" "/include:$inc_win" "/log:$dir_win\\$ea.compile.log" \
      >> "$OUT/$ea.wine-output.txt" 2>&1
    if [ "$RUN_TIMED_OUT" = yes ]; then
      echo "MetaEditor still running after ${TIMEOUT_S}s; stopped it (result: TIMEOUT)"
      # No MetaEditor was running before step 3, so a MetaEditor compile left now belongs to this run.
      # The pattern needs the /compile: argument, so it cannot match a shell that merely names the file.
      pkill -f 'metaeditor64\.exe.*/compile:' 2>/dev/null
      sleep 2
    fi
    echo "Exit code: $RUN_CODE (not used as the pass signal); ${RUN_WAITED}s; timed out: $RUN_TIMED_OUT"
    if [ -f "$LOG_UNIX" ] || { [ -f "$TARGET/$ea.ex5" ] && [ "$TARGET/$ea.ex5" -nt "$OUT/.compile-start" ]; }; then break; fi
    echo "Neither a log nor a new $ea.ex5 appeared."
  done

  line=""; enc="none"
  if [ -f "$LOG_UNIX" ]; then
    cp "$LOG_UNIX" "$OUT/$ea.compile.raw.log"
    enc=$(decode_log "$LOG_UNIX" "$OUT/$ea.compile.log")
    line=$(grep -a 'Result:' "$OUT/$ea.compile.log" | tail -n 1 | tr -d '\r')
    echo "Log encoding: $enc"
    echo "Log result line: $line"
    grep -aiE '(warning|error) [0-9]+:' "$OUT/$ea.compile.log" | tr -d '\r' > "$OUT/$ea.diagnostics.txt"
    grep -ai 'includ' "$OUT/$ea.compile.log" | tr -d '\r' > "$OUT/$ea.include-lines.txt"
    # Lines naming a Windows path outside the MQL5 folder (the target folder is inside it).
    grep -aE '[A-Za-z]:\\' "$OUT/$ea.compile.log" | tr -d '\r' \
      | grep -aivF -e "$MQL5_LONG" -e "${MQL5_SHORT:-$MQL5_LONG}" > "$OUT/$ea.paths-outside-mql5.txt"
  else
    echo "No compile log was written."
  fi

  if [ -f "$TARGET/$ea.ex5" ] && [ "$TARGET/$ea.ex5" -nt "$OUT/.compile-start" ]; then
    cp "$TARGET/$ea.ex5" "$OUT/"
    ex5="new EX5, $(wc -c < "$TARGET/$ea.ex5" | tr -d ' ') bytes, SHA-256 $(shasum -a 256 "$TARGET/$ea.ex5" | cut -d' ' -f1)"
  else
    ex5="NO new EX5"
  fi
  echo "$ex5"

  case "$line" in *"Result: 0 error"*) zero_errors=yes ;; *) zero_errors=no ;; esac
  if [ "$zero_errors" = yes ] && [ -f "$OUT/$ea.ex5" ] && [ "$RUN_TIMED_OUT" = no ]; then pass=yes; else pass=no; fi
  {
    echo "$ea:"
    echo "  paths: $form; exit code $RUN_CODE; timed out: $RUN_TIMED_OUT; ${RUN_WAITED}s"
    echo "  log: ${line:-no Result line in log} (encoding: $enc)"
    echo "  $ex5"
    if [ -f "$OUT/$ea.compile.log" ]; then
      echo "  include lines in log: $(wc -l < "$OUT/$ea.include-lines.txt" | tr -d ' '); lines naming a path outside the MQL5 folder: $(wc -l < "$OUT/$ea.paths-outside-mql5.txt" | tr -d ' ')"
      echo "  warnings and errors:"
      if [ -s "$OUT/$ea.diagnostics.txt" ]; then sed 's/^/    /' "$OUT/$ea.diagnostics.txt"; else echo "    (none)"; fi
    fi
    echo "  meets pass rule (Result 0 errors, new EX5, no timeout): $pass (pending human review)"
  } > "$OUT/$ea.status.txt"
  echo
done

# 8. Confirm this step did not start the terminal, left no MetaEditor behind, and record what it changed.
echo "== 8. Process and prefix check (after)"
pgrep -fl terminal64.exe > "$OUT/terminal-after.txt" 2>&1 || true
pgrep -fl metaeditor64.exe > "$OUT/metaeditor-after.txt" 2>&1 || true
pgrep -fl wineserver > "$OUT/wineserver-after.txt" 2>&1 || true
if [ -s "$OUT/terminal-after.txt" ]; then cat "$OUT/terminal-after.txt"; else echo "No terminal64.exe process running."; fi
if [ -s "$OUT/metaeditor-after.txt" ]; then cat "$OUT/metaeditor-after.txt"; else echo "No metaeditor64.exe process running."; fi
EDITOR_SHA_AFTER=$(shasum -a 256 "$EDITOR_UNIX" | cut -d' ' -f1)
if [ "$EDITOR_SHA_AFTER" = "$EDITOR_SHA_BEFORE" ]; then editor_same=yes; else editor_same="NO (now $EDITOR_SHA_AFTER)"; fi
echo "metaeditor64.exe unchanged during the run: $editor_same"
find "$PREFIX" -newer "$OUT/.run-start" ! -path "$TARGET" ! -path "$TARGET/*" 2>/dev/null > "$OUT/prefix-writes.txt"
grep -iE '/Config/|\.ini$|accounts\.dat|terminal64\.exe|metaeditor64\.exe' "$OUT/prefix-writes.txt" > "$OUT/prefix-writes-flagged.txt"
echo "Prefix entries changed outside $TARGET: $(wc -l < "$OUT/prefix-writes.txt" | tr -d ' ') (prefix-writes.txt); flagged for review: $(wc -l < "$OUT/prefix-writes-flagged.txt" | tr -d ' ')"
sed 's/^/  /' "$OUT/prefix-writes-flagged.txt"
echo

# 9. Summary.
{
  echo "Package commit: $(head -n 1 "$HERE/COMMIT.txt")"
  echo "Compiled at (UTC): $STAMP"
  echo "Environment: MetaEditor under Wine on macOS (not Windows). EX5 hashes are not expected to match a Windows build."
  cat "$OUT/environment.txt"
  for ea in $EAS; do cat "$OUT/$ea.status.txt"; done
  echo "terminal64.exe running after the run: $([ -s "$OUT/terminal-after.txt" ] && echo yes || echo no)"
  echo "metaeditor64.exe unchanged during the run: $editor_same"
  echo "Prefix entries changed outside the compile folder: $(wc -l < "$OUT/prefix-writes.txt" | tr -d ' '); flagged for review: $(wc -l < "$OUT/prefix-writes-flagged.txt" | tr -d ' ')"
} > "$OUT/summary.txt"
cat "$OUT/summary.txt"
echo
echo "The compile folder $TARGET is left in the MQL5 tree. Delete it once the result zip has been sent back."
}

# run.txt must be complete before it is zipped, so the zip is made after tee has exited.
main 2>&1 | tee "$OUT/run.txt"
status=${PIPESTATUS[0]}
rm -f "$OUT/.run-start" "$OUT/.compile-start"
( cd "$HERE" && zip -qr "result-$STAMP.zip" "result-$STAMP" ) && echo && echo "Send back: $HERE/result-$STAMP.zip"
exit "$status"
