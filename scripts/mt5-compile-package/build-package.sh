#!/bin/bash
# Build the downloadable MetaEditor compile package for the two ARX EAs from an
# exact commit: byte-exact sources from `git show`, a SHA-256 manifest, the commit
# record, the EA changes since a reference commit, and the compile instructions.
#
# Usage: scripts/mt5-compile-package/build-package.sh <commit> <output-dir> [reference-commit]
set -euo pipefail

COMMIT_ARG=${1:?usage: build-package.sh <commit> <output-dir> [reference-commit]}
OUT_ROOT=${2:?usage: build-package.sh <commit> <output-dir> [reference-commit]}
REF_ARG=${3:-cd44c73}

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
COMMIT=$(git -C "$REPO" rev-parse --verify "$COMMIT_ARG^{commit}")
REF=$(git -C "$REPO" rev-parse --verify "$REF_ARG^{commit}")
SHORT=${COMMIT:0:10}

# Both EAs and every companion include they pull in with a quoted #include.
FILES="ReplitMT5BridgeEA_v131.mq5 ARX_AI_Universal_Agent_v154.mq5 ArxDemoExecution.mqh ArxManagementTarget.mqh ArxTradeResult.mqh"

NAME="ARX_MT5_compile_$SHORT"
PKG="$OUT_ROOT/$NAME"
rm -rf "$PKG" "$OUT_ROOT/$NAME.zip"
mkdir -p "$PKG/src"

for f in $FILES; do
  git -C "$REPO" show "$COMMIT:mt5-bridge/$f" > "$PKG/src/$f"
done

# Every quoted include in the EAs must be in the package; angle-bracket includes come from the MQL5 standard library.
for ea in ReplitMT5BridgeEA_v131.mq5 ARX_AI_Universal_Agent_v154.mq5 ArxDemoExecution.mqh ArxManagementTarget.mqh ArxTradeResult.mqh; do
  { grep -E '^[[:space:]]*#include[[:space:]]+"' "$PKG/src/$ea" || true; } | sed -E 's/.*"([^"]+)".*/\1/' | while read -r inc; do
    [ -f "$PKG/src/$inc" ] || { echo "missing quoted include $inc (from $ea)" >&2; exit 1; }
  done
done

( cd "$PKG/src" && sha256sum $FILES ) > "$PKG/MANIFEST.sha256"

{
  echo "commit $COMMIT"
  echo "subject $(git -C "$REPO" log -1 --format=%s "$COMMIT")"
  echo "committed $(git -C "$REPO" log -1 --format=%cI "$COMMIT")"
  echo "reference $REF ($REF_ARG)"
  echo "angle-bracket includes (MQL5 standard library, not packaged):"
  grep -hE '^[[:space:]]*#include[[:space:]]+<' "$PKG"/src/* | sed -E 's/^[[:space:]]*/  /' | sort -u
} > "$PKG/COMMIT.txt"

{
  echo "EA source changes from $REF to $COMMIT (mt5-bridge/)"
  echo
  echo "Packaged files:"
  for f in $FILES; do
    if git -C "$REPO" diff --quiet "$REF" "$COMMIT" -- "mt5-bridge/$f"; then
      echo "  $f: unchanged"
    else
      echo "  $f: CHANGED"
    fi
  done
  echo
  echo "git diff --stat $REF $COMMIT -- mt5-bridge:"
  git -C "$REPO" diff --stat "$REF" "$COMMIT" -- mt5-bridge | sed 's/^/  /'
  if [ -z "$(git -C "$REPO" diff --stat "$REF" "$COMMIT" -- mt5-bridge)" ]; then echo "  (empty: no file under mt5-bridge/ differs)"; fi
  echo
  echo "Non-merge commits touching mt5-bridge/ in $REF..$COMMIT (the diff above is the net change):"
  git -C "$REPO" log --no-merges --format='  %H %s' "$REF..$COMMIT" -- mt5-bridge
  if [ -z "$(git -C "$REPO" log --no-merges --format=%H "$REF..$COMMIT" -- mt5-bridge)" ]; then echo "  (none)"; fi
} > "$PKG/CHANGES_SINCE_REFERENCE.txt"

sed -e "s/@COMMIT@/$COMMIT/g" -e "s/@SHORT@/$SHORT/g" "$HERE/COMPILE_INSTRUCTIONS.md" > "$PKG/COMPILE_INSTRUCTIONS.md"
cp "$HERE/compile_mac_wine.sh" "$HERE/pe_version.py" "$PKG/"
chmod +x "$PKG/compile_mac_wine.sh"

( cd "$PKG" && find . -type f ! -name PACKAGE.sha256 | sort | sed 's|^\./||' | xargs sha256sum ) > "$PKG/PACKAGE.sha256"
( cd "$OUT_ROOT" && zip -qrX "$NAME.zip" "$NAME" )

echo "package: $OUT_ROOT/$NAME.zip"
echo "zip sha256: $(sha256sum "$OUT_ROOT/$NAME.zip" | cut -d' ' -f1)"
cat "$PKG/MANIFEST.sha256"
