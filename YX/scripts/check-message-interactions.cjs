// 在 YX/ 执行：node scripts/check-message-interactions.cjs。
// 运行真实消息状态逻辑、客户端和帧编解码，仅替换连接与账号依赖，不连接生产服务。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../node_modules/typescript');

const sourceRoot = path.resolve(__dirname, '../src/services/im');
const cache = new Map();
const sockets = [];
let uploadCalls = 0;
let afterUpload = () => {};
let currentUser = 'me';
let refreshHandler = async () => null;
class MockWebSocket {
  readyState = 0;
  sent = [];
  constructor(url) { this.url = url; sockets.push(this); }
  send(frame) {
    assert.equal(this.readyState, 1, '不能向未打开的连接写入消息');
    this.sent.push(frame);
  }
  close() { this.readyState = 3; }
}
const localStorage = { getItem: key => key === 'CurrentECode' ? '测试企业' : null };
const windowListeners = new Map();
const window = {
  addEventListener(type, handler) { windowListeners.set(type, handler); },
  removeEventListener(type, handler) { if (windowListeners.get(type) === handler) windowListeners.delete(type); },
};
const authService = {
  getCurrentUserId: () => currentUser,
  refreshToken: async () => refreshHandler(),
  refreshTokenResult: async () => {
    const token = await refreshHandler();
    return token ? { token } : {};
  },
  getCurrentUserName: () => '我',
  getDeviceId: () => 'test-device',
  getPlatform: () => 'mac',
  getAccessToken: () => 'offline-test-token',
};
const dependencies = {
  '../auth': { authService },
  '../config': {
    DEFAULT_CONFIG: { version: '5.2.97', embProtocolVersion: 2.4, heartbeatInterval: 60 },
    getServerPaths: () => ({ embWebSocketUri: 'wss://offline.invalid/im' }),
  },
  './media': {
    buildMediaContent: (fileName, size, downloadUrl) => ({ msgType: 3, content: { file_name: fileName, size, download_url: downloadUrl } }),
    uploadToStore: async (_file, onProgress) => { uploadCalls++; onProgress?.(100); await Promise.resolve(); afterUpload(); return 'offline-file-id'; },
  },
};
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', 'localStorage', 'WebSocket', 'window', code)(id => {
    if (dependencies[id]) return dependencies[id];
    assert.ok(id.startsWith('.'), '不允许加载未模拟的外部依赖：' + id);
    return load(path.resolve(path.dirname(file), id + '.ts'));
  }, module, module.exports, localStorage, MockWebSocket, window);
  return module.exports;
}
const { MsgType } = load(path.join(sourceRoot, 'types.ts'));
const { Cmd } = load(path.join(sourceRoot, 'cmd.ts'));
const { applyInteraction, emptyInteractions, mentionsUser, replyRoot } = load(path.join(sourceRoot, 'interactions.ts'));
const { encodeFrame, decodeFrame, decryptContent } = load(path.join(sourceRoot, 'protocol.ts'));
const { ImClient } = load(path.join(sourceRoot, 'im-client.ts'));

