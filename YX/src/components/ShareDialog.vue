<template>
  <div v-if="open" class="share-mask" @click.self="close">
    <section class="share-dialog" role="dialog" aria-modal="true" aria-label="网盘共享">
      <header>
        <h3>{{ edit ? '编辑共享' : '共享' }}</h3>
        <button class="secondary small" :disabled="submitting" @click="close">关闭</button>
      </header>

      <div v-if="item" class="share-target">
        <div class="target-name">共享内容：{{ item.name }}</div>
        <div class="hint">共享内容将自动更新为最新版本</div>
      </div>

      <div v-if="loading" class="state">加载中…</div>

      <template v-else-if="!result">
        <div class="field">
          <label class="field-label">共享形式</label>
          <div class="seg-row">
            <label :class="{ active: form.type === 'P' }">
              <input v-model="form.type" type="radio" value="P" />
              <span>外链共享</span>
            </label>
            <label :class="{ active: form.type === 'S' }">
              <input v-model="form.type" type="radio" value="S" />
              <span>内部共享</span>
            </label>
          </div>
        </div>

        <!-- 内部共享：选人/团队/部门 -->
        <div v-if="form.type === 'S'" class="field">
          <label class="field-label">共享对象</label>
          <div class="member-picker">
            <div v-if="selected.length" class="chips">
              <span v-for="m in selected" :key="m.code + m.id" class="chip">
                {{ kindLabel(m.code) }} · {{ m.name || m.id }}
                <button class="chip-x" :disabled="submitting" @click="removeMember(m)">×</button>
              </span>
            </div>
            <input
              v-model="memberKeyword"
              placeholder="输入姓名、部门/群组名称快速添加"
              @input="onMemberInput"
            />
            <div v-if="memberResults.length" class="member-results">
              <button
                v-for="m in memberResults"
                :key="m.code + m.id"
                class="member-row"
                :disabled="submitting"
                @click="addMember(m)"
              >
                <span class="member-kind">{{ kindLabel(m.code) }}</span>
                <span>{{ m.name || m.id }}</span>
              </button>
            </div>
          </div>
        </div>

        <div class="field">
          <label class="field-label">权限</label>
          <div class="perm-list">
            <div class="perm-row">
              <label><input v-model="form.previewable" type="checkbox" />可预览</label>
              <input
                v-model="form.previewLimit"
                class="limit-input"
                :disabled="!form.previewable"
                placeholder="不限次数"
                inputmode="numeric"
              />
            </div>
            <div class="perm-row">
              <label><input v-model="form.downloadable" type="checkbox" />可下载</label>
              <input
                v-model="form.downloadLimit"
                class="limit-input"
                :disabled="!form.downloadable"
                placeholder="不限次数"
                inputmode="numeric"
              />
            </div>
            <div v-if="showEditPerm" class="perm-row">
              <label><input v-model="form.editable" type="checkbox" />可编辑</label>
            </div>
            <div v-if="showUploadPerm" class="perm-row">
              <label><input v-model="form.uploadable" type="checkbox" />可上传</label>
            </div>
          </div>
          <p class="hint">次数留空表示不限；取消勾选表示不允许。</p>
        </div>

        <div v-if="form.type === 'P'" class="field">
          <label class="field-label">提取码</label>
          <div class="check-row">
            <label><input v-model="form.passwordOn" type="checkbox" />需要提取码</label>
          </div>
          <input
            v-if="form.passwordOn"
            v-model="form.password"
            maxlength="8"
            placeholder="4-8 位字母或数字"
          />
        </div>

        <div class="field">
          <label class="field-label">有效期</label>
          <select v-model="form.validity">
            <option value="7">7 天内</option>
            <option value="30">30 天内</option>
            <option value="forever">永久有效</option>
            <option value="custom">指定日期</option>
          </select>
          <input v-if="form.validity === 'custom'" v-model="form.expireDate" type="date" />
        </div>

        <p v-if="error" class="share-error" role="alert">{{ error }}</p>

        <footer>
          <button class="secondary small" :disabled="submitting" @click="close">取消</button>
          <button class="small" :disabled="submitting" @click="submit">
            {{ submitting ? '提交中…' : edit ? '保存' : '创建共享' }}
          </button>
        </footer>
      </template>

      <template v-else>
        <div class="share-result">
          <p class="result-title">{{ result.type === 'S' ? '共享成功！' : '成功创建共享链接' }}</p>
          <template v-if="result.type === 'S'">
            <p class="hint">已共享给 {{ selectedNames || '所选成员' }}。</p>
          </template>
          <template v-else>
            <div class="result-row">
              <label>链接</label>
              <div class="link-text">{{ result.href || '-' }}</div>
            </div>
            <div v-if="result.password" class="result-row">
              <label>提取码</label>
              <span>{{ result.password }}</span>
            </div>
            <div class="result-row">
              <label>有效期</label>
              <span>{{ resultExpireText }}</span>
            </div>
            <div class="result-actions">
              <button class="small" @click="copyResult">
                {{ result.password ? '复制链接及提取码' : '复制链接' }}
              </button>
            </div>
          </template>
        </div>
        <footer>
          <button class="small" @click="close">完成</button>
        </footer>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  searchSharePrincipals,
  shareInfo,
  type PanShareInput,
  type PanShareItem,
  type PanShareLinkInfo,
  type PanSharePrincipal,
} from '../services/disk-pan'
import { useDiskStore } from '../stores/disk'

