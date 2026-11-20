<template>
  <span class="download-control" @click.stop>
    <template v-if="job?.state === 'downloading'">
      <progress :value="job.total ? job.received : undefined" :max="job.total || 1"></progress>
      <span>{{ job.total ? Math.min(100, Math.round(job.received / job.total * 100)) + '%' : humanSize(job.received) }}</span>
      <button class="file-action" @click="cancel">取消</button>
    </template>
    <template v-else-if="job?.state === 'done'">
      <button class="file-action" :title="job.path" @click="downloads.open(seg)">打开已下载文件</button>
    </template>
    <button v-else class="file-action" :disabled="!seg.downloadUrl" @click="start">{{ job?.state === 'failed' || job?.state === 'cancelled' ? '重新下载' : '下载' }}</button>
    <span v-if="job?.state === 'done'" class="saved">已保存到下载／YX</span>
    <span v-if="job?.error" class="error" role="status">{{ job.error }}</span>
  </span>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import type { ImageMeta } from '../services/im/content'
import { humanSize } from '../services/im/content'
import { useDownloadsStore } from '../stores/downloads'
const props = defineProps<{ seg: ImageMeta }>()
const downloads = useDownloadsStore()
const job = computed(() => downloads.jobFor(props.seg))
async function start() { await downloads.start(props.seg).catch(() => {}) }
async function cancel() { await downloads.cancel(props.seg).catch(() => {}) }
</script>
<style scoped>
.download-control { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-left: 10px; font-size: 12px; }
.file-action { border: 0; background: transparent; color: var(--link); padding: 2px 0; }
progress { width: 80px; height: 8px; }
.error { color: var(--danger); }
.saved { color: var(--text-muted); }
</style>
