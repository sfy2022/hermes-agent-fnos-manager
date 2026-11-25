<template>
  <div class="w-full flex-1 flex flex-col gap-4 sm:gap-6 pb-20 sm:pb-8">
    <!-- 页头 -->
    <div class="sticky top-0 z-20 -mx-4 sm:-mx-8 px-4 sm:px-8 pt-5 pb-3 bg-[#f4f6fb]/90 dark:bg-[#12141a]/90 backdrop-blur-md flex items-center justify-between gap-3 w-full min-w-0">
      <h1 class="text-xl font-bold text-slate-800 dark:text-slate-100 tracking-tight shrink-0">概览</h1>
      <span v-if="statusData.config?.imageTag" class="text-xs font-mono text-slate-500 dark:text-slate-400 truncate" :title="`镜像: ${statusData.config.imageTag}`">
        镜像: {{ statusData.config.imageTag }}
      </span>
    </div>

    <template v-if="loaded">
      <!-- 状态核心卡片 -->
      <n-card :bordered="false" class="shadow-sm rounded-2xl">
        <div class="flex flex-col py-1 sm:py-2">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div class="space-y-1 min-w-0 flex-1">
              <div class="flex items-center gap-2.5 flex-wrap min-w-0">
                <span class="text-lg sm:text-xl font-bold text-slate-800 dark:text-slate-100 tracking-tight leading-tight truncate">
                  Hermes Agent
                </span>
                <n-tag v-if="installJob.state === 'running'" type="info" size="small" round :bordered="false">
                  <template #icon><n-spin :size="10" class="mr-0.5" /></template>
                  {{ installJob.percent }}%
                </n-tag>
                <n-tag v-else-if="snapshotJob.state === 'running'" type="warning" size="small" round :bordered="false">
                  <template #icon><n-spin :size="10" class="mr-0.5" /></template>
                  快照 {{ snapshotJob.percent }}%
                </n-tag>
              </div>
              <div class="text-xs sm:text-sm text-slate-500 dark:text-slate-400 flex items-center gap-1.5 sm:gap-2 flex-wrap min-w-0">
                <span class="shrink-0">版本: {{ versionText }}</span>
                <span v-if="statusData.config?.imageTag" class="shrink-0">· {{ statusData.config.imageTag }}</span>
                <span class="shrink-0">· 端口 {{ statusData.access?.port || 9121 }}</span>
              </div>
            </div>

            <n-button
              type="primary"
              size="medium"
              :disabled="!isRunning"
              class="w-full sm:w-auto !h-9 sm:!h-12 px-4 sm:px-7 shadow-sm shadow-fnos-blue/20 font-medium rounded-lg sm:rounded-xl text-sm sm:text-base transition-transform duration-150 active:scale-95"
              @click="openWebui"
            >
              <template #icon><n-icon class="text-[17px] sm:text-[20px]"><ExternalLink /></n-icon></template>
              <span>进入 Hermes</span>
            </n-button>
          </div>

          <n-divider class="!my-3.5 sm:!my-6" />

          <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 sm:gap-3 text-center">
            <div class="order-1 py-2 sm:py-3.5 px-3 rounded-xl sm:rounded-2xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100/80 dark:border-white/[0.06] flex flex-col justify-center items-center gap-1">
              <span class="text-xs text-slate-500 dark:text-slate-400 font-medium">运行状态</span>
              <n-tag :type="statusTagType" size="small" round :bordered="false" class="font-medium">
                <template #icon v-if="busyOrProgress"><n-spin :size="10" class="mr-0.5" /></template>
                {{ statusLabel }}
              </n-tag>
            </div>

            <div class="order-2 sm:order-3 py-2 sm:py-3.5 px-3 rounded-xl sm:rounded-2xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100/80 dark:border-white/[0.06] flex flex-col justify-center items-center gap-1">
              <span class="text-xs text-slate-500 dark:text-slate-400 font-medium">容器 ID</span>
              <div class="text-xs sm:text-base font-bold text-slate-700 dark:text-slate-200 font-mono truncate" :title="containerId">
                {{ containerId }}
              </div>
            </div>

            <div class="order-3 sm:order-4 py-2 sm:py-3.5 px-3 rounded-xl sm:rounded-2xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100/80 dark:border-white/[0.06] flex flex-col justify-center items-center gap-1">
              <span class="text-xs text-slate-500 dark:text-slate-400 font-medium">CPU 占用</span>
              <div class="text-xs sm:text-base font-bold text-slate-700 dark:text-slate-200 font-mono truncate">{{ metrics.cpu || '-' }}</div>
            </div>

            <div class="order-4 sm:order-5 py-2 sm:py-3.5 px-3 rounded-xl sm:rounded-2xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100/80 dark:border-white/[0.06] flex flex-col justify-center items-center gap-1">
              <span class="text-xs text-slate-500 dark:text-slate-400 font-medium">内存占用</span>
              <div class="text-xs sm:text-base font-bold text-slate-700 dark:text-slate-200 font-mono truncate">{{ metrics.memory || '-' }}</div>
            </div>

            <div class="order-5 col-span-2 sm:col-span-1 py-2 sm:py-3.5 px-3.5 rounded-xl sm:rounded-2xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100/80 dark:border-white/[0.06] flex flex-row sm:flex-col justify-between sm:justify-center items-center gap-1">
              <span class="text-xs text-slate-500 dark:text-slate-400 font-medium">运行时间</span>
              <div class="text-xs sm:text-base font-bold text-slate-700 dark:text-slate-200 font-mono truncate">{{ uptimeText }}</div>
            </div>
          </div>
        </div>
      </n-card>

      <!-- 运行控制 -->
      <div class="space-y-4">
        <h2 class="text-lg font-bold text-slate-800 dark:text-slate-100 tracking-tight">运行控制</h2>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-4">
          <n-tooltip v-for="a in actionCards" :key="a.key" trigger="hover" :disabled="a.disabled || a.loading">
            <template #trigger>
              <div class="h-full">
                <n-card
                  hoverable
                  :bordered="false"
                  class="cursor-pointer text-center interactive-card select-none shadow-sm group rounded-xl sm:rounded-2xl !h-full"
                  :class="{ 'opacity-50 !cursor-not-allowed !transform-none': a.disabled }"
                  @click="!a.disabled && triggerAction(a)"
                >
                  <div class="flex flex-col items-center justify-center gap-1.5 sm:gap-2.5 py-1.5 sm:py-3">
                    <div class="w-9 h-9 sm:w-12 sm:h-12 rounded-xl sm:rounded-2xl flex items-center justify-center transition-all duration-200 group-hover:scale-110" :class="a.iconBg">
                      <n-spin v-if="a.loading" :size="20" />
                      <n-icon v-else class="text-[18px] sm:text-[24px]" :class="a.iconColor"><component :is="a.icon" /></n-icon>
                    </div>
                    <span class="text-xs sm:text-sm font-medium text-slate-700 dark:text-slate-300">{{ a.label }}</span>
                  </div>
                </n-card>
              </div>
            </template>
            {{ a.desc }}
          </n-tooltip>
        </div>
      </div>
    </template>

    <!-- 底部提示 -->
    <div class="space-y-3">
      <n-alert v-if="progressMessage" type="info" :show-icon="true" class="rounded-2xl shadow-sm">{{ progressMessage }}</n-alert>
      <n-alert v-if="!wsConnected" type="error" :show-icon="true" class="rounded-2xl shadow-sm">
        实时连接已断开，正在自动重连…
      </n-alert>
      <n-alert v-if="error" type="error" closable @close="error = ''" class="rounded-2xl shadow-sm">{{ error }}</n-alert>
    </div>

    <!-- 在线部署 / 切换版本 -->
    <n-modal
      v-model:show="showDeployModal"
      preset="dialog"
      type="info"
      title="在线部署 Hermes"
      positive-text="开始部署"
      negative-text="取消"
      :loading="deploying"
      :positive-button-props="{ disabled: !selectedVersion }"
      @positive-click="confirmDeploy"
      @negative-click="showDeployModal = false"
    >
      <div class="space-y-3 pt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
        <div class="flex items-center justify-between gap-3">
          <span class="text-slate-500 dark:text-slate-400">当前版本</span>
          <span class="font-mono font-medium text-slate-700 dark:text-slate-200">{{ versionText }}</span>
        </div>
        <div class="space-y-1.5">
          <span class="text-slate-500 dark:text-slate-400">选择版本：</span>
          <n-select
            v-model:value="selectedVersion"
            :options="versionOptions"
            :loading="loadingVersions"
            :placeholder="versionsError ? '加载失败，展开重试' : '选择版本'"
            size="medium"
            class="w-full"
            @update:show="(show) => show && versionsError && loadVersions()"
          />
        </div>
        <div class="text-[11.5px] text-slate-500 dark:text-slate-400">
          版本来自 GitHub Releases；部署会拉取对应的 -desktop 镜像，校验 Desktop 渲染层后重建容器。
        </div>
      </div>
    </n-modal>

    <!-- 发现新版本 -->
    <n-modal
      v-model:show="showUpdateModal"
      preset="dialog"
      type="info"
      title="发现新版本"
      positive-text="立即更新"
      negative-text="暂不更新"
      :loading="updating"
      @positive-click="confirmUpgrade"
      @negative-click="showUpdateModal = false"
    >
      <div class="space-y-3 pt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
        <div class="p-3 bg-slate-50 dark:bg-white/[0.03] rounded-xl border border-slate-200/70 dark:border-slate-800 space-y-2">
          <div class="flex items-center justify-between text-xs">
            <span class="text-slate-500 dark:text-slate-400">当前版本</span>
            <span class="font-mono font-medium text-slate-700 dark:text-slate-200">{{ versionText }}</span>
          </div>
          <div class="flex items-center justify-between text-xs pt-2 border-t border-slate-200/60 dark:border-white/[0.06]">
            <span class="text-blue-600 dark:text-blue-400 font-medium">目标版本</span>
            <span class="font-mono font-semibold text-blue-600 dark:text-blue-400">{{ latestVersion || versionText }}</span>
          </div>
        </div>
        <div class="p-3 rounded-xl bg-amber-500/[0.08] dark:bg-amber-500/[0.15] border border-amber-500/30 space-y-2">
          <div class="font-bold text-amber-700 dark:text-amber-400 text-xs tracking-wide flex items-center gap-1.5">
            <n-icon :size="15"><AlertTriangle /></n-icon>
            <span>环境兼容提示</span>
          </div>
          <div class="text-[11.5px] leading-relaxed text-amber-800 dark:text-amber-300">
            新版本可能存在插件或配置变动，建议更新前创建快照以备回滚。
          </div>
          <div class="p-2 rounded-lg bg-white/70 dark:bg-black/20 border border-amber-500/20 text-[11px] text-amber-900 dark:text-amber-200 flex items-center justify-between gap-2">
            <span>更新后若遇异常，可随时还原快照或使用重置修复。</span>
            <n-button text type="warning" size="tiny" class="font-medium shrink-0" @click="goToSnapshots">前往快照 →</n-button>
          </div>
        </div>
      </div>
    </n-modal>

    <InstallModal v-model:show="showInstall" @installed="reload" />
  </div>
