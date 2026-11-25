<template>
  <div v-if="open" class="gs-mask" @click.self="close">
    <section class="gs" role="dialog" aria-modal="true" aria-label="群设置">
      <header>
        <h3>群设置</h3>
        <button class="secondary small" :disabled="busyLeave" @click="close">关闭</button>
      </header>

      <div v-if="detailError" class="state error">{{ detailError }}</div>
      <div v-else-if="!detail" class="state">加载中…</div>

      <template v-else>
        <nav class="tabs">
          <button
            v-for="t in tabs"
            :key="t.id"
            :class="{ on: tab === t.id }"
            @click="switchTab(t.id)"
          >
            {{ t.label }}
          </button>
        </nav>

        <!-- ============ 群资料 ============ -->
        <div v-show="tab === 'profile'" class="panel">
          <div class="hero">
            <ContactAvatar class="big-avatar" :id="groupId" :type="2" :name="detail.name" />
            <div class="hero-info">
              <input
                v-if="canEditInfo"
                v-model="nameDraft"
                class="name-input"
                maxlength="64"
                aria-label="群名称"
                @blur="saveName"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
              />
              <h2 v-else>{{ detail.name || '未命名群组' }}</h2>
              <div class="sub">
                <span class="tag">{{ typeLabel }}</span>
                <span v-if="role === -1" class="tag warn">未加入</span>
                <span v-if="role === 2" class="tag">群主</span>
                <span v-else-if="role === 1" class="tag">管理员</span>
                <span v-if="detail.groupJieSan" class="tag warn">已解散</span>
              </div>
            </div>
          </div>

          <dl class="rows">
            <div class="row">
              <dt>群主</dt>
              <dd>{{ ownerName }}</dd>
            </div>
            <div class="row">
              <dt>群人数</dt>
              <dd>{{ detail.memberCount ?? '-' }}</dd>
            </div>
            <div v-if="isMember && !forbidEditInfo" class="row">
              <dt>我的群内昵称</dt>
              <dd class="grow">
                <input
                  v-model="nickDraft"
                  class="inline-input"
                  placeholder="展示在群里的名字"
                  maxlength="32"
                  @blur="saveNick"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                />
              </dd>
            </div>
            <div class="row">
              <dt>群介绍</dt>
              <dd class="grow">
                <textarea
                  v-if="canEditInfo"
                  v-model="notesDraft"
                  rows="3"
                  placeholder="添加群介绍"
                  @blur="saveNotes"
                ></textarea>
                <span v-else class="text">{{ detail.notes || '-' }}</span>
              </dd>
            </div>
            <div v-if="canEditInfo" class="row">
              <dt>公开群</dt>
              <dd class="grow right">
                <label class="switch">
                  <input
                    type="checkbox"
                    :checked="isPublic"
                    :disabled="!canEditInfo"
                    @change="setPublic(($event.target as HTMLInputElement).checked)"
                  />
                  <span>{{ isPublic ? '公开' : '私密' }}</span>
                </label>
              </dd>
            </div>
            <div v-if="ownerRole" class="row">
              <dt>邀请/申请入群确认</dt>
              <dd class="grow right">
                <label class="switch">
                  <input
                    type="checkbox"
                    :checked="joinModeOn"
                    @change="setJoinMode(($event.target as HTMLInputElement).checked)"
                  />
                  <span>{{ joinModeOn ? '已开启' : '已关闭' }}</span>
                </label>
              </dd>
            </div>
            <div v-if="ownerRole" class="row">
              <dt>允许成员邀请入群</dt>
              <dd class="grow right">
                <label class="switch">
                  <input
                    type="checkbox"
                    :checked="!!detail.isAllowMemInvite"
                    @change="setAllowInvite(($event.target as HTMLInputElement).checked)"
                  />
                  <span>{{ detail.isAllowMemInvite ? '已开启' : '已关闭' }}</span>
                </label>
              </dd>
            </div>
            <div class="row">
              <dt>群 ID</dt>
              <dd class="mono">{{ groupId }}</dd>
            </div>
          </dl>

          <p v-if="role === -1" class="tip warn">你不是该群成员，无法发送消息</p>
          <div v-if="role === -1 && !detail.groupJieSan" class="apply-box">
            <textarea
              v-model="applyReason"
              rows="2"
              placeholder="描述申请入群原因（可选）"
            ></textarea>
            <input
              v-if="joinModeOn"
              v-model="applyCode"
              class="inline-input code"
              maxlength="4"
              placeholder="4位入群密码"
            />
            <button :disabled="busyApply" @click="doApply">
              {{ busyApply ? '申请中…' : '申请入群' }}
            </button>
          </div>
        </div>

        <!-- ============ 群成员 ============ -->
        <div v-show="tab === 'members'" class="panel">
          <div class="mm-head">
            <input v-model="memberKw" placeholder="搜索群成员" aria-label="搜索群成员" />
            <span class="mm-total">{{ membersTotal }} 人</span>
          </div>
          <div class="mm-actions">
            <button v-if="canAddMember" class="secondary" :disabled="busy" @click="pickerFor = 'add'">
              添加成员
            </button>
            <button
              v-if="role > 0 && !forbidEditInfo"
              class="secondary"
              :disabled="busy"
              @click="pickerFor = 'invite'"
            >
              邀请入群
            </button>
            <button
              v-if="ownerRole"
              class="secondary"
              :disabled="busy"
              @click="pickerFor = 'transfer'"
            >
              转让群组
            </button>
          </div>

          <p v-if="membersError" class="state error" role="alert">{{ membersError }}</p>
          <p v-else-if="membersLoading" class="state">加载成员中…</p>
          <ul v-else class="mm-list">
            <li
              v-for="m in filteredMembers"
              :key="m.userId"
              class="mm-row"
              :class="{ me: m.userId === selfId }"
            >
              <ContactAvatar class="avatar" :id="m.userId" :type="1" :name="showName(m)" />
              <span class="mm-info">
                <span class="mm-name">
                  {{ showName(m) }}{{ m.userId === selfId ? '（我）' : '' }}
                  <i v-if="m.memberRole === 2" class="badge owner">群主</i>
                  <i v-else-if="m.memberRole === 1" class="badge admin">管理员</i>
                  <i v-if="isSelfMuted(m)" class="badge muted">已禁言</i>
                </span>
                <small v-if="m.nickName && m.nickName !== m.name" class="mm-nick">
                  群内昵称：{{ m.nickName }}
                </small>
              </span>
              <span class="mm-ops" @click.stop>
                <button
                  v-if="ownerRole && m.memberRole !== 2"
                  class="mini"
                  :disabled="busy"
                  @click="askSetAdmin(m)"
                >
                  {{ m.memberRole === 1 ? '取消管理员' : '设为管理员' }}
                </button>
                <button
                  v-if="canRemove(m)"
                  class="mini danger"
                  :disabled="busy"
                  @click="askRemove(m)"
                >
                  移除
                </button>
              </span>
            </li>
            <li v-if="!filteredMembers.length" class="state">
              {{ memberKw.trim() ? '没有匹配的成员' : '群里还没有其他成员' }}
            </li>
          </ul>

          <!-- 邀请入群：选择后填原因 -->
          <div v-if="inviteOpen" class="invite-box">
            <div class="invite-head">
              <span>邀请 {{ invitedItems.length }} 人入群</span>
              <button class="link" @click="inviteOpen = false">清除</button>
            </div>
            <p v-if="joinModeOn" class="tip">
              群主已启用“邀请/申请入群确认”，邀请成员入群可向群主或群管理员描述原因
            </p>
            <textarea v-model="inviteReason" rows="2" placeholder="描述邀请原因（可选）"></textarea>
            <div class="invite-foot">
              <button class="secondary" @click="inviteOpen = false">取消</button>
              <button :disabled="busy" @click="confirmInvite">
                {{ busy ? '发送中…' : '发送邀请' }}
              </button>
            </div>
          </div>
        </div>

        <!-- ============ 群公告 ============ -->
        <div v-show="tab === 'bulletin'" class="panel">
          <p v-if="!isMember" class="state">你不是该群成员，无法查看群公告</p>
          <template v-else>
            <div class="bn-actions">
              <button
                v-if="canEditInfo"
                :disabled="busy"
                @click="openEditor(null)"
              >
                发布公告
              </button>
              <span v-else class="muted">公告由群主或管理员发布</span>
            </div>

            <!-- 编辑器 -->
            <div v-if="editorOpen" class="editor">
              <input
                v-model="bTitle"
                class="inline-input"
                maxlength="50"
                placeholder="标题（必填），最多50字"
              />
              <textarea v-model="bContent" rows="6" placeholder="正文（必填），最多500字"></textarea>
              <label class="chk">
                <input v-model="bImportant" type="checkbox" /> 设为重要公告（置顶）
              </label>
              <label v-if="editing" class="chk">
                <input v-model="bSendMessage" type="checkbox" /> 同时向群里发一条公告消息
              </label>
              <p v-if="bError" class="state error" role="alert">{{ bError }}</p>
              <div class="invite-foot">
                <button class="secondary" :disabled="busy" @click="editorOpen = false">取消</button>
                <button :disabled="busy" @click="saveBulletin">
                  {{ busy ? '发布中…' : editing ? '保存' : '发布' }}
                </button>
              </div>
            </div>

            <template v-else>
              <p v-if="bulletinsError" class="state error" role="alert">{{ bulletinsError }}</p>
              <p v-else-if="bulletinsLoading && !bulletins.length" class="state">加载中…</p>
              <ul v-else class="bn-list">
                <li v-for="b in bulletins" :key="b.bulletinId" class="bn-item">
                  <div class="bn-title">
                    <span v-if="b.isImportant" class="star" title="重要公告">★</span>
                    {{ b.title || '（无标题）' }}
                  </div>
                  <div class="bn-content">{{ b.content }}</div>
                  <div class="bn-meta">
                    {{ b.createName || b.creatorName || '' }}{{ fmtTime(Number(b.createTime)) ? ' · ' + fmtTime(Number(b.createTime)) : '' }}
                  </div>
                  <div v-if="canEditInfo" class="bn-ops">
                    <button class="mini" :disabled="busy" @click="openEditor(b)">编辑</button>
                    <button class="mini" :disabled="busy" @click="askImportant(b)">
                      {{ b.isImportant ? '取消重要' : '设为重要' }}
                    </button>
                    <button class="mini danger" :disabled="busy" @click="askDeleteBulletin(b)">删除</button>
                  </div>
                </li>
                <li v-if="!bulletins.length" class="state">
                  {{ joinModeOn ? '' : '' }}还没有公告
                </li>
              </ul>
              <div v-if="bulletinCursor" class="more-row">
                <button class="secondary" :disabled="bulletinsLoading" @click="loadBulletins(true)">
                  {{ bulletinsLoading ? '加载中…' : '加载更多' }}
                </button>
              </div>
            </template>
          </template>
        </div>

        <!-- ============ 群禁言（群主 + 配置中心开关） ============ -->
        <div v-show="tab === 'mute'" class="panel">
          <p class="tip">全员禁言启用后，只允许群主、管理员及添加的成员发言</p>
          <div class="row">
            <dt>全员禁言</dt>
            <dd class="grow right">
              <label class="switch">
                <input
                  type="checkbox"
                  :checked="isSilentOn"
                  :disabled="busy"
                  @change="toggleMuteAll(($event.target as HTMLInputElement).checked)"
                />
                <span>{{ isSilentOn ? '已开启' : '已关闭' }}</span>
              </label>
            </dd>
          </div>

          <h4 class="sub-h">
            被禁言的成员（{{ mutedList.length }}）
            <button class="mini" :disabled="busy || !isSilentOn" @click="pickerFor = 'mute'">添加</button>
          </h4>
          <ul class="mm-list slim">
            <li v-for="m in mutedList" :key="'s' + m.userId" class="mm-row">
              <span class="mm-info">
                <span class="mm-name">{{ m.userName || m.name || m.userId }}</span>
                <small v-if="m.silentExpireIn" class="mm-nick">{{ silentExpireTip(m.silentExpireIn) }}</small>
              </span>
              <span class="mm-ops" @click.stop>
                <button class="mini" :disabled="busy" @click="unmuteMuted(m)">解除</button>
              </span>
            </li>
            <li v-if="!mutedList.length" class="state">暂无</li>
          </ul>

          <h4 class="sub-h">
            允许发言的成员（{{ whitelist.length }}）
            <button class="mini" :disabled="busy || !isSilentOn" @click="pickerFor = 'whitelist'">添加</button>
          </h4>
          <ul class="mm-list slim">
            <li v-for="m in whitelist" :key="'w' + m.userId" class="mm-row">
              <span class="mm-info">
                <span class="mm-name">{{ m.userName || m.name || m.userId }}</span>
              </span>
              <span class="mm-ops" @click.stop>
                <button class="mini" :disabled="busy" @click="removeWhitelist(m)">移除</button>
              </span>
            </li>
            <li v-if="!whitelist.length" class="state">暂无</li>
          </ul>
        </div>

        <!-- ============ 更多 ============ -->
        <div v-show="tab === 'more'" class="panel">
          <template v-if="ownerRole">
            <div class="row">
              <dt>入群密码</dt>
              <dd class="grow">
                <template v-if="isPublic">
                  <span class="muted">公开群可主动加入，无需入群密码</span>
                </template>
                <template v-else>
                  <div v-if="joinCode" class="code-box">
                    <span v-for="(c, i) in joinCode.split('')" :key="i" class="code-digit">{{ c }}</span>
                    <button class="mini" @click="copyText(joinCode)">复制</button>
                  </div>
                  <p v-if="joinCodeExpire" class="tip">密码将在 {{ joinCodeExpire }} 后失效，请在时效范围内根据密码入群</p>
                  <button class="secondary" :disabled="busy" @click="genJoinCode">
                    {{ busy ? '生成中…' : '随机生成4位入群密码' }}
                  </button>
                </template>
              </dd>
            </div>
          </template>

          <div class="row">
            <dt>群二维码</dt>
            <dd class="grow">
              <template v-if="isPublic">
                <p class="tip">扫一扫上面的二维码入群</p>
                <pre class="qr-text">{{ qrcodeText }}</pre>
                <button class="secondary" @click="copyText(qrcodeText)">复制二维码内容</button>
              </template>
              <span v-else class="muted">私密群不支持扫码入群，请用入群密码或管理员邀请</span>
            </dd>
          </div>

          <div v-if="ownerRole && !isMeetingTemplate" class="row">
            <dt>转让群组</dt>
            <dd class="grow right">
              <button class="secondary" :disabled="busy" @click="pickerFor = 'transfer'">选择新群主</button>
            </dd>
          </div>

          <div class="row danger-row">
            <dt>{{ ownerRole ? '解散群组' : '退出群组' }}</dt>
            <dd class="grow right">
              <button class="danger" :disabled="busy || busyLeave" @click="askLeave">
                {{ ownerRole ? '解散群组' : '退出群组' }}
              </button>
            </dd>
          </div>
        </div>
      </template>

      <div v-if="toast" class="toast" role="status">{{ toast }}</div>
    </section>
  </div>

  <!-- 成员选择器（按用途切换来源/单选） -->
  <MemberPicker
    :open="pickerFor !== '' && open"
    v-bind="pickerConfig"
    @close="pickerFor = ''"
    @confirm="onPickerConfirm"
  />

  <!-- 禁言时长 -->
  <div v-if="muteTimeOpen && open" class="sub-mask" @click.self="muteTimeOpen = false">
    <section class="sub-box" role="dialog" aria-modal="true" aria-label="禁言时长">
      <h3>禁言时长</h3>
      <div class="time-opts">
        <label v-for="o in SILENT_TIME_OPTIONS" :key="o.value" class="time-opt">
          <input v-model="muteTime" type="radio" :value="o.value" name="silent-time" />
          {{ o.label }}
        </label>
      </div>
      <footer>
        <button class="secondary" @click="muteTimeOpen = false">取消</button>
        <button :disabled="busy" @click="confirmMuteTime">{{ busy ? '处理中…' : '确定' }}</button>
      </footer>
    </section>
  </div>

  <!-- 二次确认 -->
  <ConfirmDialog
    :open="confirm.open"
    :title="confirm.title"
    :message="confirm.message"
    :ok-text="confirm.okText"
    :danger="confirm.danger"
    @close="confirm.open = false"
    @confirm="runConfirm"
  />
