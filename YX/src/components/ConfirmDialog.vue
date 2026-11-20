<template>
  <div v-if="open" class="confirm-mask" @click.self="onCancel">
    <section class="box" role="alertdialog" aria-modal="true" :aria-label="title">
      <h3>{{ title }}</h3>
      <p class="msg">{{ message }}</p>
      <footer>
        <button class="secondary" :disabled="busy" @click="onCancel">取消</button>
        <button :class="danger ? 'danger' : 'primary'" :disabled="busy" @click="onConfirm">
          {{ busy ? '处理中…' : okText }}
        </button>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 轻量二次确认（对齐官方 confirm 弹窗，文案由调用方传入 i18n 原文）：
 * 移成员 / 退群 / 解散 / 转让 / 取消管理员 / 删公告 等危险操作统一走这里。
 */
import { ref } from 'vue'

withDefaults(
  defineProps<{
    open: boolean
    title?: string
    message: string
    okText?: string
    danger?: boolean
  }>(),
  {
    title: '提示',
    okText: '确定',
    danger: false,
  },
)
const emit = defineEmits<{
  close: []
  confirm: []
}>()

const busy = ref(false)

function onCancel() {
  if (!busy.value) {
    emit('close')
  }
}

async function onConfirm() {
  if (busy.value) return
  busy.value = true
  emit('confirm')
  busy.value = false
}
</script>

<style scoped>
.confirm-mask {
  position: fixed; inset: 0; z-index: 95; background: var(--overlay);
  display: flex; align-items: center; justify-content: center;
}
.box {
  width: min(340px, 90vw);
  background: var(--surface); padding: 20px; border-radius: 10px;
  display: flex; flex-direction: column; gap: 14px;
}
h3 { margin: 0; font-size: 15px; }
.msg { font-size: 13px; color: var(--text-muted); line-height: 1.7; }
footer { display: flex; justify-content: flex-end; gap: 10px; }
</style>