const props = defineProps<{
  open: boolean
  item: { id: string; name: string; type: 'D' | 'F' } | null
  /** 传入表示编辑已有共享 */
  edit?: PanShareItem | null
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'saved', edited: boolean): void
}>()

const disk = useDiskStore()

const form = reactive({
  type: 'P' as 'P' | 'S',
  validity: '7' as '7' | '30' | 'forever' | 'custom',
  expireDate: '',
  passwordOn: false,
  password: '',
  previewable: true,
  downloadable: true,
  editable: false,
  uploadable: false,
  previewLimit: '',
  downloadLimit: '',
})

const selected = ref<PanSharePrincipal[]>([])
const memberKeyword = ref('')
const memberResults = ref<PanSharePrincipal[]>([])
const loading = ref(false)
const submitting = ref(false)
const error = ref('')
const result = ref<PanShareLinkInfo | null>(null)
let searchSeq = 0

const selectedNames = computed(() =>
  selected.value.map((m) => m.name || m.id).join('、'),
)

/** 目录（或编辑已有共享时）才提供「可上传」 */
const showUploadPerm = computed(
  () => props.item?.type === 'D' || !!props.edit,
)

/** 文件才能设可编辑；编辑已有共享时原版两者都放开 */
const showEditPerm = computed(() => !!props.edit || props.item?.type !== 'D')

const resultExpireText = computed(() => {
  const r = result.value
  if (!r) return ''
  if (r.validity !== -1) return '永久有效'
  if (!r.expireDate) return ''
  if (typeof r.expireDate === 'number') {
    return new Date(r.expireDate).toLocaleDateString('zh-CN')
  }
  return String(r.expireDate).split(' ')[0] || ''
})