</template>

<script setup lang="ts">
/**
 * 群设置（对齐官方 groupSetting 弹窗）：
 * 群资料 / 群成员 / 群公告 / 群禁言 / 更多（入群码、二维码、转让、退群解散）
 * 权限口径见 services/group-client.ts 头部注释。
 */
import { computed, ref, watch } from 'vue'
import {
  groupService,
  silentExpireTip,
  SILENT_TIME_OPTIONS,
  type BulletinItem,
  type GroupDetail,
  type GroupMember,
} from '../services/group-client'
import { authService } from '../services/auth'
import { useImStore } from '../stores/im'
import ContactAvatar from './ContactAvatar.vue'
import MemberPicker from './MemberPicker.vue'
import type { PickedMember } from './MemberPicker.vue'
import ConfirmDialog from './ConfirmDialog.vue'

const props = defineProps<{
  open: boolean
  groupId: string
  groupName?: string
}>()
const emit = defineEmits<{
  close: []
  /** 退群/解散成功后通知父级清理会话 */
  left: [kind: 'quit' | 'dismiss']
}>()

const im = useImStore()
const selfId = authService.getCurrentUserId()

/* ---------------- 基础状态 ---------------- */

const tab = ref<'profile' | 'members' | 'bulletin' | 'mute' | 'more'>('profile')
const detail = ref<GroupDetail | null>(null)
const detailError = ref('')