function message(overrides = {}) {
  return {
    msg_id: 'original', msg_type: MsgType.TEXT, content: '请确认会议安排',
    from_id: 'author', from_name: '发起人', from_type: 1,
    to_id: 'group', to_name: '测试群', to_type: 2, send_time: 10,
    ...overrides,
  };
}
function reaction(id, user, emoji, time, remove = false) {
  return message({
    msg_id: id, msg_type: MsgType.CTRL, from_id: user, from_name: '成员' + user, send_time: time,
    content: { cmd: remove ? 1001 : 1000, params: { msgId: 'original', sourceMsgFromId: 'author', emoji } },
  });
}
function activeReactions(state) {
  return state.reactions.original.filter(item => item.active).map(item => `${item.userId}:${item.emoji}`).sort();
}
const state = emptyInteractions();
const received = reaction('received', 'me', '[ok]', 20);
const applause = reaction('applause', 'me', '[鼓掌]', 21);
const another = reaction('another', 'other', '[ok]', 22);
for (const event of [received, applause, another]) assert.equal(applyInteraction(state, event), true);
assert.deepEqual(activeReactions(state), ['me:[ok]', 'me:[鼓掌]', 'other:[ok]']);
assert.equal(state.reactions.original.find(item => item.userId === 'other').name, '成员other', '保留回应人的姓名');
const cancel = reaction('cancel', 'me', '[ok]', 30, true);
applyInteraction(state, cancel);
assert.deepEqual(activeReactions(state), ['me:[鼓掌]', 'other:[ok]'], '取消自己的收到不能删除他人或其他表情');
const snapshot = JSON.stringify(state);
for (const event of [received, received, another, cancel, applause]) applyInteraction(state, event);
assert.equal(JSON.stringify(state), snapshot, '重放重复事件和旧回应不能复活已经取消的表情');
applyInteraction(state, reaction('re-add', 'me', '[ok]', 40));
assert.deepEqual(activeReactions(state), ['me:[ok]', 'me:[鼓掌]', 'other:[ok]'], '更新的事件可重新添加回应');
const reverse = emptyInteractions();
for (const event of [cancel, another, applause, received]) applyInteraction(reverse, event);
assert.deepEqual(activeReactions(reverse), ['me:[鼓掌]', 'other:[ok]'], '取消先抵达时，旧添加事件不能重新激活');
assert.equal(applyInteraction(state, message()), false, '普通消息不应被当作控制消息吞掉');
assert.equal(applyInteraction(state, message({ msg_type: MsgType.CTRL, content: { cmd: 12345 } })), false, '未知指令留给其他消息处理逻辑');
console.log('多人、多表情回应、取消、重复与乱序事件回归通过');

const recalls = emptyInteractions();
const normalRecall = message({ msg_id: 'recall', msg_type: MsgType.RECALL, content: 'original', send_time: 50 });
assert.equal(applyInteraction(recalls, normalRecall), true);
assert.deepEqual(recalls.recalls.original, { type: MsgType.RECALL, time: 50, hidden: false }, '原消息尚未出现时仍保存撤回状态');
assert.equal(applyInteraction(recalls, message()), false);
assert.equal(recalls.recalls.original.type, MsgType.RECALL, '后来收到原消息不丢弃已知撤回');
const adminRecall = message({ msg_id: 'admin-recall', msg_type: MsgType.ADMINRECALL, content: { msgId: 'original' }, send_time: 60 });
assert.equal(applyInteraction(recalls, adminRecall), true);
applyInteraction(recalls, normalRecall);
assert.deepEqual(recalls.recalls.original, { type: MsgType.ADMINRECALL, time: 60, hidden: false }, '旧撤回不能覆盖新的管理员撤回');
applyInteraction(recalls, message({ msg_type: MsgType.CTRL, send_time: 70, content: { cmd: '99', params: { msgIds: 'original,second' }, traceless: 'true' } }));
assert.equal(recalls.recalls.original.hidden, true);
assert.equal(recalls.recalls.second.hidden, true, 'CTRL99 支持多个目标及字符串 traceless 标记');
applyInteraction(recalls, message({ msg_type: MsgType.CTRL, send_time: 80, content: { cmd: 99, params: { msgIds: 'third' }, traceless: false } }));
assert.equal(recalls.recalls.third.hidden, false, '普通 CTRL99 撤回保留提示');
assert.equal(applyInteraction(recalls, message({ msg_type: MsgType.ADMINRECALL, content: {} })), false, '缺少目标的撤回不能修改其他消息');
console.log('撤回先于原消息、管理员撤回、CTRL99 和旧事件保护回归通过');

