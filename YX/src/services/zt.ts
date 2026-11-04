/**
 * 零信任代理：前端只负责配置与展示，真正的转发在 Rust（src-tauri/src/zt.rs）。
 * 对齐 yx-cloud-kb 的 kit/src/zt：白名单式分流，支持 HTTP CONNECT / 普通 HTTP / SOCKS5。
 */
import { invoke } from '@tauri-apps/api/core'

export type ZtAction = 'direct' | 'proxy' | 'block'

export interface ZtRuleMatch {
  hostExact: string[]
  hostSuffix: string[]
  hostRegex: string[]
  cidr: string[]
  port?: Array<string | number> | string | number
}

export interface ZtRule {
  id: string
  action: ZtAction
  note: string
  match: ZtRuleMatch
}

export interface ZtConfig {
  enabled: boolean
  listen: { host: string; port: number }
  defaultAction: ZtAction
  fallback: 'direct' | 'block'
  upstream: { type: 'direct' | 'http' | 'socks5'; host: string; port: number }
  rules: ZtRule[]
}

export interface ZtStats {
  total: number
  direct: number
  proxy: number
  block: number
  failed: number
}

export interface ZtLogEntry {
  seq: number
  ts: number
  proto: string
  host: string
  port: number
  rule: string | null
  action: ZtAction
  reason: string
  up: number
  down: number
  ok: boolean
  err: string | null
  ms: number | null
}

export interface ZtStatus {
  running: boolean
  host: string
  port: number
  startedAt: number
  stats: ZtStats
  logs: ZtLogEntry[]
  config: ZtConfig | null
}

export const DEFAULT_ZT_CONFIG: ZtConfig = {
  enabled: true,
  listen: { host: '127.0.0.1', port: 8899 },
  defaultAction: 'direct',
  fallback: 'direct',
  upstream: { type: 'http', host: '127.0.0.1', port: 1080 },
  rules: [],
}

export function loadZtConfig(): ZtConfig {
  try {
    const raw = localStorage.getItem('yl.zt.config')
    if (!raw) return cloneDefault()
    const cfg = JSON.parse(raw)
    return normalizeZtConfig(cfg)
  } catch {
    return cloneDefault()
  }
}

function cloneDefault(): ZtConfig {
  return JSON.parse(JSON.stringify(DEFAULT_ZT_CONFIG)) as ZtConfig
}

export function saveZtConfig(cfg: ZtConfig): void {
  localStorage.setItem('yl.zt.config', JSON.stringify(cfg))
}

export function normalizeZtConfig(input: any): ZtConfig {
  const base = cloneDefault()
  const cfg: ZtConfig = {
    ...base,
    ...(input || {}),
    listen: { ...base.listen, ...(input?.listen || {}) },
    upstream: { ...base.upstream, ...(input?.upstream || {}) },
    rules: Array.isArray(input?.rules) ? input.rules : [],
  }
  if (!['direct', 'proxy', 'block'].includes(cfg.defaultAction)) {
    cfg.defaultAction = 'direct'
  }
  if (!['direct', 'block'].includes(cfg.fallback)) cfg.fallback = 'direct'
  if (!['direct', 'http', 'socks5'].includes(cfg.upstream.type)) {
    cfg.upstream.type = 'direct'
  }
  cfg.rules = cfg.rules.map((r, i) => ({
    id: r?.id || `rule-${i}`,
    action: ['direct', 'proxy', 'block'].includes(r?.action)
      ? r.action
      : 'proxy',
    note: r?.note || '',
    match: {
      hostExact: r?.match?.hostExact || [],
      hostSuffix: r?.match?.hostSuffix || [],
      hostRegex: r?.match?.hostRegex || [],
      cidr: r?.match?.cidr || [],
      port: r?.match?.port,
    },
  }))
  return cfg
}

export async function ztStart(config: ZtConfig): Promise<ZtStatus> {
  return invoke<ZtStatus>('zt_start', { config })
}

export async function ztStop(): Promise<void> {
  await invoke('zt_stop')
}

export async function ztStatus(): Promise<ZtStatus> {
  return invoke<ZtStatus>('zt_status')
}

export function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return (i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i]
}

export function fmtTs(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (x: number) => String(x).padStart(2, '0')
  return (
    [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join(':') +
    '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  )
}