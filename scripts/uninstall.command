#!/bin/zsh
cd "$(dirname "$0")/.."
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
fi
DSH_BIN="$(command -v dsh || true)"
STATUS=0
"$NODE_BIN" scripts/install.mjs --uninstall --apply || STATUS=$?
if [ -n "$DSH_BIN" ]; then
  for p in desktop web; do
    "$DSH_BIN" plugin --profile "$p" remove dsh-provider-guard || true
  done
else
  echo "未找到 dsh 命令；请手动运行：dsh plugin --profile <profile> remove dsh-provider-guard"
fi
echo
read -k 1 "?按任意键关闭..."
exit $STATUS