const members = ref<GroupMember[]>([])
const membersTotal = ref(0)
const membersLoading = ref(false)
const membersError = ref('')
const memberKw = ref('')

const bulletins = ref<BulletinItem[]>([])
const bulletinTotal = ref(0)
const bulletinCursor = ref('')
const bulletinsLoading = ref(false)
const bulletinsError = ref('')

const mutedList = ref<GroupMember[]>([])
const whitelist = ref<GroupMember[]>([])

const joinCode = ref('')
const joinCodeExpire = ref('')

const nameDraft = ref('')
const notesDraft = ref('')
const nickDraft = ref('')
const applyReason = ref('')
const applyCode = ref('')
const busyApply = ref(false)

const invitedItems = ref<PickedMember[]>([])
const inviteReason = ref('')
const inviteOpen = ref(false)

const editorOpen = ref(false)
const editing = ref<BulletinItem | null>(null)
const bTitle = ref('')
const bContent = ref('')
const bImportant = ref(false)
const bSendMessage = ref(false)
const bError = ref('')

const pickerFor = ref('')
const muteTimeOpen = ref(false)
const muteTime = ref(1)
const pendingMuteIds = ref<string[]>([])
const presetIds = ref<string[]>([])

const confirm = ref({
  open: false,
  title: '提示',
  message: '',
  okText: '确定',
  danger: false,
  run: null as null | (() => Promise<void>),
})
const busy = ref(false)
const busyLeave = ref(false)

