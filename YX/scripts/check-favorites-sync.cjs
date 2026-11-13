// 离线运行真实 Vue/Pinia 收藏状态与协议封装；不连接生产服务。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const vue = require('vue');
const pinia = require('pinia');
const root = path.resolve(__dirname, '../src');
const cache = new Map();
let account = 'account-a';
let getHandler = async () => [];
let writeHandler = async () => ({code: 200});
const calls = [];
const mocks = {
  vue, pinia,
  [path.join(root, 'services/auth.ts')]: {authService: {getCurrentUserId: () => account}},
  [path.join(root, 'services/config.ts')]: {getServerPaths: () => ({uamApiUri: 'https://offline.invalid/uamapi'})},
  [path.join(root, 'services/http.ts')]: {httpJson: async (url, options = {}) => {
    const call = {url: new URL(url), options, account};
    calls.push(call);
    if (!options.method) return {code: 200, data: await getHandler(call.url.searchParams.get('cursor'), call)};
    return writeHandler(call);
  }},
};
function load(file) {
  if (mocks[file]) return mocks[file];
  if (cache.has(file)) return cache.get(file).exports;
  const module = {exports: {}};
  cache.set(file, module);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  new Function('require', 'module', 'exports', source)(id => {
    if (mocks[id]) return mocks[id];
    assert.ok(id.startsWith('.'), '不允许未模拟的外部依赖：' + id);
    return load(path.resolve(path.dirname(file), id + '.ts'));
  }, module, module.exports);
  return module.exports;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no});
  return {promise, resolve, reject};
}
const {useFavoritesStore} = load(path.join(root, 'stores/favorites.ts'));
const api = load(path.join(root, 'services/im/favorites.ts'));
const message = (id, text, overrides = {}) => ({msg_id: id, msg_type: 1, from_id: 'author', from_name: '发送人', from_type: 1, to_id: 'group', to_name: '测试群', to_type: 2, send_time: 100, content: text, ...overrides});
const a = message('a', '第一条'), b = message('b', '第二条'), c = message('c', '第三条');
const favorite = (m, time) => ({...api.messageFavorite(m), createdDate: time});
const fa = favorite(a, 300), fb = favorite(b, 200), fc = favorite(c, 100);
function pages(rows) {
  getHandler = async cursor => !cursor ? rows : [];
}
(async () => {
  pinia.setActivePinia(pinia.createPinia());
  const store = useFavoritesStore();
  assert.equal(store.status(a), 'unknown');
  getHandler = async cursor => cursor === '' ? [fa] : cursor === '300' ? [fb] : [];
  await store.sync();
  assert.equal(store.complete, true);
  assert.deepEqual(store.items.map(item => item.itemId), [fa.itemId, fb.itemId]);
  assert.equal(store.status(b), 'saved', '完整分页必须包含第一页以外收藏');
  assert.equal(store.status(c), 'unsaved');
  const first = calls.filter(call => !call.options.method);
  assert.deepEqual(first.map(call => call.url.searchParams.get('cursor')), ['', '300', '200']);
  getHandler = async cursor => {if (!cursor) return [fa]; throw new Error('第二页失败');};
  await assert.rejects(store.sync(), /第二页失败/);
  assert.equal(store.isFavorite(b), true, '后续页失败不能用部分列表清除已有标记');
  assert.equal(store.items.length, 2);
  console.log('全量分页、未知状态与失败原子同步回归通过');

  let page = deferred();
  getHandler = async cursor => !cursor ? [fa] : cursor === '300' ? page.promise : [];
  const sync = store.sync();
  await Promise.resolve();
  await store.remove(fb.itemId);
  assert.equal(store.isFavorite(b), false);
  page.resolve([fb]);
  await sync;
  assert.equal(store.isFavorite(b), false, '同步期间成功取消收藏后旧分页不能复活标记');
  page = deferred();
  getHandler = async cursor => !cursor ? [fa] : cursor === '300' ? page.promise : [];
  const syncAdd = store.sync();
  await Promise.resolve();
  await store.toggle(c, {name: '测试群', type: 2});
  page.resolve([fb]);
  await syncAdd;
  assert.equal(store.isFavorite(c), true, '同步期间新增收藏不能被旧快照抹掉');
  const save = deferred();
  writeHandler = async () => save.promise;
  const oldWrites = calls.filter(call => call.options.method).length;
  const toggle1 = store.toggle(c);
  const toggle2 = store.toggle(c);
  assert.equal(store.isPending(c), true);
  save.resolve({code: 200});
  await Promise.all([toggle1, toggle2]);
  assert.equal(calls.filter(call => call.options.method).length, oldWrites + 1, '同项并发点击只提交一次');
  assert.equal(store.isFavorite(c), false);
  writeHandler = async () => {throw new Error('取消被拒绝');};
  await assert.rejects(store.remove(fa.itemId), /取消被拒绝/);
  assert.equal(store.isFavorite(a), true);
  writeHandler = async () => ({code: 200});
  console.log('同步与增删竞态、重复点击及失败保留状态回归通过');

  getHandler = async () => [fa];
  await assert.rejects(store.sync(), /游标未推进/);
  assert.equal(store.isFavorite(a), true, '重复游标不得将不完整结果冒充全量成功');
  pages([]);
  await store.sync();
  assert.equal(store.isFavorite(a), false, '跨设备取消后完整同步应清除旧标记');
  const oldAccountPage = deferred();
  getHandler = async () => oldAccountPage.promise;
  const oldSync = store.sync();
  account = 'account-b';
  assert.equal(store.status(a), 'unknown', '换账号后不能读旧快照');
  pages([fc]);
  await store.sync();
  oldAccountPage.resolve([fa]);
  await oldSync;
  assert.deepEqual(store.items.map(item => item.itemId), [fc.itemId], '旧账号迟到响应不能覆盖新账号');
  assert.equal(store.isFavorite(c), true);
  console.log('分页停滞、跨设备删除与账号隔离回归通过');

  const located = {...a, sessionId: 'group', sessionType: 2, sessionName: '测试群'};
  const repeat = {...located, msg_id: 'repeat', send_time: 200};
  const wrongSender = {...located, msg_id: 'wrong', from_id: 'another'};
  const similar = {...located, msg_id: 'similar', content: '第一条（不同正文）'};
  assert.deepEqual(api.favoriteMessageLocations(fa, [located, wrongSender, similar]).map(item => item.msg_id), ['a']);
  assert.deepEqual(api.favoriteMessageLocations(fa, [located, repeat]).map(item => item.msg_id), ['repeat', 'a'], '同内容多次发送必须保留歧义供选择');
  const file = message('file', {file_name: '预算.xlsx', download_url: 'file-id'}, {msg_type: 3});
  const fileFavorite = favorite(file, 1);
  fileFavorite.itemId = '来自其他序列化顺序的标识';
  fileFavorite.content = JSON.stringify({download_url: 'file-id', file_name: '预算.xlsx'});
  assert.equal(api.favoriteMessageLocations(fileFavorite, [{...file, sessionId: 'group', sessionType: 2}]).length, 1, '对象字段顺序不同仍按完整内容确定匹配');
  assert.equal(api.favoriteMessageLocations({...fa, sourceId: ''}, [located]).length, 0, '缺发送人不能用同名或摘要猜测原消息');
  assert.equal(api.favoriteMessageLocations(fa, []).length, 0);
  console.log('收藏原消息精确定位、多候选及完整结构匹配回归通过');
  store.items = [fileFavorite, {...favorite(file, 2), sourceDisplayName: '第二条同内容收藏'}];
  const beforeRemoval = calls.length;
  await store.toggle(file);
  assert.ok(calls[beforeRemoval].url.pathname.endsWith(encodeURIComponent(fileFavorite.itemId)), '索引必须保留原items.find的第一个匹配项顺序');
  const numeric = message('numeric', '123');
  store.items = [{...favorite(numeric, 1), itemId: 'different', content: 123}];
  assert.equal(store.isFavorite(numeric), false, '数字字符串和数字正文不能因规范化混同');
  const many = Array.from({length: 15000}, (_, index) => ({...fa, itemId: 'stored-' + index, sourceId: 'source-' + index, content: 'body-' + index}));
  store.items = many;
  const indexedMessage = message('indexed', 'body-14999', {from_id: 'source-14999'});
  let candidateBuilds = 0, matchKeyBuilds = 0;
  const realCandidate = api.messageFavorite, realKeys = api.favoriteMatchKeys;
  api.messageFavorite = (...args) => {candidateBuilds++; return realCandidate(...args);};
  api.favoriteMatchKeys = (...args) => {matchKeyBuilds++; return realKeys(...args);};
  assert.equal(store.isFavorite(indexedMessage), true, '全量收藏索引必须覆盖最后一项');
  candidateBuilds = 0; matchKeyBuilds = 0;
  for (let row = 0; row < 300; row++) {
    assert.equal(store.status(indexedMessage), 'saved');
    assert.equal(store.isFavorite(indexedMessage), true);
  }
  assert.equal(candidateBuilds, 600, '每次查询只构建一次消息candidate，不得按收藏总数重复MD5');
  assert.equal(matchKeyBuilds, 600, '索引热查询不得重新遍历15000条收藏');
  api.messageFavorite = realCandidate; api.favoriteMatchKeys = realKeys;
  console.log('全量收藏索引：匹配顺序与类型语义不变，300行×15000项无逐行全表扫描回归通过');

})().catch(error => {console.error(error); process.exitCode = 1});
