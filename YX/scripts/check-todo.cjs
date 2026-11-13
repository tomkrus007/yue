const fs = require('fs');
const ts = require(process.cwd() + '/node_modules/typescript');
const path = require('path');
function load(file) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8').replace(/import\.meta\.glob/g, '__assetGlob'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module = {exports:{}};
  new Function('require','module','exports','__assetGlob',code)(id => load(path.resolve(path.dirname(file),id+'.ts')),module,module.exports,() => ({}));
  return module.exports;
}
const assert = require('assert/strict');
const content = load(path.resolve('src/services/im/content.ts'));
const fixture = {brief:'您有一条新的待办',type:5,contents:[{content:{title:'测试审批单',brief:'请及时处理',more:'补充说明'},action_type:1,action_param:'[UnityTodo]\ndefaultIndex=1\nsource=K2'}]};
const segments = content.segmentsOf(99,fixture);
assert.equal(segments[0].type,'card','待办通知必须渲染为卡片');
assert.equal(segments[0].title,'测试审批单');
assert.equal(segments[0].brief,'请及时处理');
assert.equal(segments[0].more,'补充说明');
assert.equal(segments[0].action,fixture.contents[0].action_param);
console.log('待办卡片字段回归通过');
assert.equal(content.toPlainText(99,fixture),fixture.brief,'会话列表保留摘要');
assert.equal(content.segmentsOf(1,'普通消息')[0].text,'普通消息');
assert.equal(content.segmentsOf(99,{brief:'空卡片',type:5,contents:[]})[0].text,'空卡片');