const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined
function showToast(msg: string) {
  toast.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 2500)
}

/* ---------------- 权限派生（对齐官方） ---------------- */

const role = computed(() => (detail.value ? Number(detail.value.memberRole ?? 0) : 0))
const isMember = computed(() => role.value > -1)
const canEdit = computed(() => role.value > 0)
const ownerRole = computed(() => role.value === 2)
/** 项目群禁止编辑群资料 */
const forbidEditInfo = computed(() => Number(detail.value?.type) === 3)
const canEditInfo = computed(() => canEdit.value && !forbidEditInfo.value)
const isMeetingTemplate = computed(() => detail.value?.templateCode === 'meetingGroupDefault')
const isPublic = computed(() => groupService.isPublicGroup(detail.value))
const joinModeOn = computed(() => groupService.isJoinModeOn(detail.value))
const isSilentOn = computed(() => groupService.isSilentOn(detail.value))
const canAddMember = computed(
  () => role.value > 0 || !!detail.value?.isAllowMemInvite,
)
const canMuteTab = computed(() => ownerRole.value && groupService.isGroupSilentEnabled())

const tabs = computed(() =>
  [
    { id: 'profile' as const, label: '群资料' },
    { id: 'members' as const, label: '群成员' },
    { id: 'bulletin' as const, label: '群公告' },
    ...(canMuteTab.value ? [{ id: 'mute' as const, label: '群禁言' }] : []),
    { id: 'more' as const, label: '更多' },
  ],
)

const myMember = computed(() => members.value.find((m) => m.userId === selfId) || null)
const ownerMember = computed(() => members.value.find((m) => m.memberRole === 2) || null)
const ownerName = computed(
  () => ownerMember.value ? showName(ownerMember.value) : (detail.value?.ownerId ? `ID: ${detail.value.ownerId}` : '-'),
)
const typeLabel = computed(() => {
  switch (Number(detail.value?.type)) {
    case 1: return '普通群'
    case 2: return '讨论组'
    case 3: return '项目群'
    case 4: return '工作群'
    default: return '群组'
  }
})

const filteredMembers = computed(() => {
  const kw = memberKw.value.trim().toLowerCase()
  if (!kw) return members.value
  return members.value.filter((m) =>
    [m.name, m.userName, m.nickName, m.loginId, m.userId].some(
      (v) => (v || '').toLowerCase().includes(kw),
    ),
  )
})

const qrcodeText = computed(
  () => `[OpenBuiltIn]\nkey=GroupCard\ngroupId=${props.groupId}`,
)

/* ---------------- 展示辅助 ---------------- */

function showName(m: GroupMember): string {
  return m.nickName || m.name || m.userName || m.userId
}

/** 全员禁言开启时，普通成员被单独禁言才显示「已禁言」 */
function isSelfMuted(m: GroupMember): boolean {
  if (!isSilentOn.value || Number(m.silentStatus) !== 1) return false
  return Number(m.memberRole) === 0
}

function fmtTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts < 1e11 ? ts * 1000 : ts)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ---------------- 加载 ---------------- */

function resetAll() {
  tab.value = 'profile'
  detail.value = null
  detailError.value = ''
  members.value = []
  membersTotal.value = 0
  membersError.value = ''
  memberKw.value = ''
  bulletins.value = []
  bulletinTotal.value = 0
  bulletinCursor.value = ''
  bulletinsError.value = ''
  mutedList.value = []
  whitelist.value = []
  joinCode.value = ''
  joinCodeExpire.value = ''
  nameDraft.value = props.groupName || ''
  notesDraft.value = ''
  nickDraft.value = ''
  applyReason.value = ''
  applyCode.value = ''
  inviteOpen.value = false
  inviteReason.value = ''
  invitedItems.value = []
  editorOpen.value = false
  editing.value = null
  pickerFor.value = ''
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    resetAll()
    try {
      detail.value = await im.ensureGroupDetail(props.groupId)
      if (!detail.value) throw new Error('获取群信息失败：接口未返回群资料')
      if (!nameDraft.value) nameDraft.value = detail.value.name || props.groupName || ''
      notesDraft.value = detail.value.notes || ''
      if (myMember.value) {
        nickDraft.value = myMember.value.nickName || myMember.value.name || ''
      }
      joinCode.value = String(detail.value.joinCode || '')
      joinCodeExpire.value = fmtTime(Number(detail.value.expireDate))
    } catch (e: any) {
      detailError.value = e?.message || '获取群信息失败'
    }
    void loadMembers()
    if (isMember.value) void loadBulletins()
  },
  { immediate: true },
)

