<template>
  <div class="w-full flex-1 flex flex-col gap-4 sm:gap-6 pb-20 sm:pb-8">
    <!-- 页头 -->
    <div class="sticky top-0 z-20 -mx-4 sm:-mx-8 px-4 sm:px-8 pt-5 pb-3 bg-[#f4f6fb]/90 dark:bg-[#12141a]/90 backdrop-blur-md flex items-center justify-between gap-3 w-full">
      <h1 class="text-xl font-bold text-slate-800 dark:text-slate-100 tracking-tight">应用设置</h1>
      <div v-if="installed" class="flex items-center gap-2 shrink-0">
        <n-button v-if="isChanged" size="small" :disabled="saving" @click="resetForm">
          <template #icon><n-icon :size="15"><X /></n-icon></template>
          取消
        </n-button>
        <n-button type="primary" size="small" :loading="saving" :disabled="!isChanged || !loaded" @click="saveAll">保存设置</n-button>
      </div>
    </div>

    <n-alert v-if="error" type="error" closable @close="error = ''">{{ error }}</n-alert>

    <template v-if="!installed">
      <n-card :bordered="false" class="py-12 text-center shadow-sm rounded-2xl">
        <n-empty description="Hermes 尚未安装">
          <template #icon><n-icon :size="48" class="text-slate-300 dark:text-slate-600"><Settings /></n-icon></template>
          <template #extra><span class="text-xs text-slate-500 dark:text-slate-400">安装 Hermes 后才能修改运行设置</span></template>
        </n-empty>
      </n-card>
    </template>

    <n-form v-else label-placement="top" size="medium" class="flex flex-col gap-4 sm:gap-6">
      <!-- 核心服务 -->
      <n-card title="核心服务" :bordered="false" class="shadow-sm rounded-2xl">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
          <n-form-item>
            <template #label>
              <div class="flex items-center gap-1.5">
                <span>内部监听端口</span>
                <n-tooltip><template #trigger><n-icon size="14" class="text-slate-400 cursor-help"><Help /></n-icon></template>
                  Hermes WebUI 的监听端口；修改后会重启容器，直连地址随之变化（网关入口不变）
                </n-tooltip>
              </div>
            </template>
            <n-input-number v-model:value="form.webappPort" :min="1024" :max="65535" class="w-full" />
          </n-form-item>

          <n-form-item>
            <template #label>
              <div class="flex items-center gap-1.5">
                <span>容器内存上限</span>
                <n-tooltip><template #trigger><n-icon size="14" class="text-slate-400 cursor-help"><Help /></n-icon></template>
                  Hermes 容器可使用的最大内存，保存后重建容器生效
                </n-tooltip>
              </div>
            </template>
            <n-select v-model:value="form.memoryMb" :options="memoryOptions" />
          </n-form-item>

          <n-form-item>
            <template #label>
              <div class="flex items-center gap-1.5">
                <span>登录用户名</span>
                <n-tooltip><template #trigger><n-icon size="14" class="text-slate-400 cursor-help"><Help /></n-icon></template>
                  用于登录 Desktop 工作区；修改后需要重建容器
                </n-tooltip>
              </div>
            </template>
            <n-input v-model:value="form.username" placeholder="admin" />
          </n-form-item>

          <n-form-item>
            <template #label>
              <div class="flex items-center gap-1.5">
                <span>修改登录口令</span>
                <n-tooltip><template #trigger><n-icon size="14" class="text-slate-400 cursor-help"><Help /></n-icon></template>
                  留空表示不修改；填写后以 scrypt 哈希写入运行配置
                </n-tooltip>
              </div>
            </template>
            <n-input v-model:value="form.password" type="password" show-password-on="click" placeholder="留空不修改，至少 8 位" autocomplete="new-password" />
          </n-form-item>

          <n-form-item class="sm:col-span-2">
            <template #label>
              <div class="flex items-center gap-1.5">
                <span>打开方式选择</span>
                <n-tooltip><template #trigger><n-icon size="14" class="text-slate-400 cursor-help"><Help /></n-icon></template>
                  控制概览页「进入 Hermes」与桌面 WebUI 入口使用的链路
                </n-tooltip>
              </div>
            </template>
            <n-radio-group v-model:value="form.accessMode" class="w-full flex">
              <n-radio-button value="gateway" class="!flex-1 text-center">飞牛网关</n-radio-button>
              <n-radio-button value="port" class="!flex-1 text-center">直连端口</n-radio-button>
              <n-radio-button value="custom" class="!flex-1 text-center">自定义地址</n-radio-button>
            </n-radio-group>
          </n-form-item>

          <n-form-item v-if="form.accessMode === 'custom'" class="sm:col-span-2">
            <template #label>
              <div class="flex items-center gap-1.5">
                <span>自定义外部访问地址</span>
                <n-tooltip><template #trigger><n-icon size="14" class="text-slate-400 cursor-help"><Help /></n-icon></template>
                  例如 https://hermes.example.com，用于反代或域名访问
                </n-tooltip>
              </div>
            </template>
            <n-input v-model:value="form.customUrl" placeholder="例如 https://hermes.example.com" clearable />
          </n-form-item>
        </div>
      </n-card>

      <!-- 运行与接口 -->
      <n-card title="运行与接口" :bordered="false" class="shadow-sm rounded-2xl">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
          <n-form-item>
            <template #label>
              <div class="flex items-center gap-1.5">
                <span>官方版本</span>
                <n-tooltip><template #trigger><n-icon size="14" class="text-slate-400 cursor-help"><Help /></n-icon></template>
                  来自 GitHub Releases 的稳定版；保存后拉取对应镜像并重建容器
                </n-tooltip>
              </div>
            </template>
            <n-select v-model:value="form.imageTag" :options="versionOptions" :loading="versionsLoading" filterable tag />
          </n-form-item>

          <n-form-item>
            <template #label><span>OpenAI 兼容 API</span></template>
            <div class="flex items-center gap-3 h-8">
              <n-switch v-model:value="form.apiEnabled" />
              <span class="text-[12px] text-slate-500 dark:text-slate-400">{{ form.apiEnabled ? '已开启' : '未开启' }}</span>
            </div>
          </n-form-item>

          <n-form-item v-if="form.apiEnabled">
            <template #label><span>API 端口</span></template>
            <n-input-number v-model:value="form.apiPort" :min="1024" :max="65535" class="w-full" />
          </n-form-item>

          <n-form-item v-if="form.apiEnabled">
            <template #label><span>API 密钥</span></template>
            <div class="flex gap-2">
              <n-input v-model:value="form.apiKey" placeholder="留空保持不变" />
              <n-button @click="generateKey">生成</n-button>
            </div>
          </n-form-item>
        </div>
      </n-card>

      <!-- 网络与依赖源 -->
      <n-card title="网络与依赖源" :bordered="false" class="shadow-sm rounded-2xl">
        <div class="space-y-4">
          <n-form-item>
            <template #label>
              <div class="flex items-center gap-1.5">
                <span>版本更新通道</span>
                <n-tooltip><template #trigger><n-icon size="14" class="text-slate-400 cursor-help"><Help /></n-icon></template>
                  当前只同步 GitHub Releases 的稳定版（canary 标签无法映射成镜像标签）
                </n-tooltip>
              </div>
            </template>
            <n-select :value="'stable'" :options="[{ label: '稳定版（GitHub Releases）', value: 'stable' }]" disabled />
          </n-form-item>

          <n-form-item>
            <template #label>
              <div class="flex items-center gap-1.5">
                <span>镜像源</span>
                <n-tooltip><template #trigger><n-icon size="14" class="text-slate-400 cursor-help"><Help /></n-icon></template>
                  拉取 Hermes 镜像使用的加速站；首次安装与版本更新都会走这里
                </n-tooltip>
              </div>
            </template>
            <n-select v-model:value="form.imageMirror" :options="mirrorOptions" filterable tag />
          </n-form-item>

          <n-form-item>
            <template #label>
              <div class="flex items-center gap-1.5">
                <span>网络代理地址 (HTTP / SOCKS5)</span>
                <n-tooltip><template #trigger><n-icon size="14" class="text-slate-400 cursor-help"><Help /></n-icon></template>
                  用于 Hermes 访问外部网络，留空使用直连
                </n-tooltip>
              </div>
            </template>
            <n-input v-model:value="form.networkProxy" placeholder="例如 http://192.168.1.100:7890 或 socks5://192.168.1.100:7890" clearable />
          </n-form-item>

          <div class="pt-3 border-t border-slate-100 dark:border-slate-800/80 space-y-1.5">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-1.5">
                <span class="text-sm font-medium text-slate-800 dark:text-slate-100">应用于 Hermes 服务进程</span>
                <n-tooltip><template #trigger><n-icon size="14" class="text-slate-400 cursor-help"><Help /></n-icon></template>
                  启用后向容器注入 HTTP_PROXY / HTTPS_PROXY / NO_PROXY
                </n-tooltip>
              </div>
              <n-switch v-model:value="form.proxyRuntime" :disabled="!form.networkProxy.trim()" />
            </div>
            <div class="text-xs text-slate-500 dark:text-slate-400">启用后让 Hermes 通过代理访问外部网络，保存后重启容器。</div>
          </div>
        </div>
      </n-card>

      <!-- 运行时 -->
      <n-card title="运行时" :bordered="false" class="shadow-sm rounded-2xl">
        <div class="space-y-3">
          <div class="flex items-center justify-between gap-3">
            <div class="text-[13px] text-slate-700 dark:text-slate-200">
              当前：<n-tag size="small" :bordered="false" :type="runtime.mode === 'native' ? 'warning' : 'info'">
                {{ runtime.mode === 'native' ? '原生运行时（实验）' : 'Docker 容器' }}
              </n-tag>
              <span v-if="runtime.native?.tag" class="ml-2 font-mono text-[12px] text-slate-500 dark:text-slate-400">{{ runtime.native.tag }}</span>
            </div>
            <div class="flex items-center gap-2">
              <n-button v-if="runtime.mode === 'docker'" size="small" secondary :disabled="!runtime.native?.installed || switching" :loading="switching" @click="switchRuntime('native')">
                切换到原生
              </n-button>
              <n-button v-if="runtime.mode === 'native'" size="small" secondary :loading="switching" @click="switchRuntime('docker')">
                切换回 Docker
              </n-button>
            </div>
          </div>
          <div class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            原生运行时从官方镜像提取 Python 与 Webapp，由管理端直接托管进程，不启动容器；隔离性弱于 Docker，
            且需要在安装时选择「原生运行时」。未安装原生运行时时，重新安装并选择原生即可。
          </div>
        </div>
      </n-card>

      <!-- 重置修复 -->
      <n-card title="重置修复" :bordered="false" class="shadow-sm rounded-2xl border border-rose-100 dark:border-rose-950/40">
        <div class="space-y-3">
          <div class="flex items-center justify-between gap-3">
            <div class="text-sm font-medium text-slate-800 dark:text-slate-100">重建当前版本容器</div>
            <n-button type="error" size="small" secondary :loading="repairing" @click="repair">修复</n-button>
          </div>
          <div class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            适用于配置冲突、容器异常或渲染层损坏。保留模型 Key、会话数据与设置，重建容器并校验 Desktop 渲染层。
          </div>

          <n-divider class="!my-1" />

          <div class="flex items-center justify-between gap-3">
            <div class="text-sm font-medium text-slate-800 dark:text-slate-100">卸载 Hermes</div>
            <div class="flex items-center gap-2">
              <n-button size="small" secondary @click="uninstall(false)">卸载（保留数据）</n-button>
              <n-button size="small" type="error" secondary @click="uninstall(true)">卸载并删除数据</n-button>
            </div>
          </div>
          <div class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            卸载只移除容器与运行配置；选择删除数据会连同 <span class="code-chip">hermes-agent/data</span> 一并清空。
          </div>
        </div>
      </n-card>
    </n-form>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import {
  NAlert, NButton, NCard, NDivider, NEmpty, NForm, NFormItem, NIcon, NInput, NInputNumber,
  NRadioButton, NRadioGroup, NSelect, NSwitch, NTag, NTooltip, useDialog, useMessage
} from 'naive-ui'
import { Help, Settings, X } from '@vicons/tabler'
import { get, post } from '../api'

