#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -d frontend/node_modules ]; then
    echo "==> 安装前端依赖"
    (cd frontend && npm ci)
fi

echo "==> 构建管理端前端"
(cd frontend && npm run build)

echo "==> 打包 fpk"
./tools/fnpack build -d .

echo "==> 产物：$ROOT/hermes-agent.fpk"
