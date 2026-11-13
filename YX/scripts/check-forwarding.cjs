// 离线回归：真实转发信封、拆批、缓存补全及 MessageContent setup；不访问生产。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const vue = require('vue');
const root = path.resolve(__dirname, '../src');
const cache = new Map();
const source = file => ts.transpileModule(fs.readFileSync(file, 'utf8').replace(/import\.meta\.glob/g, '__assetGlob'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
const mocks = new Map([
  [path.join(root, 'services/im/official-face.ts'), {faceTextHtml: value => value, appendFaceText() {}}],
  [path.join(root, 'services/auth.ts'), {authService: {getCurrentUserId: () => 'me'}}],
  [path.join(root, 'stores/downloads.ts'), {useDownloadsStore: () => ({start: async () => {throw new Error('本回归不得下载文件');}})}],
  [path.join(root, 'stores/im.ts'), {useImStore: () => ({loadForwardDetails: async () => {throw new Error('本回归不得请求远端详情');}})}],
  [path.join(root, 'services/im/media.ts'), {canPreviewFile: () => false, filePreviewUrl: async () => '', fileUrl: () => ''}],
  [path.join(root, 'services/im/todo.ts'), {openTodoInBrowser: async () => {}, resolveTodoNotice: async () => '', todoTarget: () => null, todoUrl: () => ''}],
]);
const external = {
  vue, 'vue-router': {useRouter: () => ({push() {}})}, '@tauri-apps/plugin-opener': {openUrl: async () => {}},
};
function requireFrom(file, id) {
  if (external[id]) return external[id];
  if (id.endsWith('.vue')) return {default: {render: () => null}};
  assert.ok(id.startsWith('.'), '禁止未经模拟的外部依赖：' + id);
  return load(path.resolve(path.dirname(file), id + '.ts'));
}
function load(file) {
  if (mocks.has(file)) return mocks.get(file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = {exports: {}};
  cache.set(file, module);
  new Function('require', 'module', 'exports', '__assetGlob', source(file))(id => requireFrom(file, id), module, module.exports, () => ({}));
  return module.exports;
}
const {forwardEnvelope, splitForwardBatches, hydrateForwardContent} = load(path.join(root, 'services/im/forwarding.ts'));
const {combineDetails} = load(path.join(root, 'services/im/content.ts'));
const message = (id, overrides = {}) => ({
  msg_id: id, msg_type: 1, from_id: 'author', from_name: '发送人', from_type: 1,
  to_id: 'group', to_name: '测试群', to_type: 2, send_time: 100, content: '正文' + id, ...overrides,
});
const old = message('old', {send_time: 10, __delivery: {state: 'failed', attempts: 3}, __sent: false, __error: '本机错误', sessionId: 'local-session'});
const recent = message('recent', {send_time: 30});
const quoted = message('quote', {send_time: 20, reply_msg_id: 'old'});
const envelope = forwardEnvelope([recent, old, quoted], [old]);
assert.deepEqual(envelope.msgs.map(item => item.msg_id), ['old', 'quote', 'recent']);
assert.equal(envelope.from_name, old.from_name);
assert.equal(envelope.to_name, old.to_name);
for (const item of envelope.msgs) {
  for (const field of ['__delivery', '__sent', '__error', 'sessionId', 'sessionType']) assert.equal(item[field], undefined, '转发不得携带本机字段：' + field);
}
const quote = envelope.msgs[1];
assert.equal(quote.reply_msg_id, 'old');
assert.equal(quote.reply_from_id, old.from_id);
assert.equal(quote.reply_from_name, old.from_name);
assert.equal(quote.reply_msg_type, 1);
assert.equal(quote.reply_content, old.content);
const protectedSource = message('secret', {content: '保密原文', is_need_read_receipt: true});
const protectedReply = message('safe-reply', {reply_msg_id: 'secret'});
const protectedEnvelope = forwardEnvelope([protectedReply], [protectedSource]);
assert.equal(protectedEnvelope.msgs[0].reply_content, '[受保护消息]');
assert.ok(!JSON.stringify(protectedEnvelope).includes('保密原文'));
console.log('转发时间顺序、消息身份、去本机状态与普通/保护引用快照回归通过');

const attachment = message('file', {msg_type: 3, content: {download_url: 'file-key', file_name: '预算.xlsx', size: 1024}, __delivery: {state: 'pending'}, __error: '本机失败'});
const nested = message('nested', {msg_type: 24, content: {brief: '[聊天记录]', msgs: [attachment]}});
const nestedEnvelope = forwardEnvelope([nested]);
assert.deepEqual(nestedEnvelope.msgs[0].content.msgs[0].content, attachment.content, '嵌套附件存储标识、名称与大小必须完整保留');
assert.equal(nestedEnvelope.msgs[0].content.msgs[0].__delivery, undefined, '嵌套明细不得泄露本机投递状态');
assert.equal(nestedEnvelope.msgs[0].content.msgs[0].__error, undefined);
assert.ok(attachment.__delivery, '清理转发副本不得改动本机原消息');
const nestedQuote = message('nested-quote', {reply_msg_id: 'nested'});
const quotedNested = forwardEnvelope([nestedQuote], [nested]);
assert.equal(quotedNested.msgs[0].reply_content.msgs[0].__delivery, undefined, '合并记录引用快照同样清理本机字段');
for (const type of [66, 67]) assert.throws(() => forwardEnvelope([message('recalled', {msg_type: type})]), /撤回|保护/);
for (const flag of ['is_need_read_receipt', 'is_delete_after_read']) {
  const forbidden = message('forbidden', {[flag]: 'true', content: '不能外发'});
  assert.throws(() => forwardEnvelope([message('nested-forbidden', {msg_type: 24, content: {msgs: [forbidden]}})]), /保护/);
}
console.log('嵌套附件保留、嵌套与引用去本机状态、保护/撤回记录拒绝回归通过');

const messages = Array.from({length: 41}, (_, index) => message(String(index), {content: '合并正文🙂'.repeat(300), send_time: 1000 - index}));
const batches = splitForwardBatches(messages);
assert.ok(batches.length > 1, '超过20000字符应自动拆批');
for (const batch of batches) assert.ok(JSON.stringify(forwardEnvelope(batch)).length <= 20000);
const ids = batches.flat().map(item => item.msg_id);
assert.equal(ids.length, messages.length);
assert.equal(new Set(ids).size, messages.length, '拆批不能重复消息');
assert.deepEqual(ids, [...messages].sort((a, b) => a.send_time - b.send_time).map(item => item.msg_id), '拆批不得丢失消息或打乱原时间顺序');
assert.throws(() => splitForwardBatches([message('oversized', {content: '长'.repeat(20001)})]), /其中一条|大小限制/);
assert.throws(() => forwardEnvelope([]), /选择/);
assert.deepEqual(splitForwardBatches([]), []);
console.log('20000字符拆批、无丢重顺序、单条超限与空选择回归通过');

const cachedB = message('cached-b', {msg_type: 24, content: {forwardMsgDetailId: 'B', msgs: [attachment]}});
const cachedA = message('cached-a', {msg_type: 24, content: {forwardMsgDetailId: 'A', msgs: [message('ref-b', {msg_type: 24, content: {forwardMsgDetailId: 'B'}})]}});
const hydrated = hydrateForwardContent({forwardMsgDetailId: 'A'}, [cachedA, cachedB]);
assert.equal(hydrated.msgs[0].content.msgs[0].content.download_url, 'file-key');
assert.deepEqual(hydrateForwardContent({forwardMsgDetailId: 'unknown'}, [cachedA]), {forwardMsgDetailId: 'unknown'}, '未知ID只保留缺明细状态，不猜远端接口');
const cycleA = message('cycle-a', {msg_type: 24, content: {forwardMsgDetailId: 'cycle-A', msgs: [message('to-b', {msg_type: 24, content: {forwardMsgDetailId: 'cycle-B'}})]}});
const cycleB = message('cycle-b', {msg_type: 24, content: {forwardMsgDetailId: 'cycle-B', msgs: [message('to-a', {msg_type: 24, content: {forwardMsgDetailId: 'cycle-A'}})]}});
const cycle = hydrateForwardContent({forwardMsgDetailId: 'cycle-A'}, [cycleA, cycleB]);
assert.equal(cycle.msgs[0].content.msgs[0].content.forwardMsgDetailId, 'cycle-A');
assert.ok(!cycle.msgs[0].content.msgs[0].content.msgs, '缓存ID循环应停止展开');
assert.ok(JSON.stringify(cycle).length < 10000);
assert.ok(!cachedA.content.msgs[0].content.msgs, '补全应返回副本，不篡改原缓存');
console.log('已有详情ID缓存补全、未知ID边界与循环保护回归通过');

function checkMessageContentSetup() {
  const filename = path.join(root, 'components/MessageContent.vue');
  const {parse, compileScript} = require('vue/compiler-sfc');
  const descriptor = parse(fs.readFileSync(filename, 'utf8'), {filename}).descriptor;
  const compiled = compileScript(descriptor, {id: 'forwarding-smoke'}).content;
  const module = {exports: {}};
  new Function('require', 'module', 'exports', ts.transpileModule(compiled, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText)(id => requireFrom(filename, id), module, module.exports);
  const setup = module.exports.default.setup;
  const source = message('source');
  const reply = message('reply', {reply_msg_id: 'source'});
  const protectedMessage = message('protected', {content: '保密正文', is_delete_after_read: true});
  const replyProtected = message('reply-protected', {reply_msg_id: 'protected'});
  const snapshot = message('snapshot', {reply_msg_id: 'unloaded', reply_msg_type: 1, reply_content: '随记录携带原文', reply_from_name: '原发送人'});
  const props = {msgType: 24, content: {msgs: [source, reply, protectedMessage, replyProtected, snapshot]}};
  const state = setup(props, {expose() {}, emit() {}});
  const rows = combineDetails(props.content);
  assert.equal(state.nestedReply(rows[1]).content, source.content);
  assert.equal(state.nestedReply(rows[3]).content, '[受保护消息]');
  assert.equal(state.nestedReply(rows[4]).content, '随记录携带原文');
  const groupContext = state.rowContext(rows[1]);
  assert.equal(groupContext.sessionId, 'group');
  assert.equal(groupContext.sessionType, 2);
  const direct = message('direct', {from_id: 'peer', to_id: 'me', to_type: 1});
  const own = message('own-direct', {from_id: 'me', to_id: 'peer', to_type: 1});
  const service = message('service', {from_id: 'service', from_type: 5, to_id: 'me', to_type: 1});
  const serviceOwn = message('service-own', {from_id: 'me', to_id: 'service', to_type: 5});
  const unknown = message('unknown-direct', {from_id: 'someone', to_id: 'another', to_type: 1});
  const contextRows = combineDetails({msgs: [direct, own, service, serviceOwn, unknown]});
  assert.equal(state.rowContext(contextRows[0]).sessionId, 'peer');
  assert.equal(state.rowContext(contextRows[1]).sessionId, 'peer');
  assert.equal(state.rowContext(contextRows[2]).sessionType, 5, '服务号来信不能归为个人上下文');
  assert.equal(state.rowContext(contextRows[3]).sessionType, 5, '发给服务号的消息仍应保留会话类型');
  assert.equal(state.rowContext(contextRows[4]).sessionId, undefined, '不属于自己的原单聊不得猜测操作上下文');
  console.log('真实MessageContent setup：嵌套引用快照、保护遮罩、群聊/单聊/服务号上下文回归通过');
}
checkMessageContentSetup();