function isoDate(offsetDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function kindLabel(code: PanSharePrincipal['code']): string {
  if (code === 'team') return '团队'
  if (code === 'department') return '部门'
  return '用户'
}

function resetForm() {
  form.type = 'P'
  form.validity = '7'
  form.expireDate = ''
  form.passwordOn = false
  form.password = ''
  form.previewable = true
  form.downloadable = true
  form.editable = false
  form.uploadable = false
  form.previewLimit = ''
  form.downloadLimit = ''
  selected.value = []
  memberKeyword.value = ''
  memberResults.value = []
  error.value = ''
  result.value = null
  loading.value = false
  submitting.value = false
}

function fillFromEdit(item: PanShareItem) {
  form.type = item.shareType === 'S' ? 'S' : 'P'
  form.passwordOn = !!item.password
  form.password = item.password || ''

  if (item.status === 0) {
    form.validity = 'forever'
    form.expireDate = ''
  } else if (item.status === -2) {
    const date = item.expiredInfo
      ? String(item.expiredInfo).split(' ')[0]
      : typeof item.expireDate === 'number'
        ? new Date(item.expireDate).toISOString().slice(0, 10)
        : ''
    form.validity = 'custom'
    form.expireDate = date || isoDate(7)
  } else {
    form.validity = '7'
    form.expireDate = isoDate(7)
  }

  // 原版编辑用列表项的 operationPerm / 次数上限回填
  const perm = item.operationPerm || {}
  form.previewable = perm.previewable !== false && item.previewLimit !== 0
  form.downloadable = perm.downloadable !== false && item.downloadLimit !== 0
  form.editable = perm.editable === true
  form.uploadable = perm.uploadable === true
  form.previewLimit =
    typeof item.previewLimit === 'number' && item.previewLimit > 0
      ? String(item.previewLimit)
      : ''
  form.downloadLimit =
    typeof item.downloadLimit === 'number' && item.downloadLimit > 0
      ? String(item.downloadLimit)
      : ''
}

async function loadEdit() {
  const item = props.edit
  if (!item) return
  // 列表项已带类型/权限/有效期，先回填；成员只有详情接口返回
  fillFromEdit(item)
  if (item.shareType !== 'S') return
  loading.value = true
  error.value = ''
  try {
    const info = await shareInfo(item.id)
    selected.value = (info.shareMembers || [])
      .map((m) => {
        const code =
          m.type === 'team' || m.type === 'department' ? m.type : 'user'
        return {
          // 原版 shareMembers 的 id 带 U/G/D 前缀，创建/修改时去掉
          id: String(m.id || '').slice(1),
          code,
          name: m.name,
        } as PanSharePrincipal
      })
      .filter((m) => !!m.id)
  } catch (e: any) {
    error.value = '加载共享对象失败：' + (e?.message || String(e))
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    resetForm()
    if (props.edit) void loadEdit()
  },
  { immediate: true },
)

function close() {
  if (submitting.value) return
  emit('update:open', false)
}

function addMember(m: PanSharePrincipal) {
  if (selected.value.some((x) => x.code === m.code && x.id === m.id)) return
  selected.value.push({ ...m })
  memberKeyword.value = ''
  memberResults.value = []
}

function removeMember(m: PanSharePrincipal) {
  selected.value = selected.value.filter(
    (x) => !(x.code === m.code && x.id === m.id),
  )
}

async function onMemberInput() {
  const kw = memberKeyword.value.trim()
  if (!kw) {
    memberResults.value = []
    return
  }
  const seq = ++searchSeq
  try {
    const list = await searchSharePrincipals(kw)
    if (seq === searchSeq) memberResults.value = list
  } catch {
    if (seq === searchSeq) memberResults.value = []
  }
}

/** 输入框留空表示不限，否则按正整数次数 */
function limitValue(raw: string): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return -1
  return Math.floor(n)
}

function buildInput(): PanShareInput {
  const days = form.validity === 'forever' ? 0 : -1
  const expireDate =
    form.validity === '7'
      ? isoDate(7)
      : form.validity === '30'
        ? isoDate(30)
        : form.validity === 'custom'
          ? form.expireDate
          : undefined
  return {
    type: form.type,
    resources: props.item
      ? [{ resourceId: props.item.id, resourceType: props.item.type }]
      : [],
    principals:
      form.type === 'S'
        ? selected.value.map((m) => ({ id: m.id, code: m.code }))
        : undefined,
    previewLimit: form.previewable ? limitValue(form.previewLimit) : 0,
    downloadLimit: form.downloadable ? limitValue(form.downloadLimit) : 0,
    operationPerm: {
      previewable: form.previewable,
      downloadable: form.downloadable,
      editable: form.editable && showEditPerm.value,
      uploadable: form.uploadable && showUploadPerm.value,
    },
    days,
    expireDate,
    password:
      form.type === 'P' && form.passwordOn
        ? form.password.trim()
        : undefined,
  }
}

async function submit() {
  if (submitting.value) return
  error.value = ''
  if (form.type === 'S' && selected.value.length === 0) {
    error.value = '请选择共享对象'
    return
  }
  if (form.passwordOn && form.type === 'P' && !/^[\da-zA-Z]{4,8}$/.test(form.password)) {
    error.value = '提取码需为 4-8 位字母或数字'
    return
  }
  if (form.validity === 'custom' && !form.expireDate) {
    error.value = '请选择到期日期'
    return
  }
  submitting.value = true
  try {
    const info = await disk.saveShare(buildInput(), props.edit?.id)
    if (!info) throw new Error('服务端未返回共享结果')
    if (props.edit) {
      // 原版编辑共享后直接关闭弹窗并刷新列表，不再展示链接
      emit('saved', true)
      emit('update:open', false)
      return
    }
    result.value = info
    emit('saved', false)
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    submitting.value = false
  }
}

async function copyResult() {
  const r = result.value
  if (!r?.href) return
  const text = r.password
    ? `${r.href} 提取码：${r.password}`
    : r.href
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* 剪贴板不可用时用户可手动复制 */
  }
}
</script>