const calls = [];
const browserOpens = [];
const mocks = {
  '@tauri-apps/plugin-opener': {openUrl:async url => {browserOpens.push(url);}},
  './content': content,
  'json5': require('json5'),
  '../config': {DEFAULT_CONFIG:{clientId:'link_desktop',clientSecret:'bGlua19jbGllbnRfc2VjcmV1',version:'5.2.97',version2:'5.2.4'},getServerPaths:() => ({toDoUri:'https://gw.yuexiu.com/todosrvapi',ssoUri:'https://www.bingolink.biz/sso'})},
  '../auth': {authService:{getAccessToken:() => 'test-token'}},
  '../http': {httpJson:async (url,options) => {
    calls.push({url,options});
    return {data:[{id:'1',title:'审批单',action:{pc:'[OpenUrl]\nurl=https://work.yuexiu.com/task?id=1'}}],total:21};
  }},
};
const mod = {exports:{}};
new Function('require','module','exports',ts.transpileModule(fs.readFileSync('src/services/im/todo.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id => {
  assert.ok(mocks[id], '未预期依赖：'+id);
  return mocks[id];
},mod,mod.exports);
const todo = mod.exports;
assert.deepEqual(todo.todoTarget(fixture.contents[0].action_param),{tab:'read',source:'K2'});
assert.deepEqual(todo.todoTarget('[UnityTodo]\\ndefaultIndex=2\\nsource=K2'),{tab:'done',source:'K2'});
assert.equal(todo.todoTarget('[Other]'),null);
assert.equal(todo.actionParams('[OpenUrl]\nurl=https://work.yuexiu.com/?id=a=b').url,'https://work.yuexiu.com/?id=a=b');
assert.equal(todo.todoUrl('{broken'), '');
assert.equal(todo.todoUrl({pc:'[OpenUrl]\nurl=https://work.yuexiu.com/task?id=1'}),'https://work.yuexiu.com/task?id=1','对象格式的动作必须能启用打开按钮');
assert.equal(todo.todoUrl("{pc:'[OpenUrl]\\nurl=https://work.yuexiu.com/task?id=1'}"),'https://work.yuexiu.com/task?id=1','官方兼容的对象字面量必须能启用打开按钮');
assert.equal(todo.todoUrl({pc:'  [OpenUrl]url=https://work.yuexiu.com/task?id=1'}),'https://work.yuexiu.com/task?id=1','标记和参数之间不要求换行');
assert.equal(todo.todoUrl('{pc: (() => { throw new Error("禁止执行") })()}'),'','拒绝执行动作数据中的表达式');
assert.equal(todo.todoUrl('{pc:"[OpenUrl]\nurl=https://work.yuexiu.com/task?id=1\nwin_width=1200"}'),'https://work.yuexiu.com/task?id=1','内嵌真实换行的动作串必须能解析');
assert.equal(todo.todoUrl("{pc:'[OpenUrl]\nurl=https://work.yuexiu.com/task?id=1'}"),'https://work.yuexiu.com/task?id=1','单引号加真实换行必须能解析');
assert.equal(todo.todoUrl('[OpenUrl]\nurl=https://work.yuexiu.com/task?id=1'),'https://work.yuexiu.com/task?id=1','未包 JSON 的纯动作串必须能解析');
assert.equal(todo.todoUrl({pc:'[OpenUrl]\n url=https://work.yuexiu.com/task?id=1\n groupId=9'}),'https://work.yuexiu.com/task?id=1&groupId=9','换行后带缩进空格的参数');

assert.equal(todo.todoUrl(JSON.stringify({pc:'[OpenUrl]\nurl=javascript:alert(1)'})), '');
assert.equal(todo.safeWebUrl('https://user:pass@work.yuexiu.com'), '');
const service = todo.todoUrl(JSON.stringify({pc:'[OpenUrl]\nurl=https://work.yuexiu.com/task?id=1\nwin_width=1200'}));
assert.equal(service,'https://work.yuexiu.com/task?id=1');
(async () => {
  const list = await todo.listTodos('read','K2','审批',2);
  assert.equal(list.total,21);
  assert.equal(todo.todoUrl(list.items[0].action),service,'列表返回的动作对象可直接用于打开');
  const requestUrl = new URL(calls[0].url);
  assert.equal(requestUrl.pathname,'/todosrvapi/v1/api/toreads');
  assert.equal(requestUrl.searchParams.get('source'),'K2');
  assert.equal(requestUrl.searchParams.get('page'),'2');
  assert.equal(calls[0].options.extraHeaders.ClientType,'pc');
  assert.equal(calls[0].options.tokenInQuery,true,'待办接口必须同时传递 access_token 参数');
  const networkCalls = calls.length;
  await todo.openTodoInBrowser(service);
  assert.deepEqual(browserOpens,[service],'直接打开原始详情地址，不改成 CAS 登录地址');
  assert.equal(calls.length,networkCalls,'外部打开不发起登录或票据请求');
  await assert.rejects(todo.openTodoInBrowser('javascript:alert(1)'),/链接无效/);
  assert.equal(browserOpens.length,1,'不打开非法协议');
  mocks['@tauri-apps/plugin-opener'].openUrl = async () => {throw new Error('系统浏览器不可用');};
  await assert.rejects(todo.openTodoInBrowser(service),/系统浏览器不可用/);
  mocks['@tauri-apps/plugin-opener'].openUrl = async url => {browserOpens.push(url);};
  const notice = {title:'您有一条新的待办',brief:'审批 事项',action:'[UnityTodo]\ndefaultIndex=0\nsource=K2'};
  const matched = {id:'target',title:'审批 事项',source:'K2',action:{pc:'[OpenUrl]\nurl='+service}};
  mocks['../http'].httpJson = async url => {
    if (new URL(url).pathname.endsWith('/todos')) return {data:[matched],total:1};
    throw new Error('HTTP 500 handled exception!');
  };
  assert.equal(await todo.resolveTodoNotice(notice),service,'待办已唯一匹配时，其他列表接口的500不应阻止打开');
  mocks['../http'].httpJson = async url => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/todos')) return {data:[],total:0};
    if (pathname.endsWith('/toreads')) throw new Error('HTTP 500 handled exception!');
    return {data:[matched],total:1};
  };
  assert.equal(await todo.resolveTodoNotice(notice),service,'无关回退分类500时仍可定位已办条目');
  mocks['../http'].httpJson = async () => {throw new Error('HTTP 500 handled exception!');};
  await assert.rejects(todo.resolveTodoNotice(notice),/待办列表（\/v1\/api\/todos）请求失败：HTTP 500/,'主要查询失败时明确指出接口，不伪报已找到详情');
  let listCalls = [];
  mocks['../http'].httpJson = async url => {
    const query = new URL(url);
    listCalls.push(query);
    assert.equal(query.searchParams.get('title'),'审批 事项','查询保留标题中的空格');
    assert.equal(query.searchParams.get('source'),'K2');
    if (!query.pathname.endsWith('/todos')) return {data:[],total:0};
    return query.searchParams.get('page') === '1'
      ? {data:Array.from({length:20},(_,id)=>({id:String(id),title:'其他事项',source:'K2'})),total:21}
      : {data:[matched],total:21};
  };
  assert.equal(await todo.resolveTodoNotice(notice),service,'消息标题位于卡片摘要时，跨页匹配并直接返回详情链接');
  assert.equal(listCalls.length,2);
  mocks['../http'].httpJson = async () => ({data:[matched,{...matched,id:'duplicate'}],total:2});
  await assert.rejects(todo.resolveTodoNotice(notice),/多条同名/);
  mocks['../http'].httpJson = async url => ({data:[{...matched,id:new URL(url).pathname}],total:1});
  assert.equal(await todo.resolveTodoNotice(notice),service,'优先采用消息指定分类的唯一匹配，不被其他分类同名记录干扰');
  mocks['../http'].httpJson = async () => ({data:[{...matched,dealTerminal:3}],total:1});
  await assert.rejects(todo.resolveTodoNotice(notice),/移动端/);
  mocks['../http'].httpJson = async () => ({data:[{...matched,action:''}],total:1});
  await assert.rejects(todo.resolveTodoNotice(notice),/未提供/);
  mocks['../http'].httpJson = async () => ({data:[{...matched,source:'其他来源'}],total:1});
  await assert.rejects(todo.resolveTodoNotice(notice),/未找到/);
  listCalls = [];
  mocks['../http'].httpJson = async url => {
    const query = new URL(url);
    listCalls.push(query.pathname);
    return query.pathname.endsWith('/done_list') ? {data:[matched],total:1} : {data:[],total:0};
  };
  assert.equal(await todo.resolveTodoNotice(notice),service,'历史通知可定位已办条目');
  assert.equal(listCalls.length,3);
  assert.equal(await todo.resolveTodoNotice({...notice,action:'[OpenUrl]\nurl='+service}),service,'消息自带详情地址时直接使用');
  assert.equal(listCalls.length,3,'直链消息不查询列表');
  await assert.rejects(todo.resolveTodoNotice({...notice,brief:''}),/缺少具体待办标题/);
  // 运行真实 httpJson，验证刷新后 URL 参数和请求头一起更新。
  const httpRequests = [];
  let currentToken = 'expired-test-token';
  let refreshCount = 0;
  const actualHttp = {exports:{}};
  const httpMocks = {
    '@tauri-apps/plugin-http': {fetch:async (url,options) => {
      httpRequests.push({url:new URL(url),options});
      const ok = httpRequests.length !== 1;
      return {ok,status:ok ? 200 : 401,text:async () => JSON.stringify(ok ? {data:[]} : {error:'需要登录的access_token'})};
    }},
    './auth': {authService:{getAccessToken:() => currentToken,refreshToken:async () => {refreshCount++; currentToken = 'fresh-test-token'; return currentToken;}}},
  };
  new Function('require','module','exports',ts.transpileModule(fs.readFileSync('src/services/http.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id => httpMocks[id],actualHttp,actualHttp.exports);
  await actualHttp.exports.httpJson('https://gw.yuexiu.com/todosrvapi/api/todo/done_list?page=1&access_token=stale-query-token',{tokenInQuery:true});
  assert.equal(refreshCount,1);
  assert.equal(httpRequests.length,2);
  assert.equal(httpRequests[0].url.searchParams.get('access_token'),'expired-test-token');
  assert.equal(httpRequests[1].url.searchParams.get('access_token'),'fresh-test-token');
  assert.equal(httpRequests[1].options.headers.Authorization,'Bearer fresh-test-token');
  assert.equal(httpRequests[1].url.searchParams.get('page'),'1');
  await actualHttp.exports.httpJson('https://www.bingolink.biz/sso/oauth2/authorize?response_type=create_session',{tokenInQuery:true});
  assert.equal(httpRequests[2].url.searchParams.get('access_token'),'fresh-test-token');
  await actualHttp.exports.httpJson('https://example.com/unrelated');
  assert.equal(httpRequests[3].url.searchParams.has('access_token'),false,'普通接口不新增凭证参数');
  mocks['../auth'].authService.getAccessToken = () => '';
  await assert.rejects(todo.listTodos('todo','','',1),/重新登录/);
  console.log('待办鉴权参数、SSO 凭证、401 刷新后重建 URL 和空凭证提示回归通过（模拟响应）');
  console.log('动作解析、来源过滤与失败处理回归通过（模拟响应）');
  console.log('消息直接定位详情、分页、已办回退、歧义与失败提示回归通过（模拟响应）');
  console.log('直接调用系统浏览器、无登录请求及非法链接回归通过（模拟响应）');
})().catch(error => { console.error(error); process.exitCode = 1; });
