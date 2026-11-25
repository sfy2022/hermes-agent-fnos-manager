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

echo "==> JSON 校验"
python3 - <<'PY'
import json
for path in ["manifest.json"]:
    pass
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
