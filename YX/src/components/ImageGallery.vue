<template>
  <div class="image-gallery" role="dialog" aria-modal="true" aria-label="图片查看器" @click.self="emit('close')">
    <div class="gallery-tools"><span>{{ currentName }} · {{ index + 1 }} / {{ images.length }}</span><button @click="scale = Math.max(0.25, scale - 0.25)">缩小</button><button @click="scale = Math.min(4, scale + 0.25)">放大</button><button @click="rotation += 90">旋转</button><button @click="scale = 1; rotation = 0">复位</button><button @click="emit('close')">关闭</button></div>
    <button class="previous" :disabled="index <= 0 || loading" @click="move(-1)">‹ 上一张</button>
    <div class="gallery-image"><img v-if="url && !loading" :src="url" :alt="currentName" :style="{ transform: `scale(${scale}) rotate(${rotation}deg)` }" /><p v-if="loading">图片加载中…</p><p v-if="error" role="alert">{{ error }} <button @click="load">重试</button></p></div>
    <button class="next" :disabled="index >= images.length - 1 || loading" @click="move(1)">下一张 ›</button>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { ImageMeta } from '../services/im/content'
import { getImageUrl } from '../services/im/media'
const props = defineProps<{ images: ImageMeta[]; initialIndex: number; initialUrl: string; initialName: string }>()
const emit = defineEmits<{ close: [] }>()
const index = ref(Math.max(0, props.initialIndex))
const url = ref(props.initialUrl)
const loading = ref(false)
const error = ref('')
const scale = ref(1)
const rotation = ref(0)
const currentName = computed(() => props.images[index.value]?.fileName || props.initialName || '图片')
let generation = 0
async function load() {
  const image = props.images[index.value]
  if (!image) return
  const request = ++generation
  loading.value = true
  error.value = ''
  scale.value = 1
  rotation.value = 0
  try { const result = await getImageUrl(image); if (request === generation) url.value = result }
  catch { if (request === generation) { url.value = ''; error.value = '图片加载失败' } }
  finally { if (request === generation) loading.value = false }
}
function move(step: number) {
  const next = index.value + step
  if (loading.value || next < 0 || next >= props.images.length) return
  index.value = next
  void load()
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
  if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1) }
  if (event.key === 'ArrowRight') { event.preventDefault(); move(1) }
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => { generation++; window.removeEventListener('keydown', onKey) })
</script>
<style scoped>
.image-gallery { position: fixed; inset: 0; z-index: 120; background: #111e; color: white; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 64px 20px 20px; }
.gallery-tools { position: absolute; top: 12px; left: 20px; right: 20px; display: flex; justify-content: center; align-items: center; gap: 10px; flex-wrap: wrap; }
.gallery-tools span { max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button { flex-shrink: 0; padding: 8px 12px; background: #ffffff26; color: white; border-radius: 6px; }
.gallery-image { display: grid; place-items: center; overflow: auto; width: 100%; height: 100%; }
.gallery-image img { max-width: 100%; max-height: calc(100vh - 110px); object-fit: contain; }
</style>
