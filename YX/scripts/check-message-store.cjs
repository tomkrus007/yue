// 在 YX/ 执行：node scripts/check-message-store.cjs。
// 使用真实 Vue、Pinia、store、消息归一和 IM 帧，仅模拟本机能力、账号与网络边界。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../node_modules/typescript');
const vue = require('vue');
const pinia = require('pinia');
const root = path.resolve(__dirname, '../src');
const cache = new Map();
const saved = new Map();
const localStorage = {
  getItem: key => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, String(value)),
  removeItem: key => saved.delete(key),
  key: index => [...saved.keys()][index] ?? null,
  get length() {
    return saved.size
  },
};
const sockets = [];
class MockWebSocket {
  readyState = 0;
  sent = [];
  constructor() { sockets.push(this); }
  send(frame) { assert.equal(this.readyState, 1); this.sent.push(frame); }
  close() { this.readyState = 3; }
}
let historyRows = [];
const httpCalls = [];
const nativeCalls = [];
// 内存版 SQLite：模拟 im_store.rs 的命令，让真实的 services/im/store.ts 参与回归。
const database = { messages: new Map(), state: new Map() };
const dbKey = (accountId, msgId) => `${accountId}\u0000${msgId}`;
const stateKey = (accountId, scope, key) => `${accountId}\u0000${scope}\u0000${key}`;
const textCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function stateOf(accountId, scope, key) { return database.state.get(stateKey(accountId, scope, key))?.value; }
async function settle(ms = 30) { await new Promise(resolve => setTimeout(resolve, ms)); }
async function persist(store) {
  // 节流队列 + 串行链：多轮 flush/settle 保证所有异步写入都落到内存库。
  for (let i = 0; i < 3; i++) { store.flush(); await settle(40); }
}
function handleCommand(command, params = {}) {
  switch (command) {
    case 'im_messages_upsert': {
      const updatedAt = Date.now();
      for (const row of params.rows || []) database.messages.set(dbKey(params.accountId, row.msgId), { accountId: params.accountId, ...row, updatedAt });
      return params.rows?.length || 0;
    }
    case 'im_messages_recent': {
      const rows = [...database.messages.values()].filter(row => row.accountId === params.accountId)
        .sort((a, b) => b.sendTime - a.sendTime || textCmp(b.msgId, a.msgId))
        .slice(0, params.limit).reverse();
      return rows.map(row => row.body);
    }
    case 'im_messages_session': {
      const rows = [...database.messages.values()].filter(row => row.accountId === params.accountId && row.sessionId === params.sessionId)
        .sort((a, b) => b.sendTime - a.sendTime || textCmp(b.msgId, a.msgId))
        .slice(0, params.limit).reverse();
      return rows.map(row => row.body);
    }
    case 'im_messages_around': {
      const target = [...database.messages.values()].find(row => row.accountId === params.accountId && row.sessionId === params.sessionId && row.msgId === params.msgId);
      if (!target) return [];
      const rows = [...database.messages.values()].filter(row => row.accountId === params.accountId && row.sessionId === params.sessionId);
      const older = rows.filter(row => row.sendTime < target.sendTime || (row.sendTime === target.sendTime && textCmp(row.msgId, target.msgId) <= 0))
        .sort((a, b) => b.sendTime - a.sendTime || textCmp(b.msgId, a.msgId)).slice(0, params.before).reverse();
      const newer = rows.filter(row => row.sendTime > target.sendTime || (row.sendTime === target.sendTime && textCmp(row.msgId, target.msgId) > 0))
        .sort((a, b) => a.sendTime - b.sendTime || textCmp(a.msgId, b.msgId)).slice(0, params.after);
      return [...older, ...newer].map(row => row.body);
    }
    case 'im_messages_get': {
      const row = database.messages.get(dbKey(params.accountId, params.msgId));
      return row ? row.body : null;
    }
    case 'im_messages_delete': {
      let removed = 0;
      for (const id of params.ids || []) if (database.messages.delete(dbKey(params.accountId, id))) removed++;
      return removed;
    }
    case 'im_account_clear': {
      for (const [key, row] of database.messages) if (row.accountId === params.accountId) database.messages.delete(key);
      for (const [key, row] of database.state) if (row.accountId === params.accountId) database.state.delete(key);
      return null;
    }
    case 'im_state_upsert': {
      const updatedAt = Date.now();
      for (const entry of params.entries || []) database.state.set(stateKey(params.accountId, params.scope, entry.key), { accountId: params.accountId, scope: params.scope, key: entry.key, value: entry.value, updatedAt });
      return params.entries?.length || 0;
    }
    case 'im_state_query': {
      const keys = params.keys ? new Set(params.keys) : null;
      return [...database.state.values()]
        .filter(row => row.accountId === params.accountId && row.scope === params.scope && (!keys || keys.has(row.key)))
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .map(row => ({ key: row.key, value: row.value }));
    }
    case 'im_state_delete': {
      let removed = 0;
      for (const key of params.keys || []) if (database.state.delete(stateKey(params.accountId, params.scope, key))) removed++;
      return removed;
    }
    case 'im_state_clear': {
      let removed = 0;
      const scopes = params.scopes ? new Set(params.scopes) : null;
      for (const [key, row] of database.state) {
        if (row.accountId !== params.accountId || (scopes && !scopes.has(row.scope))) continue;
        database.state.delete(key); removed++;
      }
      return removed;
    }
    case 'im_state_trim': {
      const rows = [...database.state.values()].filter(row => row.accountId === params.accountId && row.scope === params.scope)
        .sort((a, b) => b.updatedAt - a.updatedAt || textCmp(b.key, a.key)).slice(params.keep);
      for (const row of rows) database.state.delete(stateKey(row.accountId, row.scope, row.key));
      return rows.length;
    }
    default:
      return undefined;
  }
}
const authService = {
  getCurrentUserId: () => 'me', getCurrentUserName: () => '我',
  getDeviceId: () => 'device', getAccessToken: () => 'offline-test-token',
  getPlatform: () => 'macOS', refreshTokenResult: async () => true,
};
const moduleMocks = new Map([
  [path.join(root, 'services/auth.ts'), { authService }],
  [path.join(root, 'stores/auth.ts'), { useAuthStore: () => ({ isLoggedIn: true, user: { id: 'me', name: '我' }, logout() {} }) }],
  [path.join(root, 'services/http.ts'), {
    httpJson: async url => {
      httpCalls.push(url);
      if (new URL(url).pathname.endsWith('/get/history/date')) return { messages: historyRows, total: historyRows.length };
      return { data: [] };
    },
    postForm: async () => { throw new Error('回归不应执行偏好写操作'); },
  }],
  [path.join(root, 'services/contact-client.ts'), { contactService: {} }],
  [path.join(root, 'services/group-client.ts'), { groupService: {
    getGroupDetail: async id => ({ groupId: id, memberRole: 0, silentStatus: 0, memberCount: 2 }),
    getMembersPage: async () => ({ members: [{ userId: 'me', name: '我' }, { userId: 'author', name: '发起人' }], total: 2, hasMore: false }),
  } }],
  [path.join(root, 'services/im/media.ts'), {
    uploadForwardDetails: async () => { throw new Error('回归不应上传转发明细'); },
    buildMediaContent: () => { throw new Error('回归不应上传附件'); },
    uploadToStore: async () => { throw new Error('回归不应上传附件'); },
    normalizeClipboardImage: file => file,
  }],
]);
const external = {
  vue, pinia,
  'vue-router': { useRoute: () => ({ query: {} }), useRouter: () => ({ replace() {}, push() {} }) },
  '@tauri-apps/api/core': {
    invoke: async (command, params) => { nativeCalls.push({ command, params }); return handleCommand(command, params); },
    Channel: class { onmessage = null },
  },
  '@tauri-apps/api/window': { getCurrentWindow: () => ({ setBadgeCount: async () => {} }) },
  '@tauri-apps/plugin-notification': {
    isPermissionGranted: async () => true,
    requestPermission: async () => 'granted',
    sendNotification: () => {},
  },
  '@tauri-apps/plugin-http': { fetch: async () => { throw new Error('回归不应发起真实网络请求'); } },
  '@tauri-apps/api/event': { listen: async () => () => {}, emit: async () => {}, once: async () => () => {} },
  'json5': require('json5'),
  'jsencrypt': class {},
};
function load(file) {
  if (moduleMocks.has(file)) return moduleMocks.get(file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8').replace(/import\.meta\.glob/g, '__assetGlob'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const windowMock = { __TAURI_INTERNALS__: {}, addEventListener() {}, removeEventListener() {} };
  new Function('require', 'module', 'exports', 'localStorage', 'WebSocket', 'window', '__assetGlob', code)(id => {
    if (external[id]) return external[id];
    assert.ok(id.startsWith('.'), '未模拟的外部依赖：' + id);
    return load(path.resolve(path.dirname(file), id + '.ts'));
  }, module, module.exports, localStorage, MockWebSocket, windowMock, () => ({}));
  return module.exports;
}
const { useImStore } = load(path.join(root, 'stores/im.ts'));
const { imClient } = load(path.join(root, 'services/im/im-client.ts'));
const { MsgType } = load(path.join(root, 'services/im/types.ts'));
const { Cmd } = load(path.join(root, 'services/im/cmd.ts'));
const { encodeFrame, decodeFrame, encryptContent, decryptContent } = load(path.join(root, 'services/im/protocol.ts'));
const { normalizeImMessage, previewOf } = load(path.join(root, 'services/im/session-api.ts'));
const { toPlainText } = load(path.join(root, 'services/im/content.ts'));
const message = (overrides = {}) => ({
  msg_id: 'original', msg_type: MsgType.TEXT, content: '待确认的会议安排', from_id: 'author', from_name: '发起人',
  from_type: 1, to_id: 'group', to_name: '测试群', to_type: 2, send_time: 100, is_read: 0, ...overrides,
});
function incoming(socket, event) {
  const frame = encodeFrame(Cmd.dRecMsg, 1, event);
  socket.onmessage({ data: frame.buffer });
}
function receipt(socket, data) {
  // command13 的content是原始ID或错误说明，不经过普通消息的content取反编码。
  const payload = new TextEncoder().encode(JSON.stringify(data));
  const buffer = new ArrayBuffer(8 + payload.length);
  const bytes = new Uint8Array(buffer);
  bytes.set([5, Cmd.dSendMsg, 0, 1]);
  new DataView(buffer).setUint32(4, payload.length);
  bytes.set(payload, 8);
  socket.onmessage({ data: buffer });
}
function readFrames(socket) {
  return socket.sent.map(buffer => {
    const frame = decodeFrame(buffer);
    if (frame.data?.content !== undefined) {
      const content = decryptContent(frame.data.content);
      try { frame.data.content = JSON.parse(content); } catch { frame.data.content = content; }
    }
    return frame;
  });
}
function connect(store) {
  store.start();
  const socket = sockets.at(-1);
  socket.readyState = 1;
  socket.onopen();
  imClient.authed = true;
  store.authed = true;
  socket.sent.length = 0;
  return socket;
}

async function checkChatSetup(store) {
  const { parse, compileScript } = require('vue/compiler-sfc');
  const { renderToString } = require('vue/server-renderer');
  const filename = path.join(root, 'views/ChatView.vue');
  const descriptor = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor;
  const script = compileScript(descriptor, { id: 'offline-chat-smoke' }).content;
  const compiled = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'localStorage', compiled)(id => {
    if (external[id]) return external[id];
    if (id.endsWith('.vue')) return { default: { render: () => null } };
    assert.ok(id.startsWith('.'), '页面初始化未模拟的依赖：' + id);
    return load(path.resolve(path.dirname(filename), id + '.ts'));
  }, module, module.exports, localStorage);
  const component = module.exports.default;
  // 这里只验证真实 setup 初始化；消息DOM及Tauri窗口行为仍需桌面端验收。
  component.render = () => vue.h('div', '初始化通过');
  for (const sessionId of ['', 'group']) {
    store.currentSessionId = sessionId;
    const html = await renderToString(vue.createSSRApp(component));
    assert.match(html, /初始化通过/);
    await vue.nextTick();
  }
  console.log('真实ChatView setup：空会话与已有群聊初始化无TDZ异常（SSR冒烟，不验证桌面DOM）');
}

