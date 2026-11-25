/**
 * 应用内统一日志：协议（IM）、登录、云盘/零信任等业务日志，以及所有 console.*、
 * 未捕获异常，都汇总到这里，由「消息 → 更多 → 日志」窗口展示。
 *
 * 约束：最多保留 500 条，单条截断到 2000 字符，避免长跑进程把内存吃满。
 */
import { reactive } from 'vue'

export type LogLevel = 'info' | 'warn' | 'error'

export interface AppLogEntry {
  id: number
  time: string
  /** 来源，如「协议」「登录」「console」「系统」 */
  scope: string
  level: LogLevel
  text: string
}

const MAX_ENTRIES = 500
const MAX_TEXT = 2000

export const appLog = reactive<{ entries: AppLogEntry[] }>({ entries: [] })
let seq = 0
let writing = false

function stamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function logEvent(scope: string, text: string, level: LogLevel = 'info'): void {
  if (writing) return
  writing = true
  try {
    const trimmed = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
    appLog.entries.unshift({ id: ++seq, time: stamp(), scope, level, text: trimmed })
    if (appLog.entries.length > MAX_ENTRIES) appLog.entries.length = MAX_ENTRIES
  } finally {
    writing = false
  }
}

export function clearLogs(): void {
  appLog.entries.length = 0
}

/** console 参数既可能是字符串也可能是对象，尽量转成可读文本且不因循环引用抛错 */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || value.message
  if (value === null || typeof value !== 'object') return String(value)
  try {
    const seen = new WeakSet<object>()
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]'
        seen.add(val)
      }
      return val
    }) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * 接管 console.* 与未捕获异常，让系统各处的输出都能进日志窗口。
 * 只在 main.ts 启动时调用一次；重复调用会把上一层的包装再包一层。
 */
export function installLogCapture(): void {
  const methods: Array<['log' | 'info' | 'debug' | 'warn' | 'error', LogLevel]> = [
    ['log', 'info'],
    ['info', 'info'],
    ['debug', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
  ]
  for (const [method, level] of methods) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]) => {
      logEvent('console', args.map(stringify).join(' '), level)
      original(...args)
    }
  }

  window.addEventListener('error', (event) => {
    const detail = event.error ? stringify(event.error) : `${event.message} (${event.filename}:${event.lineno})`
    logEvent('系统', detail, 'error')
  })
  window.addEventListener('unhandledrejection', (event) => {
    logEvent('系统', `未处理的 Promise 拒绝：${stringify(event.reason)}`, 'error')
  })
}