</template>

<script setup>
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  NAlert, NButton, NCard, NDivider, NIcon, NModal, NSelect, NSpin, NTag, NTooltip, useDialog, useMessage
} from 'naive-ui'
import { AlertTriangle, CloudDownload, Download, ExternalLink, PlayerPlay, PlayerStop, Refresh } from '@vicons/tabler'
import InstallModal from '../components/InstallModal.vue'
import { get, post } from '../api'
import { trimSdk } from '../utils/trimSdk'

const message = useMessage()
const dialog = useDialog()

const statusData = ref({})
const loaded = ref(false)
const wsConnected = ref(false)
const error = ref('')
const activeAction = ref('')
const progressMessage = ref('')
const checking = ref(false)
const showDeployModal = ref(false)
const showUpdateModal = ref(false)
const showInstall = ref(false)
const deploying = ref(false)
const updating = ref(false)
const loadingVersions = ref(false)
const versionsError = ref(false)
const versions = ref([])
const selectedVersion = ref('')
const latestVersion = ref('')

const installJob = computed(() => statusData.value.installJob || { state: 'idle' })
const snapshotJob = computed(() => statusData.value.snapshotJob || { state: 'idle' })
const container = computed(() => statusData.value.container || {})
const isRunning = computed(() => Boolean(container.value.running))
const isInstalled = computed(() => Boolean(statusData.value.installed))
const metrics = computed(() => statusData.value.metrics || {})
const versionText = computed(() => statusData.value.versionShort || (isInstalled.value ? '未就绪' : '未安装'))
const containerId = computed(() => (isRunning.value ? container.value.id || '-' : '-'))
const busyOrProgress = computed(() => installJob.value.state === 'running' || snapshotJob.value.state === 'running' || Boolean(activeAction.value))

