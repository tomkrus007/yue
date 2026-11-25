#!/usr/bin/env bash
# 把 vendor 里的 TMSDK.framework 打成组件包：TMSDK-<ver>-<platform>-<arch>.tar.zst
#
# 用法：
#   ./scripts/pack-tmsdk.sh                     # 默认从 src-tauri/vendor 取框架，输出到 dist-components/
#   ./scripts/pack-tmsdk.sh /path/TMSDK.framework [输出目录]
#
# 产物：
#   TMSDK-3.21.303-macos-arm64.tar.zst   （约 118 MB，zstd -19）
#   TMSDK-3.21.303-macos-arm64.tar.zst.sha256
#
# 包内结构（应用内的安装器只认这个结构）：
#   component.json
#   payload/TMSDK.framework/...
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$ROOT/src-tauri/vendor/TMSDK.framework}"
OUT="${2:-$ROOT/dist-components}"
# 载入器（dlopen）所在的第一个版本；比它老的 app 装不上这个包
MIN_APP="${MIN_APP:-0.1.27}"

if [[ ! -d "$SRC" ]]; then
  echo "找不到 TMSDK.framework：$SRC" >&2
  echo "先运行 ./scripts/sync-wemeet.sh 从官方安装包拷到 vendor。" >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "TMSDK 只有 arm64 slice，请在 Apple Silicon 上打包。" >&2
  exit 1
fi

INFO="$SRC/Versions/A/Resources/Info.plist"
if [[ ! -f "$INFO" ]]; then
  echo "框架缺少 Info.plist：$INFO" >&2
  exit 1
fi
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INFO")"
NAME="TMSDK-${VERSION}-macos-arm64.tar.zst"

# 关键的嵌套库必须存在，否则装上去也加载不了
CORE="$SRC/Versions/A/Frameworks/tmsdk_wemeet_sdk.framework/Versions/A/tmsdk_wemeet_sdk"
if [[ ! -f "$CORE" ]]; then
  echo "框架缺少核心库：$CORE" >&2
  exit 1
fi

echo "校验腾讯签名…"
codesign --verify --deep --strict "$SRC"
TEAM="$(codesign -dv --verbose=4 "$SRC" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
if [[ "$TEAM" != "5PMRFKHZTP" ]]; then
  echo "签名主体不是腾讯（TeamIdentifier=$TEAM），应用里的安装器会拒绝这个包。" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "复制框架到 staging…"
mkdir -p "$WORK/payload"
# ditto 保留符号链接 / 可执行位 / 嵌套 helper.app
ditto "$SRC" "$WORK/payload/TMSDK.framework"

cat > "$WORK/component.json" <<JSON
{
  "schema": 1,
  "component": "tmsdk",
  "version": "$VERSION",
  "platform": "macos",
  "arch": "arm64",
  "payload": "payload/TMSDK.framework",
  "min_app": "$MIN_APP",
  "notes": "From 云上越秀 5.2.97-arm64"
}
JSON

mkdir -p "$OUT"
echo "打包（tar → zstd -19，约需数十秒）…"
# --no-xattrs/--no-mac-metadata：别把本机的扩展属性带进分发包。
# 先落成 tar 文件再压（约 355 MB 临时空间），压缩参数与产物大小都更可控。
( cd "$WORK" && /usr/bin/tar --no-xattrs --no-mac-metadata -cf "$WORK/package.tar" component.json payload )
zstd -T0 -19 -q -o "$OUT/$NAME" "$WORK/package.tar"
rm -f "$WORK/package.tar"

( cd "$OUT" && shasum -a 256 "$NAME" > "$NAME.sha256" )

echo
SIZE="$(stat -f '%z' "$OUT/$NAME")"
echo "完成：$OUT/$NAME（$((SIZE / 1024 / 1024)) MB）"
echo "sha256：$(cut -d' ' -f1 "$OUT/$NAME.sha256")"
echo
echo "发布到 GitHub Release：" 
echo "  gh release create tmsdk-v$VERSION --title \"TMSDK $VERSION\" --notes \"腾讯会议组件包（macOS arm64）\" \\"
echo "    \"$OUT/$NAME\" \"$OUT/$NAME.sha256\""
