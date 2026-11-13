// 在 YX/ 执行。只运行真实解析、组件动作与模拟接口，不访问生产服务。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { parse: parseSfc, compileScript } = require('vue/compiler-sfc');
const vue = require('vue');
function loadTs(file, mocks) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(name => mocks?.[name] || require(name), module, module.exports);
  return module.exports;
}
const actions = loadTs('src/services/im/card-actions.ts');
const { planCardActions: plan, compatibleCardActions } = actions;
const context = { messageId: 'message1', sessionId: 'group1', sessionName: '测试群', sessionType: 2, message: { msg_id: 'message1', from_id: 'author', content: '卡片', msg_type: 27 } };
assert.equal(plan('[OpenUrl]\\nurl=https://example.invalid/a?x=1=2')[0].url, 'https://example.invalid/a?x=1=2');
assert.equal(plan("{pc:'[OpenUrl]\\nurl=https://example.invalid/a'}")[0].kind, 'url');
assert.throws(() => plan("{android:'[OpenUrl]url=https://example.invalid/a'}"), /电脑端/);
assert.equal(plan('[OpenUrl]\nurl={uam}/a', {}, { uamUri: 'https://example.invalid' })[0].url, 'https://example.invalid/a');
assert.throws(() => plan('[OpenUrl]\nurl={unknown}/a'), /未下发/);
for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'https://user:pass@example.invalid/']) assert.throws(() => plan('[OpenUrl]\nurl=' + url));
const list = plan('[Toast]\nmessage=第一条\n\n[OpenChat]\nid=group2\ntargetType=2\nname=测试群');
assert.deepEqual(list.map(action => action.kind), ['notice', 'chat']);
assert.throws(() => plan('[Toast]\nmessage=已完成\n\n[Unknown]\nkey=x'), /Unknown/, '整批含未知动作时解析先失败，不能先执行前半部分');
assert.deepEqual(plan('[StartUserCard]\nid=user1')[0], { kind: 'contact', id: 'user1', type: 1, name: '' });
assert.deepEqual(plan('[OpenBuiltIn]\nkey=GroupCard\ngroupId=group1')[0], { kind: 'contact', id: 'group1', type: 2, name: '' });
assert.equal(plan('[OpenItem]\nopenMode=session\ntype=5\nid=service1')[0].type, 5);
const app = plan('[OpenApp]\nappCode=app1\npcHomeUrl=https://example.invalid/app\nquery={"x":1}\nmodeType=sidebar')[0];
assert.equal(new URL(app.url).searchParams.get('query'), '{"x":1}');
assert.equal(new URL(app.url).searchParams.has('appCode'), false);
const req = plan('[RequestUrl]\nurl=https://example.invalid/${sessionId}/action\nmethod=POST\nparams={msgId:"${msgId}", nested:{text:"a\\nb"}}', context)[0];
assert.equal(req.data.url, 'https://example.invalid/group1/action');
assert.equal(req.data.params.msgId, 'message1');
assert.equal(req.data.params.nested.text, 'a\nb');
assert.throws(() => plan('[RequestUrl]\nurl=https://example.invalid/${sessionId}\nmethod=GET'));
const form = plan('[RequestUrl]\nurl=https://example.invalid/\nmethod=POST\ncontentType=application/x-www-form-urlencoded\nparams=x=a%3Db&name=%E4%B8%AD%E6%96%87')[0];
assert.deepEqual(form.data.params, { x: 'a=b', name: '中文' });
assert.equal(plan('[Message]\nactionId=agree', context)[0].type, 8);
assert.equal(plan('[Message]\ntype=1\ncontent=收到', context)[0].target.id, 'group1');
assert.throws(() => plan('[Message]\ntype=66\ncontent=撤回', context), /暂未接入/);
const business = { type: 'Action.Link', url: 'javascript:should-not-transform', actions: [{ type: 'Action.Link', url: 'data:x' }] };
const adapted = compatibleCardActions({ type: 'AdaptiveCard', actions: [{ type: 'Action.Link', title: '打开', url: '[OpenChat]\nid=x\ntargetType=1', data: business }] });
assert.equal(adapted.actions[0].type, 'Action.OpenUrl');
assert.deepEqual(adapted.actions[0].data, business, '适配仅遍历卡片结构，不能改业务数据');
console.log('卡片指令解析回归通过：换行、参数等号、JSON5、上下文、批次、应用、会话、请求及未知动作');

