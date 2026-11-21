<template>
  <div ref="root" class="avatar-box" :class="{ photo: photoSrc }">
    <img v-if="photoSrc" :src="photoSrc" :alt="name" />
    <template v-else>{{ initial }}</template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { getAvatarUrl } from '../services/im/media'

/**
 * 列表用头像：优先展示存储服务里的真实头像，取不到时保留调用方的首字样式。
 * 只有进入视口才请求，避免一次拉几百个群头像。
 */
const props = defineProps<{ id: string; type?: number; name?: string }>()

const photoSrc = ref('')
const root = ref<HTMLElement | null>(null)
const initial = computed(() => (props.name || '?').slice(0, 1))

let observer: IntersectionObserver | null = null

async function load() {
  if (!props.id || !props.type) return
  try {
    photoSrc.value = await getAvatarUrl(props.id, props.type)
  } catch {
    photoSrc.value = ''
  }
}

onMounted(() => {
  if (!props.id || !props.type) return
  observer = new IntersectionObserver(
    entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer?.disconnect()
      observer = null
      void load()
    },
    { rootMargin: '160px' },
  )
  if (root.value) observer.observe(root.value)
})

onUnmounted(() => {
  observer?.disconnect()
  observer = null
})
</script>

<style scoped>
.avatar-box.photo { overflow: hidden; background: transparent; }
.avatar-box img {
  width: 100%; height: 100%;
  object-fit: cover; display: block;
  border-radius: inherit;
}
</style>