const readState = emptyInteractions();
const read = message({ msg_type: MsgType.READED, from_id: 'reader', from_name: '阅读者', content: { readMsgIds: 'original,second' } });
assert.equal(applyInteraction(readState, read), true);
applyInteraction(readState, read);
assert.deepEqual(readState.readers, { original: { reader: '阅读者' }, second: { reader: '阅读者' } }, '重复95回执不重复计数');
assert.equal(readState.readTimes.original.reader, read.send_time, '保存单条阅读确认的时间');
applyInteraction(readState, message({ ...read, send_time: read.send_time - 1 }));
assert.equal(readState.readTimes.original.reader, read.send_time, '迟到旧回执不能倒退已知阅读时间');
applyInteraction(readState, message({ ...read, from_id: 'reader2', from_name: '', content: { readMsgIds: 'original' } }));
assert.equal(Object.keys(readState.readers.original).length, 2);
assert.equal(readState.readers.original.reader2, 'reader2', '姓名缺失时保留阅读人标识');
for (const ids of ['x, me ,y', ['x', 'me'], 'ALL', ['ALL']]) assert.equal(mentionsUser(message({ at_user_ids: ids }), 'me'), true);
for (const ids of ['someone-me', 'me2', '', []]) assert.equal(mentionsUser(message({ at_user_ids: ids }), 'me'), false, '不能按子串误判@目标');
assert.equal(mentionsUser(message({ at_user_ids: 'ALL' }), ''), false, '尚未确认自己的身份时不判定@我');
const chain = [message({ msg_id: 'root' }), message({ msg_id: 'child', reply_msg_id: 'root' }), message({ msg_id: 'grandchild', reply_msg_id: 'child' })];
assert.equal(replyRoot('grandchild', chain), 'root');
assert.equal(replyRoot('root', chain), 'root');
assert.equal(replyRoot('missing', chain), 'missing');
assert.equal(replyRoot('child', [chain[1]]), 'root', '原消息尚未加载时保留引用目标编号');
assert.ok(['a', 'b'].includes(replyRoot('a', [message({ msg_id: 'a', reply_msg_id: 'b' }), message({ msg_id: 'b', reply_msg_id: 'a' })])), '循环引用应有限结束');
assert.equal(replyRoot('self', [message({ msg_id: 'self', reply_msg_id: 'self' })]), 'self');
const ownReadState = emptyInteractions();
applyInteraction(ownReadState, message({ msg_type: MsgType.READED, from_id: 'me', from_name: '我', content: { readMsgIds: 'original' } }), 'me');
assert.deepEqual(ownReadState.readers, {}, '自己的已读回执不能算作他人已读');
applyInteraction(ownReadState, message({ msg_type: MsgType.READED, from_id: 'reader', from_name: '阅读者', content: { readMsgIds: 'original' } }), 'me');
assert.deepEqual(ownReadState.readers, { original: { reader: '阅读者' } }, '只记录对方的阅读确认');
console.log('@目标精确匹配、95回执去重、引用链和循环防护回归通过');

