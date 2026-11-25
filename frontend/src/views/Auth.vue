<template>
  <div class="flex flex-col gap-4 pb-20 sm:pb-8">
    <div class="sticky top-0 z-20 -mx-4 sm:-mx-8 px-4 sm:px-8 pt-5 pb-3 bg-[#f4f6fb]/90 dark:bg-[#12141a]/90 backdrop-blur-md flex items-center justify-between gap-3">
      <div class="flex items-baseline gap-2.5 min-w-0">
        <h1 class="text-xl font-bold text-slate-800 dark:text-slate-100 tracking-tight shrink-0">授权管理</h1>
        <span class="text-xs text-slate-500 dark:text-slate-400 font-medium truncate">账号、环境变量与密钥</span>
      </div>
      <n-button size="small" secondary :loading="loading" @click="load">刷新</n-button>
    </div>

    <n-alert v-if="error" type="error" closable @close="error = ''">{{ error }}</n-alert>

    <template v-if="!data.installed">
      <n-card :bordered="false" class="py-12 text-center shadow-sm rounded-2xl">
        <n-empty description="Hermes 尚未安装">
          <template #icon><n-icon :size="48" class="text-slate-300 dark:text-slate-600"><Key /></n-icon></template>
          <template #extra><span class="text-xs text-slate-500 dark:text-slate-400">安装完成后这里会显示账号与密钥状态</span></template>
        </n-empty>
      </n-card>
    </template>

    <template v-else>
      <!-- 账号 -->
      <n-card size="small" class="interactive-card">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-slate-100 dark:bg-white/[0.06] flex items-center justify-center">
              <n-icon :size="20" class="text-slate-500 dark:text-slate-400"><User /></n-icon>
            </div>
            <div>
              <div class="text-[14px] font-semibold text-slate-800 dark:text-slate-100">
                Nous Portal
                <n-tag size="small" :bordered="false" class="ml-1.5" :type="data.connected ? 'success' : 'default'">
                  {{ data.connected ? '已连接' : '未连接' }}
                </n-tag>
                <n-tag v-if="login.running" size="small" :bordered="false" type="warning" class="ml-1">登录中</n-tag>
              </div>
              <div class="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">
                {{ data.connected ? '可用 Nous 订阅模型；切换账号会重新走一次设备码授权' : '登录后可解锁 Nous 订阅模型与门户能力' }}
              </div>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <n-button v-if="!data.connected" type="primary" size="small" @click="openLogin">登录</n-button>
            <n-button v-else size="small" secondary @click="openLogin">切换</n-button>
            <n-button size="small" secondary @click="openPool">账号池</n-button>
            <n-button v-if="data.connected" size="small" secondary :loading="loggingOut" @click="logout">登出</n-button>
            <n-button size="small" tertiary tag="a" :href="webappUrl" target="_blank">打开工作区</n-button>
          </div>
        </div>
      </n-card>

      <!-- 环境变量 -->
      <n-card title="环境变量" size="small">
        <template #header-extra>
          <div class="flex items-center gap-2">
            <n-tag size="small" round :bordered="false">{{ envItems.length }} 项</n-tag>
            <n-button size="small" secondary @click="addEnv">添加</n-button>
            <n-button size="small" type="primary" secondary :loading="savingEnv" @click="saveEnv">保存</n-button>
          </div>
        </template>
        <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-3">
          写入 <span class="code-chip">data/.env</span>（Hermes 的密钥仓库，0600），保存后重启容器生效。敏感变量名默认以密码框显示，可点眼睛查看。
        </div>
        <div v-if="envItems.length" class="space-y-2">
          <div class="hidden sm:grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2 text-[12px] font-medium text-slate-500 dark:text-slate-400">
            <span>名称</span><span>值</span><span></span>
          </div>
          <div
            v-for="(item, index) in envItems"
            :key="index"
            class="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2 items-center"
          >
            <n-input v-model:value="item.key" placeholder="变量名，如 DEEPSEEK_API_KEY" class="col-start-1 row-start-1" />
            <n-input
              v-model:value="item.value"
              placeholder="变量值"
              :type="isSensitiveKey(item.key) ? 'password' : 'text'"
              show-password-on="click"
              class="col-span-2 col-start-1 row-start-2 sm:col-span-1 sm:col-start-2 sm:row-start-1"
            />
            <n-button quaternary circle size="small" class="col-start-2 row-start-1 sm:col-start-3" @click="removeEnv(index)">
              <template #icon><n-icon :size="15"><Trash /></n-icon></template>
            </n-button>
          </div>
        </div>
        <n-empty v-else description="暂无自定义变量，点击右上角「添加」新建" size="small" class="py-6" />
      </n-card>

      <!-- 当前模型服务 -->
      <n-card title="模型服务" size="small">
        <template #header-extra>
          <n-button size="small" secondary @click="openModelModal">编辑</n-button>
        </template>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-[13px]">
          <div>
            <div class="text-[12px] text-slate-500 dark:text-slate-400">服务商</div>
            <div class="mt-1 font-medium text-slate-800 dark:text-slate-100">{{ providerLabel(data.currentProvider) }}</div>
          </div>
          <div>
            <div class="text-[12px] text-slate-500 dark:text-slate-400">默认模型</div>
            <div class="mt-1 code-chip text-slate-700 dark:text-slate-200">{{ data.currentModel || '—' }}</div>
          </div>
          <div>
            <div class="text-[12px] text-slate-500 dark:text-slate-400">访问口令</div>
            <div class="mt-1 text-slate-700 dark:text-slate-200">{{ data.username }}（去「应用设置」重置）</div>
          </div>
        </div>
      </n-card>

      <!-- 各服务商密钥 -->
      <n-card title="模型 API Key" size="small">
        <div class="divide-y divide-slate-100 dark:divide-white/5">
          <div v-for="p in data.providers" :key="p.id" class="flex items-center justify-between gap-3 py-2.5">
            <div class="min-w-0">
              <div class="text-[13px] font-medium text-slate-800 dark:text-slate-100">{{ p.label }}</div>
              <div class="code-chip text-[12px] text-slate-500 dark:text-slate-400">{{ p.env }}</div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <n-tag size="small" :bordered="false" :type="p.configured ? 'success' : 'default'">{{ p.configured ? '已配置' : '未配置' }}</n-tag>
              <n-button size="small" secondary @click="openKeyModal(p)">更新</n-button>
            </div>
          </div>
        </div>
      </n-card>

      <n-card title="OpenAI 兼容 API" size="small">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="text-[13px] text-slate-600 dark:text-slate-300">
            {{ data.api?.enabled ? `已开启 · 端口 ${data.api.port}` : '未开启' }}
          </div>
          <div class="flex items-center gap-2">
            <n-button size="small" secondary @click="copy(apiBase)">复制地址</n-button>
            <n-button size="small" secondary @click="goSettings">去设置</n-button>
          </div>
        </div>
      </n-card>
    </template>

    <!-- 账号池 -->
    <n-modal v-model:show="poolModal" preset="card" title="账号池" class="w-[92vw] max-w-xl" :mask-closable="false">
      <n-spin :show="poolLoading">
        <div v-if="!poolProviders.length" class="py-8 text-center text-[13px] text-slate-500 dark:text-slate-400">
          暂无已保存的凭据
        </div>
        <div v-else class="space-y-4">
          <div v-for="provider in poolProviders" :key="provider.provider" class="space-y-2">
            <div class="flex items-baseline gap-2">
              <span class="text-[13px] font-semibold text-slate-800 dark:text-slate-100">{{ provider.provider }}</span>
              <span class="text-[12px] text-slate-500 dark:text-slate-400">{{ provider.items.length }} 个凭据</span>
            </div>
            <div v-for="item in provider.items" :key="item.id" class="flex items-center justify-between gap-3 rounded-xl border border-slate-100 dark:border-white/10 px-3 py-2">
              <div class="min-w-0">
                <div class="text-[13px] text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                  {{ item.label }}
                  <n-tag v-if="item.active" size="small" :bordered="false" type="success">当前</n-tag>
                </div>
                <div class="text-[11px] text-slate-500 dark:text-slate-400">
                  {{ item.type }} · priority {{ item.priority }} · #{{ item.index }}
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <n-button size="small" secondary :disabled="item.active" @click="switchCred(provider.provider, item)">切换</n-button>
                <n-button size="small" type="error" secondary @click="removeCred(provider.provider, item)">移除</n-button>
              </div>
            </div>
          </div>
        </div>
      </n-spin>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button secondary @click="poolModal = false">关闭</n-button>
          <n-button type="primary" @click="addAccount">添加账号</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 登录（设备码） -->
    <n-modal v-model:show="loginModal" preset="card" title="登录 Nous Portal" class="w-[92vw] max-w-lg" :mask-closable="false" @after-leave="cancelLogin">
      <div v-if="login.code" class="space-y-4">
        <n-alert type="info" :bordered="false">
          在浏览器打开下面的地址，确认设备码后回到这里等待完成。
        </n-alert>
        <div class="rounded-xl border border-slate-200 dark:border-white/10 p-4 text-center">
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">设备码</div>
          <div class="text-2xl font-bold tracking-widest code-chip">{{ login.code }}</div>
        </div>
        <div class="flex items-center gap-2">
          <n-input :value="login.url" readonly />
          <n-button secondary tag="a" :href="login.url" target="_blank">打开</n-button>
        </div>
        <div class="text-[12px] text-slate-500 dark:text-slate-400">{{ login.message }}</div>
        <n-alert v-if="login.error" type="error">{{ login.error }}</n-alert>
      </div>
      <div v-else class="py-6 text-center text-[13px] text-slate-500 dark:text-slate-400">
        {{ loginState === 'running' ? '正在申请设备码…' : '已取消' }}
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button @click="closeLogin">关闭</n-button>
          <n-button type="primary" :loading="loginState === 'running'" @click="refreshLogin">检查状态</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 编辑模型服务 -->
    <n-modal v-model:show="modelModal" preset="card" title="模型服务" class="w-[92vw] max-w-lg" :mask-closable="false">
      <div class="space-y-3">
        <div>
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">服务商</div>
          <n-select v-model:value="modelForm.provider" :options="providerOptions" />
        </div>
        <div>
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">默认模型</div>
          <n-input v-model:value="modelForm.model" placeholder="如 deepseek-chat" />
        </div>
        <div>
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">接口地址</div>
          <n-input v-model:value="modelForm.baseUrl" placeholder="留空使用官方地址" />
        </div>
        <div>
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">API Key（留空保持不变）</div>
          <n-input v-model:value="modelForm.modelKey" type="password" show-password-on="click" placeholder="sk-..." />
        </div>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button @click="modelModal = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="saveModel">保存</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 更新单个服务商 Key -->
    <n-modal v-model:show="keyModal" preset="card" :title="`更新 ${keyTarget?.label || ''} Key`" class="w-[92vw] max-w-md" :mask-closable="false">
      <n-input v-model:value="keyValue" type="password" show-password-on="click" placeholder="粘贴新的 API Key" />
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button @click="keyModal = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="saveKey">保存</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { NAlert, NButton, NCard, NDivider, NEmpty, NIcon, NInput, NModal, NSelect, NTag, useDialog, useMessage } from 'naive-ui'
import { Key, Trash, User } from '@vicons/tabler'
import { copyText, get, post } from '../api'

