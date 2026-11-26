<template>
  <n-modal
    v-model:show="visible"
    preset="card"
    :mask-closable="false"
    :title="started ? '正在安装 Hermes Agent' : '安装 Hermes Agent'"
    class="w-[92vw] max-w-2xl"
    @after-leave="reset"
  >
    <!-- 安装向导 -->
    <div v-if="!started" class="space-y-4">
      <n-alert type="info" :bordered="false" class="!text-[13px]">
        <template v-if="form.runtime === 'native'">
          原生运行时（实验）：由管理端直接托管 Hermes 进程，不启动容器。
          源码构建会从 GitHub 拉源码并用国内镜像（PyPI 清华源、npmmirror、Electron 镜像）安装依赖，首次约 10–30 分钟；
          镜像提取则复用官方镜像里的 Python/Webapp，速度更快但需要本地有镜像。
        </template>
        <template v-else>
          安装会拉取官方镜像、生成访问口令与配置并启动容器。首次下载约 3.76 GB，耗时取决于网络；
          会话、记忆与技能都保存在共享目录，卸载时可选保留。
        </template>
      </n-alert>

      <div>
        <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">运行时</div>
        <n-radio-group v-model:value="form.runtime" class="w-full flex">
          <n-radio-button value="docker" class="!flex-1 text-center">Docker 容器（默认）</n-radio-button>
          <n-radio-button value="native" class="!flex-1 text-center">原生运行时（实验）</n-radio-button>
        </n-radio-group>
      </div>

      <div v-if="form.runtime === 'native'">
        <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">原生安装方式</div>
        <n-radio-group v-model:value="form.nativeSource" class="w-full flex">
          <n-radio-button value="source" class="!flex-1 text-center">源码构建（国内加速）</n-radio-button>
          <n-radio-button value="image" class="!flex-1 text-center">镜像提取（快速）</n-radio-button>
        </n-radio-group>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">登录用户名</div>
          <n-input v-model:value="form.username" placeholder="admin" />
        </div>
        <div>
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">登录口令（至少 8 位）</div>
          <n-input v-model:value="form.password" type="password" show-password-on="click" placeholder="用于登录 Desktop 工作区" />
        </div>
        <div>
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">官方版本</div>
          <n-select v-model:value="form.version" :options="versionOptions" :loading="versionsLoading" placeholder="选择官方版本" />
        </div>
        <div v-if="form.runtime === 'docker'">
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">容器内存上限（MB）</div>
          <n-input-number v-model:value="form.memoryMb" :min="512" :max="16384" :step="512" class="w-full" />
        </div>
        <div>
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">模型服务商</div>
          <n-select v-model:value="form.provider" :options="providerOptions" />
        </div>
        <div>
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">默认模型（可选）</div>
          <n-input v-model:value="form.model" placeholder="如 deepseek-chat" />
        </div>
        <div>
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">接口地址（可选）</div>
          <n-input v-model:value="form.baseUrl" placeholder="留空使用官方地址" />
        </div>
        <div>
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">模型 API Key（可稍后填写）</div>
          <n-input v-model:value="form.modelKey" type="password" show-password-on="click" placeholder="sk-..." />
        </div>
        <div>
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">OpenAI 兼容 API</div>
          <div class="flex items-center gap-2 h-8">
            <n-switch v-model:value="form.apiEnabled" />
            <span class="text-[12px] text-slate-500 dark:text-slate-400">{{ form.apiEnabled ? `端口 ${form.apiPort}` : '不开启' }}</span>
          </div>
        </div>
        <div v-if="form.apiEnabled">
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">API 端口</div>
          <n-input-number v-model:value="form.apiPort" :min="1024" :max="65535" class="w-full" />
        </div>
      </div>

      <div>
        <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">自定义镜像标签（可选，版本列表不可用时使用）</div>
        <n-input v-model:value="form.customTag" placeholder="例如 v0.23.4-desktop" />
      </div>

      <n-alert v-if="error" type="error" closable @close="error = ''">{{ error }}</n-alert>
    </div>

    <!-- 安装进度 -->
    <div v-else class="space-y-4">
      <div class="space-y-2">
        <div v-for="item in stepItems" :key="item.key" class="flex items-center gap-2.5">
          <n-icon :size="18" :class="item.state === 'done' ? 'text-emerald-500' : item.state === 'current' ? 'text-fnos-blue' : 'text-slate-300 dark:text-slate-600'">
            <component :is="item.state === 'done' ? Check : item.state === 'current' ? Loader : Circle" />
          </n-icon>
          <span
            class="text-[13px]"
            :class="item.state === 'pending' ? 'text-slate-400 dark:text-slate-500' : 'text-slate-700 dark:text-slate-200'"
          >{{ item.label }}</span>
        </div>
      </div>

      <div>
        <n-progress
          type="line"
          :percentage="job.percent || 0"
          :processing="job.state === 'running'"
          :status="job.state === 'error' ? 'error' : job.state === 'done' ? 'success' : 'default'"
          :show-indicator="Boolean(job.percent)"
        />
        <div class="text-[12px] text-slate-500 dark:text-slate-400 mt-1">{{ job.message || '准备中…' }}</div>
      </div>

      <n-alert v-if="job.error" type="error">{{ job.error }}</n-alert>

      <div class="rounded-xl bg-slate-50 dark:bg-[#12141a] border border-slate-100 dark:border-white/5 p-3 max-h-56 overflow-auto">
        <div class="log-view text-slate-600 dark:text-slate-300">
          <div v-for="(line, i) in job.log.slice(-80)" :key="i" :class="lineClass(line)">{{ line }}</div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <n-button v-if="!started" @click="visible = false">取消</n-button>
        <n-button v-if="!started" type="primary" :loading="submitting" @click="install">开始安装</n-button>
        <n-button v-if="started && job.state === 'done'" type="primary" @click="finish">完成</n-button>
        <n-button v-if="started && job.state === 'error'" @click="reset">重新填写</n-button>
        <n-button v-if="started && job.state === 'running'" disabled loading>安装中…</n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NIcon,
  NInput,
  NInputNumber,
  NModal,
  NProgress,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSwitch,
  useMessage
} from 'naive-ui'
import { Check, Circle, Loader } from '@vicons/tabler'
import { get, post } from '../api'

