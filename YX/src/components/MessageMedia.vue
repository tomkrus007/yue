<template>
  <div class="message-media">
    <span>{{ seg.fileName || (seg.type === 'audio' ? '语音消息' : '视频消息') }}</span>
    <audio v-if="url && seg.type === 'audio'" :src="url" controls preload="metadata" @error="onError" />
    <video v-else-if="url" :src="url" controls preload="metadata" @error="onError" />
    <button v-if="!url || error" :disabled="loading || !seg.downloadUrl" @click.stop="load">{{ loading ? '正在准备…' : error ? '重试播放' : '流式播放' }}</button>
    <DownloadButton :seg="seg" />
    <button v-if="error && canConvert" :disabled="loading" @click.stop="convert">{{ converting ? '正在本机转换…' : '转换为兼容格式播放' }}</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="error && canConvert === false">未检测到本机 ffmpeg，可下载后用系统播放器打开；客户端不会自动安装转换工具。</p>
  </div>
</template>
<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { ImageMeta } from '../services/im/content'
import { openMediaStream, openConvertedMedia, type MediaLease, type SavedDownload } from '../services/im/transfers'
import { useDownloadsStore } from '../stores/downloads'
import DownloadButton from './DownloadButton.vue'
const props = defineProps<{ seg: ImageMeta & { type: 'audio' | 'video' } }>()
const downloads = useDownloadsStore()
const url = ref('')
const loading = ref(false)
const converting = ref(false)
const error = ref('')
const canConvert = ref<boolean | null>(null)
let disposed = false
let lease: MediaLease | undefined
async function release() { const previous = lease; lease = undefined; url.value = ''; await previous?.close().catch(() => {}) }
async function load() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    await release()
    const next = await openMediaStream(props.seg, props.seg.type === 'video')
    if (disposed) { await next.close(); return }
    lease = next
    url.value = next.url
  } catch { if (!disposed) error.value = '准备播放失败，请重试或下载后播放' }
  finally { loading.value = false }
}
async function onError() {
  error.value = '当前媒体无法播放，可重试或下载后使用系统播放器打开'
  try { canConvert.value = await invoke<boolean>('media_codec_support') } catch { canConvert.value = false }
}
async function convert() {
  if (loading.value) return
  loading.value = true
  converting.value = true
  try {
    const saved = await downloads.start(props.seg)
    const converted = await invoke<SavedDownload>('attachment_transcode', { id: saved.id, video: props.seg.type === 'video' })
    await release()
    const next = await openConvertedMedia(converted.id, props.seg.type === 'video')
    if (disposed) { await next.close(); return }
    lease = next
    url.value = next.url
    error.value = ''
  } catch (cause) { if (!disposed) error.value = (cause instanceof Error ? cause.message : String(cause || '本机转换失败')).replace(/https?:\/\/[^\s)]+/g, '[请求地址]') }
  finally { loading.value = false; converting.value = false }
}
onUnmounted(() => { disposed = true; void release() })
</script>
<style scoped>
.message-media { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.message-media audio, .message-media video { width: 100%; max-width: 360px; max-height: 280px; }
.message-media p { width: 100%; font-size: 12px; color: var(--text-muted); }
.message-media p[role="alert"] { color: var(--danger); }
</style>