function switchTab(next: typeof tab.value) {
  tab.value = next
  if (next === 'mute' && (!mutedList.value.length || !whitelist.value.length)) {
    void loadMuteLists()
  }
}

async function refreshDetail() {
  try {
    const d = await groupService.getGroupDetail(props.groupId)
    if (d) {
      im.setGroupDetail(d)
      detail.value = d
      joinCode.value = String(d.joinCode || joinCode.value)
      joinCodeExpire.value = fmtTime(Number(d.expireDate)) || joinCodeExpire.value
    }
  } catch {
    /* 刷新失败保留本地状态 */
  }
}

async function loadMembers() {
  membersLoading.value = true
  membersError.value = ''
  try {
    const all = await groupService.getMembers(props.groupId)
    members.value = all
    membersTotal.value = all.length
    if (myMember.value && !nickDraft.value) {
      nickDraft.value = myMember.value.nickName || myMember.value.name || ''
    }
  } catch (e: any) {
    membersError.value = e?.message || '获取群成员失败'
  } finally {
    membersLoading.value = false
  }
}

async function loadBulletins(append = false) {
  if (!isMember.value) return
  bulletinsLoading.value = true
  try {
    const page = await groupService.listBulletins(
      props.groupId,
      append ? bulletinCursor.value : '',
    )
    bulletins.value = append ? [...bulletins.value, ...page.items] : page.items
    bulletinTotal.value = page.total
    bulletinCursor.value = page.cursor
  } catch (e: any) {
    if (!append) bulletinsError.value = e?.message || '公告加载失败'
  } finally {
    bulletinsLoading.value = false
  }
}

async function loadMuteLists() {
  try {
    mutedList.value = await groupService.listMutedMembers(props.groupId)
  } catch {
    /* 非关键 */
  }
  try {
    whitelist.value = await groupService.listWhitelistMembers(props.groupId)
  } catch {
    /* 非关键 */
  }
}

/* ---------------- 群资料 ---------------- */

async function saveName() {
  const v = nameDraft.value.trim()
  if (!v || v === (detail.value?.name || '')) return
  const prev = detail.value?.name
  detail.value && (detail.value.name = v)
  try {
    await groupService.updateGroup(props.groupId, { name: v })
    im.renameSession(props.groupId, v)
    showToast('修改成功')
  } catch (e: any) {
    if (prev && detail.value) detail.value.name = prev
    else nameDraft.value = prev || ''
    showToast(e?.message || '修改群名失败')
  }
}

async function saveNotes() {
  const v = notesDraft.value
  if (v === (detail.value?.notes || '')) return
  const prev = detail.value?.notes
  detail.value && (detail.value.notes = v)
  try {
    await groupService.updateGroup(props.groupId, { notes: v })
    showToast('修改成功')
  } catch (e: any) {
    if (detail.value) detail.value.notes = prev
    notesDraft.value = prev || ''
    showToast(e?.message || '修改群介绍失败')
  }
}

async function saveNick() {
  const v = nickDraft.value.trim()
  const cur = myMember.value?.nickName
  if (v === (cur || '')) return
  try {
    await groupService.setMyNickname(props.groupId, v)
    if (myMember.value) myMember.value.nickName = v || undefined
    showToast('修改成功')
  } catch (e: any) {
    showToast(e?.message || '修改群内昵称失败')
  }
}

async function setPublic(on: boolean) {
  if (!detail.value) return
  const prev = groupService.isPublicGroup(detail.value) ? 1 : 0
  detail.value.isPublic = on ? 1 : 0
  try {
    await groupService.updateGroup(props.groupId, { isPublic: on ? 1 : 0 })
    // 官方行为：转回公开群时本地密码清空
    if (on) {
      joinCode.value = ''
      joinCodeExpire.value = ''
    }
    showToast('修改成功')
  } catch (e: any) {
    detail.value.isPublic = prev
    showToast(e?.message || '操作失败')
  }
}

async function setJoinMode(on: boolean) {
  if (!detail.value) return
  const prev = groupService.isJoinModeOn(detail.value)
  detail.value.joinMode = on ? '1' : '0'
  try {
    await groupService.updateGroup(props.groupId, { joinMode: on ? '1' : '0' })
    showToast(on ? '已开启入群确认' : '已关闭入群确认')
  } catch (e: any) {
    detail.value.joinMode = prev ? '1' : '0'
    showToast(e?.message || '操作失败')
  }
}

async function setAllowInvite(on: boolean) {
  if (!detail.value) return
  const prev = !!detail.value.isAllowMemInvite
  detail.value.isAllowMemInvite = on
  try {
    await groupService.updateGroup(props.groupId, { isAllowMemInvite: on })
    showToast(on ? '已允许成员邀请入群' : '已取消允许成员邀请')
  } catch (e: any) {
    detail.value.isAllowMemInvite = prev
    showToast(e?.message || '操作失败')
  }
}

async function doApply() {
  busyApply.value = true
  try {
    await groupService.applyJoin(props.groupId, applyReason.value, applyCode.value)
    showToast('申请已提交，等待群主或管理员确认')
    applyReason.value = ''
    applyCode.value = ''
    void refreshDetail()
  } catch (e: any) {
    showToast(e?.message || '申请入群失败')
  } finally {
    busyApply.value = false
  }
}

/* ---------------- 成员管理 ---------------- */

/** 移除权限（对齐官方）：群主可移除非群主；管理员可移除非管理员非群主 */
function canRemove(m: GroupMember): boolean {
  if (m.memberRole === 2) return false
  if (role.value === 2) return true
  if (role.value === 1) return m.memberRole !== 1
  return false
}