const message = useMessage()
const dialog = useDialog()

const loaded = ref(false)
const installed = ref(false)
const saving = ref(false)
const repairing = ref(false)
const error = ref('')
const versions = ref([])
const runtime = ref({ mode: 'docker', native: {} })
const switching = ref(false)
const versionsLoading = ref(false)
const baseline = ref('')

const form = reactive({
  webappPort: 9121,
  memoryMb: 3072,
  username: 'admin',
  password: '',
  accessMode: 'gateway',
  customUrl: '',
  imageTag: 'main-desktop',
  apiEnabled: false,
  apiPort: 8642,
  apiKey: '',
  imageMirror: 'docker.m.daocloud.io',
  networkProxy: '',
  proxyRuntime: false,
  provider: 'openrouter',
  model: '',
  baseUrl: ''
})

const memoryOptions = [1024, 2048, 3072, 4096, 6144, 8192, 12288].map((mb) => ({ label: `${mb} MB`, value: mb }))
const mirrorOptions = [
  { label: 'docker.m.daocloud.io（默认）', value: 'docker.m.daocloud.io' },
  { label: 'docker.fnnas.com（飞牛）', value: 'docker.fnnas.com' },
  { label: 'docker.io（官方）', value: 'docker.io' }
]

const versionOptions = computed(() => versions.value.map((v, i) => ({
  label: `${v.version}${i === 0 ? '（最新）' : ''} · ${v.published}`,
  value: v.tag
})))

