// 使用真实消息入库逻辑检查未读数、托盘合计和提示音调用。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const ast = ts.createSourceFile('im.ts', readFileSync(new URL('../src/stores/im.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
let addMessage
let trayUnread
const readingFunctions = []
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ['clearUnread', 'setChatActive'].includes(node.name?.text)) readingFunctions.push(node.getText(ast))
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'addMessage') addMessage = node.getText(ast)
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'trayUnread') trayUnread = node.getText(ast)
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(addMessage && trayUnread)
const code = ts.transpileModule(`${addMessage}\n${readingFunctions.join("\n")}\nvar ${trayUnread}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const ref = (value) => ({ value })
const calls = []
const context = vm.createContext({
  messages: ref([]), unread: ref({}), unreadAt: ref({}), unreadIds: ref(new Set()),
  muted: ref(new Set()), folded: ref(new Set()), currentSessionId: ref(''), chatActive: ref(true), lastSoundAt: 0,
  authService: { getCurrentUserId: () => 'me', getDeviceId: () => 'local' },
  sessionOfMsg: () => ({ id: 'peer', type: 1, name: '测试会话' }),
  isMine: (m) => m.from_id === 'me', isServiceAccount: () => false,
  upsertSession: () => ({}), previewOfMessage: () => '', TO_MULTI_TYPES: new Set([2, 4, 8]),
  persistUnread() {}, persistMessages() {}, persistSessions() {}, log() {},
  invoke: async (command) => { calls.push(command) },
  computed: (getter) => ({ get value() { return getter() } }),
})
vm.runInContext(code, context)
context.msg = { msg_id: 'new', msg_type: 1, from_id: 'peer', from_device: 'remote', is_read: 0, offline: false }
vm.runInContext('addMessage(msg)', context)
assert.equal(context.unread.value.peer, 1, '消息界面应有未读数')
assert.equal(vm.runInContext('trayUnread.value', context), 1, '托盘应有未读合计')
assert.deepEqual(calls, ['play_message_sound'], '实时新消息应播放提示音')
vm.runInContext('addMessage(msg)', context)
assert.equal(context.unread.value.peer, 1, '重复消息不得累计未读')
assert.equal(calls.length, 1, '重复消息不得重复响铃')
console.log('通过：普通实时消息的未读数、托盘合计、提示音及去重检查')

// 隐藏后仍选中的会话也应累计未读和托盘数字。
context.currentSessionId.value = 'peer'
context.chatActive.value = false
context.unread.value = {}
context.msg = { ...context.msg, msg_id: 'hidden-current' }
vm.runInContext('addMessage(msg)', context)
assert.equal(context.unread.value.peer, 1, '隐藏窗口的当前会话不能自动视为已读')
assert.equal(vm.runInContext('trayUnread.value', context), 1, '隐藏窗口的当前会话应计入托盘未读')
console.log('通过：隐藏窗口的当前会话未读检查')

// 恢复到前台只清除当前会话，其他会话保留；前台新消息不累计未读。
context.unread.value.other = 3
vm.runInContext('setChatActive(true)', context)
assert.equal(context.unread.value.peer, undefined)
assert.equal(context.unread.value.other, 3, '恢复窗口不能清除其他会话未读')
context.msg = { ...context.msg, msg_id: 'visible-current' }
vm.runInContext('addMessage(msg)', context)
assert.equal(context.unread.value.peer, undefined, '正在查看的会话无需累计未读')
console.log('通过：恢复窗口的已读范围及前台会话检查')

// 免打扰接口的关闭值即使是字符串，也不能屏蔽普通会话的提醒。
const prefsAst = ts.createSourceFile('prefs.ts', readFileSync(new URL('../src/services/im/prefs.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const prefsFunctions = prefsAst.statements.filter((node) => ts.isFunctionDeclaration(node) && ['normalizeList', 'uamBase', 'loadMuteStates'].includes(node.name?.text)).map((node) => node.getText(prefsAst).replace(/^export /, ''))
const prefsContext = vm.createContext({
  getServerPaths: () => ({ uamApiUri: 'https://example.invalid' }),
  httpJson: async (url) => url.endsWith('/nodisturbing/list')
    ? [{ instanceId: 'off', msgReceiveMode: '0' }, { instanceId: 'on', msgReceiveMode: 1 }]
    : url.endsWith('/organizations/list')
      ? [{ orgId: 'org-off', msgReceiveType: '0' }] : [],
})
vm.runInContext(ts.transpileModule(prefsFunctions.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, prefsContext)
const muteStates = await vm.runInContext('loadMuteStates()', prefsContext)
assert.equal(muteStates.has('off'), false, '字符串 0 被误判为单聊免打扰，会屏蔽所有提醒')
assert.equal(muteStates.has('org-off'), false, '字符串 0 被误判为组织免打扰')
assert.equal(muteStates.has('on'), true, '真正免打扰的会话必须保持静音')
console.log('通过：免打扰数值状态兼容检查')
