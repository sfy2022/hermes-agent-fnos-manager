<template>
  <div class="flex flex-col gap-4 pb-20 sm:pb-8">
    <div class="sticky top-0 z-20 -mx-4 sm:-mx-8 px-4 sm:px-8 pt-5 pb-3 bg-[#f4f6fb]/90 dark:bg-[#12141a]/90 backdrop-blur-md flex items-center justify-between gap-3">
      <div class="flex items-baseline gap-2.5 min-w-0">
        <h1 class="text-xl font-bold text-slate-800 dark:text-slate-100 tracking-tight shrink-0">快照管理</h1>
        <span class="text-xs text-slate-500 dark:text-slate-400 font-medium truncate">
          共 {{ items.length }} 个 · {{ totalSize }}
        </span>
      </div>
      <n-button type="primary" size="small" :disabled="!installed || busy" @click="openCreate">创建快照</n-button>
    </div>

    <n-alert v-if="error" type="error" closable @close="error = ''">{{ error }}</n-alert>

    <!-- 进度 -->
    <div v-if="progress.state === 'running'" class="p-4 rounded-2xl bg-white dark:bg-[#181a22] border border-blue-100 dark:border-blue-900/40 shadow-sm space-y-2">
      <div class="flex items-center justify-between gap-3 text-[13px]">
        <div class="flex items-center gap-2 min-w-0">
          <n-spin :size="14" />
          <span class="text-slate-700 dark:text-slate-200 truncate">
            {{ progress.kind === 'restore' ? '恢复快照' : '创建快照' }} · {{ progress.message }}
          </span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="font-mono font-bold text-fnos-blue">{{ progress.percent }}%</span>
          <n-button size="small" type="error" secondary @click="cancel">取消</n-button>
        </div>
      </div>
      <n-progress type="line" :percentage="progress.percent" :show-indicator="false" :processing="true" :height="6" />
    </div>

    <n-alert v-if="progress.state === 'error'" type="error" closable @close="progress.state = 'idle'">
      {{ progress.error || '快照任务失败' }}
    </n-alert>

    <template v-if="!installed">
      <n-card :bordered="false" class="py-12 text-center shadow-sm rounded-2xl">
        <n-empty description="Hermes 尚未安装">
          <template #icon><n-icon :size="48" class="text-slate-300 dark:text-slate-600"><History /></n-icon></template>
          <template #extra><span class="text-xs text-slate-500 dark:text-slate-400">安装完成后可在这里备份与恢复数据目录</span></template>
        </n-empty>
      </n-card>
    </template>

    <template v-else>
      <n-card v-if="!items.length && !loading" :bordered="false" class="py-12 text-center shadow-sm rounded-2xl">
        <n-empty description="暂无快照备份">
          <template #icon><n-icon :size="48" class="text-slate-300 dark:text-slate-600"><History /></n-icon></template>
          <template #extra>
            <span class="text-xs text-slate-500 dark:text-slate-400">快照会打包 data 目录（不含缓存），恢复前会自动再存一份</span>
          </template>
        </n-empty>
      </n-card>

      <div v-else class="flex flex-col gap-2.5">
        <n-card v-for="item in items" :key="item.id" :bordered="false" hoverable class="interactive-card shadow-sm rounded-2xl">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-10 h-10 rounded-xl bg-slate-100 dark:bg-white/[0.06] flex items-center justify-center shrink-0">
                <n-icon :size="20" class="text-slate-500 dark:text-slate-400"><History /></n-icon>
              </div>
              <div class="min-w-0">
                <div class="text-[14px] font-semibold text-slate-800 dark:text-slate-100">{{ item.name || item.id }}</div>
                <div class="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">
                  {{ item.note || '—' }} · {{ formatTime(item.createdAt) }} · {{ formatSize(item.size) }}
                </div>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <n-button size="small" secondary :disabled="busy" @click="restore(item)">恢复</n-button>
              <n-button size="small" type="error" secondary :disabled="busy" @click="remove(item)">删除</n-button>
            </div>
          </div>
        </n-card>
      </div>
    </template>

    <!-- 创建快照 -->
    <n-modal v-model:show="createModal" preset="card" title="创建快照" class="w-[92vw] max-w-md" :mask-closable="false">
      <div class="space-y-3">
        <div>
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">名称（可选）</div>
          <n-input v-model:value="createForm.name" placeholder="如 升级前备份" />
        </div>
        <div>
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">备注（可选）</div>
          <n-input v-model:value="createForm.note" type="textarea" :rows="2" placeholder="这次快照的用途" />
        </div>
        <div class="text-[12px] text-slate-500 dark:text-slate-400">
          会先短暂停止容器，打包 data 目录（排除缓存）后自动恢复运行；可在进度卡片里取消。
        </div>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button @click="createModal = false">取消</n-button>
          <n-button type="primary" @click="startCreate">开始创建</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NIcon, NInput, NModal, NProgress, NSpin, useDialog, useMessage } from 'naive-ui'