async function onAddMembers(items: PickedMember[]) {
  busy.value = true
  try {
    await groupService.addMembers(
      props.groupId,
      items.map((i) => ({ id: i.id, memRole: 0 })),
    )
    showToast('添加成功')
    await Promise.all([loadMembers(), refreshDetail()])
  } catch (e: any) {
    showToast(e?.message || '添加成员失败')
  } finally {
    busy.value = false
  }
}

function askRemove(m: GroupMember) {
  confirm.value = {
    open: true,
    title: '移除成员',
    message: `确定将该成员移除本群？`,
    okText: '移除',
    danger: true,
    run: async () => {
      try {
        await groupService.removeMembers(props.groupId, [m.userId])
        showToast('已移除')
        await Promise.all([loadMembers(), refreshDetail()])
      } catch (e: any) {
        showToast(e?.message || '移除成员失败')
      }
    },
  }
}

function askSetAdmin(m: GroupMember) {
  const add = m.memberRole !== 1
  confirm.value = {
    open: true,
    title: add ? '设置管理员' : '取消管理员',
    message: add ? '确定将该成员设为管理员？' : '确定取消管理员资格？',
    okText: add ? '设为管理员' : '取消管理员',
    danger: !add,
    run: async () => {
      // 整份覆盖：当前管理员（不含群主）± 目标
      const admins = new Set(
        members.value
          .filter((x) => Number(x.memberRole) === 1)
          .map((x) => x.userId),
      )
      if (add) admins.add(m.userId)
      else admins.delete(m.userId)
      try {
        await groupService.resetAdmins(props.groupId, [...admins])
        for (const x of members.value) {
          if (x.userId === m.userId) x.memberRole = add ? 1 : 0
        }
        showToast('操作成功')
      } catch (e: any) {
        showToast(e?.message || '操作失败')
      }
    },
  }
}

function confirmInvite() {
  busy.value = true
  groupService
    .inviteMembers(
      props.groupId,
      inviteReason.value,
      invitedItems.value.map((i) => i.id),
    )
    .then(() => {
      showToast('邀请已发送')
      inviteOpen.value = false
      invitedItems.value = []
      inviteReason.value = ''
    })
    .catch((e: any) => showToast(e?.message || '邀请入群失败'))
    .finally(() => (busy.value = false))
}

/* ---------------- 群公告 ---------------- */

function openEditor(b: BulletinItem | null) {
  editing.value = b
  bTitle.value = b?.title || ''
  bContent.value = b?.content || ''
  bImportant.value = !!b?.isImportant
  bSendMessage.value = false
  bError.value = ''
  editorOpen.value = true
}

function saveBulletin() {
  const title = bTitle.value.trim()
  const content = bContent.value
  if (!title) {
    bError.value = '请输入公告标题'
    return
  }
  if (title.length > 50) {
    bError.value = '标题不能超过50字'
    return
  }
  if (!content.trim()) {
    bError.value = '请输入公告内容'
    return
  }
  if (content.length > 500) {
    bError.value = '内容不能超过500字'
    return
  }
  bError.value = ''
  const body = {
    isImportant: bImportant.value,
    title,
    content,
    resources: [],
  }
  busy.value = true
  const req = editing.value
    ? groupService.updateBulletin(props.groupId, editing.value.bulletinId, body, bSendMessage.value)
    : groupService.createBulletin(props.groupId, body)
  req
    .then(() => {
      showToast('发布成功')
      editorOpen.value = false
      void loadBulletins()
    })
    .catch((e: any) => showToast(e?.message || '公告发布失败'))
    .finally(() => (busy.value = false))
}

function askImportant(b: BulletinItem) {
  const next = !b.isImportant
  const doIt = () => {
    // 官方行为：同一时间只有一个重要公告
    for (const x of bulletins.value) x.isImportant = false
    b.isImportant = next
    groupService
      .setBulletinImportant(props.groupId, b.bulletinId, next)
      .then(() => showToast('操作成功'))
      .catch((e: any) => {
        b.isImportant = !next
        showToast(e?.message || '操作失败')
      })
  }
  if (next) {
    doIt()
    return
  }
  confirm.value = {
    open: true,
    title: '取消重要公告',
    message: '取消后不再永久置顶，确认取消吗？',
    okText: '取消置顶',
    danger: true,
    run: async () => doIt(),
  }
}

function askDeleteBulletin(b: BulletinItem) {
  confirm.value = {
    open: true,
    title: '删除公告',
    message: '确定删除此公告？',
    okText: '删除',
    danger: true,
    run: async () => {
      try {
        await groupService.deleteBulletin(props.groupId, b.bulletinId)
        showToast('已删除')
        void loadBulletins()
      } catch (e: any) {
        showToast(e?.message || '公告删除失败')
      }
    },
  }
}

/* ---------------- 群禁言 ---------------- */

async function toggleMuteAll(on: boolean) {
  if (!detail.value) return
  const prev = isSilentOn.value
  detail.value.silentStatus = on ? 1 : 0
  try {
    await groupService.setMuteAll(props.groupId, on)
    showToast(on ? '已开启全员禁言' : '已解除全员禁言')
    im.setSelfMuted(props.groupId, false)
    void refreshDetail()
  } catch (e: any) {
    detail.value.silentStatus = prev ? 1 : 0
    showToast(e?.message || '操作失败')
  }
}

function unmuteMuted(m: GroupMember) {
  if (m.userId === selfId) {
    showToast('不能解除自己的禁言')
    return
  }
  // 官方：管理员不能解除其他管理员的禁言
  if (role.value === 1 && Number(m.memberRole) === 1) {
    showToast('不能解除管理员的禁言')
    return
  }
  busy.value = true
  groupService
    .removeMutedMembers(props.groupId, [m.userId])
    .then(() => {
      mutedList.value = mutedList.value.filter((x) => x.userId !== m.userId)
      showToast('已解除禁言')
    })
    .catch((e: any) => showToast(e?.message || '操作失败'))
    .finally(() => (busy.value = false))
}