function lastSent(socket) {
  const frame = decodeFrame(socket.sent.at(-1));
  assert.equal(frame.command, Cmd.uSendMsg);
  assert.equal(frame.operation, 1, '消息负载标记位是 byte3');
  assert.equal(frame.number, 0);
  const content = decryptContent(frame.data.content);
  return { ...frame.data, content: [MsgType.TEXT, MsgType.RECALL].includes(Number(frame.data.msg_type)) ? content : JSON.parse(content) };
}
async function checkClient() {
  const client = new ImClient();
  const events = [];
  client.on(event => events.push(event));
  await client.init();
  const socket = sockets.at(-1);
  assert.equal(socket.url, 'wss://offline.invalid/im');
  socket.readyState = 1;
  socket.onopen();
  assert.equal(decodeFrame(socket.sent[0]).command, Cmd.uAuth);
  client.authed = true;
  const target = message();
  const session = { id: 'group', name: '测试群', type: 2 };
  const text = client.sendText('group', '测试群', 2, '@发起人 已确认', target.msg_id, ['author', 'author', 'other']);
  let sent = lastSent(socket);
  assert.equal(sent.content, '@发起人 已确认');
  assert.equal(sent.reply_msg_id, 'original');
  assert.equal(sent.at_user_ids, 'author,other', '引用回复保留真正的@身份并去重');
  assert.equal(text.content, '@发起人 已确认', '编码不得原地改写本地消息内容');
  assert.equal(text.from_id, 'me');
  assert.equal(text.from_device, 'test-device');
  client.sendText('author', '发起人', 1, '单聊');
  assert.equal(lastSent(socket).is_need_send_read, 1, '普通单聊请求单条已读通知');
  client.sendText('group', '测试群', 2, '请回执', undefined, [], { receipt: true });
  assert.equal(lastSent(socket).is_need_read_receipt, true);
  assert.equal(lastSent(socket).is_need_send_read, 0);
  client.sendText('author', '发起人', 1, '阅后即焚', undefined, [], { deleteAfterRead: true });
  assert.equal(lastSent(socket).is_delete_after_read, true);
  assert.equal(lastSent(socket).is_need_send_read, 0);
  for (const remove of [false, true]) {
    client.sendReaction(target, session, '[ok]', remove);
    sent = lastSent(socket);
    assert.equal(sent.msg_type, MsgType.CTRL);
    assert.equal(sent.protocol_version_since, 2.4);
    assert.equal(sent.is_count_unread, false);
    assert.deepEqual(sent.content, { cmd: remove ? 1001 : 1000, params: { emoji: '[ok]', msgId: 'original', sourceMsgFromId: 'author' } });
    socket.onmessage({ data: socket.sent.at(-1) });
    assert.equal(events.at(-1).type, 'message', '收到的CTRL消息必须交给状态处理器');
    assert.deepEqual(events.at(-1).data.content, sent.content, '真实接收链路解码CTRL内容');
  }
  client.sendRecall(target, session);
  sent = lastSent(socket);
  assert.equal(sent.msg_type, MsgType.RECALL);
  assert.equal(sent.content, 'original', '普通撤回content是原消息编号字符串');
  client.sendRecall(target, session, true);
  sent = lastSent(socket);
  assert.equal(sent.msg_type, MsgType.ADMINRECALL);
  assert.deepEqual(sent.content, { msgId: 'original' }, '管理员撤回content是对象');
  client.sendMessageRead(target, session);
  sent = lastSent(socket);
  assert.equal(sent.msg_type, MsgType.READED);
  assert.equal(sent.to_id, 'author');
  assert.equal(sent.to_type, 1);
  assert.equal(sent.content.readMsgIds, 'original');
  assert.equal(sent.content.toId, 'group');
  assert.equal(sent.is_count_unread, false);
  assert.equal(Object.hasOwn(sent.content, 'cmd'), false, '普通阅读确认不携带要求回执/焚毁指令');
  client.sendMessageRead(target, session, 2);
  assert.equal(lastSent(socket).content.cmd, 2, '要求回执使用95/cmd2');
  client.sendMessageRead(target, session, 1);
  assert.equal(lastSent(socket).content.cmd, 1);
  // 使用真实帧编解码向客户端投递另一人的回应，而不是直接调用状态辅助函数。
  const incoming = encodeFrame(Cmd.dRecMsg, 1, reaction('remote', 'other', '[ok]', 100));
  socket.onmessage({ data: incoming.buffer });
  assert.equal(events.at(-1).data.from_id, 'other');
  assert.equal(events.at(-1).data.content.params.emoji, '[ok]');

  const file = { name: '会议安排.pdf', size: 42 };
  const progress = [];
  await client.sendMedia(file, 'group', '测试群', 2, value => progress.push(value), 'original');
  sent = lastSent(socket);
  assert.equal(sent.msg_type, MsgType.FILE);
  assert.equal(sent.reply_msg_id, 'original', '附件回复携带结构化引用编号');
  assert.equal(sent.content.file_name, file.name);
  assert.equal(sent.content.download_url, 'offline-file-id');
  assert.deepEqual([...new Set(progress)], [100], '上传进度与缓存完成通知都必须正确到达100%');
  const beforeFailedMedia = socket.sent.length;
  afterUpload = () => { socket.readyState = 3; };
  const interruptedFile = { ...file, name: '上传后断线.pdf' };
  await assert.rejects(client.sendMedia(interruptedFile, 'group', '测试群', 2, undefined, 'original'), /连接已断开/,
    '上传完成时连接已断开，必须抛错而不能报告附件发送成功');
  assert.equal(uploadCalls, 2);
  assert.equal(socket.sent.length, beforeFailedMedia, '上传成功但连接断开时不写入虚假的附件消息帧');
  afterUpload = () => {};
  socket.readyState = 1;
  await client.sendMedia(interruptedFile, 'group', '测试群', 2, undefined, 'original');
  assert.equal(uploadCalls, 2, '上传后写入连接失败的附件重试必须复用上传结果，不能重复上传');
  assert.equal(lastSent(socket).reply_msg_id, 'original');

  const beforeClearedMedia = socket.sent.length;
  const beforeClearedUploads = uploadCalls;
  afterUpload = () => client.clearSession();
  const clearedFile = { ...file, name: '上传完成时已退出.pdf' };
  await assert.rejects(client.sendMedia(clearedFile, 'group', '测试群', 2), /会话已变化/,
    '上传完成期间clearSession必须阻止旧附件进入新会话');
  assert.equal(socket.sent.length, beforeClearedMedia);
  afterUpload = () => {};
  await client.sendMedia(clearedFile, 'group', '测试群', 2);
  assert.equal(uploadCalls, beforeClearedUploads + 2, '退出期间的旧上传结果不能污染新会话上传缓存');
  client.clearSession();
  await client.sendMedia(clearedFile, 'group', '测试群', 2);
  assert.equal(uploadCalls, beforeClearedUploads + 3, 'clearSession必须清除同一File对象的已上传缓存');
  const beforeChangedAccount = socket.sent.length;
  afterUpload = () => { currentUser = 'another-account'; };
  await assert.rejects(client.sendMedia({ ...file, name: '上传完成时换号.pdf' }, 'group', '测试群', 2), /会话已变化/);
  assert.equal(socket.sent.length, beforeChangedAccount);
  afterUpload = () => {}; currentUser = 'me'; client.clearSession();

  socket.readyState = 3;
  const count = socket.sent.length;
  let draft = '断线时保留的草稿';
  assert.throws(() => { client.sendText('group', '测试群', 2, draft, 'original', ['author']); draft = ''; }, /连接已断开/);
  assert.equal(draft, '断线时保留的草稿', '发送抛错后调用方没有执行清空草稿');
  assert.throws(() => client.sendReaction(target, session, '[ok]', false), /连接已断开/);
  assert.throws(() => client.sendRecall(target, session), /连接已断开/);
  assert.throws(() => client.sendMessageRead(target, session), /连接已断开/);
  assert.equal(socket.sent.length, count, '失败操作不能产生伪成功帧');
  socket.readyState = 1;
  client.authed = false;
  assert.throws(() => client.sendText('group', '测试群', 2, '未鉴权'), /连接已断开/);
  assert.equal(socket.sent.length, count, '连接已开但未鉴权时不能发送业务消息');
  client.close();
  console.log('真实客户端文本/附件引用、@身份、回应控制帧、撤回类型、阅读确认及上传后断线失败回归通过（模拟连接）');
  console.log('附件上传生命周期：退出/换号阻止旧发送，退出清除缓存且断线重试仍可复用当前会话缓存回归通过');
  await checkRefreshLifecycle();
}