let activeStore;
async function main() {
  pinia.setActivePinia(pinia.createPinia());
  // 旧版 IM 数据：启动时应直接清理，不迁移、不读取。
  saved.set('yl.im.messages', JSON.stringify([{ msg_id: 'legacy-message', content: '旧消息' }]));
  saved.set('yl.im.unread', JSON.stringify({ group: 9 }));
  saved.set('yl.im.interactions.me', JSON.stringify({ reactions: {} }));
  saved.set('yl.im.interactions.other-account', JSON.stringify({ reactions: {} }));
  saved.set('yl.im.mentions.other-account', JSON.stringify({ list: [] }));
  const store = useImStore();
  activeStore = store;
  const socket = connect(store);
  await store.hydrate();
  assert.equal(saved.has('yl.im.messages'), false, '旧消息缓存直接清理，不做迁移');
  assert.equal(saved.has('yl.im.unread'), false, '旧未读缓存直接清理');
  assert.equal(saved.has('yl.im.interactions.me'), false, '旧交互缓存直接清理');
  assert.equal(saved.has('yl.im.interactions.other-account'), false, '其他账号的旧交互缓存也清理');
  assert.equal(saved.has('yl.im.mentions.other-account'), false, '其他账号的旧提醒缓存也清理');
  assert.equal(store.messages.some(item => item.msg_id === 'legacy-message'), false);
  const reaction = message({ msg_id: 'reaction', msg_type: MsgType.CTRL, send_time: 110,
    content: { cmd: 1000, params: { msgId: 'original', sourceMsgFromId: 'author', emoji: '[ok]' } } });
  incoming(socket, reaction);
  assert.equal(store.messages.length, 0, '回应先于原消息时，不产生普通消息气泡');
  assert.equal(store.unreadOf('group'), 0, '回应控制消息不计未读');
  assert.equal(store.reactionsFor('original')[0].emoji, '[ok]');
  incoming(socket, message({ at_user_ids: 'me' }));
  assert.equal(store.messages.length, 1);
  assert.equal(store.unreadOf('group'), 1);
  assert.equal(store.unreadAt.group, 1);
  assert.equal(store.reactionsFor('original').length, 1, '原消息到达后仍能展示先前回应');
  incoming(socket, reaction);
  assert.equal(store.reactionsFor('original').length, 1, '重复推送不重复展示回应');
  assert.equal(store.unreadOf('group'), 1);
  store.selectSession('group');
  incoming(socket, message({ msg_id: 'ack-target', from_id: 'me', from_name: '我', from_device: 'device', content: '等待确认的消息' }));
  const ackTarget = store.messages.find(item => item.msg_id === 'ack-target');
  const ackTime = Date.now() + 1000;
  store.toggleReaction(ackTarget, '[鼓掌]');
  let control = readFrames(socket).at(-1).data;
  assert.equal(store.interactionPending('ack-target'), true);
  assert.equal(store.reactionsFor('ack-target').length, 0, '收到服务端ack前不显示虚假的回应成功');
  receipt(socket, { success: true, content: control.msg_id, time: ackTime });
  assert.equal(store.interactionPending('ack-target'), false);
  assert.equal(store.reactionsFor('ack-target')[0].emoji, '[鼓掌]');
  store.toggleReaction(ackTarget, '[鼓掌]');
  control = readFrames(socket).at(-1).data;
  assert.equal(control.content.cmd, 1001);
  receipt(socket, { success: false, msg_id: control.msg_id, errorCode: 'denied', content: '测试拒绝取消' });
  assert.equal(store.interactionPending('ack-target'), false);
  assert.equal(store.reactionsFor('ack-target').length, 1, '取消失败后保留服务端已确认的回应');
  assert.equal(store.interactionErrors['ack-target'], '测试拒绝取消');
  store.toggleReaction(ackTarget, '[鼓掌]');
  control = readFrames(socket).at(-1).data;
  receipt(socket, { success: true, content: control.msg_id, time: ackTime + 1 });
  assert.equal(store.reactionsFor('ack-target').length, 0);
  store.recallMessage(ackTarget);
  control = readFrames(socket).at(-1).data;
  assert.equal(ackTarget.content, '等待确认的消息', '撤回ack前不能清空原文');
  receipt(socket, { success: true, content: control.msg_id, time: ackTime + 2 });
  assert.equal(ackTarget.content, '', '撤回成功ack应用目标状态');
  assert.equal(ackTarget.msg_type, MsgType.RECALL);
  console.log('真实store回执：原版13成功/失败形状、回应确认后展示、失败保留状态及撤回确认回归通过');
  incoming(socket, message({ msg_id: 'reply', content: '已确认', reply_msg_id: 'original', send_time: 120 }));
  const reply = store.messages.find(item => item.msg_id === 'reply');
  assert.equal(store.replySource(reply).content, '待确认的会议安排');
  assert.deepEqual(store.repliesFor('original').map(item => item.msg_id), ['reply']);
  incoming(socket, message({ msg_id: 'recall', msg_type: MsgType.RECALL, content: 'original', send_time: 130 }));
  const original = store.messages.find(item => item.msg_id === 'original');
  assert.equal(original.msg_type, MsgType.RECALL);
  assert.equal(original.content, '', '撤回后清除原文');
  assert.equal(store.replySource(reply).content, '', '引用摘要从更新后的原消息读取，不再显示已撤回原文');
  assert.equal(toPlainText(store.replySource(reply).msg_type, store.replySource(reply).content), '[消息已撤回]');
  assert.equal(store.reactionsFor('original').length, 0, '原消息撤回时清除回应');
  assert.equal(store.messages.some(item => item.msg_id === 'recall'), false, '撤回事件不产生独立气泡');
  console.log('真实store：控制消息与未读隔离、回应先到、撤回更新引用及回复聚合回归通过');

  incoming(socket, message({ msg_id: 'recall-before', msg_type: MsgType.ADMINRECALL, content: { msgId: 'late' }, send_time: 150 }));
  incoming(socket, message({ msg_id: 'late', content: '不应复活的原文', send_time: 140 }));
  assert.equal(store.messages.find(item => item.msg_id === 'late').msg_type, MsgType.ADMINRECALL);
  assert.equal(store.messages.find(item => item.msg_id === 'late').content, '');
  const normalized = normalizeImMessage({
    msgId: 'history-reply', msgType: 1, content: encryptContent('历史回复'), fromId: 'author', fromName: '发起人', fromType: 1,
    toId: 'group', toName: '测试群', toType: 2, sendTime: 50, replyMsgId: 'original', replyFromId: 'author',
    replyFromName: '发起人', replyMsgType: 1, replyContent: '历史引用摘要', atUserIds: 'me',
    isNeedReadReceipt: true, isDeleteAfterRead: false, isNeedSendRead: 1, isCountUnread: false,
  });
  assert.equal(normalized.content, '历史回复');
  assert.equal(normalized.reply_msg_id, 'original');
  assert.equal(normalized.reply_from_name, '发起人');
  assert.equal(normalized.reply_content, '历史引用摘要');
  assert.equal(normalized.is_need_read_receipt, true);
  assert.equal(normalized.is_delete_after_read, false);
  assert.equal(normalized.is_need_send_read, 1);
  assert.equal(normalized.is_count_unread, false);
  assert.equal(previewOf({ msgType: 1, content: encryptContent('受保护原文'), isNeedReadReceipt: true }), '[受保护消息]');
  historyRows = [
    { ...normalized, content: encryptContent('历史回复') },
    { msgId: 'late', msgType: 1, content: encryptContent('历史中的撤回前原文'), fromId: 'author', toId: 'group', toType: 2, sendTime: 40 },
  ];
  await store.loadHistory('group');
  assert.equal(store.messages.find(item => item.msg_id === 'history-reply').reply_msg_id, 'original');
  assert.equal(store.messages.find(item => item.msg_id === 'late').content, '', '历史补齐不会复活已撤回原文');
  console.log('真实历史归一与store合并：引用、@、阅读标志、受保护摘要及撤回状态回归通过');

  const beforeSend = store.messages.length;
  store.sendText('@发起人 已确认', ['author'], 'reply', { receipt: true });
  let sent = readFrames(socket).at(-1);
  assert.equal(sent.data.reply_msg_id, 'reply');
  assert.equal(sent.data.at_user_ids, 'author');
  assert.equal(sent.data.is_need_read_receipt, true);
  assert.equal(store.messages.length, beforeSend + 1);
  assert.equal(store.messages.at(-1).reply_msg_id, 'reply');
  const outgoing = store.messages.at(-1);
  receipt(socket, { success: false, msg_id: outgoing.msg_id, errorCode: 'not-allowed', content: '测试消息提交失败' });
  assert.equal(outgoing.__sent, false);
  assert.equal(outgoing.__error, '测试消息提交失败');
  store.retryMessage(outgoing);
  sent = readFrames(socket).at(-1);
  assert.equal(sent.data.msg_id, outgoing.msg_id, '重试复用原消息编号，避免产生重复消息');
  assert.equal(sent.data.is_resend, true);
  assert.equal(sent.data.reply_msg_id, 'reply');
  assert.equal(sent.data.at_user_ids, 'author');
  assert.equal(sent.data.__error, undefined, '本地错误标记不发送到服务端');
  assert.equal(outgoing.__error, undefined);
  receipt(socket, { success: true, content: outgoing.msg_id, time: ackTime + 3 });
  assert.equal(outgoing.__sent, true);
  assert.equal(outgoing.send_time, ackTime + 3, '成功回执使用服务端时间');
  await persist(store);
  assert.equal(stateOf('me', 'outbox', outgoing.msg_id), undefined, '确认成功后从 outbox 删除');
  socket.readyState = 3;
  let draft = 'store断线草稿';
  assert.throws(() => { store.sendText(draft, ['author'], 'original'); draft = ''; }, /连接已断开/);
  assert.equal(draft, 'store断线草稿');
  assert.equal(store.messages.length, beforeSend + 1, '底层断线后store不落入假发送消息');
  assert.equal(store.sending, false, '失败后释放发送状态');
  imClient.authed = false;
  assert.throws(() => store.sendText(draft), /长连接未就绪/);
  socket.readyState = 1;
  imClient.authed = true;
  console.log('真实store发送：结构化引用与@参数、断线抛错及草稿/发送状态保留回归通过');

  incoming(socket, message({ msg_id: 'need-confirm', is_need_read_receipt: true, send_time: 200 }));
  const messageCountBeforeRead = store.messages.length;
  store.confirmMessageRead(store.messages.find(item => item.msg_id === 'need-confirm'));
  sent = readFrames(socket).at(-1);
  assert.equal(sent.command, Cmd.uSendMsg);
  assert.equal(sent.data.msg_type, MsgType.READED);
  assert.equal(sent.data.content.readMsgIds, 'need-confirm');
  assert.equal(sent.data.content.cmd, 2);
  const readCommandId = sent.data.msg_id;
  assert.equal(store.localReadConfirmations['need-confirm'], undefined, '写入连接不能冒充阅读确认已送达');
  assert.equal(store.pendingReadCommands[readCommandId].__delivery.state, 'pending');
  assert.equal(store.messages.length, messageCountBeforeRead, '95命令不产生普通消息气泡');
  await persist(store);
  assert.equal(JSON.parse(stateOf('me', 'read_command', readCommandId)).content.readMsgIds, 'need-confirm', '确认前完整95命令持久化');
  const sentCount = socket.sent.length;
  store.confirmMessageRead(store.messages.find(item => item.msg_id === 'need-confirm'));
  assert.equal(socket.sent.length, sentCount, '等待确认时同一消息不重复发送阅读确认');
  receipt(socket, { success: false, msg_id: readCommandId, content: '测试拒绝阅读确认' });
  assert.equal(store.pendingReadCommands[readCommandId].__delivery.state, 'failed');
  assert.equal(store.localReadConfirmations['need-confirm'], undefined, '拒绝后不能保留伪成功阅读状态');
  assert.match(store.readConfirmationError('need-confirm'), /拒绝/);
  store.confirmMessageRead(store.messages.find(item => item.msg_id === 'need-confirm'));
  sent = readFrames(socket).at(-1);
  assert.equal(sent.data.msg_id, readCommandId, '阅读确认重试复用原命令编号');
  assert.equal(sent.data.is_resend, true);
  assert.equal(sent.data.content.cmd, 2);
  receipt(socket, { success: true, content: readCommandId, time: 201 });
  assert.equal(store.localReadConfirmations['need-confirm'], true);
  assert.equal(store.pendingReadCommands[readCommandId], undefined, '成功后移除可靠队列项');
  assert.equal(store.readConfirmationError('need-confirm'), '');
  const confirmedCount = socket.sent.length;
  store.confirmMessageRead(store.messages.find(item => item.msg_id === 'need-confirm'));
  assert.equal(socket.sent.length, confirmedCount, '已确认的消息不重新发送95命令');
  receipt(socket, { success: false, msg_id: readCommandId, content: '迟到的拒绝' });
  assert.equal(store.localReadConfirmations['need-confirm'], true, '迟到的失败不能推翻已确认阅读');

  incoming(socket, message({ msg_id: 'burn', is_delete_after_read: true, send_time: 210 }));
  store.confirmMessageRead(store.messages.find(item => item.msg_id === 'burn'));
  assert.equal(readFrames(socket).at(-1).data.content.cmd, 1, '阅后即焚确认使用95/cmd1');
  assert.ok(store.burnDeadlines.burn > Date.now(), '打开时记录阅后即焚截止时间');
  await persist(store);
  assert.equal(Number(stateOf('me', 'burn_deadline', 'burn')), store.burnDeadlines.burn, '焚毁截止时间持久化');
  const firstBurnDeadline = store.burnDeadlines.burn;
  const burnReadCommandId = readFrames(socket).at(-1).data.msg_id;
  receipt(socket, { success: false, msg_id: burnReadCommandId, content: '测试拒绝焚毁阅读确认' });
  store.confirmMessageRead(store.messages.find(item => item.msg_id === 'burn'));
  assert.equal(readFrames(socket).at(-1).data.msg_id, burnReadCommandId);
  assert.equal(store.burnDeadlines.burn, firstBurnDeadline, '重试阅读确认不能重新延长阅后即焚截止时间');
  incoming(socket, message({ msg_id: 'normal-read', is_need_send_read: 1, send_time: 220 }));
  incoming(socket, message({ msg_id: 'normal-string-read', is_need_send_read: 1, is_need_read_receipt: 'false', is_delete_after_read: 'false', send_time: 225 }));
  incoming(socket, message({ msg_id: 'other-group', to_id: 'group2', to_name: '另一群', is_need_send_read: 1, send_time: 230 }));
  socket.sent.length = 0;
  store.clearUnread('group');
  const frames = readFrames(socket);
  const sessionRead = frames.find(frame => frame.command === Cmd.uReadedSession);
  assert.deepEqual(sessionRead.data, { toId: 'group', toType: 2 }, '会话阅读命令使用实际会话类型');
  const singleReads = frames.filter(frame => frame.command === Cmd.uSendMsg && frame.data.msg_type === MsgType.READED);
  const normalRead = singleReads.find(frame => frame.data.content.readMsgIds === 'normal-read');
  assert.ok(normalRead);
  assert.equal(Object.hasOwn(normalRead.data.content, 'cmd'), false, '普通阅读确认不携带要求回执/焚毁指令');
  const stringRead = singleReads.find(frame => frame.data.content.readMsgIds === 'normal-string-read');
  assert.ok(stringRead, '字符串false阅读标记不能阻止普通95确认');
  assert.equal(Object.hasOwn(stringRead.data.content, 'cmd'), false);
  receipt(socket, { success: true, content: stringRead.data.msg_id, time: 226 });
  assert.equal(singleReads.some(frame => frame.data.content.readMsgIds === 'other-group'), false, '阅读当前群不能确认另一个群的消息');
  assert.equal(store.unreadOf('group'), 0);
  assert.equal(store.unreadOf('group2'), 1);
  assert.equal(store.localReadConfirmations['normal-read'], undefined, '自动阅读确认也需等待服务端确认');
  receipt(socket, { success: true, content: normalRead.data.msg_id, time: 221 });
  assert.equal(store.localReadConfirmations['normal-read'], true);
  await persist(store);
  assert.equal(stateOf('me', 'read_confirmation', 'normal-read'), '1', '成功阅读确认状态持久化');
  store.burnMessage('burn');
  assert.equal(store.currentMessages.some(item => item.msg_id === 'burn'), false, '焚毁后的消息从当前会话隐藏');
  assert.equal(store.messages.find(item => item.msg_id === 'burn').content, '');
  assert.equal(store.burnDeadlines.burn, undefined);
  console.log('真实store阅读：95可靠队列、拒绝/重试/成功、重复保护、阅后即焚、会话已读及跨会话隔离回归通过');

  incoming(socket, message({ msg_id: 'read-reconnect', is_need_read_receipt: true, send_time: 240 }));
  store.confirmMessageRead(store.messages.find(item => item.msg_id === 'read-reconnect'));
  const reconnectCommandId = readFrames(socket).at(-1).data.msg_id;
  incoming(socket, message({ msg_id: 'read-echo', is_need_read_receipt: true, send_time: 245 }));
  store.confirmMessageRead(store.messages.find(item => item.msg_id === 'read-echo'));
  const echoCommandId = readFrames(socket).at(-1).data.msg_id;
  incoming(socket, message({ msg_id: 'burn-restart', content: '重启前已打开的保护正文', is_delete_after_read: true, send_time: 250 }));
  store.confirmMessageRead(store.messages.find(item => item.msg_id === 'burn-restart'));
  const burnRestartCommandId = readFrames(socket).at(-1).data.msg_id;
  assert.ok(store.burnDeadlines['burn-restart'] > Date.now(), '模拟在30秒截止前重启');
  incoming(socket, message({ msg_id: 'burn-unopened', content: '尚未打开的保护正文', is_delete_after_read: true, send_time: 260 }));
  assert.equal(store.burnDeadlines['burn-unopened'], undefined);

  for (const [id, to, time] of [['cursor-own', 'peer', 300], ['cursor-future', 'peer', 600], ['cursor-other', 'peer2', 100]]) {
    incoming(socket, message({ msg_id: id, from_id: 'me', from_name: '我', from_device: 'device', to_id: to, to_type: 1, send_time: time }));
  }
  incoming(socket, message({ msg_id: 'read-cursor', msg_type: MsgType.READED, from_id: 'peer', from_name: '阅读者', to_id: 'me', to_type: 1, send_time: 700, content: { toId: 'me', toType: 1, lastSendTime: 500 } }));
  assert.equal(store.interactions.readers['cursor-own'].peer, '阅读者');
  assert.equal(store.interactions.readTimes['cursor-own'].peer, 700);
  assert.equal(store.interactions.readers['cursor-future'], undefined, '会话已读游标不能确认未来消息');
  assert.equal(store.interactions.readers['cursor-other'], undefined, '会话已读游标不能确认其他会话');
  incoming(socket, message({ msg_id: 'sender-burn', from_id: 'me', from_name: '我', from_device: 'device', to_id: 'peer', to_type: 1, is_delete_after_read: true, send_time: 800 }));
  incoming(socket, message({ msg_id: 'sender-burn-read', msg_type: MsgType.READED, from_id: 'peer', from_name: '阅读者', to_id: 'me', to_type: 1, send_time: 900, content: { cmd: 1, readMsgIds: 'sender-burn' } }));
  assert.equal(store.messages.find(item => item.msg_id === 'sender-burn').content, '', '发送方收到95/cmd1也销毁本机正文');
  assert.equal(store.interactions.readTimes['sender-burn'].peer, 900);
  socket.onclose({ code: 1006 });
  assert.equal(store.pendingReadCommands[reconnectCommandId].__delivery.state, 'queued', '真实连接关闭事件挂起未确认的95命令');
  assert.equal(store.pendingReadCommands[burnRestartCommandId].__delivery.state, 'queued');
  // 留一条未确认消息：即使滚出启动窗口，也要靠 outbox 恢复重发入口。
  socket.readyState = 1;
  imClient.authed = true;
  store.authed = true;
  store.selectSession('group');
  store.sendText('重启后仍未确认的消息');
  const pendingOut = store.messages.at(-1);
  await persist(store);
  store.stop();
  await persist(store);
  store.$dispose();
  pinia.setActivePinia(pinia.createPinia());
  const restored = useImStore();
  await restored.hydrate();
  activeStore = restored;
  assert.equal(restored.messages.find(item => item.msg_id === 'late').content, '', '重启后仍保留撤回状态');
  assert.equal(restored.unreadOf('group2'), 1, '未读数从 SQLite 恢复，不再依赖服务端重算');
  assert.equal(restored.messages.find(item => item.msg_id === pendingOut.msg_id)?.__delivery?.state, 'queued', '未确认消息从 outbox 恢复，重启后仍可重发');
  assert.equal(restored.localReadConfirmations['normal-read'], true);
  assert.equal(restored.messages.find(item => item.msg_id === 'burn-restart').content, '', '截止前重启也不能重新展示已打开的阅后即焚正文');
  assert.equal(restored.messages.find(item => item.msg_id === 'burn-unopened').content, '尚未打开的保护正文', '尚未打开的保护消息不误销毁');
  assert.equal(restored.pendingReadCommands[reconnectCommandId].__delivery.state, 'queued');
  assert.equal(restored.pendingReadCommands[burnRestartCommandId].__delivery.state, 'queued', '已销毁正文的95确认仍需可靠补发');
  assert.equal(restored.localReadConfirmations['read-reconnect'], undefined);
  const resumedSocket = connect(restored);
  const { __delivery: ignoredDelivery, __sent: ignoredSent, __error: ignoredError, ...echoCommand } = restored.pendingReadCommands[echoCommandId];
  incoming(resumedSocket, { ...echoCommand, from_id: 'another-reader', from_name: '其他阅读人', offline: true, send_time: 999 });
  assert.ok(restored.pendingReadCommands[echoCommandId], '其他人的95不能确认本机待发送命令');
  assert.equal(restored.localReadConfirmations['read-echo'], undefined);
  incoming(resumedSocket, { ...echoCommand, offline: true, send_time: 1000 });
  assert.equal(restored.localReadConfirmations['read-echo'], true, '收到本人95离线回显即确认服务端已接受');
  assert.equal(restored.pendingReadCommands[echoCommandId], undefined);
  await persist(restored);
  assert.equal(stateOf('me', 'read_command', echoCommandId), undefined, '本人95回显后从持久化待发送队列移除');
  assert.equal(stateOf('me', 'read_confirmation', 'read-echo'), '1');
  const offlineEnd = encodeFrame(Cmd.dEOFoffline, 0);
  resumedSocket.onmessage({ data: offlineEnd.buffer });
  const resumedReads = readFrames(resumedSocket).filter(frame => frame.command === Cmd.uSendMsg && frame.data?.msg_type === MsgType.READED);
  assert.equal(resumedReads.some(frame => frame.data.msg_id === echoCommandId), false, '已收到本人95回显的命令在离线同步结束后不再补发');
  assert.ok(resumedReads.some(frame => frame.data.msg_id === reconnectCommandId && frame.data.is_resend), '离线同步结束后恢复未确认的95命令');
  assert.ok(resumedReads.some(frame => frame.data.msg_id === burnRestartCommandId && frame.data.is_resend), '焚毁后重启仍补发原编号阅读确认');
  assert.equal(restored.messages.some(item => item.msg_type === MsgType.READED), false);
  receipt(resumedSocket, { success: true, content: reconnectCommandId, time: 1000 });
  receipt(resumedSocket, { success: true, content: burnRestartCommandId, time: 1001 });
  assert.equal(restored.localReadConfirmations['read-reconnect'], true);
  assert.equal(restored.pendingReadCommands[reconnectCommandId], undefined);
  assert.equal(restored.localReadConfirmations['burn-restart'], true);
  assert.equal(restored.pendingReadCommands[burnRestartCommandId], undefined);
  console.log('真实store重启：95待确认命令恢复、焚毁正文不复活、阅读游标与回执时间回归通过');
  await persist(restored);
  assert.ok([...database.messages.values()].some(row => row.accountId === 'me' && row.msgId === 'history-reply'), '消息按行写入 SQLite，不再整块写 localStorage');
  assert.ok(nativeCalls.some(call => call.command === 'set_tray_unread'));
  assert.ok(httpCalls.every(url => url.startsWith('https://')), '网络边界全部由模拟httpJson接管');
  await checkChatSetup(restored);
  restored.stop();
  restored.$dispose();
  await vue.nextTick();
  console.log('消息与交互状态持久化恢复回归通过（模拟网络和本机能力）');
}
main().catch(error => { console.error(error); activeStore?.stop(); activeStore?.$dispose(); imClient.close(); process.exitCode = 1; });
