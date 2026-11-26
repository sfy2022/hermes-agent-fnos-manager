#!/usr/bin/env python3
"""Generate detailed GitHub release notes from manifest + git history."""
from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "https://github.com/sfy2022/hermes-agent-fnos-manager"


def run(*args: str, default: str = "") -> str:
    try:
        return subprocess.check_output(args, cwd=ROOT, text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return default


def read(path: str) -> str:
    with open(os.path.join(ROOT, path), encoding="utf-8") as fh:
        return fh.read()


manifest = read("manifest")
version = (re.search(r"^version\s*=\s*(\S+)", manifest, re.M) or [None, ""])[1]
changelog = (re.search(r"^changelog\s*=\s*(.+)$", manifest, re.M) or [None, ""])[1].strip()
tag = os.environ.get("GITHUB_REF_NAME") or f"v{version}"

previous = run("git", "describe", "--tags", "--abbrev=0", f"{tag}^", default="")
commits: list[str] = []
if previous:
    raw = run("git", "log", f"{previous}..{tag}", "--pretty=format:%h %s", default="")
    commits = [line for line in raw.splitlines() if line.strip()][:40]

fpk = os.path.join(ROOT, "hermes-agent.fpk")
sha = os.environ.get("HERMES_FPK_SHA256") or (hashlib.sha256(open(fpk, "rb").read()).hexdigest() if os.path.exists(fpk) else "")
compare = f"{REPO}/compare/{previous}...{tag}" if previous else f"{REPO}/commits/main"

lines = [
    f"## Hermes Agent for fnOS {version}",
    "",
    "### 本版更新",
    "",
    f"- {changelog}" if changelog else "- 详见提交记录",
    "",
]
if commits:
    lines += ["### 提交记录", ""] + [f"- `{c}`" for c in commits] + [""]
lines += [
    "### 安装",
    "",
    "1. 下载 `hermes-agent.fpk`；",
    "2. 应用中心 → 手动安装 → 选择 fpk；",
    "3. 安装向导选择存储位置与运行权限；",
    "4. 打开 **Hermes Admin** →「安装 Hermes Agent」；",
    "5. 运行时可选 Docker 容器或原生（源码构建 / 镜像提取）。",
    "",
    "### 说明",
    "",
    "- Docker 模式数据在共享目录，原生数据在 `@appdata/hermes-agent/native/data`；",
    "- 原生源码构建首次约 10–30 分钟，使用国内镜像加速；",
    "- fnOS 每个应用只有一个桌面快捷方式；",
    "- 仅同步 GitHub 稳定版。",
    "",
    "### 校验",
    "",
    "```",
    f"SHA256 (hermes-agent.fpk): {sha or '见附件 .sha256'}",
    "```",
    "",
    f"完整变更对比：{compare}",
    "",
    f"MIT License · 项目：{REPO}",
    "",
]
sys.stdout.write("\n".join(lines))
