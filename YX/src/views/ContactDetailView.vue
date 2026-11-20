<template>
  <div class="detail-page">
    <header class="detail-top" data-tauri-drag-region="deep">
      <button class="secondary small" @click="router.back()">← 返回</button>
    </header>

    <ContactDetailPanel
      :kind="kind"
      :id="id"
      :name="queryName"
      @chat="goChat"
      @group-left="onGroupLeft"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useImStore } from '../stores/im'
import ContactDetailPanel from '../components/ContactDetailPanel.vue'

const route = useRoute()
const router = useRouter()
const im = useImStore()

const kind = computed(() => String(route.params.kind || 'user'))
const id = computed(() => decodeURIComponent(String(route.params.id || '')))
const queryName = computed(() => String(route.query.name || ''))

function goChat(name: string) {
  im.openChat(id.value, name || id.value, kind.value === 'group' ? 2 : kind.value === 'serviceno' ? 5 : 1)
  router.push('/chat')
}

function onGroupLeft() {
  im.markLeftGroup(id.value)
}
</script>

<style scoped>
.detail-page { height: 100%; background: var(--bg); overflow-y: auto; }
.detail-top { height: var(--titlebar-height); padding: 0 24px 0 96px; display: flex; align-items: center; }
.small { padding: 5px 12px; font-size: 12px; }
</style>
