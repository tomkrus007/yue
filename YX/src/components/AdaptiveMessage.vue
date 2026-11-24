<template>
  <section v-if="!closed" class="adaptive-message">
    <div ref="host"></div>
    <p v-if="busy">正在加载卡片…</p>
    <p v-if="status" role="status">{{ status }}</p>
    <button v-if="failed || content?.query" :disabled="busy" @click="load">重新加载</button>
  </section>
</template>
<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { AdaptiveCard, OpenUrlAction, SubmitAction, HostConfig } from 'adaptivecards'
import { openUrl } from '@tauri-apps/plugin-opener'
import { cardHttpUrl, cardImages, disableCardActions, loadCard, queryCard, submitCard } from '../services/im/cards'
import { compatibleCardActions, planCardActions, type CardActionContext } from '../services/im/card-actions'
import { getServerPaths } from '../services/config'
import { loadApps } from '../services/app-client'
import { useImStore } from '../stores/im'
import { useWeMeetStore } from '../stores/wemeet'
import { favoriteMessage } from '../services/im/favorites'
import { resolveTodoNotice } from '../services/im/todo'
const props = defineProps<{ content: any; actionContext?: CardActionContext }>()
const router = useRouter()
const im = useImStore()
const host = ref<HTMLElement | null>(null)
const busy = ref(false)
const status = ref('')
const failed = ref(false)
const closed = ref(false)
let generation = 0
let resources: string[] = []
function release() { resources.forEach(url => URL.revokeObjectURL(url)); resources = [] }
async function execute(value: string, title = '') {
  const context = props.actionContext || {}
  const plans = planCardActions(value, context, getServerPaths())
  for (const plan of plans) {
    switch (plan.kind) {
      case 'url': await openUrl(plan.url); break
      case 'app': {
        const apps = await loadApps()
        const app = apps.find(entry => entry.code === plan.code || entry.id === plan.code)
        if (!app?.url) throw new Error(`应用 ${plan.code} 未提供可打开的电脑端地址`)
        const url = new URL(cardHttpUrl(app.url))
        for (const [key, value] of Object.entries(plan.params)) if (!['appCode', 'appUrl', 'pcNoTitleWindow'].includes(key)) url.searchParams.set(key, value)
        await openUrl(url.href)
        break
      }
      case 'meeting': {
        const meeting = useWeMeetStore()
        if (plan.code) {
          status.value = '正在加入会议…'
          await meeting.joinMeeting(plan.code)
          status.value = '已发起入会请求'
        } else {
          await meeting.openHome()
        }
        break
      }
      case 'chat':
        im.openChat(plan.id, plan.name || plan.id, plan.type)
        await router.push('/chat')
        break
      case 'contact': {
        const kind = plan.type === 2 ? 'group' : plan.type === 5 ? 'serviceno' : 'user'
        await router.push({ path: `/contact/${kind}/${encodeURIComponent(plan.id)}`, query: { name: plan.name } })
        break
      }
      case 'request': await submitCard(plan.data); if (props.content.query) await load(); else status.value = '操作成功'; break
      case 'message': {
        const source = context.message
        await im.forwardMessage(plan.target, [{
          msg_id: crypto.randomUUID(), msg_type: plan.type, content: plan.content,
          from_id: source?.from_id || '', from_name: source?.from_name || '', from_type: 1,
          to_id: plan.target.id, to_name: plan.target.name, to_type: plan.target.type, send_time: Date.now(),
        }], false)
        status.value = '消息已提交，最终发送结果以服务端回执为准'
        break
      }
      case 'todo':
        await openUrl(await resolveTodoNotice({ title: props.content?.title || title || props.content?.brief || '', brief: props.content?.brief || '', action: plan.action }))
        break
      case 'favorite':
        await favoriteMessage(context.message!, { name: context.sessionName || '', type: context.sessionType || 1 })
        status.value = '已收藏到服务端'
        break
      case 'notice': status.value = plan.text; break
      case 'close': closed.value = true; break
    }
  }
}
async function load() {
  const version = ++generation
  busy.value = true
  status.value = ''
  failed.value = false
  const blobs: string[] = []
  try {
    let json = await loadCard(props.content)
    if (props.content.query) {
      try { json = await queryCard(props.content.query) }
      catch { status.value = '刷新卡片失败，显示消息内已有内容；可重新加载'; json = disableCardActions(json) }
    }
    const card = new AdaptiveCard()
    card.hostConfig = new HostConfig({ fontFamily: 'inherit', supportsInteractivity: true })
    card.onAnchorClicked = (_, anchor) => {
      if (busy.value) return true
      busy.value = true
      void execute(anchor.getAttribute('href') || anchor.href)
        .catch(error => { status.value = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[请求地址]') : '打开链接失败' })
        .finally(() => { busy.value = false })
      return true
    }
    card.onExecuteAction = async action => {
      if (busy.value) return
      busy.value = true
      try {
        if (action instanceof OpenUrlAction) await execute(action.url || '', action.title)
        else if (action instanceof SubmitAction) { await submitCard(action.data); status.value = '操作成功'; if (props.content.query) await load() }
        else status.value = '此卡片动作暂不支持'
      } catch (error) { status.value = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[请求地址]') : '卡片操作失败' }
      finally { busy.value = false }
    }
    card.parse(await cardImages(compatibleCardActions(json), blobs))
    const warnings = card.validateProperties().validationEvents
    const rendered = card.render()
    if (version !== generation) { blobs.forEach(url => URL.revokeObjectURL(url)); return }
    release()
    resources = blobs
    host.value?.replaceChildren(...(rendered ? [rendered] : []))
    if (!rendered) throw new Error('卡片内容无法展示')
    if (warnings.length) status.value = '卡片含不支持的字段，部分内容或动作可能无法展示'
  } catch (error) {
    blobs.forEach(url => URL.revokeObjectURL(url))
    if (version === generation) { failed.value = true; status.value = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[请求地址]') : '卡片加载失败' }
  } finally { if (version === generation) busy.value = false }
}
watch(() => [props.content, host.value], () => { if (host.value) void load() }, { immediate: true })
onUnmounted(() => { generation++; release() })
</script>
<style scoped>
.adaptive-message { min-width: 240px; max-width: 520px; }
.adaptive-message p { font-size: 12px; color: var(--text-muted); }
.adaptive-message :deep(img) { max-width: 100%; }
</style>
