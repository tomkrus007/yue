#!/usr/bin/env bash
# 把官方安装包里的腾讯会议原生框架拷到 YX 的 vendor 目录（不入库）。
#
# 用法：
#   ./scripts/sync-wemeet.sh                 # 默认从已挂载的 DMG 卷拷贝
#   ./scripts/sync-wemeet.sh /path/to/TMSDK.framework
#
# 说明：TMSDK.framework 约 357 MB，arm64-only，许可证归腾讯所有；仅本地开发使用，
# 不要提交到仓库、不要随公开构建分发。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/src-tauri/vendor/TMSDK.framework"
DEFAULT_SRC="/Volumes/云上越秀 5.2.97-arm64/云上越秀.app/Contents/Frameworks/TMSDK.framework"

SRC="${1:-$DEFAULT_SRC}"

if [[ ! -d "$SRC" ]]; then
  echo "找不到 TMSDK.framework：$SRC" >&2
  echo "请先挂载 yx-packages/yuexiu_*.dmg，或把框架路径作为第一个参数传入。" >&2
  exit 1
fi

if [[ -d "$DEST" ]]; then
  echo "已存在：$DEST（跳过；如需重拷先删除）"
  exit 0
fi

mkdir -p "$ROOT/src-tauri/vendor"
echo "拷贝 $SRC → $DEST"
# -R 保留嵌套 framework / helper.app / 符号链接；rpath 依赖原始目录层级。
cp -R "$SRC" "$DEST"
echo "完成：$(du -sh "$DEST" | awk '{print $1}')"
