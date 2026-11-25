#!/bin/bash
#
# prepull.sh —— 在安装前把镜像准备好（可选）。
#
# 用途：部分网络的 Docker Hub 直连会超时，安装时 appcenter 的 compose up 会卡在
#       "Pulling fs layer"。先跑本脚本，通过镜像加速站拉取并打成官方镜像名，
#       之后安装走「本地已有 → 零网络」分支，几秒完成。
#
# 用法：sudo bash tools/prepull.sh
# 可用环境变量覆盖：IMAGE_MIRROR（默认 docker.fnnas.com，走飞牛官方 registry-mirror）

set -euo pipefail

IMAGE_REPO="nousresearch/hermes-agent"
IMAGE_TAG="${IMAGE_TAG:-main-desktop}"
IMAGE_MIRROR="${IMAGE_MIRROR:-docker.fnnas.com}"
CANONICAL="${IMAGE_REPO}:${IMAGE_TAG}"
if [ "${IMAGE_MIRROR}" = "docker.fnnas.com" ]; then
    MIRRORED="${IMAGE_REPO}:${IMAGE_TAG}"
else
    MIRRORED="${IMAGE_MIRROR}/${IMAGE_REPO}:${IMAGE_TAG}"
fi

if docker image inspect "${CANONICAL}" >/dev/null 2>&1; then
    echo "镜像已存在：${CANONICAL}，无需拉取。"
    exit 0
fi

echo "从镜像加速站拉取：${MIRRORED}"
docker pull "${MIRRORED}"
docker tag "${MIRRORED}" "${CANONICAL}"
echo "完成：已打标签 ${CANONICAL}（安装时将直接使用本地镜像）"
