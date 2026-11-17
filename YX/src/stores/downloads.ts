import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { ImageMeta } from '../services/im/content'
import { authService } from '../services/auth'
import { saveAttachment, type SavedDownload } from '../services/im/transfers'

export interface DownloadJob { id: string; state: 'downloading' | 'done' | 'cancelled' | 'failed'; received: number; total?: number; path?: string; error?: string }
export const useDownloadsStore = defineStore('downloads', () => {
  const jobs = ref<Record<string, DownloadJob>>({})
  const pending = new Map<string, Promise<SavedDownload>>()
  const controllers = new Map<string, { accountId: string; controller: AbortController }>()
  function key(seg: ImageMeta, accountId = authService.getCurrentUserId()) { return `${accountId}|${seg.downloadUrl}|${seg.fileName}` }
  function jobFor(seg: ImageMeta) { return jobs.value[key(seg)] }
  function start(seg: ImageMeta): Promise<SavedDownload> {
    const accountId = authService.getCurrentUserId()
    const identity = key(seg, accountId)
    const active = pending.get(identity)
    if (active) return active
    const previous = jobs.value[identity]
    if (previous?.state === 'done' && previous.path) return Promise.resolve({ id: previous.id, path: previous.path })
    const id = crypto.randomUUID()
    const controller = new AbortController()
    const job: DownloadJob = { id, state: 'downloading', received: 0 }
    jobs.value[identity] = job
    controllers.set(identity, { accountId, controller })
    const task = saveAttachment(seg, id, controller, (received, total) => {
      Object.assign(jobs.value[identity], { received, total })
    }).then(saved => {
      Object.assign(jobs.value[identity], { state: 'done', path: saved.path, error: '' })
      return saved
    }).catch(error => {
      // plugin-http 的网络错误按字符串 reject（非 Error 实例），要显示真实文本而不是吞成「下载失败」。
      const message = error instanceof Error ? error.message : (typeof error === 'string' && error.trim()) || '下载失败'
      Object.assign(jobs.value[identity], { state: controller.signal.aborted ? 'cancelled' : 'failed', error: String(message).replace(/https?:\/\/[^\s)]+/g, '[请求地址]') })
      throw error
    }).finally(() => { pending.delete(identity); controllers.delete(identity) })
    pending.set(identity, task)
    return task
  }
  async function cancel(seg: ImageMeta) {
    const identity = key(seg)
    controllers.get(identity)?.controller.abort()
    const job = jobs.value[identity]
    if (job) await invoke('attachment_download_cancel', { id: job.id })
  }
  async function cancelAll(accountId?: string) {
    const active = [...controllers.entries()].filter(([, owner]) => accountId === undefined || owner.accountId === accountId)
    for (const [, owner] of active) owner.controller.abort()
    await Promise.allSettled(active.map(async ([identity]) => {
      const job = jobs.value[identity]
      if (job) await invoke('attachment_download_cancel', { id: job.id }).catch(() => {})
      await pending.get(identity)?.catch(() => {})
    }))
  }
  async function open(seg: ImageMeta) {
    const job = jobFor(seg)
    if (!job?.path) return
    try { await invoke('attachment_download_open', { id: job.id }) }
    catch { job.error = '文件已移动或无法打开，可重新下载'; job.state = 'failed' }
  }
  return { jobs, jobFor, start, cancel, cancelAll, open }
})