const isChanged = computed(() => {
  if (!loaded.value) return false
  return JSON.stringify(snapshot()) !== baseline.value
})

function snapshot() {
  return {
    webappPort: form.webappPort,
    memoryMb: form.memoryMb,
    username: form.username,
    password: form.password,
    accessMode: form.accessMode,
    customUrl: form.customUrl,
    imageTag: form.imageTag,
    apiEnabled: form.apiEnabled,
    apiPort: form.apiPort,
    apiKey: form.apiKey,
    imageMirror: form.imageMirror,
    networkProxy: form.networkProxy,
    proxyRuntime: form.proxyRuntime
  }
}

function captureBaseline() {
  baseline.value = JSON.stringify(snapshot())
}

async function loadVersions() {
  versionsLoading.value = true
  try {
    const data = await get('api/versions')
    versions.value = data.versions || []
  } catch { /* 忽略 */ }
  finally { versionsLoading.value = false }
}

async function load() {
  try {
    const [status, settings, appSettings, runtimeInfo] = await Promise.all([
      get('api/status'),
      get('api/settings'),
      get('api/app-settings'),
      get('api/runtime')
    ])
    runtime.value = runtimeInfo
    installed.value = Boolean(status.installed)
    const s = appSettings.settings || {}
    form.webappPort = appSettings.webappPort || 9121
    form.memoryMb = settings.memoryMb || 3072
    form.username = settings.username || 'admin'
    form.password = ''
    form.imageTag = settings.imageTag || 'main-desktop'
    form.apiEnabled = Boolean(settings.apiEnabled)
    form.apiPort = settings.apiPort || 8642
    form.apiKey = ''
    form.accessMode = s.accessMode || 'gateway'
    form.customUrl = s.customUrl || ''
    form.imageMirror = s.imageMirror || 'docker.m.daocloud.io'
    form.networkProxy = s.networkProxy || ''
    form.proxyRuntime = Boolean(s.proxyRuntime)
    form.provider = settings.provider || 'openrouter'
    form.model = settings.model || ''
    form.baseUrl = settings.baseUrl || ''
    loaded.value = true
    captureBaseline()
    error.value = ''
    loadVersions()
  } catch (err) {
    error.value = err.message
  }
}