const message = useMessage()
const dialog = useDialog()
const data = ref({})
const error = ref('')
const loading = ref(false)
const saving = ref(false)
const loggingOut = ref(false)
const modelModal = ref(false)
const keyModal = ref(false)
const keyTarget = ref(null)
const keyValue = ref('')
const loginModal = ref(false)
const loginState = ref('idle')
const login = reactive({ code: '', url: '', message: '', error: '', running: false })
const envItems = ref([])
const poolModal = ref(false)
const poolLoading = ref(false)
const poolProviders = ref([])
const savingEnv = ref(false)

const providerOptions = [
  { label: 'OpenRouter', value: 'openrouter' },
  { label: 'OpenAI', value: 'openai' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'DeepSeek', value: 'deepseek' },
  { label: 'Kimi / Moonshot', value: 'kimi' },
  { label: '智谱 GLM', value: 'glm' },
  { label: '自定义 OpenAI 兼容接口', value: 'custom' }
]

const modelForm = reactive({ provider: 'openrouter', model: '', baseUrl: '', modelKey: '' })
const webappUrl = '/app/hermes-agent/webapp/'
const apiBase = `${window.location.origin}/app/hermes-agent/`

let pollTimer = null

function providerLabel(id) {
  const hit = providerOptions.find((p) => p.value === id)
  return hit ? hit.label : id || '—'
}

