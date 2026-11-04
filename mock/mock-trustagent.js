#!/usr/bin/env node
/**
 * 云上越秀 TrustAgent Mock 服务
 *
 * 用途：代替 /Applications/TrustAgentLauncher.app 里的 trustagentsdk 本地 HTTP 服务，
 *      让"云上越秀"客户端在不安装零信任组件的情况下通过登录流程的 TrustAgent 校验。
 *
 * 依据：
 *   - 前端 web/html/static/js/login.*.js 中 webpack 模块 31（零信任助手）：
 *       l="http://127.0.0.1", u=35443, d="trustagent", h="/zta"
 *       ping  → /ping            期望 {"message":"pong"}
 *       login → /trustagent {method:"login",params:{host,port,user_token}}
 *       status→ /trustagent {method:"status",params:{type:"user_info"}} 期望 result.code==0 && result.message=="online"
 *       status→ /trustagent {method:"status",params:{type:"nc_status"}} 期望 result.code==0 && result.message=="connected"
 *       topic → /trustagent {method:"topic",params:{type:"register"|"unregister",callback:[...]}}
 *       logout→ /trustagent {method:"logout",params:{}}
 *   - 端口回退逻辑：先 35443，失败后 35440→35441→35442→35443→35444… 因此同时监听 35440-35443。
 *   - trustagentsdk 二进制（Go+gin）字符串佐证：路由 /ping、/trustagent、/proxyserver/*，
 *     方法 login/logout/status/topic、字段 user_token/nc_status、错误码 [0105005]/[0305002]。
 *
 * 局限：本 mock 只满足应用层的"TrustAgent 在线"校验，不提供真实零信任网络隧道。
 *       若 bingolink.biz 业务/SSO 流量必须经 aTrust 隧道才能到达，仍需在网络层打通。
 */

const http = require('http');

const HOST = '127.0.0.1';
const PORTS = [35443, 35442, 35441, 35440]; // 同时监听这四个端口，覆盖前端的端口扫描回退

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function log(port, line) {
  console.log(`[${ts()}] :${port}  ${line}`);
}

/** 构造 JSON-RPC 风格的成功响应体 */
function ok(message = 'success', extra) {
  const body = { result: { code: 0, message } };
  if (extra) Object.assign(body.result, extra);
  return body;
}

/** 处理 POST /trustagent 的 JSON-RPC 请求体 */
function handleTrustAgent(reqBody) {
  const { method, params } = reqBody || {};
  switch (method) {
    case 'login':
      // params: {host, port, user_token} —— mock 直接放行
      return ok('success');
    case 'logout':
      return ok('success');
    case 'status': {
      const type = params && params.type;
      if (type === 'user_info') {
        // 返回 online → 前端 isOnlineStatus 走"已在线"分支，跳过 loginTrustAgent 直接入主界面
        return ok('online');
      }
      if (type === 'nc_status') {
        // NC 隧道连接状态：connected 表示零信任隧道已就绪
        return ok('connected');
      }
      return ok('online');
    }
    case 'topic':
      // register / unregister 回调注册，mock 接受即可，不需要真正回调
      return ok('success');
    default:
      return ok('success');
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (chunk) => { buf += chunk.toString(); });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function createServer(port) {
  const server = http.createServer(async (req, res) => {
    // 只关心 POST；其余一律 200 空体，避免 SDK 内部探活误判
    if (req.method !== 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }

    const body = await readBody(req);
    let resp;

    if (req.url === '/ping') {
      // 前端 verifyServiceAvailable 校验："pong"==n.message
      resp = { message: 'pong' };
      log(port, `POST /ping → pong`);
    } else if (req.url === '/trustagent' || req.url === '/trustagent/') {
      resp = handleTrustAgent(body);
      const m = body.method, t = body.params && body.params.type;
      log(port, `POST /trustagent  method=${m}${t ? ` type=${t}` : ''} → ${JSON.stringify(resp)}`);
    } else {
      // 兼容其它探活路径
      resp = { message: 'pong' };
      log(port, `POST ${req.url} (fallback) → pong`);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resp));
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[!] 端口 ${port} 已被占用（可能是真实 TrustAgent 或上一次 mock 仍在运行），跳过。`);
    } else {
      console.error(`[!] 端口 ${port} 监听失败：`, e.message);
    }
  });

  server.listen(port, HOST, () => {
    log(port, `TrustAgent mock listening on http://${HOST}:${port}`);
  });

  return server;
}

const servers = PORTS.map(createServer);

// 优雅退出
function shutdown() {
  console.log('\n[i] 正在关闭 mock 服务…');
  servers.forEach((s) => { try { s.close(); } catch {} });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`[i] 云上越秀 TrustAgent Mock 已启动，监听 ${HOST} 端口 ${PORTS.join(', ')}`);
console.log('[i] 按 Ctrl+C 退出。');
