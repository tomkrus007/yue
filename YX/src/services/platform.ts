/**
 * 本机能力视图。
 *
 * 平台差异不要散落在页面里：能力由 Rust 侧按平台给出（`capabilities()`），
 * 前端只按它显隐入口。`null` 表示还没查到，此时按「可用」处理，避免 macOS 上闪一下。
 */
import { invoke } from '@tauri-apps/api/core'
import { ref } from 'vue'

export interface Capabilities {
  meeting: boolean
  zero_trust: boolean
  message_sound: boolean
}

const caps = ref<Capabilities | null>(null)
let pending: Promise<void> | null = null

/** 读取一次能力表（全应用共用；失败保持 null）。 */
export function loadCapabilities(): Promise<void> {
  pending ??= invoke<Capabilities>('capabilities')
    .then((value) => {
      caps.value = value
    })
    .catch(() => {
      caps.value = null
    })
  return pending
}

export function useCapabilities() {
  return { caps, loadCapabilities }
}
