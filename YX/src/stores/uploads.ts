import { defineStore } from 'pinia'
import { ref } from 'vue'
import { uploadFileToDir } from '../services/disk-upload'

export type UploadStatus = 'queued' | 'uploading' | 'saving' | 'done' | 'error'

export interface UploadTask {
  id: string
  name: string
  dirId: string
  dirLabel: string
  file: File
  status: UploadStatus
  /** 上传进度 0-100 */
  progress: number
  error: string
  /** 同一批上传完成后的回调（用于刷新目录） */
  onSettled?: () => void
}

const MAX_CONCURRENT = 2
const DONE_HIDE_MS = 5000

export const useUploadStore = defineStore('uploads', () => {
  const tasks = ref<UploadTask[]>([])
  const visible = ref(false)
  const collapsed = ref(false)
  let seq = 0
  let active = 0

  function enqueue(files: File[], dirId: string, dirLabel: string, onSettled?: () => void) {
    if (!files.length) return
    if (!dirId) throw new Error('请先进入一个目录')
    for (const file of files) {
      tasks.value.push({
        id: `u${Date.now()}-${++seq}`,
        name: file.name,
        dirId,
        dirLabel,
        file,
        status: 'queued',
        progress: 0,
        error: '',
        onSettled,
      })
    }
    visible.value = true
    collapsed.value = false
    pump()
  }

  function pump() {
    while (active < MAX_CONCURRENT) {
      const task = tasks.value.find((t) => t.status === 'queued')
      if (!task) break
      void run(task)
    }
  }

  async function run(task: UploadTask) {
    task.status = 'uploading'
    task.progress = 0
    task.error = ''
    active += 1
    try {
      await uploadFileToDir(task.file, task.dirId, (pct) => {
        task.progress = Math.min(99, pct)
        if (pct >= 100) task.status = 'saving'
      })
      task.status = 'done'
      task.progress = 100
      task.onSettled?.()
      window.setTimeout(() => remove(task.id), DONE_HIDE_MS)
    } catch (e: any) {
      task.status = 'error'
      task.error = e?.message || String(e)
      visible.value = true
      collapsed.value = false
    } finally {
      active -= 1
      pump()
    }
  }

  function retry(id: string) {
    const task = tasks.value.find((t) => t.id === id)
    if (!task || task.status !== 'error') return
    task.status = 'queued'
    task.error = ''
    task.progress = 0
    visible.value = true
    collapsed.value = false
    pump()
  }

  function retryAll() {
    for (const task of tasks.value) {
      if (task.status === 'error') {
        task.status = 'queued'
        task.error = ''
        task.progress = 0
      }
    }
    visible.value = true
    collapsed.value = false
    pump()
  }

  function remove(id: string) {
    tasks.value = tasks.value.filter((t) => t.id !== id)
    if (!tasks.value.length) visible.value = false
  }

  function clearFinished() {
    tasks.value = tasks.value.filter((t) => t.status !== 'done')
    if (!tasks.value.length) visible.value = false
  }

  function close() {
    // 有未完成任务时只收起，避免把进度藏掉
    if (tasks.value.some((t) => t.status !== 'done')) {
      collapsed.value = true
    } else {
      visible.value = false
      tasks.value = []
    }
  }

  return {
    tasks,
    visible,
    collapsed,
    enqueue,
    retry,
    retryAll,
    remove,
    clearFinished,
    close,
  }
})
