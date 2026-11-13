// 离线回归：真实投递状态机与提醒中心，假时钟、真实 Vue/Pinia；不访问生产服务。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const vue = require('vue');
const pinia = require('pinia');
const root = path.resolve(__dirname, '../src');
const cache = new Map();
const timers = new Map();
let now = 1000, timerId = 0, account = 'me';
const saved = new Map();
const localStorage = {
  getItem: key => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, String(value)),
  removeItem: key => saved.delete(key),
};
class FakeDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
function setTimeoutMock(callback, delay) {
  const id = ++timerId;
  timers.set(id, {callback, time: now + Number(delay || 0)});
  return id;
}
function tick(milliseconds) {
  const target = now + milliseconds;
  let iterations = 0;
  for (;;) {
    const next = [...timers].filter(([, timer]) => timer.time <= target).sort((a, b) => a[1].time - b[1].time || a[0] - b[0])[0];
    if (!next) break;
    assert.ok(++iterations < 1000, '计时器不应形成无限循环');
    timers.delete(next[0]);
    now = next[1].time;
    next[1].callback();
  }
  now = target;
}
const external = {vue, pinia};
const mocks = new Map([
  [path.join(root, 'services/auth.ts'), {authService: {getCurrentUserId: () => account}}],
]);
function load(file) {
  if (mocks.has(file)) return mocks.get(file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = {exports: {}};
  cache.set(file, module);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8').replace(/import\.meta\.glob/g, '__assetGlob'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  new Function('require', 'module', 'exports', 'localStorage', 'Date', 'setTimeout', 'clearTimeout', '__assetGlob', source)(id => {
    if (external[id]) return external[id];
    assert.ok(id.startsWith('.'), '不允许未模拟的外部依赖：' + id);
    return load(path.resolve(path.dirname(file), id + '.ts'));
  }, module, module.exports, localStorage, FakeDate, setTimeoutMock, id => timers.delete(id), () => ({}));
  return module.exports;
}
const {MessageDelivery} = load(path.join(root, 'services/im/delivery.ts'));
const {useMentionsStore} = load(path.join(root, 'stores/mentions.ts'));
const message = (overrides = {}) => ({
  msg_id: 'message', msg_type: 1, content: '请确认安排', from_id: 'author', from_name: '发起人',
  from_type: 1, to_id: 'group', to_name: '测试群', to_type: 2, send_time: now, at_user_ids: 'me', is_read: 0, ...overrides,
});
function deliveryHarness() {
  let connected = true, throws = false;
  const writes = [], snapshots = [], confirmations = [];
  const delivery = new MessageDelivery({
    connected: () => connected,
    resend: item => {if (throws) throw new Error('模拟写入断线'); writes.push(item.msg_id);},
    changed: () => snapshots.push(now), confirmed: item => confirmations.push(item.msg_id),
  });
  return {delivery, writes, snapshots, confirmations, online: value => {connected = value;}, throws: value => {throws = value;}};
}
function checkDelivery() {
  let test = deliveryHarness(), item = message({msg_id: 'timeout'});
  test.delivery.track(item);
  assert.equal(item.__delivery.state, 'pending');
  assert.equal(item.__delivery.attempts, 1);
  tick(14999);
  assert.deepEqual(test.writes, []);
  tick(1);
  assert.deepEqual(test.writes, ['timeout']);
  tick(15000);
  assert.deepEqual(test.writes, ['timeout', 'timeout']);
  tick(15000);
  assert.equal(item.__delivery.state, 'failed');
  assert.equal(item.__delivery.attempts, 3);
  assert.match(item.__error, /超时/);
  tick(60000);
  assert.equal(test.writes.length, 2, '初次外部发送加自动重发，合计最多三次');
  assert.equal(test.delivery.acknowledge('timeout', true), true, '确认超时后的迟到成功必须仍可修正状态');
  assert.equal(item.__delivery.state, 'confirmed');
  assert.equal(item.__sent, true);
  assert.equal(item.__error, undefined);
  assert.deepEqual(test.confirmations, ['timeout']);
  test.delivery.acknowledge('timeout', true);
  assert.deepEqual(test.confirmations, ['timeout'], '重复成功回执不能重复触发确认副作用');
  test.delivery.acknowledge('timeout', false, '旧尝试失败');
  assert.equal(item.__delivery.state, 'confirmed', '成功后迟到的旧失败回执不能回退状态');
  test.delivery.dispose();

  test = deliveryHarness(); item = message({msg_id: 'rejected'});
  test.delivery.track(item);
  assert.equal(test.delivery.acknowledge(item.msg_id, false, '群内已禁言'), true);
  tick(120000);
  assert.equal(item.__delivery.state, 'failed');
  assert.equal(item.__error, '群内已禁言');
  assert.deepEqual(test.writes, [], '服务端明确拒绝不应自动重发');
  test.delivery.retry(item);
  assert.deepEqual(test.writes, ['rejected']);
  assert.throws(() => test.delivery.retry(item), /等待确认|重复/);
  assert.equal(test.writes.length, 1, '重复手动点击不得多发');
  test.delivery.acknowledge(item.msg_id, true);
  assert.equal(item.__delivery.state, 'confirmed');
  test.delivery.dispose();

  test = deliveryHarness(); item = message({msg_id: 'offline'});
  test.delivery.track(item);
  test.online(false); test.delivery.suspend();
  assert.equal(item.__delivery.state, 'queued');
  tick(90000);
  assert.deepEqual(test.writes, []);
  test.online(true); test.delivery.resume();
  assert.deepEqual(test.writes, ['offline']);
  assert.equal(item.__delivery.attempts, 2);
  test.delivery.resume();
  assert.equal(test.writes.length, 1, '重复重连事件不能重复重发等待确认的消息');
  test.delivery.acknowledge(item.msg_id, true);
  test.delivery.dispose();

  test = deliveryHarness();
  const pending = message({msg_id: 'restored', __delivery: {state: 'pending', attempts: 2, updatedAt: now - 1000}});
  const confirmed = message({msg_id: 'confirmed', __sent: true, __delivery: {state: 'confirmed', attempts: 1, updatedAt: now}});
  const rejected = message({msg_id: 'failed', __delivery: {state: 'failed', attempts: 1, updatedAt: now}});
  const restored = JSON.parse(JSON.stringify([pending, confirmed, rejected]));
  test.delivery.restore(restored);
  assert.equal(restored[0].__delivery.state, 'queued');
  test.delivery.resume();
  assert.deepEqual(test.writes, ['restored'], '恢复队列只重发未确认项，不重发已确认或明确失败项');
  assert.equal(restored[0].__delivery.attempts, 3, '重启不能重置已消耗重试次数');
  tick(15000);
  assert.equal(restored[0].__delivery.state, 'failed');
  assert.equal(test.delivery.acknowledge('failed', true), true, '恢复的失败项也应能接受迟到成功');
  assert.equal(restored[2].__delivery.state, 'confirmed');
  test.delivery.dispose();

  test = deliveryHarness(); item = message({msg_id: 'write-failure'});
  test.throws(true); test.delivery.retry(item);
  assert.equal(item.__delivery.state, 'queued');
  assert.deepEqual(test.writes, []);
  test.throws(false); test.delivery.resume();
  assert.deepEqual(test.writes, ['write-failure']);
  test.delivery.dispose();
  assert.equal(timers.size, 0, '释放队列必须清理计时器');
  console.log('投递状态机：确认超时、原ID限次重发、拒绝/断线/重连、持久化恢复、重复重试与迟到成功回归通过');
}
function checkMentions() {
  pinia.setActivePinia(pinia.createPinia());
  const mentions = useMentionsStore();
  const session = {id: 'group', name: '测试群', type: 2};
  const original = message({msg_id: 'notice'});
  mentions.observe(original, session);
  assert.equal(mentions.pending.length, 1);
  mentions.observe({...original, is_read: 1}, session, true);
  assert.equal(mentions.pending.length, 1, '会话已读或历史已读标志不能清除待处理提醒');
  mentions.handle('notice', 'received');
  assert.equal(mentions.pending.length, 0);
  assert.equal(mentions.notices.notice.handledBy, 'received');
  mentions.observe(original, session);
  assert.equal(mentions.pending.length, 0, '重复消息不能复活已处理提醒');
  mentions.reopen('notice');
  assert.equal(mentions.pending.length, 1);
  assert.equal(mentions.notices.notice.handledBy, undefined);
  mentions.handle('notice', 'reply');
  assert.equal(mentions.notices.notice.handledBy, 'reply');
  mentions.observe(message({msg_id: 'historical-read', is_read: 1}), session, true);
  assert.equal(mentions.notices['historical-read'], undefined, '已读历史不应凭空新增待处理提醒');
  mentions.observe(message({msg_id: 'historical-unread', is_read: 0}), session, true);
  assert.ok(mentions.notices['historical-unread']);
  mentions.observe(message({msg_id: 'not-for-me', at_user_ids: 'someone'}), session);
  mentions.observe(message({msg_id: 'my-own', from_id: 'me'}), session);
  assert.equal(mentions.notices['not-for-me'], undefined);
  assert.equal(mentions.notices['my-own'], undefined);
  const secret = '不能持久化的秘密正文';
  mentions.observe(message({msg_id: 'protected', content: secret, is_delete_after_read: true}), session);
  mentions.observe(message({msg_id: 'receipt-protected', content: secret, is_need_read_receipt: 'true'}), session);
  assert.equal(mentions.notices.protected.preview, '[受保护消息]');
  assert.equal(mentions.notices['receipt-protected'].preview, '[受保护消息]');
  assert.ok(![...saved.values()].join('').includes(secret));
  mentions.remove('historical-unread');
  assert.equal(mentions.notices['historical-unread'], undefined);
  mentions.observe(message({msg_id: 'historical-unread', is_read: 0}), session, true);
  assert.equal(mentions.notices['historical-unread'], undefined, '撤回删除后的旧历史不得重新新增提醒');
  const previousIds = Object.keys(mentions.notices);
  account = 'another'; mentions.ensureAccount();
  assert.deepEqual(Object.keys(mentions.notices), []);
  mentions.observe(message({msg_id: 'another-notice', at_user_ids: 'another'}), session);
  assert.equal(mentions.pending.length, 1);
  account = 'me'; mentions.ensureAccount();
  assert.deepEqual(Object.keys(mentions.notices), previousIds);
  assert.equal(mentions.notices['another-notice'], undefined);
  pinia.setActivePinia(pinia.createPinia());
  const restored = useMentionsStore();
  assert.equal(restored.notices.notice.status, 'done', '处理状态应跨重启保留');
  assert.equal(restored.notices.protected.preview, '[受保护消息]');
  console.log('提醒中心：未读独立、处理/重新待办/撤回去重、历史过滤、保护正文与账号隔离回归通过');
}
checkDelivery();
checkMentions();
