// 离线回归：运行实际 TypeScript 模块，以模拟 HTTP 校验收藏协议，不连接生产服务。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const requests = [];
let response = { code: 200, data: [] };
let failure = null;
const mocks = {
  '../config': { getServerPaths: () => ({ uamApiUri: 'https://example.invalid/uamapi/' }) },
  '../http': { httpJson: async (url, options = {}) => {
    requests.push({ url, options });
    if (failure) throw failure;
    return response;
  } },
};
function load(file) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(id => {
    if (mocks[id]) return mocks[id];
    assert.equal(id, './types', '不应增加未经模拟的网络依赖');
    return load(path.resolve(path.dirname(file), id + '.ts'));
  }, module, module.exports);
  return module.exports;
}
const api = load(path.join(root, 'src/services/im/favorites.ts'));
const base = { msg_id: 'msg-1', msg_type: 1, from_id: '甲', from_name: '张三', from_type: 1, to_id: 'group-1', to_name: '项目群', to_type: 2, send_time: 1700000000000 };
const md5 = value => crypto.createHash('md5').update(value).digest('base64');
const text = { ...base, content: '你好🙂' };

for (const body of ['', 'abc', '你好🙂', 'x'.repeat(54), 'x'.repeat(55), 'x'.repeat(63), '长'.repeat(1000)]) {
  const message = { ...base, from_id: 'u', content: body || ' ' };
  if (!body) { assert.throws(() => api.messageFavorite(message), /内容为空/); continue; }
  assert.equal(api.favoriteId(message), md5('u' + body), '收藏标识必须匹配 UTF-8 MD5/Base64');
}
assert.deepEqual(api.messageFavorite(text, { name: '项目群', type: 2 }), {
  itemId: md5('甲你好🙂'), contentType: 1, content: '你好🙂', sourceId: '甲', sourceType: 1,
  sourceName: '张三', sourceDisplayName: '张三-项目群', keyword: '张三张三-项目群你好🙂',
});
assert.equal(api.messageFavorite(text, { name: '李四', type: 1 }).sourceDisplayName, '张三');
const file = { ...base, msg_type: 3, content: { download_url: '存储文件-1', file_name: '预算.xlsx', size: 200 } };
const fileDto = api.messageFavorite(file);
assert.equal(fileDto.itemId, md5('甲存储文件-1'));
assert.equal(fileDto.contentType, 6);
assert.deepEqual(JSON.parse(fileDto.content), file.content, '附件正文必须是 JSON 字符串');
assert.equal(api.favoriteId({ ...file, content: JSON.stringify(file.content) }), fileDto.itemId, '对象与 JSON 输入产生相同标识');
const richPhoto = { ...base, msg_type: 96, content: [{ msg_type: 2, content: JSON.stringify(file.content) }] };
assert.equal(api.messageFavorite(richPhoto).contentType, 3, '单张图片富文本按图片收藏');
assert.equal(api.favoriteId(richPhoto), fileDto.itemId);
const emoji1 = { ...base, msg_type: 28, content: { id: 'emoji-1', title: '表情一' } };
const emoji2 = { ...base, msg_type: 28, content: { id: 'emoji-2', title: '表情二' } };
assert.notEqual(api.favoriteId(emoji1), api.favoriteId(emoji2), '不同表情不能覆盖同一收藏');
assert.notEqual(api.favoriteId(emoji1), md5(''), '不能继承官方空 identity 缺陷');
assert.equal(api.favoriteId(emoji1), md5('甲' + JSON.stringify(emoji1.content)));
for (const type of [11, 27, 29]) {
  const card = api.messageFavorite({ ...base, msg_type: type, content: { title: '通知', brief: '正文' } });
  assert.equal(card.contentType, type === 11 ? 12 : type);
  assert.equal(typeof card.content, 'string');
  assert.equal(api.favoriteMessageType(card.contentType), type);
}
for (const type of [4, 8, 19, 25, 30, 66, 999]) assert.throws(() => api.messageFavorite({ ...base, msg_type: type, content: {} }), /不支持/);
for (const value of [null, undefined, '', 'not-json', [], {}]) {
  assert.throws(() => api.messageFavorite({ ...base, msg_type: 11, content: value }), /格式不正确/);
}
assert.throws(() => api.messageFavorite({ ...file, content: {} }), /格式不正确/);
assert.throws(() => api.messageFavorite({ ...file, content: { file_name: '没有地址' } }), /缺少附件地址/);
assert.throws(() => api.messageFavorite({ ...richPhoto, content: [{ msg_type: 2, content: null }] }), /缺少附件地址/);
assert.throws(() => api.messageFavorite({ ...text, from_id: '' }), /缺少发送人/);
assert.equal(api.favoriteContent({ contentType: 1, content: '123' }), '123', '文字收藏不能被 JSON.parse 改为数字');
assert.deepEqual(api.favoriteContent({ contentType: 6, content: fileDto.content }), file.content);

(async () => {
  assert.equal(await api.favoriteMessage(text, { name: '项目群', type: 2 }), md5('甲你好🙂'));
  assert.equal(requests[0].url, 'https://example.invalid/uamapi/v1/favorites');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(requests[0].options.body, { ...api.messageFavorite(text, { name: '项目群', type: 2 }), syncBlogFavor: false });
  response = { code: 200, data: [{ ...fileDto, createdDate: '2026-11-12T12:00:00' }] };
  assert.deepEqual(await api.fetchFavorites({ keyword: '预算', contentTypes: '6', cursor: 123 }), response.data);
  const query = new URL(requests[1].url);
  assert.equal(query.pathname, '/uamapi/v1/favorites');
  assert.deepEqual(Object.fromEntries(query.searchParams), { keyword: '预算', contentTypes: '6', cursor: '123', limit: '15' });
  await api.removeFavorite('a+/b==');
  assert.equal(requests[2].url, 'https://example.invalid/uamapi/v1/favorites/a%2B%2Fb%3D%3D?syncBlogFavor=false');
  assert.equal(requests[2].options.method, 'DELETE');
  await api.removeFavorite('blog-1', true);
  assert.ok(requests[3].url.endsWith('?syncBlogFavor=true'));
  const count = requests.length;
  await assert.rejects(api.removeFavorite(''), /缺少收藏标识/);
  await assert.rejects(api.favoriteMessage({ ...file, content: null }), /格式不正确/);
  assert.equal(requests.length, count, '无效内容不发送收藏请求');
  response = { code: 403, message: '无权限' };
  let confirmedId = '';
  await assert.rejects(async () => { confirmedId = await api.favoriteMessage(text); }, /无权限/);
  assert.equal(confirmedId, '', '服务器拒绝后不能返回成功标识');
  await assert.rejects(api.removeFavorite(fileDto.itemId), /无权限/);
  await assert.rejects(api.fetchFavorites(), /无权限/);
  for (const bad of [null, {}, { code: 0 }, { code: 200, data: {} }, { code: 200, data: [null] }, { code: 200, data: [{ itemId: '', contentType: 1, content: '文字' }] }, { code: 200, data: [{ itemId: 'a', contentType: 1, content: null }] }]) {
    response = bad;
    await assert.rejects(api.fetchFavorites(), /收藏/);
  }
  failure = new Error('HTTP 500');
  await assert.rejects(api.favoriteMessage(text), /HTTP 500/);
  await assert.rejects(api.removeFavorite(fileDto.itemId), /HTTP 500/);
  console.log('消息收藏回归通过：标识去重、中文与表情、真实 DTO、GET/POST/DELETE 协议、非法内容与失败状态。');
})().catch(error => { console.error(error); process.exitCode = 1; });
