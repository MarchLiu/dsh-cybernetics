#!/usr/bin/env bash
# Apply the v0.14 "per-sub-agent reasoning effort" patch to the DSH web
# profile checkout at /Users/mars/.dsh/profiles/web/.
#
# WHY A SCRIPT: the delegated task agent's file sandbox is scoped to its own
# session workspace and cannot write the checkout — every write there fails
# closed. All edits were therefore prepared and fully validated on the staged
# copies in ./stage/ (see README.md), and this script materializes them.
# Run it from any shell with write access to the checkout.
set -euo pipefail

WEB=/Users/mars/.dsh/profiles/web
SRC="$(cd "$(dirname "$0")" && pwd)/stage"
STAMP=$(date +%Y%m%d-%H%M%S)

CYB="$WEB/node_modules/@mars.liu/dsh-cybernetics"
PTC="$WEB/node_modules/@deepseek-ai/dsh-workflow-ptc"

targets=(
  "$SRC/dsh-workflow-ptc/lib/index.js|$PTC/lib/index.js"
  "$SRC/dsh-cybernetics/src/index.ts|$CYB/src/index.ts"
  "$SRC/dsh-cybernetics/src/controller.ts|$CYB/src/controller.ts"
  "$SRC/dsh-cybernetics/workflows/round.js|$CYB/workflows/round.js"
  "$SRC/dsh-cybernetics/lib/client.js|$CYB/lib/client.js"
)

echo "== backup current files (.bak-pre-effort-$STAMP) =="
for pair in "${targets[@]}"; do
  dst="${pair#|*}"; dst="${pair##*|}"
  cp "$dst" "$dst.bak-pre-effort-$STAMP"
done

echo "== apply patched files =="
for pair in "${targets[@]}"; do
  src="${pair%%|*}"; dst="${pair##*|}"
  cp "$src" "$dst"
  echo "  $dst"
done

echo "== install new offline test =="
cp "$SRC/dsh-cybernetics/test/v14-effort-row.mjs" "$CYB/test/v14-effort-row.mjs"

echo "== post-apply sanity (syntax) =="
node --check "$PTC/lib/index.js"
node --check "$CYB/lib/client.js"

echo "OK. Restart the DSH host so the Node half (src schema is read at boot) and the client bundle are reloaded."
echo "Revert: for f in <each target>; do cp \"\$f.bak-pre-effort-$STAMP\" \"\$f\"; done"