const statusTagType = computed(() => {
  if (installJob.value.state === 'running') return 'info'
  if (snapshotJob.value.state === 'running') return 'warning'
  if (!isInstalled.value) return 'default'
  return isRunning.value ? 'success' : 'error'
})

const statusLabel = computed(() => {
  if (installJob.value.state === 'running') return '安装中'
  if (snapshotJob.value.state === 'running') return '快照中'
  if (activeAction.value) return '处理中'
  if (!isInstalled.value) return '未安装'
  return isRunning.value ? '运行中' : '已停止'
})

const uptimeText = computed(() => {
  const seconds = Number(statusData.value.uptime || 0)
  if (!isRunning.value || !seconds) return '-'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d) return `${d} 天 ${h} 小时`
  if (h) return `${h} 小时 ${m} 分`
  return `${m} 分 ${seconds % 60} 秒`
})

const versionOptions = computed(() => {
  const list = versions.value.map((v) => ({ label: `${v.version}${v.version === latestVersion.value ? '（最新）' : ''} · ${v.published}`, value: v.version }))
  return list
})

const actionCards = computed(() => {
  const busy = busyOrProgress.value
  return [
    isRunning.value
      ? { key: 'stop', icon: PlayerStop, label: '停止服务', desc: '停止 Hermes 容器，保留数据', iconBg: 'bg-rose-50 dark:bg-rose-950/30', iconColor: 'text-rose-600 dark:text-rose-400', disabled: busy, loading: activeAction.value === 'stop', action: 'stop' }
      : {
          key: 'start',
          icon: PlayerPlay,
          label: !isInstalled.value ? '安装 Hermes' : '启动服务',
          desc: !isInstalled.value ? '选择官方版本并完成安装' : '拉起容器并等待工作区就绪',
          iconBg: 'bg-emerald-50 dark:bg-emerald-950/30',
          iconColor: 'text-emerald-600 dark:text-emerald-400',
          disabled: busy,
          loading: activeAction.value === 'start',
          action: !isInstalled.value ? 'install' : 'start'
        },
    { key: 'restart', icon: Refresh, label: '重启服务', desc: '重建容器，使配置或密钥变更生效', iconBg: 'bg-amber-50 dark:bg-amber-950/30', iconColor: 'text-amber-600 dark:text-amber-400', disabled: !isRunning.value || busy, loading: activeAction.value === 'restart', action: 'restart' },
    { key: 'update', icon: Download, label: checking.value ? '检查中…' : '检查更新', desc: '对比 GitHub Releases 的最新稳定版', iconBg: 'bg-blue-50 dark:bg-blue-950/30', iconColor: 'text-fnos-blue dark:text-blue-400', disabled: busy || checking.value, loading: checking.value, action: 'check_update' },
    { key: 'deploy', icon: CloudDownload, label: '在线部署', desc: '选择官方版本并部署或切换', iconBg: 'bg-purple-50 dark:bg-purple-950/30', iconColor: 'text-purple-600 dark:text-purple-400', disabled: busy, loading: activeAction.value === 'upgrade', action: 'deploy' }
  ]
})

