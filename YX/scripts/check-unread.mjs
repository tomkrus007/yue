// 回归检查：选择一个会话后，后台偏好同步不得清掉其他会话的未读。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/stores/im.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('im.ts', source, ts.ScriptTarget.Latest, true)
const names = ['selectSession', 'clearUnread', 'loadPreferenceStates', 'applyMute']
const functions = []
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) functions.push(node.getText(ast))
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(functions.length, names.length)
const ref = (value) => ({ value })
const context = vm.createContext({
  prefsLoaded: false, prefsLoading: false,
  currentSessionId: ref(''), chatActive: ref(true),
  hiddenSessions: ref({}), localReadConfirmations: ref({}), imClient: { authed: false },
  unread: ref({ a: 2, b: 3, c: 4 }), unreadAt: ref({ c: 1 }),
  muted: ref(new Set()), folded: ref(new Set()), pinned: ref({}), directory: ref(new Map()),
  sessions: ref(['a', 'b', 'c'].map((id) => ({ id, type: 1 }))),
  messages: ref([{ sessionId: 'a' }]),
  loadDirectory: async () => new Map(), loadPinned: async () => [],
  loadFoldStates: async () => new Set(),
  loadMuteStates: async () => new Map([['b', true], ['c', true]]),
  fillNamesFromDirectory() {}, persistSessions() {}, persistFolded() {},
  persistMuted() {}, persistUnread() {}, persistInteractions() {},
})
vm.runInContext(ts.transpileModule(functions.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, context)
// 模拟登录后的偏好请求仍在等待时，用户打开 A 会话。
await vm.runInContext('const pending = loadPreferenceStates(); selectSession("a"); pending', context)
assert.equal(context.unread.value.a, undefined)
assert.equal(context.unread.value.b, 3, '后台同步误清了 B 会话未读')
assert.equal(context.unread.value.c, 4, '后台同步误改了 C 会话未读')
// 显式修改 B 的免打扰设置，也只能影响 B。
vm.runInContext('applyMute("b", true)', context)
assert.equal(context.unread.value.b, undefined)
assert.equal(context.unread.value.c, 4, '设置 B 的免打扰误改了 C 会话未读')
console.log('通过：选择会话、后台偏好同步、单会话免打扰操作的未读隔离检查')