<style scoped>
.share-mask {
  position: fixed; inset: 0; z-index: 60;
  background: var(--overlay);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.share-dialog {
  width: min(480px, 100%); max-height: min(86vh, 760px); overflow-y: auto;
  padding: 22px 24px; background: var(--surface); border-radius: 12px;
  box-shadow: var(--shadow-2);
  display: flex; flex-direction: column; gap: 18px;
  font-size: 13px;
}
.share-dialog header {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.share-dialog h3 { font-size: 16px; font-weight: 600; }

/* 共享对象信息 */
.share-target {
  display: flex; flex-direction: column; gap: 4px;
  padding: 10px 12px;
  background: var(--bg-subtle);
  border: 1px solid var(--divider);
  border-radius: 8px;
}
.target-name { word-break: break-all; line-height: 1.5; }
.hint { color: var(--text-muted); font-size: 12px; line-height: 1.6; }
.state { padding: 8px 0; color: var(--text-muted); font-size: 13px; }

/* 表单 */
.field { display: flex; flex-direction: column; gap: 8px; }
.field-label { font-size: 13px; font-weight: 600; }
.share-dialog input:not([type='checkbox']):not([type='radio']),
.share-dialog select {
  font-size: 13px;
}
.share-dialog select {
  width: 100%; padding: 8px 12px;
  font-family: inherit; color: var(--text); background: var(--surface);
  border: 1px solid var(--border); border-radius: 6px;
  outline: none; transition: border-color 0.15s;
}
.share-dialog select:focus { border-color: var(--primary); }
.share-dialog input[type='checkbox'],
.share-dialog input[type='radio'] {
  flex: none; width: 15px; height: 15px;
  padding: 0; margin: 0;
}
.check-row label,
.seg-row label,
.perm-row label {
  display: inline-flex; align-items: center; gap: 8px;
}

/* 共享形式：两块等宽选项卡 */
.seg-row { display: flex; gap: 8px; }
.seg-row label {
  flex: 1 1 0; justify-content: center;
  padding: 9px 12px;
  border: 1px solid var(--border); border-radius: 8px;
  color: var(--text-muted); cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.seg-row label:hover { background: var(--hover); }
.seg-row label.active {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary-soft-text);
  font-weight: 500;
}

/* 共享成员 */
.member-picker { display: flex; flex-direction: column; gap: 8px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 6px 4px 10px; border-radius: 999px;
  background: var(--chip-bg); color: var(--chip-text); font-size: 12px;
}
.chip-x {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; padding: 0;
  background: transparent; color: inherit;
  border-radius: 50%; font-size: 13px; line-height: 1;
}
.chip-x:hover { background: var(--hover); }
.member-results {
  max-height: 176px; overflow-y: auto;
  border: 1px solid var(--divider); border-radius: 8px;
}
.member-row {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 8px 10px;
  background: none; color: var(--text); text-align: left; font-size: 13px;
  border-radius: 0;
}
.member-row + .member-row { border-top: 1px solid var(--divider); }
.member-row:hover { background: var(--hover); }
.member-kind {
  flex: none; padding: 1px 6px; border-radius: 4px; font-size: 11px;
  background: var(--chip-bg); color: var(--chip-text);
}

/* 权限：整块分组，行间用分隔线 */
.perm-list {
  display: flex; flex-direction: column;
  border: 1px solid var(--divider); border-radius: 8px;
  overflow: hidden;
}
.perm-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 9px 12px;
}
.perm-row + .perm-row { border-top: 1px solid var(--divider); }
.perm-row label { cursor: pointer; }
.limit-input { width: 128px; }
.limit-input:disabled { opacity: 0.5; }

.share-error {
  padding: 8px 10px; border-radius: 6px;
  background: var(--danger-soft); color: var(--danger); font-size: 12px;
}
.share-dialog footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding-top: 14px; border-top: 1px solid var(--divider);
}

/* 创建成功 */
.share-result { display: flex; flex-direction: column; gap: 12px; }
.result-title { font-size: 14px; font-weight: 600; }
.result-row { display: flex; align-items: flex-start; gap: 10px; line-height: 1.6; }
.result-row label { flex: none; width: 52px; color: var(--text-muted); }
.result-row span { min-width: 0; word-break: break-all; }
.link-text {
  flex: 1; min-width: 0;
  padding: 8px 10px;
  background: var(--bg-subtle);
  border: 1px solid var(--divider); border-radius: 6px;
  word-break: break-all; user-select: text;
}
.result-actions { display: flex; justify-content: flex-end; }
.share-dialog .small { padding: 6px 14px; font-size: 12px; }
</style>