async function openWebui() {
  const webui = statusData.value.access?.webui || '/app/hermes-agent/webapp/'
  const url = webui.startsWith('/') ? `${window.location.origin}${webui}` : webui
  const result = await trimSdk.openURL(url, '_blank')
  if (!result.success && result.message) error.value = result.message
}

function goToSnapshots() {
  showUpdateModal.value = false
  const url = new URL(window.location.href)
  url.searchParams.set('tab', 'snapshots')
  window.location.href = url.toString()
}

function triggerAction(card) {
  if (card.action === 'install') {
    showInstall.value = true
    return
  }
  if (card.action === 'deploy') {
    openDeploy()
    return
  }
  if (card.action === 'check_update') {
    checkUpdate()
    return
  }
  runAction(card.action)
}

async function runAction(action) {
  activeAction.value = action
  try {
    await post('api/action', { action })
    message.success(action === 'stop' ? '已停止' : action === 'start' ? '已启动' : '操作成功')
    setTimeout(reload, 1200)
  } catch (err) {
    error.value = err.message
  } finally {
    activeAction.value = ''
  }
}

async function loadVersions() {
  loadingVersions.value = true
  versionsError.value = false
  try {
    const data = await get('api/versions?refresh=1')
    if (data.error) throw new Error(data.error)
    versions.value = data.versions || []
    latestVersion.value = data.latest?.version || ''
    if (!selectedVersion.value) selectedVersion.value = data.installed?.version || latestVersion.value
  } catch (err) {
    versionsError.value = true
    error.value = err.message
  } finally {
    loadingVersions.value = false
  }
}

