#!/usr/bin/env bash
#
# 云上越秀 TrustAgent Mock 一键部署脚本
#
# 做三件事：
#   1. 停掉真实 TrustAgent 服务（释放 127.0.0.1:35440-35443 端口）
#   2. 后台启动 mock-trustagent.js 接管这些端口
#   3. curl 自检
#
# 恢复真实 TrustAgent：运行 ./restore.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOCK_SCRIPT="$SCRIPT_DIR/mock-trustagent.js"
LOG_FILE="${TRUSTAGENT_MOCK_LOG:-$SCRIPT_DIR/mock-trustagent.log}"
PID_FILE="$SCRIPT_DIR/mock-trustagent.pid"

# ---- 0. 检查 node ----
if ! command -v node >/dev/null 2>&1; then
  echo "[!] 未找到 node，请先安装 Node.js（建议 16+）。"
  exit 1
fi

# ---- 1. 停掉真实 TrustAgent ----
echo "[i] 停止真实 TrustAgent 服务…"

# 卸载 LaunchAgent（KeepAlive=true，必须先 unload 否则进程会被重启）
for plist in \
  /Library/LaunchAgents/com.legendsec.trustagentsdk.plist \
  "$HOME/Library/LaunchAgents/com.legendsec.trustagentservice.plist" \
  "$HOME/Library/LaunchAgents/com.legendsec.trustagentsdk.plist"; do
  if [ -f "$plist" ]; then
    launchctl unload "$plist" 2>/dev/null && echo "    unloaded: $plist" || echo "    (skip)    $plist"
  fi
done

# trustdservice 是 root LaunchDaemon，不占 3544x 端口，无需 sudo 卸载；
# 但若需要彻底停掉可手动执行：sudo launchctl unload /Library/LaunchDaemons/com.legendsec.trustdservice.plist

# 杀残留进程（trustagentsdk 占着 3544x）
pkill -x trustagentsdk     2>/dev/null && echo "    killed: trustagentsdk"     || true
pkill -x trustagentservice 2>/dev/null && echo "    killed: trustagentservice" || true
sleep 1

# ---- 2. 停掉旧的 mock ----
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  sleep 1
fi
pkill -f "mock-trustagent.js" 2>/dev/null || true

# ---- 3. 启动 mock ----
echo "[i] 启动 TrustAgent mock（日志：$LOG_FILE）…"
nohup node "$MOCK_SCRIPT" > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 1

# ---- 4. 自检 ----
echo "[i] 自检…"
ok=0
for p in 35443 35442 35441 35440; do
  resp=$(curl -s -m 2 -X POST "http://127.0.0.1:$p/ping" -H 'Content-Type: application/json' -d '{}' 2>/dev/null || echo "FAIL")
  if echo "$resp" | grep -q '"pong"'; then
    echo "    :$p/ping → $resp  ✓"
    ok=1
    break
  else
    echo "    :$p/ping → $resp"
  fi
done

if [ "$ok" -eq 0 ]; then
  echo "[✗] mock 启动失败，请查看日志：$LOG_FILE"
  exit 1
fi

echo
echo "[✓] 部署完成。"
echo "    mock PID: $(cat "$PID_FILE")"
echo "    日志:     $LOG_FILE"
echo "    停止:     kill \$(cat $PID_FILE)  或  pkill -f mock-trustagent.js"
echo "    恢复真实 TrustAgent: ./restore.sh"
echo
echo "现在可以启动"云上越秀"并登录了。"