function removeWhitelist(m: GroupMember) {
  busy.value = true
  groupService
    .removeWhitelistMembers(props.groupId, [m.userId])
    .then(() => {
      whitelist.value = whitelist.value.filter((x) => x.userId !== m.userId)
      showToast('已移除')
    })
    .catch((e: any) => showToast(e?.message || '操作失败'))
    .finally(() => (busy.value = false))
}

function confirmMuteTime() {
  busy.value = true
  groupService
    .addMutedMembers(props.groupId, pendingMuteIds.value, muteTime.value)
    .then(() => {
      showToast('已添加禁言')
      muteTimeOpen.value = false
      pendingMuteIds.value = []
      void loadMuteLists()
    })
    .catch((e: any) => showToast(e?.message || '添加禁言失败'))
    .finally(() => (busy.value = false))
}

async function addWhitelistPicked(items: PickedMember[]) {
  const ids = items
    .filter((i) => !presetIds.value.includes(i.id))
    .map((i) => i.id)
  if (!ids.length) return
  busy.value = true
  try {
    await groupService.addWhitelistMembers(props.groupId, ids)
    showToast('已添加')
    await loadMuteLists()
  } catch (e: any) {
    showToast(e?.message || '添加失败')
  } finally {
    busy.value = false
  }
}

/* ---------------- 更多 ---------------- */

async function genJoinCode() {
  busy.value = true
  try {
    const r = await groupService.createJoinCode(props.groupId, false)
    joinCode.value = r.code
    joinCodeExpire.value = fmtTime(Number(r.expireDate))
    showToast('生成成功')
  } catch (e: any) {
    showToast(e?.message || '生成入群密码失败')
  } finally {
    busy.value = false
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    showToast('已复制')
  } catch {
    showToast('复制失败，请手动选择复制')
  }
}

function askLeave() {
  const dismiss = ownerRole.value
  confirm.value = {
    open: true,
    title: dismiss ? '解散群组' : '退出群组',
    message: dismiss ? '确定解散本群？' : '确定退出本群？',
    okText: dismiss ? '解散' : '退出',
    danger: true,
    run: async () => {
      busyLeave.value = true
      try {
        if (dismiss) await groupService.dismissGroup(props.groupId)
        else await groupService.quitGroup(props.groupId)
        showToast(dismiss ? '群组已解散' : '已退出群组')
        emit('left', dismiss ? 'dismiss' : 'quit')
      } catch (e: any) {
        showToast(e?.message || (dismiss ? '解散群组失败' : '退出群组失败'))
      } finally {
        busyLeave.value = false
      }
    },
  }
}

/* ---------------- 选择器编排 ---------------- */

const pickerConfig = computed(() => {
  const ownerExclude = ownerMember.value?.userId && ownerMember.value.userId !== selfId
    ? [ownerMember.value.userId]
    : []
  switch (pickerFor.value) {
    case 'add':
      return {
        title: '添加群成员',
        source: 'contacts' as const,
        exclude: [selfId],
        preset: [] as string[],
      }
    case 'invite':
      return {
        title: '邀请入群',
        source: 'contacts' as const,
        exclude: [selfId],
        preset: [] as string[],
      }
    case 'transfer':
      return {
        title: '转让群组',
        source: 'members' as const,
        members: members.value,
        single: true,
        exclude: [selfId, ...ownerExclude],
        preset: [] as string[],
      }
    case 'mute':
      return {
        title: '添加禁言成员',
        source: 'members' as const,
        members: members.value,
        exclude: [selfId, ...ownerExclude],
        preset: mutedList.value.map((m) => m.userId),
      }
    case 'whitelist':
      return {
        title: '添加允许发言的成员',
        source: 'members' as const,
        members: members.value,
        exclude: [selfId, ...ownerExclude],
        preset: whitelist.value.map((m) => m.userId),
      }
    default:
      return {
        title: '选择成员',
        source: 'members' as const,
        members: members.value,
        exclude: [] as string[],
        preset: [] as string[],
      }
  }
})

function onPickerConfirm(items: PickedMember[]) {
  const target = pickerFor.value
  // 必须在清空 pickerFor 之前取 preset（computed 按 pickerFor 分支）
  presetIds.value = pickerConfig.value.preset
  pickerFor.value = ''
  if (!items.length) return
  if (target === 'add') void onAddMembers(items)
  else if (target === 'invite') {
    invitedItems.value = items
    inviteReason.value = ''
    inviteOpen.value = true
  } else if (target === 'transfer') {
    confirm.value = {
      open: true,
      title: '转让群组',
      message: `确定把群转让给「${items[0].name}」？转让后你将变为普通成员`,
      okText: '转让',
      danger: true,
      run: async () => {
        try {
          await groupService.transferOwner(props.groupId, items[0].id)
          showToast('转让成功')
          await refreshDetail()
          await loadMembers()
        } catch (e: any) {
          showToast(e?.message || '转让失败')
        }
      },
    }
  } else if (target === 'mute') {
    const ids = items
      .filter((i) => !presetIds.value.includes(i.id))
      .map((i) => i.id)
    if (ids.length) {
      pendingMuteIds.value = ids
      muteTime.value = 1
      muteTimeOpen.value = true
    }
  } else if (target === 'whitelist') {
    void addWhitelistPicked(items)
  }
}

function runConfirm() {
  const run = confirm.value.run
  confirm.value.open = false
  run?.()
}

function close() {
  emit('close')
}
</script>

<style scoped>
.gs-mask {
  position: fixed; inset: 0; z-index: 85; background: var(--overlay);
  display: flex; align-items: center; justify-content: center;
}
.gs {
  position: relative;
  width: min(640px, 94vw); height: min(760px, 90vh);
  background: var(--surface); border-radius: 10px;
  display: flex; flex-direction: column; overflow: hidden;
}
header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--border);
}
h3 { margin: 0; font-size: 15px; }
.small { padding: 4px 10px; font-size: 12px; }

.tabs { display: flex; border-bottom: 1px solid var(--border); }
.tabs button {
  flex: 1; background: transparent; color: var(--text-muted);
  border-radius: 0; padding: 9px 4px; font-size: 13px;
}
.tabs button.on { color: var(--primary); box-shadow: inset 0 -2px 0 var(--primary); }