async function openDeploy() {
  if (!isInstalled.value) {
    showInstall.value = true
    return
  }
  showDeployModal.value = true
  if (!versions.value.length) await loadVersions()
}

async function confirmDeploy() {
  if (!selectedVersion.value) return
  deploying.value = true
  try {
    await post('api/action', { action: 'upgrade', version: selectedVersion.value })
    message.success(`已开始部署 ${selectedVersion.value}`)
    showDeployModal.value = false
    setTimeout(reload, 1500)
  } catch (err) {
    error.value = err.message
  } finally {
    deploying.value = false
  }
}

async function checkUpdate() {
  checking.value = true
  try {
    const data = await get('api/versions?refresh=1')
    if (data.error) throw new Error(data.error)
    latestVersion.value = data.latest?.version || ''
    if (data.updateAvailable) {
      showUpdateModal.value = true
    } else {
      message.info('当前已是最新版本')
    }
  } catch (err) {
    message.error(err.message)
  } finally {
    checking.value = false
  }
}

async function confirmUpgrade() {
  if (!latestVersion.value) return
  updating.value = true
  try {
    await post('api/action', { action: 'upgrade', version: latestVersion.value })
    message.success(`已开始更新到 ${latestVersion.value}`)
    showUpdateModal.value = false
    setTimeout(reload, 1500)
  } catch (err) {
    message.error(err.message)
  } finally {
    updating.value = false
  }
}

function applyStatus(data) {
  statusData.value = data
  loaded.value = true
  const job = data.installJob || {}
  const snap = data.snapshotJob || {}
  if (job.state === 'running') progressMessage.value = `安装中：${job.message || ''} ${job.percent || 0}%`
  else if (snap.state === 'running') progressMessage.value = `快照中：${snap.message || ''} ${snap.percent || 0}%`
  else progressMessage.value = data.lastMessage || ''
}

let socket = null
let pollTimer = null
let closedByUs = false

function connectStatus() {
  closedByUs = false
  const url = new URL('api/status/ws', document.baseURI)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  try {
    socket = new WebSocket(url)
  } catch {
    startPolling()
    return
  }
  socket.onopen = () => { wsConnected.value = true }
  socket.onmessage = (event) => {
    try { applyStatus(JSON.parse(event.data)) } catch { /* 忽略坏帧 */ }
  }
  socket.onerror = () => { wsConnected.value = false }
  socket.onclose = () => {
    wsConnected.value = false
    if (!closedByUs) startPolling()
  }
}

function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(reload, 5000)
  reload()
}

async function reload() {
  try {
    applyStatus(await get('api/status'))
    error.value = ''
  } catch (err) {
    error.value = err.message
  }
}

onMounted(() => {
  reload()
  connectStatus()
})

onBeforeUnmount(() => {
  closedByUs = true
  if (socket) socket.close()
  if (pollTimer) clearInterval(pollTimer)
})
</script>