async function load() {
  loading.value = true
  try {
    const [account, authData, env] = await Promise.all([get('api/account'), get('api/auth'), get('api/env-vars')])
    data.value = { ...authData, connected: account.connected, status: account.status }
    loginState.value = account.login?.state || 'idle'
    if (account.login?.state === 'running') {
      Object.assign(login, { ...account.login, running: true })
    }
    envItems.value = (env.items || []).map((item) => ({ key: item.key, value: item.value }))
    error.value = ''
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function openLogin() {
  loginModal.value = true
  loginState.value = 'running'
  Object.assign(login, { code: '', url: '', message: '', error: '', running: true })
  try {
    await post('api/account/login', {})
    startPolling()
  } catch (err) {
    loginState.value = 'error'
    login.error = err.message
  }
}

function startPolling() {
  clearInterval(pollTimer)
  pollTimer = setInterval(refreshLogin, 2000)
}

async function refreshLogin() {
  try {
    const auth = await get('api/account')
    const l = auth.login || {}
    loginState.value = l.state
    login.code = l.code || login.code
    login.url = l.url || login.url
    login.message = l.message || login.message
    login.error = l.error || ''
    login.running = l.state === 'running'
    if (l.state === 'done') {
      clearInterval(pollTimer)
      message.success('Nous Portal 登录成功')
      loginModal.value = false
      await load()
    } else if (l.state === 'error' || l.state === 'cancelled') {
      clearInterval(pollTimer)
    }
  } catch (err) {
    login.error = err.message
  }
}

async function cancelLogin() {
  clearInterval(pollTimer)
  if (login.running) {
    try { await post('api/account/login/cancel', {}) } catch { /* 忽略 */ }
  }
}

function closeLogin() {
  loginModal.value = false
}

async function loadPool() {
  poolLoading.value = true
  try {
    const data = await get('api/account/pool')
    poolProviders.value = data.providers || []
  } catch (err) {
    message.error(err.message)
  } finally {
    poolLoading.value = false
  }
}

function openPool() {
  poolModal.value = true
  loadPool()
}

function addAccount() {
  poolModal.value = false
  openLogin()
}

async function switchCred(provider, item) {
  try {
    await post('api/account/pool/switch', { provider, target: String(item.index) })
    message.success(`已切换到 ${item.label}`)
    await Promise.all([loadPool(), load()])
  } catch (err) {
    message.error(err.message)
  }
}

function removeCred(provider, item) {
  dialog.warning({
    title: '移除凭据',
    content: `确认移除 ${provider} 的「${item.label}」？下次使用需要重新授权。`,
    positiveText: '移除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await post('api/account/pool/remove', { provider, target: String(item.index) })
        message.success('已移除')
        await loadPool()
      } catch (err) {
        message.error(err.message)
      }
    }
  })
}