const props = defineProps({ show: Boolean })
const emit = defineEmits(['update:show', 'installed'])
const message = useMessage()

const visible = computed({
  get: () => props.show,
  set: (value) => emit('update:show', value)
})

const form = reactive({
  runtime: 'docker',
  nativeSource: 'source',
  username: 'admin',
  password: '',
  version: '',
  customTag: '',
  memoryMb: 3072,
  provider: 'openrouter',
  model: '',
  baseUrl: '',
  modelKey: '',
  apiEnabled: false,
  apiPort: 8642
})

const versions = ref([])
const versionsLoading = ref(false)
const versionOptions = computed(() => versions.value.map((v, i) => ({
  label: `${v.version}${i === 0 ? '（最新）' : ''} · ${v.published || ''}`,
  value: v.version
})))
const providerOptions = [
  { label: 'OpenRouter', value: 'openrouter' },
  { label: 'OpenAI', value: 'openai' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'DeepSeek', value: 'deepseek' },
  { label: 'Kimi / Moonshot', value: 'kimi' },
  { label: '智谱 GLM', value: 'glm' },
  { label: '自定义 OpenAI 兼容接口', value: 'custom' }
]

const started = ref(false)
const submitting = ref(false)
const error = ref('')
const job = reactive({ state: 'idle', step: '', percent: 0, message: '', log: [], error: '' })

const STEPS = [
  { key: 'pull', label: '准备镜像' },
  { key: 'config', label: '生成配置与访问口令' },
  { key: 'start', label: '启动容器' },
  { key: 'ready', label: '等待工作区就绪' }
]

const stepItems = computed(() => {
  const order = STEPS.map((s) => s.key)
  const currentIndex = order.indexOf(job.step)
  return STEPS.map((step, i) => ({
    ...step,
    state: job.state === 'done' ? 'done' : currentIndex === i ? 'current' : i < currentIndex ? 'done' : 'pending'
  }))
})

let timer = null

async function install() {
  if (!form.version && !form.customTag.trim()) {
    error.value = '请选择官方版本'
    return
  }
  if (form.password.length < 8) {
    error.value = '登录口令至少 8 位'
    return
  }
  submitting.value = true
  error.value = ''
  try {
    const payload = { ...form }
    if (form.customTag.trim()) payload.tag = form.customTag.trim()
    await post('api/install', payload)
    started.value = true
    poll()
  } catch (err) {
    error.value = err.message
  } finally {
    submitting.value = false
  }
}

async function poll() {
  clearTimeout(timer)
  try {
    const data = await get('api/install/status')
    Object.assign(job, {
      state: data.state,
      step: data.step,
      percent: data.percent,
      message: data.message,
      log: data.log || [],
      error: data.error || ''
    })
    if (data.state === 'done') {
      message.success('Hermes Agent 安装完成')
      emit('installed')
      return
    }
    if (data.state === 'error') return
    timer = setTimeout(poll, 1500)
  } catch (err) {
    job.state = 'error'
    job.error = err.message
  }
}

function finish() {
  visible.value = false
  emit('installed')
}

function reset() {
  clearTimeout(timer)
  started.value = false
  job.state = 'idle'
  job.step = ''
  job.percent = 0
  job.message = ''
  job.log = []
  job.error = ''
}

function lineClass(line) {
  if (/\b(ERROR|FATAL)\b/i.test(line)) return 'log-line-error'
  if (/\b(WARN|WARNING)\b/i.test(line)) return 'log-line-warn'
  return ''
}

async function loadVersions() {
  versionsLoading.value = true
  try {
    const data = await get('api/versions')
    versions.value = data.versions || []
    if (!form.version && versions.value.length) form.version = versions.value[0].version
  } catch { /* 忽略，留空时不可提交 */ }
  finally { versionsLoading.value = false }
}

watch(visible, async (open) => {
  if (!open) return
  reset()
  loadVersions()
  try {
    const data = await get('api/install/status')
    if (data.state === 'running') {
      started.value = true
      poll()
    }
  } catch { /* 忽略 */ }
})
</script>
