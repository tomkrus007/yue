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
const message = (id, sendTime) => ({msg_id: String(id), send_time: sendTime, msg_type: 1, content: '消息' + id});
const page = ids => ({messages: ids.map((id, index) => message(id, 12345 - index)), total: ids.length});
/** 模拟真实服务端：dateTime 是含上界，忽略 skip，按时间倒序返回。 */
const server = rows => async ({dateTime, limit}) => ({
  messages: rows.filter(row => row.send_time <= dateTime).slice(0, limit),
  total: rows.length,
});
function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no}); return {promise, resolve, reject};}
(async () => {
  calls.length = 0;
  const rows = Array.from({length: 253}, (_, index) => message(index, 100000 - index));
  handler = server(rows);
  const pager = new HistoryPager('group', 2, 200000);
  const received = [];
  while (!pager.complete) received.push(...(await pager.next(100)).messages);
  assert.equal(received.length, rows.length);
  assert.equal(new Set(received.map(item => item.msg_id)).size, rows.length, '翻页不得漏消息或重复交付');
  assert.deepEqual(received.map(item => item.msg_id), rows.map(item => item.msg_id));
  assert.ok(calls.every(call => call.skip === undefined && call.targetId === 'group' && call.targetType === 2));
  assert.equal(calls[0].dateTime, 200000, '第一页使用固定查询上界');
  assert.ok(calls.every((call, index) => index === 0 || call.dateTime < calls[index - 1].dateTime), 'dateTime 必须逐页往前推');
  assert.equal(pager.offset, 253);
  const finishedCalls = calls.length;
  assert.deepEqual(await pager.next(100), {messages: [], total: 253});
  assert.equal(calls.length, finishedCalls, '结束后不再请求服务端');
  console.log('dateTime 上界翻页与去重完整性回归通过');

  calls.length = 0;
  const sameMs = [
    message('m0', 1000), message('m1', 999), message('m2', 998),
    message('m3', 500), message('m4', 500), message('m5', 400),
  ];
  handler = server(sameMs);
  const boundary = new HistoryPager('same-ms', 2, 2000);
  const boundaryIds = [];
  while (!boundary.complete) boundaryIds.push(...(await boundary.next(4)).messages.map(item => item.msg_id));
  assert.deepEqual(boundaryIds, ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'], '页尾落在同一毫秒时不得漏掉同毫秒的其余消息');
  console.log('同一毫秒跨页不丢消息回归通过');

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
  const retryRows = [message('a', 500), message('b', 400), message('c', 300)];
  handler = async ({dateTime, limit}) => {
    if (dateTime === 400 && !failed) { failed = true; throw new Error('模拟第二页失败'); }
    return {messages: retryRows.filter(row => row.send_time <= dateTime).slice(0, limit), total: 3};
  };
  const retry = new HistoryPager('retry-group', 2, 1000);
  await retry.next(2);
  assert.equal(retry.offset, 2);
  await assert.rejects(retry.next(2), /第二页失败/);
  assert.equal(retry.offset, 2, '失败不能推进游标');
  assert.equal(retry.complete, false);
  const successfulRetry = await retry.next(2);
  assert.deepEqual(successfulRetry.messages.map(item => item.msg_id), ['c']);
  assert.equal(calls[calls.length - 1].dateTime, 400, '重试复用失败页游标');
  assert.equal(retry.offset, 3);
  await retry.next(2);
  assert.equal(retry.complete, true);
  console.log('失败保留游标与重试恢复回归通过');

  calls.length = 0;
  const stuckPage = {messages: [message('a', 80000), message('b', 80000)], total: 2};
  handler = async () => stuckPage;
  const stuck = new HistoryPager('stuck', 2, 80000);
  await stuck.next(2);
  let guard = 0;
  while (!stuck.complete && guard++ < 10) await stuck.next(2);
  assert.equal(stuck.complete, true, '服务端反复返回同一页时必须终止而不是报错');
  assert.equal(guard < 10, true, '反复页不得无限请求');
  assert.equal(stuck.offset, 2, '已交付消息不会因重复页再次计数');
  console.log('服务端重复页自动停止且不抛错回归通过');

  const empty = new HistoryPager('empty', 2, 90000);
  handler = async () => page([]);
  await empty.next(100);
  assert.equal(empty.complete, true);
  assert.equal(empty.offset, 0);
  console.log('首次空页结束回归通过');

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