import { History } from '@vicons/tabler'
import { del, get, post } from '../api'

const message = useMessage()
const dialog = useDialog()

const items = ref([])
const installed = ref(false)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const createModal = ref(false)
const createForm = reactive({ name: '', note: '' })
const progress = reactive({ state: 'idle', kind: '', percent: 0, message: '', error: '' })

let pollTimer = null

const totalSize = computed(() => formatSize(items.value.reduce((sum, i) => sum + (i.size || 0), 0)))

function formatSize(bytes) {
  const n = Number(bytes || 0)
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function load() {
  loading.value = true
  try {
    const [snapshots, status] = await Promise.all([get('api/snapshots'), get('api/status')])
    items.value = snapshots.items || []
    installed.value = Boolean(status.installed)
    error.value = ''
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function pollProgress() {
  try {
    const data = await get('api/snapshots/progress')
    Object.assign(progress, data)
    busy.value = data.state === 'running'
    if (data.state === 'done') {
      clearInterval(pollTimer)
      pollTimer = null
      message.success(data.kind === 'restore' ? '恢复完成' : '快照已创建')
      setTimeout(() => { progress.state = 'idle'; busy.value = false; load() }, 1200)
    } else if (data.state === 'error' || data.state === 'cancelled') {
      clearInterval(pollTimer)
      pollTimer = null
      busy.value = false
      if (data.state === 'error') message.error(data.error || '任务失败')
    }
  } catch (err) {
    error.value = err.message
  }
}

function startPolling() {
  clearInterval(pollTimer)
  pollTimer = setInterval(pollProgress, 1000)
  pollProgress()
}

function openCreate() {
  createForm.name = ''
  createForm.note = ''
  createModal.value = true
}

async function startCreate() {
  try {
    await post('api/snapshots', { name: createForm.name, note: createForm.note })
    createModal.value = false
    busy.value = true
    startPolling()
  } catch (err) {
    message.error(err.message)
  }
}

function restore(item) {
  dialog.warning({
    title: '恢复快照',
    content: `将用 ${item.name || item.id} 覆盖当前数据目录。恢复前会自动创建一份安全快照，容器会短暂停止。`,
    positiveText: '恢复',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await post('api/snapshots/restore', { id: item.id })
        busy.value = true
        startPolling()
      } catch (err) {
        message.error(err.message)
      }
    }
  })
}

function remove(item) {
  dialog.warning({
    title: '删除快照',
    content: `确定删除 ${item.name || item.id}？该操作不可恢复。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await del(`api/snapshots/${encodeURIComponent(item.id)}`)
        message.success('已删除')
        await load()
      } catch (err) {
        message.error(err.message)
      }
    }
  })
}

async function cancel() {
  try {
    await post('api/snapshots/cancel', {})
  } catch (err) {
    message.error(err.message)
  }
}

onMounted(load)
onBeforeUnmount(() => clearInterval(pollTimer))
</script>
