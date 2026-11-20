<template>
  <div class="detail-panel">
    <div v-if="loading" class="state">加载中…</div>
    <div v-else-if="error" class="state error">{{ error }}</div>

    <div v-else class="detail-card">
      <div class="hero">
        <div class="big-avatar" :class="kind">{{ (displayName || '?').slice(0, 1) }}</div>
        <div class="hero-info">
          <h2>{{ displayName }}</h2>
          <div class="sub">
            <span class="tag">{{ kindLabel(kind) }}</span>
            <span v-if="detail.loginId || detail.userName" class="mono">{{ detail.loginId || detail.userName }}</span>
          </div>
        </div>
        <div class="hero-actions">
          <button class="primary" @click="emit('chat', displayName)">发消息</button>
          <button v-if="kind === 'group'" class="secondary" @click="groupSettingsOpen = true">群设置</button>
        </div>
      </div>

      <dl class="fields">
        <template v-if="kind === 'user'">
          <div class="field"><dt>姓名</dt><dd>{{ displayName }}</dd></div>
          <div class="field"><dt>账号</dt><dd>{{ detail.loginId || detail.userName || '-' }}</dd></div>
          <div class="field"><dt>手机</dt><dd>{{ detail.mobile || detail.mobile2 || detail.mobile3 || detail.telephone || detail.homeTelephone || '-' }}</dd></div>
          <div class="field"><dt>部门</dt><dd>{{ detail.orgName || detail.deptName || detail.departmentName || '-' }}</dd></div>
          <div class="field"><dt>公司/组织</dt><dd>{{ detail.eName || detail.companyName || '-' }}</dd></div>
          <div class="field"><dt>岗位</dt><dd>{{ detail.postDescription || detail.positionalTitle || '-' }}</dd></div>
          <div class="field"><dt>邮箱</dt><dd class="mono">{{ detail.email || '-' }}</dd></div>
        </template>

        <template v-else-if="kind === 'group'">
          <div class="field"><dt>群名称</dt><dd>{{ displayName }}</dd></div>
          <div class="field"><dt>群类型</dt><dd>{{ groupTypeLabel }}</dd></div>
          <div class="field"><dt>成员数</dt><dd>{{ detail.memberCount ?? detail.userCount ?? '-' }}</dd></div>
          <div class="field"><dt>群主</dt><dd>{{ detail.ownerName || detail.creatorName || '-' }}</dd></div>
          <div class="field"><dt>群简介</dt><dd>{{ detail.description || detail.remark || '-' }}</dd></div>
          <div class="field"><dt>群 ID</dt><dd class="mono">{{ detail.groupId || id }}</dd></div>
        </template>
        <template v-else-if="kind === 'serviceno'">
          <div class="field"><dt>服务号名称</dt><dd>{{ displayName }}</dd></div>
          <div class="field"><dt>简介</dt><dd>{{ detail.description || detail.brief || detail.introduction || '-' }}</dd></div>
          <div class="field"><dt>所属企业</dt><dd>{{ detail.eName || detail.eCode || '-' }}</dd></div>
          <div class="field"><dt>关注状态</dt><dd>{{ Number(detail.isFollow) === 1 ? '已关注' : Number(detail.isFollow) === 0 ? '未关注' : '-' }}</dd></div>
          <div class="field"><dt>允许回复</dt><dd>{{ Number(detail.isAllowReply) === 0 ? '不允许' : Number(detail.isAllowReply) === 1 ? '允许' : '-' }}</dd></div>
          <div class="field"><dt>服务号 ID</dt><dd class="mono">{{ detail.accountId || id }}</dd></div>
        </template>
      </dl>

      <pre v-if="showRaw" class="raw">{{ JSON.stringify(detail, null, 2) }}</pre>
      <button class="link" @click="showRaw = !showRaw">{{ showRaw ? '收起原始数据' : '查看原始数据' }}</button>
    </div>

    <GroupSettingsModal
      v-if="groupSettingsOpen && kind === 'group'"
      :open="groupSettingsOpen"
      :group-id="id"
      :group-name="displayName"
      @close="groupSettingsOpen = false"
      @left="emit('group-left')"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { contactService } from '../services/contact-client'
import { getServiceNoDetail } from '../services/im/service-no'
import GroupSettingsModal from './GroupSettingsModal.vue'

const props = defineProps<{ kind: string; id: string; name?: string }>()
const emit = defineEmits<{ chat: [name: string]; 'group-left': [] }>()

const detail = ref<any>({})
const loading = ref(true)
const error = ref('')
const showRaw = ref(false)
const groupSettingsOpen = ref(false)
/** 详情接口解析出的名称（props.name 为空时兜底） */
const resolvedName = ref('')

/** 展示名：传入名 > 接口名 > ID */
const displayName = computed(() => props.name || resolvedName.value || props.id)

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
    if (props.kind === 'group') {
      detail.value = (await contactService.getGroupDetail(props.id)) || {}
      if (!resolvedName.value) resolvedName.value = detail.value.groupName || detail.value.name || props.id
    } else if (props.kind === 'serviceno') {
      detail.value = await getServiceNoDetail(props.id)
      if (!resolvedName.value) resolvedName.value = detail.value.name || props.id
    } else {
      const u = await contactService.getUserDetail(props.id)
      detail.value = u || {}
      if (!resolvedName.value) {
        resolvedName.value = (u as any)?.name || (u as any)?.userName || (u as any)?.loginId || props.id
      }
    }
  } catch (e: any) {
    error.value = e.message || '加载详情失败'
  } finally {
    loading.value = false
  }
})

function kindLabel(k: string): string {
  return k === 'group' ? '群组' : k === 'serviceno' ? '服务号' : '用户'
}
</script>

<style scoped>
.detail-panel { height: 100%; overflow-y: auto; }
.state { text-align: center; color: var(--text-muted); padding: 40px; }
.state.error { color: var(--danger); }

.detail-card {
  max-width: 760px; margin: 8px auto 40px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 12px; padding: 24px;
}
.hero { display: flex; align-items: center; gap: 18px; margin-bottom: 24px; }
.hero-actions { display: flex; gap: 8px; flex-shrink: 0; }
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
  display: inline-block; background: var(--chip-bg); color: var(--chip-text);
  border-radius: 4px; padding: 1px 8px; font-size: 12px;
}
.mono { font-family: Menlo, monospace; }
.primary { padding: 8px 20px; }

.fields { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
.field {
  padding: 12px 4px; border-bottom: 1px solid var(--divider);
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
