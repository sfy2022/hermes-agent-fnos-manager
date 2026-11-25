#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> 语法检查"
node --check app/manager/server.js
for f in cmd/* scripts/*.sh tools/prepull.sh; do
    [ -f "$f" ] || continue
    bash -n "$f"
done

echo "==> 版本一致性"
VER="$(sed -n 's/^version[[:space:]]*=[[:space:]]*//p' manifest | head -n 1 | tr -d '\r ')"
PKG="$(node -p "require('./frontend/package.json').version")"
APP="$(sed -n "s/.*appVersion = '\([^']*\)'.*/\1/p" frontend/src/App.vue | head -n 1)"
if [ -z "$VER" ] || [ "$VER" != "$PKG" ] || [ "$VER" != "$APP" ]; then
    echo "版本不一致: manifest=$VER package=$PKG app=$APP"
    exit 1
fi
echo "version $VER"

echo "==> JSON 校验"
python3 - <<'PY'
import json
for path in ["wizard/install", "wizard/uninstall", "wizard/upgrade", "app/ui/config", "config/resource", "config/privilege"]:
    with open(path, encoding="utf-8") as fh:
        json.load(fh)
print("json ok")
PY

echo "==> 前端构建"
if [ -d frontend/node_modules ]; then
    (cd frontend && npm run build)
else
    echo "skip frontend build (node_modules missing)"
fi
