<template>
  <div class="flex flex-col gap-4 pb-20 sm:pb-8">
    <div class="sticky top-0 z-20 -mx-4 sm:-mx-8 px-4 sm:px-8 pt-5 pb-3 bg-[#f4f6fb]/90 dark:bg-[#12141a]/90 backdrop-blur-md flex items-center justify-between gap-3">
      <div class="flex items-baseline gap-2.5 min-w-0">
        <h1 class="text-xl font-bold text-slate-800 dark:text-slate-100 tracking-tight shrink-0">运行日志</h1>
        <span class="text-xs text-slate-500 dark:text-slate-400 font-medium truncate">
          {{ connected ? '实时推送' : '未连接' }}
        </span>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <n-input v-model:value="keyword" size="small" placeholder="过滤关键字" clearable class="!w-40 hidden sm:block" />
        <n-button size="small" secondary @click="toggleStream">{{ auto ? '暂停' : '继续' }}</n-button>
      </div>
    </div>

    <n-card size="small">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <n-tabs v-model:value="source" type="segment" size="small" class="!w-56" @update:value="restart">
          <n-tab name="container">容器日志</n-tab>
          <n-tab name="app">应用日志</n-tab>
        </n-tabs>
        <div class="flex flex-wrap items-center gap-2">
          <n-select v-model:value="tail" size="small" :options="tailOptions" class="w-28" @update:value="restart" />
          <n-button size="small" :loading="loading" @click="loadHistory">刷新</n-button>
          <n-button size="small" tag="a" :href="downloadUrl" target="_blank">下载</n-button>
          <n-button v-if="source === 'app'" size="small" type="error" secondary @click="clearLog">清空</n-button>
        </div>
      </div>
    </n-card>

    <n-card size="small" content-style="padding: 0;">
      <div class="flex items-center justify-between px-4 py-2 border-b border-slate-100 dark:border-white/5">
        <div class="text-[12px] text-slate-500 dark:text-slate-400">
          {{ source === 'app' ? 'var/info.log' : '容器输出（docker logs）' }}
          <span v-if="visibleLines.length" class="ml-2">{{ visibleLines.length }} 行</span>
        </div>
        <div class="text-[12px]" :class="error ? 'text-red-500' : 'text-emerald-500'">
          {{ error || (auto ? (connected ? 'WebSocket 已连接' : '连接中…') : '已暂停') }}
        </div>
      </div>
      <div ref="scroller" class="max-h-[62vh] overflow-auto p-4 bg-slate-50/60 dark:bg-[#12141a]">
        <div v-if="visibleLines.length" class="log-view">
          <div v-for="(line, i) in visibleLines" :key="i" :class="lineClass(line)">{{ line }}</div>
        </div>
        <n-empty v-else :description="loading ? '加载中…' : '暂无日志'" size="small" class="py-12" />
      </div>
    </n-card>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NCard, NEmpty, NInput, NSelect, NTab, NTabs, useDialog, useMessage } from 'naive-ui'
import { del, get } from '../api'

const message = useMessage()
const dialog = useDialog()

const source = ref('container')
const tail = ref(300)
const auto = ref(true)
const loading = ref(false)
const error = ref('')
const connected = ref(false)
const lines = ref([])
const keyword = ref('')
const scroller = ref(null)

const tailOptions = [
  { label: '200 行', value: 200 },
  { label: '500 行', value: 500 },
  { label: '1000 行', value: 1000 },
  { label: '2000 行', value: 2000 }
]

const downloadUrl = computed(() => `api/logs/download?source=${source.value}`)
const visibleLines = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return lines.value
  return lines.value.filter((line) => line.toLowerCase().includes(kw))
})

let socket = null
let fallbackTimer = null
let scrollPinned = true

function scrollToBottom() {
  if (!scrollPinned || !scroller.value) return
  scroller.value.scrollTop = scroller.value.scrollHeight
}

async function loadHistory() {
  loading.value = true
  try {
    const data = await get(`api/logs?source=${source.value}&tail=${tail.value}`)
    lines.value = data.lines || []
    error.value = ''
    await nextTick()
    scrollToBottom()
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

function stopStream() {
  connected.value = false
  if (socket) {
    try { socket.close() } catch { /* 忽略 */ }
    socket = null
  }
  if (fallbackTimer) {
    clearInterval(fallbackTimer)
    fallbackTimer = null
  }
}

function connect() {
  stopStream()
  const url = new URL('api/logs/ws', document.baseURI)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('source', source.value)
  url.searchParams.set('tail', String(tail.value))

  try {
    socket = new WebSocket(url)
  } catch (err) {
    error.value = err.message
    startFallback()
    return
  }
  socket.onopen = () => { connected.value = true; error.value = '' }
  socket.onmessage = (event) => {
    lines.value.push(String(event.data))
    if (lines.value.length > 3000) lines.value.splice(0, lines.value.length - 3000)
    nextTick(scrollToBottom)
  }
  socket.onerror = () => { error.value = 'WebSocket 断开，已降级为轮询' }
  socket.onclose = () => {
    connected.value = false
    if (auto.value) startFallback()
  }
}

function startFallback() {
  if (fallbackTimer || !auto.value) return
  fallbackTimer = setInterval(loadHistory, 2000)
}

async function restart() {
  stopStream()
  lines.value = []
  if (auto.value) {
    await loadHistory()
    connect()
  }
}

async function toggleStream() {
  auto.value = !auto.value
  if (auto.value) {
    await loadHistory()
    connect()
  } else {
    stopStream()
  }
}

function onScroll() {
  const el = scroller.value
  if (!el) return
  scrollPinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

function clearLog() {
  dialog.warning({
    title: '清空应用日志',
    content: '只会清空 var/info.log，容器日志由 Docker 管理，不受影响。',
    positiveText: '清空',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await del('api/logs')
        message.success('已清空')
        lines.value = []
        restart()
      } catch (err) {
        message.error(err.message)
      }
    }
  })
}

function lineClass(line) {
  if (/\b(ERROR|FATAL|Exception|Traceback)\b/i.test(line)) return 'log-line-error'
  if (/\b(WARN|WARNING)\b/i.test(line)) return 'log-line-warn'
  return ''
}

onMounted(async () => {
  await loadHistory()
  if (scroller.value) scroller.value.addEventListener('scroll', onScroll, { passive: true })
  connect()
})

onBeforeUnmount(() => {
  stopStream()
  if (scroller.value) scroller.value.removeEventListener('scroll', onScroll)
})
</script>
