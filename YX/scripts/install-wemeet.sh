#!/usr/bin/env bash
# 把本地 TMSDK.framework 装进已构建的 YX.app（开发/临时验证用）。
#
# 组件化之后 YX.app 不再内嵌 TMSDK，需要单独安装；正式的安装入口在应用内
# （见 doc/TMSDK组件化与跨平台设计.md），这个脚本只解决“本地还没接通安装器时怎么验”。
#
# 用法：
#   ./scripts/install-wemeet.sh target/debug/bundle/macos/YX.app
#   ./scripts/install-wemeet.sh YX.app /path/to/TMSDK.framework
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/src-tauri/target/debug/bundle/macos/YX.app}"
SRC="${2:-$ROOT/src-tauri/vendor/TMSDK.framework}"

if [[ ! -d "$APP/Contents/MacOS" ]]; then
  echo "不是 .app 包：$APP" >&2
  echo "先运行 pnpm tauri build --debug，再指定 bundle/macos/YX.app。" >&2
  exit 1
fi

if [[ ! -d "$SRC" ]]; then
  echo "找不到 TMSDK.framework：$SRC" >&2
  echo "先运行 ./scripts/sync-wemeet.sh 从官方安装包拷到 vendor。" >&2
  exit 1
fi

DEST="$APP/Contents/Frameworks/TMSDK.framework"
if [[ -e "$DEST" ]]; then
  echo "已安装：$DEST（如需覆盖先删除）"
  exit 0
fi

mkdir -p "$(dirname "$DEST")"
echo "安装 $SRC → $DEST"
# ditto 保留符号链接、可执行位与扩展属性；rpath 依赖原始层级，不能摊平。
ditto "$SRC" "$DEST"

# 改包会破坏 bundle seal（现在的产物是 ad-hoc，本来也没有 seal）；统一重签一遍。
codesign --force --sign - --options runtime \
  --entitlements "$ROOT/src-tauri/Entitlements.plist" "$APP"
codesign --verify --deep --strict "$APP"
echo "完成：$(du -sh "$DEST" | awk '{print $1}')"
