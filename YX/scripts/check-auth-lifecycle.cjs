// 离线回归：运行真实 AuthService.refreshToken，只模拟账号存储、配置和 Tauri HTTP。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const saved = new Map(), writes = [], calls = [];
const keys = {accessToken: 'AccessToken', authAccessToken: 'auth_accessToken', refreshToken: 'refresh_token', currentUserId: 'CurrentUserId', currentUserName: 'CurrentUserName', expiresAt: 'expires_at', deviceId: 'DeviceId'};
const localStorage = {
  getItem: key => saved.get(key) ?? null,
  setItem: (key, value) => {saved.set(key, String(value)); writes.push({key, value: String(value)});},
  removeItem: key => saved.delete(key),
};
let sso = 'https://offline.invalid/sso';
let fetchHandler = async () => ({ok: true, json: async () => ({})});
const loggedErrors = [];
const mocks = {
  jsencrypt: class MockJSEncrypt {setPublicKey() {} encrypt() {throw new Error('本回归不得触发密码登录');}},
  '@tauri-apps/plugin-http': {fetch: async (url, options) => {calls.push({url, options}); return fetchHandler(url, options);}},
  './config': {DEFAULT_CONFIG: {clientId: 'offline-client', clientSecret: 'offline-secret'}, STORAGE_KEYS: keys, getServerPaths: () => ({ssoUri: sso}), saveServerPaths: () => {throw new Error('本回归不得拉配置中心');}},
  // 本回归只覆盖 refresh_token 路径；静默重登用的账号口令视为未保存
  './credentials': {loadCreds: () => null, decodeSavedPassword: () => ''},
};
const moduleUnderTest = {exports: {}};
new Function('require', 'module', 'exports', 'localStorage', 'console', ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/services/auth.ts'), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText)(id => {
  assert.ok(mocks[id], '禁止未模拟的依赖：' + id);
  return mocks[id];
}, moduleUnderTest, moduleUnderTest.exports, localStorage, {error: (...args) => loggedErrors.push(args)});
const {AuthService} = moduleUnderTest.exports;
function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no}); return {promise, resolve, reject};}
function response(ok, json) {return {ok, json: async () => json};}
function account(uid, access, refresh) {
  localStorage.setItem(keys.currentUserId, uid);
  localStorage.setItem(keys.accessToken, access);
  localStorage.setItem(keys.authAccessToken, access);
  localStorage.setItem(keys.refreshToken, refresh);
  localStorage.setItem(keys.expiresAt, '0');
}
function snapshot() {return [...saved.entries()];}
(async () => {
  const auth = new AuthService();
  account('account-a', 'token-a', 'refresh-a');
  const pending = deferred();
  fetchHandler = async () => pending.promise;
  writes.length = 0; calls.length = 0;
  const first = auth.refreshToken(), concurrent = auth.refreshToken();
  assert.equal(calls.length, 1, '同账号同刷新凭据的并发刷新只请求一次');
  assert.equal(calls[0].url, 'https://offline.invalid/sso/oauth2/token');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].options.body)), {grant_type: 'refresh_token', refresh_token: 'refresh-a'});
  assert.ok(calls[0].options.headers.Authorization.startsWith('Basic '));
  pending.resolve(response(true, {access_token: 'token-a-new', refresh_token: 'refresh-a-next', expires_in: 3600}));
  assert.deepEqual(await Promise.all([first, concurrent]), ['token-a-new', 'token-a-new']);
  assert.equal(saved.get(keys.accessToken), 'token-a-new');
  assert.equal(saved.get(keys.authAccessToken), 'token-a-new');
  assert.equal(saved.get(keys.refreshToken), 'refresh-a-next');
  assert.equal(writes.filter(item => item.key === keys.accessToken).length, 1, '去重后的成功只写回一次');
  assert.ok(Number(saved.get(keys.expiresAt)) > Date.now());
  console.log('真实刷新协议、同账号并发去重及一次写回回归通过');

  const beforeFailure = snapshot();
  writes.length = 0;
  fetchHandler = async () => response(false, {access_token: '不得写入', refresh_token: '不得写入'});
  assert.equal(await auth.refreshToken(), null);
  assert.deepEqual(snapshot(), beforeFailure, 'HTTP失败不能写入响应中的token');
  assert.equal(writes.length, 0);
  fetchHandler = async () => {throw new Error('模拟网络断开');};
  assert.equal(await auth.refreshToken(), null);
  assert.deepEqual(snapshot(), beforeFailure);
  assert.ok(loggedErrors.length);
  fetchHandler = async () => response(true, {access_token: 'retried-token'});
  assert.equal(await auth.refreshToken(), 'retried-token', '失败后应解除inflight，可重试');
  assert.equal(saved.get(keys.expiresAt), '0', '缺少过期时间时保持未知，不立即过期');
  console.log('HTTP/网络失败不写回及失败后重试回归通过');

  account('account-a', 'token-a', 'refresh-a');
  const old = deferred(); fetchHandler = async () => old.promise;
  const oldRequest = auth.refreshToken();
  account('account-b', 'token-b', 'refresh-b');
  writes.length = 0;
  old.resolve(response(true, {access_token: '迟到的旧账号token', refresh_token: 'old-refresh'}));
  assert.equal(await oldRequest, null);
  assert.equal(saved.get(keys.accessToken), 'token-b');
  assert.equal(saved.get(keys.refreshToken), 'refresh-b');
  assert.equal(writes.length, 0, '旧账号迟到响应不得写新账号存储');

  account('account-a', 'token-a', 'refresh-a');
  const enteredJson = deferred(), json = deferred();
  fetchHandler = async () => ({ok: true, json: () => {enteredJson.resolve(); return json.promise;}});
  const bodyRequest = auth.refreshToken();
  await enteredJson.promise;
  account('account-a', 'new-login-token', 'new-login-refresh');
  writes.length = 0;
  json.resolve({access_token: '旧刷新正文token', refresh_token: 'old-refresh'});
  assert.equal(await bodyRequest, null);
  assert.equal(saved.get(keys.accessToken), 'new-login-token');
  assert.equal(saved.get(keys.refreshToken), 'new-login-refresh');
  assert.equal(writes.length, 0, '同UID重新登录换refresh凭据后也不能接收旧刷新');
  console.log('账号切换、响应正文阶段换号与refresh凭据更换隔离回归通过');

  account('account-a', 'token-a', 'refresh-a');
  const a = deferred(), b = deferred();
  fetchHandler = async (_url, options) => new URLSearchParams(options.body).get('refresh_token') === 'refresh-a' ? a.promise : b.promise;
  calls.length = 0;
  const requestA = auth.refreshToken();
  account('account-b', 'token-b', 'refresh-b');
  const requestB = auth.refreshToken();
  assert.equal(calls.length, 2, '不同账号刷新不能错误共用旧inflight');
  a.resolve(response(true, {access_token: 'old-a'}));
  assert.equal(await requestA, null);
  const sameB = auth.refreshToken();
  assert.equal(calls.length, 2, '旧请求finally不能清掉新账号inflight');
  b.resolve(response(true, {access_token: 'new-b', refresh_token: 'new-refresh-b'}));
  assert.deepEqual(await Promise.all([requestB, sameB]), ['new-b', 'new-b']);
  assert.equal(saved.get(keys.accessToken), 'new-b');
  assert.equal(saved.get(keys.refreshToken), 'new-refresh-b');

  const logoutPending = deferred(); fetchHandler = async () => logoutPending.promise;
  const logoutRequest = auth.refreshToken();
  auth.logout();
  writes.length = 0;
  logoutPending.resolve(response(true, {access_token: '注销后的迟到token'}));
  assert.equal(await logoutRequest, null);
  assert.equal(saved.get(keys.accessToken), undefined);
  assert.equal(writes.length, 0);
  const count = calls.length;
  assert.equal(await auth.refreshToken(), null);
  assert.equal(calls.length, count, '缺刷新凭据不请求远端');
  console.log('新旧inflight交错、注销隔离及缺凭据回归通过');
})().catch(error => {console.error(error); process.exitCode = 1});
