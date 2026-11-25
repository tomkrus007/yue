#!/usr/bin/env bash
# 只取 TMSDK 头文件（CI 编译 shim 用；框架本身运行时才装）。
#
# 地址从 src-tauri/components.json 读，与运行时组件下载共用同一处默认值，
# 避免「workflow 里写一个版本、components.json 写另一个版本」。
#
# 用法：
#   ./scripts/fetch-tmsdk-headers.sh [平台] [目标目录]
#   TMSDK_ARCHIVE=/path/TMSDK-xxx.tar.zst ./scripts/fetch-tmsdk-headers.sh macos-arm64
#
# 默认平台 macos-arm64，默认目标 src-tauri/vendor/TMSDK.framework/Versions/A
# （build.rs 只认这个位置）。设了 TMSDK_ARCHIVE 就跳过下载，用本地包。
# 依赖 node（读 components.json）与系统 tar（自动识别 zstd）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM="${1:-macos-arm64}"
DEST="${2:-$ROOT/src-tauri/vendor/TMSDK.framework/Versions/A}"

case "$PLATFORM" in
  macos-*)
    # 组件包里框架固定叫 TMSDK.framework，Windows 以后是另一套目录结构
    MEMBER="payload/TMSDK.framework/Versions/A/Headers"
    ;;
  *)
    echo "暂不支持的平台：$PLATFORM（Windows 的组件包结构还没调研，见 doc/TMSDK组件化与跨平台设计.md）" >&2
    exit 1
    ;;
esac

URL="$(COMPONENTS="$ROOT/src-tauri/components.json" PLATFORM="$PLATFORM" node -e '
  const fs = require("fs");
  const all = JSON.parse(fs.readFileSync(process.env.COMPONENTS, "utf8"));
  const entry = all?.tmsdk?.platforms?.[process.env.PLATFORM];
  if (!entry?.url) {
    console.error(`components.json 里没有 ${process.env.PLATFORM} 的组件地址`);
    process.exit(1);
  }
  process.stdout.write(entry.url);
')"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [[ -n "${TMSDK_ARCHIVE:-}" ]]; then
  echo "使用本地组件包：$TMSDK_ARCHIVE"
  ARCHIVE="$TMSDK_ARCHIVE"
else
  echo "下载组件包（约 118 MB）：$URL"
  ARCHIVE="$WORK/component.tar.zst"
  # GitHub 的 TLS 握手偶发被掐断，重试几次比直接失败有用
  curl -fL --retry 5 --retry-delay 3 --retry-all-errors \
    --connect-timeout 20 -o "$ARCHIVE" "$URL"
fi

echo "解出头文件：$MEMBER"
mkdir -p "$WORK/out"
tar -xf "$ARCHIVE" -C "$WORK/out" "$MEMBER"
mkdir -p "$DEST"
# 覆盖旧头文件，避免残留已删除的头
rm -rf "${DEST:?}/Headers"
cp -R "$WORK/out/$MEMBER" "$DEST/Headers"

COUNT="$(find "$DEST/Headers" -type f | wc -l | tr -d ' ')"
echo "完成：$DEST/Headers（$COUNT 个文件）"
ls "$DEST/Headers" | head -5
