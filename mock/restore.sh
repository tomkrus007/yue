#!/usr/bin/env bash
#
# 恢复真实 TrustAgent 服务（停掉 mock，重新加载 LaunchAgent）
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/mock-trustagent.pid"

echo "[i] 停止 mock…"
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
fi
pkill -f "mock-trustagent.js" 2>/dev/null || true
sleep 1

echo "[i] 重新加载真实 TrustAgent LaunchAgent…"
for plist in \
  /Library/LaunchAgents/com.legendsec.trustagentsdk.plist \
  "$HOME/Library/LaunchAgents/com.legendsec.trustagentservice.plist"; do
  if [ -f "$plist" ]; then
    launchctl load -wF "$plist" 2>/dev/null && echo "    loaded: $plist" || echo "    (skip) $plist"
  fi
done

# 若 TrustAgentLauncher.app 未运行也一并拉起
if ! pgrep -x TrustAgentLauncher >/dev/null 2>&1 && [ -d /Applications/TrustAgentLauncher.app ]; then
  echo "[i] 启动 TrustAgentLauncher…"
  open -a /Applications/TrustAgentLauncher.app 2>/dev/null || true
fi

sleep 1
echo "[i] 进程状态："
pgrep -fl "trustagent|TrustAgent" | head

echo
echo "[✓] 真实 TrustAgent 已恢复。"
