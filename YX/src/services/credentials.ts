/**
 * 「记住密码 / 自动登录」本地存储。
 * 与参考实现一致：只是 Base64 混淆，不是加密，仅供本机便利。
 */
import { STORAGE_KEYS } from './config'

export interface SavedCreds {
  username: string
  /** Base64 后的密码 */
  password: string
  remember: boolean
  auto: boolean
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function fromBase64(b64: string): string {
  try {
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

export function encodeSavedPassword(password: string): string {
  return toBase64(String(password || ''))
}

export function decodeSavedPassword(saved: string): string {
  return fromBase64(saved)
}

export function loadCreds(): SavedCreds | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.savedCreds)
    if (!raw) return null
    const c = JSON.parse(raw)
    if (!c || typeof c !== 'object' || !c.username) return null
    return {
      username: String(c.username),
      password: String(c.password || ''),
      remember: Boolean(c.remember),
      auto: Boolean(c.auto),
    }
  } catch {
    return null
  }
}

export function saveCreds(c: SavedCreds): void {
  localStorage.setItem(STORAGE_KEYS.savedCreds, JSON.stringify(c))
}

export function clearCreds(): void {
  localStorage.removeItem(STORAGE_KEYS.savedCreds)
}

/** 退出后保留「记住密码」方便下次一键登录，但关掉自动登录。 */
export function disableAutoLogin(): void {
  const c = loadCreds()
  if (!c) return
  saveCreds({ ...c, auto: false })
}