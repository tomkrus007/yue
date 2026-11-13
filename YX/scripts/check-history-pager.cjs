// 离线回归：真实历史翻页逻辑，仅模拟 fetchHistory，不访问生产。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const calls = [];
const timers = new Map();
let time = 0, timerId = 0;
function setTimeoutMock(callback, delay) { const id = ++timerId; timers.set(id, {callback, time: time + Number(delay || 0)}); return id; }
function tick(milliseconds) {
  const target = time + milliseconds;
  for (;;) {
    const next = [...timers].filter(([, timer]) => timer.time <= target).sort((a, b) => a[1].time - b[1].time)[0];
    if (!next) break;
    timers.delete(next[0]); time = next[1].time; next[1].callback();
  }
  time = target;
}

let handler = async () => ({messages: [], total: 0});
const moduleUnderTest = {exports: {}};
const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/services/im/history.ts'), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', source)(id => {
  assert.equal(id, './session-api');
  return {fetchHistory: async (targetId, targetType, options) => {
    calls.push({targetId, targetType, ...options});
    return handler({targetId, targetType, ...options});
  }};
}, moduleUnderTest, moduleUnderTest.exports, setTimeoutMock, id => timers.delete(id));
const {HistoryPager} = moduleUnderTest.exports;
const message = id => ({msg_id: String(id), send_time: 12345, msg_type: 1, content: '同毫秒消息' + id});
const page = ids => ({messages: ids.map(message), total: ids.length});
function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no}); return {promise, resolve, reject};}
(async () => {
  calls.length = 0;
  const rows = Array.from({length: 253}, (_, index) => message(index));
  handler = async ({skip, limit}) => ({messages: rows.slice(skip, skip + limit), total: rows.length});
  const pager = new HistoryPager('group', 2, 54321);
  const received = [];
  while (!pager.complete) received.push(...(await pager.next(100)).messages);
  assert.equal(received.length, rows.length);
  assert.equal(new Set(received.map(item => item.msg_id)).size, rows.length, '同一毫秒超过两页也不得漏消息或重复');
  assert.deepEqual(calls.map(call => call.skip), [0, 100, 200]);
  assert.ok(calls.every(call => call.dateTime === 54321 && call.targetId === 'group' && call.targetType === 2));
  assert.equal(pager.offset, 253);
  assert.deepEqual(await pager.next(100), {messages: [], total: 253});
  assert.equal(calls.length, 3, '短页结束后不再请求服务端');
  console.log('固定上界、skip翻页与同毫秒多页完整性回归通过');

  calls.length = 0;
  const wait = deferred();
  handler = async () => wait.promise;
  const concurrent = new HistoryPager('peer', 1, 60000);
  const first = concurrent.next(2), second = concurrent.next(2);
  assert.equal(first, second, '并发next应共用同一请求');
  assert.equal(calls.length, 1);
  wait.resolve(page(['a', 'b']));
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one, two);
  assert.equal(concurrent.offset, 2);
  handler = async () => page([]);
  await concurrent.next(2);
  assert.equal(concurrent.complete, true);
  assert.equal(concurrent.offset, 2);
  console.log('并发去重与空页终止回归通过');

  calls.length = 0;
  let failed = false;
  handler = async ({skip}) => {
    if (!skip) return page(['one', 'two']);
    if (!failed) {failed = true; throw new Error('模拟第二页失败');}
    return page(['three']);
  };
  const retry = new HistoryPager('retry-group', 2, 70000);
  await retry.next(2);
  await assert.rejects(retry.next(2), /第二页失败/);
  assert.equal(retry.offset, 2, '失败不能推进游标');
  assert.equal(retry.complete, false);
  const successfulRetry = await retry.next(2);
  assert.deepEqual(successfulRetry.messages.map(item => item.msg_id), ['three']);
  assert.deepEqual(calls.map(call => call.skip), [0, 2, 2], '重试复用失败页游标');
  assert.equal(retry.complete, true);
  console.log('失败保留游标与重试恢复回归通过');

  calls.length = 0;
  let repeated = true;
  handler = async ({skip}) => !skip || repeated ? page(skip ? ['b', 'a'] : ['a', 'b']) : page(['c']);
  const stuck = new HistoryPager('stuck', 2, 80000);
  await stuck.next(2);
  await assert.rejects(stuck.next(2), /分页未推进|重复/);
  assert.equal(stuck.offset, 2, '重复页错误不能继续推进');
  assert.equal(stuck.complete, false);
  repeated = false;
  await stuck.next(2);
  assert.equal(stuck.offset, 3);
  assert.equal(stuck.complete, true);
  console.log('重复页重排检测与错误后恢复回归通过');

  const empty = new HistoryPager('empty', 2, 90000);
  handler = async () => page([]);
  await empty.next(100);
  assert.equal(empty.complete, true);
  assert.equal(empty.offset, 0);
  console.log('首次空页结束回归通过');
  handler = async ({skip}) => skip === 0 || skip === 4 ? page(['a', 'b']) : page(['c', 'd']);
  const cycle = new HistoryPager('cycle', 2, 100000);
  await cycle.next(2); await cycle.next(2);
  await assert.rejects(cycle.next(2), /分页未推进|重复/);
  assert.equal(cycle.offset, 4, '非相邻重复页也必须停止推进');
  console.log('A→B→A循环页停止推进回归通过');

  let signal;
  handler = ({signal: requestSignal}) => {
    signal = requestSignal;
    assert.ok(signal instanceof AbortSignal, '真实请求必须收到AbortSignal');
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('请求已中止')), {once: true}));
  };
  const timed = new HistoryPager('timeout', 2, 110000);
  const timeoutRequest = timed.next(2);
  tick(14999); assert.equal(signal.aborted, false);
  tick(1); assert.equal(signal.aborted, true);
  await assert.rejects(timeoutRequest, /中止/);
  assert.equal(timed.offset, 0); assert.equal(timed.complete, false);
  handler = async () => page(['after-timeout']);
  await timed.next(2);
  assert.equal(timed.offset, 1, '超时后允许从原游标重试');
  assert.equal(timed.complete, true);

  const canceled = new HistoryPager('cancel', 2, 120000);
  canceled.cancel();
  handler = ({signal: requestSignal}) => new Promise((_, reject) => {
    signal = requestSignal;
    signal.addEventListener('abort', () => reject(new Error('主动取消')), {once: true});
  });
  const cancelRequest = canceled.next(2);
  canceled.cancel();
  assert.equal(signal.aborted, true);
  await assert.rejects(cancelRequest, /取消/);
  assert.equal(canceled.offset, 0); assert.equal(canceled.complete, false);
  handler = async () => page(['after-cancel']);
  await canceled.next(2);
  assert.equal(canceled.offset, 1);
  assert.equal(timers.size, 0, '成功、超时、取消后均须清理计时器');
  console.log('15秒超时、主动取消、游标保留及重试回归通过（假时钟）');

})().catch(error => {console.error(error); process.exitCode = 1});
