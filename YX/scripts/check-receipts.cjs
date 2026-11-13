// 在 YX/ 执行。真实 Vue/Pinia 名单 store 与弹窗逻辑，网络仅使用模拟接口。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vue = require('vue');
const pinia = require('pinia');
const { parse, compileScript } = require('vue/compiler-sfc');
let account = 'me';
const storage = new Map([['CurrentUserOrgId', 'org1']]);
const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
const calls = [];
let detail = { memberCount: 5 };
let detailLoader = async () => detail;
let memberLoader = async offset => offset === 0
  ? { members: [{ userId: 'me', name: '我' }, { userId: 'a', name: '甲' }, { userId: 'deleted', name: '已删除', isDeleted: 'true' }], total: 5, hasMore: true }
  : { members: [{ userId: 'b', name: '乙' }, { userId: 'robot:test', name: '机器人' }], total: 5, hasMore: false };
let department = { code: 200, total: 4, data: [{ userId: 'me' }, { userId: 'a', name: '甲' }, { userId: 'disabled', isEnable: false }, { userId: 'robot:test' }] };
const dependencies = {
  vue, pinia,
  '../services/auth': { authService: { getCurrentUserId: () => account } },
  '../services/group-client': { groupService: {
    getGroupDetail: async id => { calls.push(['detail', id]); return detailLoader(); },
    getMembersPage: async (id, offset, limit) => { calls.push(['members', id, offset, limit]); return memberLoader(offset); },
  } },
  '../services/config': { getServerPaths: () => ({ uamApiUri: 'https://offline.invalid/uamapi/' }) },
  '../services/http': { httpJson: async url => { calls.push(['http', url]); return department; } },
};
const moduleStore = { exports: {} };
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
new Function('require', 'module', 'exports', 'localStorage', compile(fs.readFileSync('src/stores/receipts.ts', 'utf8')))(id => { assert.ok(dependencies[id], id); return dependencies[id]; }, moduleStore, moduleStore.exports, localStorage);
const { useReceiptAudienceStore } = moduleStore.exports;
pinia.setActivePinia(pinia.createPinia());
const store = useReceiptAudienceStore();
const session = { id: 'group1', name: '测试群', type: 2 };
const message = (id, type = 2, to = 'group1') => ({ msg_id: id, from_id: account, from_name: '发送方', from_type: 1, msg_type: 1, content: '消息', to_id: to, to_name: to, to_type: type, send_time: 100 });
(async () => {
  const directPromise = store.capture(message('dm', 1, 'a'), { id: 'a', name: '甲', type: 1 }, { atSend: true });
  assert.equal(store.get('dm').members[0].id, 'a', '单聊必须同步建立来自消息本身的接收人快照');
  assert.equal((await directPromise).timing, 'direct');
  assert.equal(calls.length, 0, '单聊不能查询群成员或通讯录');
  const sent = message('group-sent');
  const [first, duplicate] = await Promise.all([store.capture(sent, session, { atSend: true }), store.capture(sent, session)]);
  assert.deepEqual(first, duplicate);
  assert.equal(calls.filter(call => call[0] === 'detail').length, 1, '同消息并发捕获需要合并');
  assert.deepEqual(first.members.map(member => member.id), ['a', 'b']);
  assert.equal(first.complete, true);
  assert.equal(first.timing, 'send');
  assert.deepEqual(calls.filter(call => call[0] === 'members').map(call => call.slice(2)), [[0, 500], [3, 500]]);
  detail = { memberCount: 1 };
  memberLoader = async () => ({ members: [{ userId: 'c', name: '新成员' }], total: 1, hasMore: false });
  const current = await store.refresh(sent, session);
  assert.equal(current.timing, 'later');
  assert.deepEqual(current.members.map(member => member.id), ['c']);
  assert.deepEqual(store.get(sent.msg_id).members.map(member => member.id), ['a', 'b'], '刷新当前成员不得覆盖历史快照');
  detail = {};
  const unknown = await store.capture(message('unknown-total'), session);
  assert.equal(unknown.complete, false);
  assert.match(unknown.reason, /完整性/);
  detail = { memberCount: 2 };
  const mismatch = await store.capture(message('mismatch'), session);
  assert.equal(mismatch.complete, false);
  assert.match(mismatch.reason, /不一致/);
  detail = { memberCount: 0 };
  assert.equal((await store.capture(message('zero-mismatch'), session)).complete, false, '不一致的0总数不能冒充完整');
  detail = { memberCount: 100 };
  memberLoader = async () => ({ members: [{ userId: 'c' }], total: 100, hasMore: true });
  const repeated = await store.capture(message('repeated-page'), session);
  assert.equal(repeated.complete, false);
  assert.match(repeated.reason, /没有继续推进/);
  memberLoader = async offset => ({ members: [{ userId: `member-${offset}` }], total: 10000, hasMore: true });
  const before = calls.length;
  const bounded = await store.capture(message('bounded'), session);
  assert.equal(calls.slice(before).filter(call => call[0] === 'members').length, 20);
  assert.match(bounded.reason, /上限/);
  memberLoader = async () => { throw new Error('获取失败 https://offline.invalid/?access_token=hidden'); };
  const failed = await store.capture(message('failed'), session, { atSend: true });
  assert.equal(failed.complete, false);
  assert.deepEqual(failed.members, []);
  assert.ok(!failed.reason.includes('hidden'), '错误提示必须隐藏请求地址中的凭据');
  console.log('回执名单：单聊同步、群分页/去重/排除成员、完整性、分页上限及失败状态回归通过');

  const ownDepartment = await store.capture(message('dept', 4, 'org1'), { id: 'org1', name: '本部门', type: 4 });
  assert.equal(ownDepartment.complete, true);
  assert.deepEqual(ownDepartment.members.map(member => member.id), ['a']);
  const departmentUrl = new URL(calls.find(call => call[0] === 'http')[1]);
  assert.equal(departmentUrl.pathname, '/uamapi/v1/organizations/users');
  assert.equal(departmentUrl.searchParams.get('offset'), '1');
  assert.equal(departmentUrl.searchParams.get('limit'), '800');
  const httpCount = calls.filter(call => call[0] === 'http').length;
  assert.equal((await store.capture(message('other-dept', 4, 'org2'), { id: 'org2', name: '其他部门', type: 4 })).complete, false);
  assert.equal(calls.filter(call => call[0] === 'http').length, httpCount, '不能把本部门名单套到其他部门消息');
  department = { ...department, total: 1000 };
  assert.equal((await store.capture(message('large-dept', 4, 'org1'), { id: 'org1', name: '本部门', type: 4 })).complete, false);
  console.log('部门名单：原版已核实的首分页、成员过滤、超出800人及其他部门范围回归通过');

  account = 'other';
  assert.equal(store.get('dm'), undefined);
  await store.capture(message('other-dm', 1, 'a'), { id: 'a', name: '甲', type: 1 });
  assert.ok(storage.has('yl.im.receipt-audiences.other'));
  account = 'me';
  assert.ok(store.get('dm'));
  assert.equal(store.get('other-dm'), undefined);
  let release;
  detailLoader = () => new Promise(resolve => { release = resolve; });
  const late = store.capture(message('late'), session);
  account = 'other'; store.get('other-dm');
  const memberCount = calls.filter(call => call[0] === 'members').length;
  release({ memberCount: 1 }); await late;
  assert.equal(calls.filter(call => call[0] === 'members').length, memberCount, '切换账号后不能继续使用新账号请求旧群成员');
  assert.equal(store.get('late'), undefined);
  account = 'me'; assert.equal(store.get('late'), undefined);
  detailLoader = async () => ({ memberCount: 1 });
  memberLoader = async () => ({ members: [{ userId: 'a', name: '甲' }], total: 1, hasMore: false });
  const stale = store.capture(message('clear-late'), session);
  store.clear(); await stale;
  assert.equal(store.get('clear-late'), undefined, '清理后的迟到响应不得恢复快照');
  console.log('回执名单：账号隔离、持久化恢复、迟到响应与清理竞态回归通过');

  await store.capture(message('modal-group'), session, { atSend: true });
  const sfc = parse(fs.readFileSync('src/components/ReceiptModal.vue', 'utf8')).descriptor;
  const component = { exports: {} };
  const uiMocks = { vue: { ...vue, onMounted() {}, onUnmounted() {} }, '../stores/receipts': moduleStore.exports };
  new Function('require', 'module', 'exports', compile(compileScript(sfc, { id: 'receipt-modal-test' }).content))(id => { assert.ok(uiMocks[id], id); return uiMocks[id]; }, component, component.exports);
  const props = vue.reactive({ message: message('modal-group'), readers: { a: '甲', outsider: '名单外成员' }, readTimes: { a: 1000 } });
  const ui = component.exports.default.setup(props, { expose() {} });
  await vue.nextTick();
  assert.equal(ui.received.value.length, 2);
  assert.equal(ui.received.value.find(member => member.id === 'outsider').outside, true);
  assert.equal(ui.pending.value.length, 0);
  assert.equal(ui.snapshot.value.timing, 'send');
  props.readers = {};
  assert.deepEqual(ui.pending.value.map(member => member.id), ['a']);
  ui.tab.value = 'pending'; ui.keyword.value = '甲';
  assert.equal(ui.filtered.value.length, 1);
  memberLoader = async () => ({ members: [{ userId: 'c', name: '当前成员' }], total: 1, hasMore: false });
  await ui.refresh();
  assert.equal(ui.candidate.value.members[0].id, 'c');
  assert.equal(ui.snapshot.value.members[0].id, 'a');
  assert.equal(ui.addedMembers.value, 1); assert.equal(ui.removedMembers.value, 1);
  console.log('真实回执弹窗逻辑：名单内外阅读确认、未收到回执、搜索及当前参考名单分离回归通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