async function logout() {
  dialog.warning({
    title: '登出 Nous Portal',
    content: '会清除本机保存的 Nous 凭据；模型与工具可能需要重新授权。',
    positiveText: '登出',
    negativeText: '取消',
    onPositiveClick: async () => {
      loggingOut.value = true
      try {
        await post('api/account/logout', {})
        message.success('已登出')
        await load()
      } catch (err) {
        message.error(err.message)
      } finally {
        loggingOut.value = false
      }
    }
  })
}

function openModelModal() {
  modelForm.provider = data.value.currentProvider || 'openrouter'
  modelForm.model = data.value.currentModel || ''
  modelForm.baseUrl = ''
  modelForm.modelKey = ''
  modelModal.value = true
}

async function saveModel() {
  saving.value = true
  try {
    const current = await get('api/settings')
    await post('api/settings', {
      username: current.username,
      imageTag: current.imageTag,
      memoryMb: current.memoryMb,
      apiEnabled: current.apiEnabled,
      apiPort: current.apiPort,
      provider: modelForm.provider,
      model: modelForm.model,
      baseUrl: modelForm.baseUrl,
      modelKey: modelForm.modelKey
    })
    message.success('已保存，正在重建容器')
    await post('api/action', { action: 'restart' })
    modelModal.value = false
    await load()
  } catch (err) {
    message.error(err.message)
  } finally {
    saving.value = false
  }
}

function openKeyModal(provider) {
  keyTarget.value = provider
  keyValue.value = ''
  keyModal.value = true
}

async function saveKey() {
  if (!keyValue.value.trim()) {
    message.warning('请填写 API Key')
    return
  }
  saving.value = true
  try {
    await post('api/auth/key', { provider: keyTarget.value.id, key: keyValue.value.trim() })
    message.success('已更新，重启容器后生效')
    keyModal.value = false
    await load()
  } catch (err) {
    message.error(err.message)
  } finally {
    saving.value = false
  }
}

function isSensitiveKey(key) {
  return /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH/i.test(key || '')
}

function addEnv() {
  envItems.value.push({ key: '', value: '' })
}

function removeEnv(index) {
  envItems.value.splice(index, 1)
}

async function saveEnv() {
  const rows = envItems.value.filter((item) => String(item.key || '').trim() || item.value !== '')
  const seen = new Set()
  for (const row of rows) {
    const key = String(row.key || '').trim()
    if (!key) {
      message.error('变量名不能为空')
      return
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      message.error(`变量名「${key}」不合法，仅允许字母、数字与下划线，且不能以数字开头`)
      return
    }
    if (seen.has(key)) {
      message.error(`变量名「${key}」重复`)
      return
    }
    seen.add(key)
  }
  const items = rows.map((row) => ({ key: String(row.key).trim(), value: row.value }))
  savingEnv.value = true
  try {
    await post('api/env-vars', { items })
    message.success('环境变量已保存，容器重启中')
    setTimeout(load, 2000)
  } catch (err) {
    message.error(err.message)
  } finally {
    savingEnv.value = false
  }
}

async function copy(text) {
  if (!text) return
  await copyText(text)
  message.success('已复制')
}

function goSettings() {
  const url = new URL(window.location.href)
  url.searchParams.set('tab', 'settings')
  window.location.href = url.toString()
}

onMounted(load)
onBeforeUnmount(() => clearInterval(pollTimer))
</script>
