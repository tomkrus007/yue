<template>
  <div class="detail-page">
    <header class="detail-top">
      <button class="secondary small" @click="router.back()">← 返回</button>
    </header>

    <div v-if="loading" class="state">加载中…</div>
    <div v-else-if="error" class="state error">{{ error }}</div>

    <div v-else class="detail-card">
      <div class="hero">
        <div class="big-avatar" :class="kind">{{ (name || '?').slice(0, 1) }}</div>
        <div class="hero-info">
          <h2>{{ name }}</h2>
          <div class="sub">
            <span class="tag">{{ kindLabel(kind) }}</span>
            <span v-if="detail.eCode" class="mono">{{ detail.eCode }}</span>
          </div>
        </div>
        <button class="primary" @click="goChat">发消息</button>
      </div>

      <dl class="fields">
        <template v-if="kind === 'user'">
          <div class="field"><dt>姓名</dt><dd>{{ name }}</dd></div>
          <div class="field"><dt>账号</dt><dd>{{ detail.eCode || detail.userName || '-' }}</dd></div>
          <div class="field"><dt>手机</dt><dd>{{ detail.mobile || '-' }}</dd></div>
          <div class="field"><dt>部门</dt><dd>{{ detail.deptName || '-' }}</dd></div>
          <div class="field"><dt>公司/组织</dt><dd>{{ detail.orgName || '-' }}</dd></div>
          <div class="field"><dt>岗位</dt><dd>{{ detail.postDescription || '-' }}</dd></div>
          <div class="field"><dt>用户 ID</dt><dd class="mono">{{ detail.userId || id }}</dd></div>
        </template>

        <template v-else-if="kind === 'group'">
          <div class="field"><dt>群名称</dt><dd>{{ name }}</dd></div>
          <div class="field"><dt>群类型</dt><dd>{{ groupTypeLabel }}</dd></div>
          <div class="field"><dt>成员数</dt><dd>{{ detail.memberCount ?? detail.userCount ?? '-' }}</dd></div>
          <div class="field"><dt>群主</dt><dd>{{ detail.ownerName || detail.creatorName || '-' }}</dd></div>
          <div class="field"><dt>群简介</dt><dd>{{ detail.description || detail.remark || '-' }}</dd></div>
          <div class="field"><dt>群 ID</dt><dd class="mono">{{ detail.groupId || id }}</dd></div>
        </template>
      </dl>

      <pre v-if="showRaw" class="raw">{{ JSON.stringify(detail, null, 2) }}</pre>
      <button class="link" @click="showRaw = !showRaw">{{ showRaw ? '收起原始数据' : '查看原始数据' }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { contactService } from '../services/contact-client'
import { useImStore } from '../stores/im'

const route = useRoute()
const router = useRouter()
const im = useImStore()

const kind = computed(() => String(route.params.kind || 'user'))
const id = computed(() => decodeURIComponent(String(route.params.id || '')))
const name = ref(String(route.query.name || ''))
const detail = ref<any>({})
const loading = ref(true)
const error = ref('')
const showRaw = ref(false)

const groupTypeLabel = computed(() => {
  switch (Number(detail.value.type)) {
    case 1: return '普通群'
    case 2: return '讨论组'
    case 3: return '项目群'
    case 4: return '工作群'
    default: return '-'
  }
})

onMounted(async () => {
  try {
    if (kind.value === 'group') {
      detail.value = (await contactService.getGroupDetail(id.value)) || {}
      if (!name.value) name.value = detail.value.groupName || detail.value.name || id.value
    } else {
      const u = await contactService.getUserDetail(id.value)
      detail.value = u || {}
      if (!name.value) {
        name.value = (u as any)?.name || (u as any)?.userName || (u as any)?.eName || id.value
      }
    }
  } catch (e: any) {
    error.value = e.message || '加载详情失败'
  } finally {
    loading.value = false
  }
})

function kindLabel(k: string): string {
  return k === 'group' ? '群组' : '用户'
}

function goChat() {
  im.openChat(id.value, name.value || id.value, kind.value === 'group' ? 2 : 1)
  router.push('/chat')
}
</script>

<style scoped>
.detail-page { height: 100%; background: var(--bg); overflow-y: auto; }
.detail-top { padding: 12px 24px; }
.small { padding: 5px 12px; font-size: 12px; }
.secondary { background: #f0f0f0; color: var(--text); }
.state { text-align: center; color: var(--text-muted); padding: 40px; }
.state.error { color: var(--danger); }

.detail-card {
  max-width: 760px; margin: 8px auto 40px;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 12px; padding: 24px;
}
.hero { display: flex; align-items: center; gap: 18px; margin-bottom: 24px; }
.big-avatar {
  width: 72px; height: 72px; border-radius: 12px;
  background: var(--primary); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 30px; font-weight: 700;
}
.big-avatar.group { background: #4a90d9; }
.hero-info { flex: 1; }
.hero-info h2 { font-size: 20px; margin-bottom: 6px; }
.sub { display: flex; align-items: center; gap: 10px; color: var(--text-muted); font-size: 13px; }
.tag {
  display: inline-block; background: #eef2f7; color: #5b6b7c;
  border-radius: 4px; padding: 1px 8px; font-size: 12px;
}
.mono { font-family: Menlo, monospace; }
.primary { padding: 8px 20px; }

.fields { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
.field {
  padding: 12px 4px; border-bottom: 1px solid #f0f0f0;
  display: flex; gap: 12px;
}
.field dt { width: 90px; color: var(--text-muted); font-size: 13px; flex-shrink: 0; }
.field dd { font-size: 14px; word-break: break-all; }

.raw {
  background: #2b2c2d; color: #9ad9a0; padding: 12px;
  border-radius: 8px; font-size: 11px; overflow-x: auto; margin-top: 16px;
}
.link {
  background: transparent; color: var(--primary); padding: 8px 0;
  font-size: 12px; margin-top: 10px;
}
</style>