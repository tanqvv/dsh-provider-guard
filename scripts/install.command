#!/bin/zsh
cd "$(dirname "$0")/.."
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
fi
STATUS=0
"$NODE_BIN" scripts/install.mjs --apply --bundle "$@" || STATUS=$?
echo
read -k 1 "?按任意键关闭..."
exit $STATUS