function resetForm() {
  load()
}

function generateKey() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  form.apiKey = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function saveAll() {
  if (form.password && form.password.length < 8) {
    message.warning('登录口令至少 8 位')
    return
  }
  saving.value = true
  try {
    const appResult = await post('api/app-settings', {
      webappPort: form.webappPort,
      accessMode: form.accessMode,
      customUrl: form.customUrl,
      imageMirror: form.imageMirror,
      networkProxy: form.networkProxy,
      proxyRuntime: form.proxyRuntime
    })
    const result = await post('api/settings', {
      username: form.username,
      imageTag: form.imageTag,
      memoryMb: form.memoryMb,
      apiEnabled: form.apiEnabled,
      apiPort: form.apiPort,
      apiKey: form.apiKey,
      provider: form.provider,
      model: form.model,
      baseUrl: form.baseUrl
    })
    if (form.password) {
      await post('api/password', { password: form.password })
    }
    if (result.imageChanged) {
      message.loading('正在切换版本…', { duration: 1500 })
      await post('api/action', { action: 'upgrade', tag: result.imageTag })
      message.success(`已切换到 ${result.imageTag}`)
    } else if (form.password) {
      message.loading('正在重建容器…', { duration: 1200 })
      await post('api/action', { action: 'restart' })
      message.success('设置已保存，容器已重启')
    } else {
      message.success(appResult.restarted ? '设置已保存，容器已重启' : '设置已保存')
    }
    form.password = ''
    form.apiKey = ''
    await load()
  } catch (err) {
    message.error(err.message)
  } finally {
    saving.value = false
  }
}

async function switchRuntime(mode) {
  switching.value = true
  try {
    await post('api/runtime', { mode })
    message.success(mode === 'native' ? '已切换到原生运行时' : '已切换回 Docker')
    await load()
  } catch (err) {
    message.error(err.message)
  } finally {
    switching.value = false
  }
}

function repair() {
  dialog.warning({
    title: '修复 Hermes 容器',
    content: '会重建容器并校验 Desktop 渲染层；模型 Key、会话数据与设置不受影响。',
    positiveText: '开始修复',
    negativeText: '取消',
    onPositiveClick: async () => {
      repairing.value = true
      try {
        await post('api/action', { action: 'repair' })
        message.success('修复完成')
        await load()
      } catch (err) {
        message.error(err.message)
      } finally {
        repairing.value = false
      }
    }
  })
}

function uninstall(deleteData) {
  dialog.warning({
    title: deleteData ? '卸载并删除数据' : '卸载 Hermes',
    content: deleteData
      ? '容器、运行配置与共享目录 hermes-agent/data 都会被删除，且不可恢复。'
      : '容器与运行配置会被移除，共享目录 hermes-agent/data 保留，重新安装后可继续使用。',
    positiveText: deleteData ? '确认删除' : '确认卸载',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await post('api/uninstall', { deleteData })
        message.success('已卸载')
        installed.value = false
      } catch (err) {
        message.error(err.message)
      }
    }
  })
}

onMounted(load)
</script>