function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve));
async function checkRefreshLifecycle() {
  const client = new ImClient(), events = [];
  client.on(event => events.push(event));
  await client.init();
  let socket = sockets.at(-1);
  socket.readyState = 1; socket.onopen(); client.authed = true;
  const refresh = deferred(); refreshHandler = () => refresh.promise;
  const request = encodeFrame(Cmd.dRefreshToken, 0);
  socket.onmessage({ data: request.buffer });
  client.clearSession();
  await client.init();
  socket = sockets.at(-1); socket.readyState = 1; socket.onopen(); client.authed = true;
  const count = sockets.length;
  refresh.resolve(null);
  await flushMicrotasks();
  assert.equal(events.some(event => event.type === 'need_login'), false, '旧会话刷新失败不能踢掉新会话');
  assert.equal(sockets.length, count);
  assert.equal(socket.readyState, 1);

  const refreshed = deferred(); refreshHandler = () => refreshed.promise;
  socket.onmessage({ data: request.buffer });
  refreshed.resolve('offline-refreshed-token');
  // dRefreshToken 按原版延迟 1s 入队刷新；刷新成功后在同一连接上重新鉴权。
  await new Promise(resolve => setTimeout(resolve, 1100));
  await flushMicrotasks();
  assert.equal(socket.readyState, 1, '刷新成功后不关闭当前连接');
  assert.equal(decodeFrame(socket.sent.at(-1)).command, Cmd.uAuth, '刷新成功后发送鉴权帧');
  client.clearSession();
  await client.init();
  const newSocket = sockets.at(-1); newSocket.readyState = 1; newSocket.onopen(); client.authed = true;
  const newCount = sockets.length;
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(sockets.length, newCount, '刷新后重新鉴权不得另建连接');
  assert.equal(newSocket.readyState, 1, '旧刷新定时器不得关闭新会话socket');
  client.close(); refreshHandler = async () => null;
  console.log('99刷新生命周期：迟到失败不踢新会话，成功后原连接重新鉴权且不误建/误关连接回归通过');
}

checkClient().catch(error => { console.error(error); process.exitCode = 1; });