(async () => {
  const calls = [];
  const fakeIm = { openChat: (...args) => calls.push(['chat', ...args]), forwardMessage: async (...args) => calls.push(['message', ...args]) };
  const descriptor = parseSfc(fs.readFileSync('src/components/AdaptiveMessage.vue', 'utf8')).descriptor;
  const compiled = compileScript(descriptor, { id: 'card-actions-test' }).content;
  const module = { exports: {} };
  const mocks = {
    vue: { ...vue, onUnmounted() {}, watch() {} },
    'vue-router': { useRouter: () => ({ push: async target => calls.push(['route', target]) }) },
    adaptivecards: { AdaptiveCard: class {}, OpenUrlAction: class {}, SubmitAction: class {}, HostConfig: class {} },
    '@tauri-apps/plugin-opener': { openUrl: async url => calls.push(['url', url]) },
    '../services/im/cards': { cardHttpUrl: value => actions.actionUrl(value), submitCard: async data => calls.push(['request', data]) },
    '../services/im/card-actions': actions,
    '../services/config': { getServerPaths: () => ({}) },
    '../services/app-client': { loadApps: async () => [{ id: 'app1', code: 'AppOne', url: 'https://example.invalid/app' }] },
    '../stores/im': { useImStore: () => fakeIm },
    '../services/im/favorites': { favoriteMessage: async (...args) => calls.push(['favorite', ...args]) },
    '../services/im/todo': { resolveTodoNotice: async notice => { calls.push(['todo', notice]); return 'https://example.invalid/todo/1'; } },
  };
  const code = ts.transpileModule(compiled, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(name => { assert.ok(mocks[name], '未模拟依赖：' + name); return mocks[name]; }, module, module.exports);
  const state = module.exports.default.setup({ content: { title: '通知', brief: '请处理' }, actionContext: context }, { expose() {} });
  assert.deepEqual(calls, [], '组件初始化不得执行卡片动作');
  await state.execute('[OpenChat]\nid=service1\ntargetType=5\nname=服务号');
  assert.deepEqual(calls[0], ['chat', 'service1', '服务号', 5]);
  await state.execute('[OpenApp]\nappCode=AppOne\nquery={"id":1}');
  assert.equal(new URL(calls.at(-1)[1]).searchParams.get('query'), '{"id":1}');
  await state.execute('[RequestUrl]\nurl=https://example.invalid/action\nmethod=POST\nparams={msgId:"${msgId}"}');
  assert.equal(calls.at(-1)[0], 'request');
  await state.execute('[Message]\nactionId=approve');
  assert.equal(calls.at(-1)[0], 'message');
  assert.equal(calls.at(-1)[2][0].msg_type, 8);
  await state.execute('[FavorMsg]');
  assert.equal(calls.at(-1)[0], 'favorite');
  await state.execute('[Toast]\nmessage=已处理');
  assert.equal(state.status.value, '已处理');
  await state.execute('[CloseDialog]');
  assert.equal(state.closed.value, true);
  const detailCalls = [];
  const service = loadTs('src/services/im/service-no.ts', {
    '../config': { getServerPaths: () => ({ serviceNoUri: 'https://example.invalid/service/' }) },
    '../http': { httpJson: async url => { detailCalls.push(url); return { code: 200, data: { accountId: 'a/b', name: '服务号' } }; } },
  });
  assert.equal((await service.getServiceNoDetail('a/b')).name, '服务号');
  assert.equal(detailCalls[0], 'https://example.invalid/service/v2/servicenos/a%2Fb/detail?terminalType=3');
  console.log('真实卡片组件动作与服务号协议回归通过（模拟路由、连接及HTTP；未访问生产）');
})().catch(error => { console.error(error); process.exitCode = 1; });