.panel { flex: 1; overflow-y: auto; padding: 16px 18px; }
.state { text-align: center; color: var(--text-muted); padding: 32px 8px; font-size: 13px; }
.state.error { color: var(--danger); }
.tip { font-size: 12px; color: var(--text-muted); line-height: 1.7; margin: 8px 0; }
.tip.warn { color: var(--danger); }
.muted { color: var(--text-muted); font-size: 13px; }
.mono { font-family: Menlo, monospace; font-size: 12px; word-break: break-all; }

.hero { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
.big-avatar {
  width: 60px; height: 60px; border-radius: 50%; flex-shrink: 0;
  background: #4a90d9; color: #fff; font-size: 26px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
}
.hero-info { flex: 1; min-width: 0; }
.hero-info h2 { font-size: 18px; margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; }
.name-input { max-width: 100%; font-size: 16px; font-weight: 600; }
.sub { display: flex; align-items: center; gap: 8px; }
.tag {
  display: inline-block; background: var(--chip-bg); color: var(--chip-text);
  border-radius: 4px; padding: 1px 8px; font-size: 12px;
}
.tag.warn { background: var(--danger-soft); color: var(--danger); }

.rows { margin: 0; }
.row {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 12px 2px; border-bottom: 1px solid var(--divider);
}
.row dt { width: 110px; flex-shrink: 0; color: var(--text-muted); font-size: 13px; padding-top: 2px; }
.row dd { flex: 1; min-width: 0; font-size: 13px; line-height: 1.7; word-break: break-all; }
.row dd.grow { display: flex; flex-direction: column; gap: 8px; }
.row dd.right { align-items: flex-end; }
.inline-input { max-width: 320px; }
.inline-input.code { max-width: 120px; letter-spacing: 4px; }
.text { word-break: break-all; }

.switch { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.switch input { width: 16px; height: 16px; accent-color: var(--primary); }

.apply-box { margin-top: 12px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }

/* 成员 */
.mm-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.mm-head input { flex: 1; }
.mm-total { font-size: 12px; color: var(--text-muted); flex-shrink: 0; }
.mm-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.mm-list { list-style: none; }
.mm-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 6px; border-bottom: 1px solid var(--divider);
}
.mm-row.me .mm-name { color: var(--primary); }
.avatar {
  width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
  background: var(--info-soft); color: var(--info-text); font-weight: 600; font-size: 13px;
  display: flex; align-items: center; justify-content: center;
}
.mm-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mm-name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge {
  font-style: normal; font-size: 11px; border-radius: 4px; padding: 0 5px; margin-left: 6px;
  background: var(--chip-bg); color: var(--chip-text);
}
.badge.owner { background: var(--primary-soft); color: var(--primary); }
.badge.muted { background: var(--danger-soft); color: var(--danger); }
.mm-nick { font-size: 11px; color: var(--text-muted); }
.mm-ops { display: flex; gap: 6px; flex-shrink: 0; }
.mini {
  background: var(--chip-bg); color: var(--chip-text); font-size: 11px;
  padding: 3px 8px; border-radius: 4px;
}
.mini.danger { color: var(--danger); }
.mini:hover { background: var(--hover); }

.invite-box { border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-top: 12px; }
.invite-head { display: flex; justify-content: space-between; align-items: center; font-size: 13px; margin-bottom: 8px; }
.link { background: transparent; color: var(--primary); font-size: 12px; padding: 2px 6px; }
.invite-box textarea { margin-bottom: 10px; }
.invite-foot, .sub-box footer { display: flex; justify-content: flex-end; gap: 10px; }

/* 公告 */
.bn-actions { margin-bottom: 10px; }
.editor { display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
.editor .inline-input { max-width: 100%; }
.chk { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.chk input { width: 15px; height: 15px; accent-color: var(--primary); }
.bn-list { list-style: none; }
.bn-item {
  border: 1px solid var(--border); border-radius: 8px;
  padding: 12px; margin-bottom: 10px; background: var(--bg-subtle);
}
.bn-title { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
.star { color: var(--danger); margin-right: 4px; }
.bn-content { font-size: 13px; color: var(--text); line-height: 1.7; white-space: pre-wrap; word-break: break-all; }
.bn-meta { font-size: 11px; color: var(--text-muted); margin-top: 8px; }
.bn-ops { display: flex; gap: 6px; margin-top: 8px; }
.more-row { text-align: center; margin-top: 8px; }

/* 禁言 */
.sub-h {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; margin: 16px 0 6px;
}
.sub-h .mini { margin-left: auto; }
.mm-list.slim .mm-row { border-bottom: none; padding: 6px; }

/* 更多 */
.code-box { display: flex; align-items: center; gap: 6px; }
.code-digit {
  width: 28px; height: 34px; border: 1px solid var(--border); border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-family: Menlo, monospace; font-size: 16px; font-weight: 700;
}
.qr-text {
  background: #2b2c2d; color: #9ad9a0; padding: 10px; border-radius: 6px;
  font-size: 11px; overflow-x: auto; margin-bottom: 8px; white-space: pre;
}
.danger-row dd.right { align-items: flex-end; }

/* toast / 子弹窗 */
.toast {
  position: absolute; top: 54px; left: 50%; transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.78); color: #fff;
  padding: 7px 16px; border-radius: 6px; font-size: 13px; z-index: 5;
  max-width: 80%;
}
.sub-mask {
  position: fixed; inset: 0; z-index: 96; background: var(--overlay);
  display: flex; align-items: center; justify-content: center;
}
.sub-box {
  width: min(320px, 90vw); background: var(--surface);
  border-radius: 10px; padding: 18px; display: flex; flex-direction: column; gap: 12px;
}
.time-opts { display: flex; flex-wrap: wrap; gap: 8px 16px; }
.time-opt { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.time-opt input { width: 15px; height: 15px; accent-color: var(--primary); }
</style>
