#!/usr/bin/env bash
# Apply the llm-pi-ai `off` reasoning-effort key fix to the web profile patch.
# Must run OUTSIDE the agent sandbox (a normal terminal): the agent session is
# limited to workspace-write and cannot write into ~/.dsh.
#
#   ./apply-fix.sh                 # minimal: change only the two broken keys
#   ./apply-fix.sh from-backup     # rebuild text from the 17:28 backup: same fix
#                                  # + restores the 74 comment lines destroyed by
#                                  # the earlier YAML round-trip + keeps the current
#                                  # agent-default-model and hardGate settings
#   ./apply-fix.sh minimal --force # proceed even if the file changed since diagnosis
#
# Then restart the `dsh web` process: the patch layer is read at boot and no
# watcher reloads it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${TARGET:-/Users/mars/.dsh/profiles/web/cordis.patch.yml}"
MODE="${1:-minimal}"
FORCE="${2:-}"
BACKUP="${BACKUP:-/Users/mars/.dsh/profiles/web/cordis.patch.yml.bak-pre-hardgate-20261104-172829}"
EXPECTED_CURRENT_SHA="0e2222b5f0537ebbc48746a6e8e8ee80cc2d4591d7311cd84c930ccec0344339"

[ -f "$TARGET" ] || { echo "target not found: $TARGET" >&2; exit 1; }
CURRENT_SHA="$(shasum -a 256 "$TARGET" | cut -d' ' -f1)"

if [ "$MODE" = "minimal" ]; then
  if [ "$CURRENT_SHA" = "10fc1a02fb7ce40481420a45d4532390dadef27634a2be643daf76e67210fa86" ]; then
    echo "already fixed (target matches the validated output hash) — nothing to do."
    node "$HERE/verify-cordis.mjs" "$TARGET"
    exit 0
  fi
  if [ "$CURRENT_SHA" != "$EXPECTED_CURRENT_SHA" ] && [ "$FORCE" != "--force" ]; then
    echo "REFUSING: $TARGET changed since diagnosis." >&2
    echo "  expected sha256 $EXPECTED_CURRENT_SHA" >&2
    echo "  actual   sha256 $CURRENT_SHA" >&2
    echo "Inspect the two reasoningEfforts blocks by hand, or re-run with --force." >&2
    exit 3
  fi
elif [ "$MODE" != "from-backup" ]; then
  echo "usage: $0 [minimal|from-backup] [--force]" >&2; exit 2
fi
[ -f "$BACKUP" ] || { echo "backup not found: $BACKUP" >&2; exit 1; }

TS="$(date +%Y%m%d-%H%M%S)"
DEST="$TARGET.bak-pre-offfix-$TS"
cp -p "$TARGET" "$DEST"
echo "safety backup: $DEST"

node "$HERE/patch-llm-pi-ai.mjs" "$MODE" "$TARGET" "$BACKUP"
echo
node "$HERE/verify-cordis.mjs" "$TARGET"
echo
echo "Applied. Restart the dsh web process so the patch layer is re-read."
