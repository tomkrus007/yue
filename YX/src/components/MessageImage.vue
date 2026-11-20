<template>
  <div class="inline-img">
    <span v-if="loading" class="imgchip">🖼 图片加载中…{{ sizeText }}</span>
    <span v-else-if="error" class="imgchip err" @click.stop="start">
      🖼 图片加载失败：{{ error }}（点击重试）
    </span>
    <img
      v-else
      :src="url"
      :alt="seg.fileName || '图片'"
      decoding="async"
      :title="(seg.fileName ? seg.fileName + ' · ' : '') + '点击查看大图'"
      @click.stop="$emit('preview', { url, name: seg.fileName, image: seg })"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getImageUrl } from '../services/im/media'
import type { ImageMeta } from '../services/im/content'

const props = defineProps<{ seg: ImageMeta }>()
defineEmits<{ preview: [payload: { url: string; name: string; image?: ImageMeta }] }>()

const loading = ref(false)
const error = ref('')
const url = ref('')

const sizeText = computed(() => {
  const n = props.seg.size
  if (!n) return ''
  const kb = Math.max(1, Math.round(n / 1024))
  return ' · ' + kb + ' KB'
})

async function start() {
  loading.value = true
  error.value = ''
  try {
    url.value = await getImageUrl(props.seg)
  } catch (e: any) {
    error.value = e?.message || '网络错误'
  } finally {
    loading.value = false
  }
}

onMounted(start)
</script>

<style scoped>
.inline-img { max-width: 260px; }
.inline-img img {
  max-width: 260px;
  max-height: 260px;
  border-radius: 8px;
  display: block;
  cursor: zoom-in;
}
.imgchip {
  display: inline-block;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 12px;
}
.imgchip.err { color: var(--danger); cursor: pointer; }
</style>
