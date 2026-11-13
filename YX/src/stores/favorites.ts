import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { authService } from '../services/auth'
import { getServerPaths } from '../services/config'
import type { ImMessage } from '../services/im/im-client'
import {
  favoriteId, favoriteMatchKeys, favoriteMessage, fetchFavorites, messageFavorite, removeFavorite, type Favorite,
} from '../services/im/favorites'

export type FavoriteStatus = 'saved' | 'unsaved' | 'unknown'

/** 全量列表成功才替换快照；部分分页和失败不能清除尚未看到的收藏。 */
export const useFavoritesStore = defineStore('favorites', () => {
  const items = ref<Favorite[]>([])
  const loading = ref(false)
  const complete = ref(false)
  const error = ref('')
  const lastSyncedAt = ref(0)
  const pending = ref<Record<string, boolean>>({})
  let account = ''
  let generation = 0
  let revision = 0
  let request: Promise<void> | null = null
  const commits = new Map<string, { revision: number; item: Favorite | null }>()
  const indexed = computed(() => {
    const identities = new Map<string, { item: Favorite; position: number }>()
    const contents = new Map<string, { item: Favorite; position: number }>()
    items.value.forEach((item, position) => {
      if (!item.sourceId) return
      const keys = favoriteMatchKeys(item)
      if (!identities.has(keys.identity)) identities.set(keys.identity, { item, position })
      if (!contents.has(keys.content)) contents.set(keys.content, { item, position })
    })
    return { identities, contents }
  })

  function savedCandidate(candidate: Favorite): Favorite | undefined {
    const keys = favoriteMatchKeys(candidate)
    const identity = indexed.value.identities.get(keys.identity)
    const content = indexed.value.contents.get(keys.content)
    if (!identity) return content?.item
    if (!content) return identity.item
    // 保持原先 items.find 的顺序：完整正文匹配早于同 ID 项时也不改取消目标。
    return identity.position <= content.position ? identity.item : content.item
  }

  function scope(): string {
    return JSON.stringify([authService.getCurrentUserId(), getServerPaths().uamApiUri])
  }
  function ensureAccount(): string {
    const next = scope()
    if (next !== account) {
      account = next
      generation++
      items.value = []
      loading.value = false
      complete.value = false
      error.value = ''
      lastSyncedAt.value = 0
      pending.value = {}
      commits.clear()
      revision = 0
      request = null
    }
    return account
  }
  function stillCurrent(key: string, version: number): boolean {
    return ensureAccount() === key && generation === version
  }
  function messageId(message: ImMessage): string {
    try { return favoriteId(message) } catch { return '' }
  }
  function status(message: ImMessage): FavoriteStatus {
    ensureAccount()
    let candidate: Favorite
    try { candidate = messageFavorite(message) } catch { return 'unknown' }
    if (savedCandidate(candidate)) return 'saved'
    if (commits.get(candidate.itemId)?.item === null || complete.value) return 'unsaved'
    return 'unknown'
  }
  function isFavorite(message: ImMessage): boolean { return status(message) === 'saved' }
  function isPending(message: ImMessage): boolean {
    ensureAccount()
    return !!pending.value[messageId(message)]
  }
  function errorText(cause: unknown): string {
    return (cause instanceof Error ? cause.message : '收藏操作失败').replace(/https?:\/\/[^\s)]+/g, '[请求地址]')
  }
  function applyCommit(id: string, item: Favorite | null) {
    commits.set(id, { revision: ++revision, item })
    const next = items.value.filter(value => value.itemId !== id)
    if (item) next.unshift(item)
    items.value = next
  }

  function sync(): Promise<void> {
    const key = ensureAccount()
    if (request) return request
    const version = generation
    const startedAtRevision = revision
    loading.value = true
    error.value = ''
    const run = async () => {
      try {
        const snapshot = new Map<string, Favorite>()
        const cursors = new Set<string>()
        let cursor: string | number = ''
        let finished = false
        for (let page = 0; page < 1000; page++) {
          const list = await fetchFavorites({ cursor })
          if (!stillCurrent(key, version)) return
          for (const item of list) snapshot.set(item.itemId, item)
          if (!list.length) { finished = true; break }
          const next = list[list.length - 1]?.createdDate
          if (next === undefined || next === null || String(next) === '' || String(next) === String(cursor) || cursors.has(String(next))) {
            throw new Error('收藏分页游标未推进，未覆盖现有收藏状态，请稍后重试')
          }
          cursors.add(String(next))
          cursor = next
        }
        if (!finished) throw new Error('收藏分页过多，本次同步未完成，现有收藏状态已保留')
        if (!stillCurrent(key, version)) return
        for (const [id, commit] of commits) {
          if (commit.revision <= startedAtRevision) continue
          if (commit.item) snapshot.set(id, commit.item)
          else snapshot.delete(id)
        }
        items.value = [...snapshot.values()]
        complete.value = true
        lastSyncedAt.value = Date.now()
        for (const [id, commit] of commits) if (commit.revision <= startedAtRevision) commits.delete(id)
      } catch (cause) {
        if (stillCurrent(key, version)) error.value = errorText(cause)
        throw cause
      } finally {
        if (stillCurrent(key, version)) { loading.value = false; request = null }
      }
    }
    request = run()
    return request
  }

  async function toggle(message: ImMessage, session?: { name: string; type: number }): Promise<void> {
    const key = ensureAccount()
    const version = generation
    const id = favoriteId(message)
    if (pending.value[id]) return
    pending.value[id] = true
    error.value = ''
    try {
      if (status(message) === 'unknown') await sync()
      if (!stillCurrent(key, version)) return
      const existing = savedCandidate(messageFavorite(message))
      if (existing) {
        await removeFavorite(existing.itemId, Number(existing.contentType) === 8)
        if (stillCurrent(key, version)) {
          applyCommit(existing.itemId, null)
          if (existing.itemId !== id) commits.set(id, { revision: ++revision, item: null })
        }
      } else {
        await favoriteMessage(message, session)
        if (stillCurrent(key, version)) applyCommit(id, { ...messageFavorite(message, session), createdDate: new Date().toISOString() })
      }
    } catch (cause) {
      if (stillCurrent(key, version)) error.value = errorText(cause)
      throw cause
    } finally { if (stillCurrent(key, version)) delete pending.value[id] }
  }

  async function remove(itemId: string): Promise<void> {
    const key = ensureAccount()
    const version = generation
    if (pending.value[itemId]) return
    pending.value[itemId] = true
    error.value = ''
    try {
      const existing = items.value.find(item => item.itemId === itemId)
      await removeFavorite(itemId, Number(existing?.contentType) === 8)
      if (stillCurrent(key, version)) applyCommit(itemId, null)
    } catch (cause) {
      if (stillCurrent(key, version)) error.value = errorText(cause)
      throw cause
    } finally { if (stillCurrent(key, version)) delete pending.value[itemId] }
  }

  return { items, loading, complete, error, lastSyncedAt, pending, sync, status, isFavorite, isPending, toggle, remove, ensureAccount }
})
