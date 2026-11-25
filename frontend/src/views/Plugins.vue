<template>
  <div class="flex flex-col gap-4 pb-20 sm:pb-8">
    <div class="sticky top-0 z-20 -mx-4 sm:-mx-8 px-4 sm:px-8 pt-5 pb-3 bg-[#f4f6fb]/90 dark:bg-[#12141a]/90 backdrop-blur-md flex items-center justify-between gap-3">
      <div class="flex items-baseline gap-2.5 min-w-0">
        <h1 class="text-xl font-bold text-slate-800 dark:text-slate-100 tracking-tight shrink-0">插件管理</h1>
        <span class="text-xs text-slate-500 dark:text-slate-400 font-medium truncate">
          {{ skills.length }} 个技能 · 已启用 {{ enabledCount }} · {{ categories }} 个分类
        </span>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <n-button size="small" secondary :loading="loading" @click="load">刷新</n-button>
        <n-button type="primary" size="small" :disabled="!installed" @click="openInstall">安装技能</n-button>
      </div>
    </div>

    <n-alert v-if="error" type="error" closable @close="error = ''">{{ error }}</n-alert>

    <template v-if="!installed">
      <n-card :bordered="false" class="py-12 text-center shadow-sm rounded-2xl">
        <n-empty description="Hermes 尚未安装">
          <template #icon><n-icon :size="48" class="text-slate-300 dark:text-slate-600"><Puzzle /></n-icon></template>
          <template #extra><span class="text-xs text-slate-500 dark:text-slate-400">安装完成后这里会列出容器内的技能</span></template>
        </n-empty>
      </n-card>
    </template>

    <template v-else>
      <n-card size="small">
        <div class="flex flex-col sm:flex-row gap-2">
          <n-input v-model:value="keyword" placeholder="搜索技能名称或描述" clearable class="flex-1" />
          <n-select v-model:value="category" :options="categoryOptions" clearable placeholder="全部分类" class="sm:w-48" />
        </div>
      </n-card>

      <n-card v-if="!filtered.length" :bordered="false" class="py-12 text-center shadow-sm rounded-2xl">
        <n-empty :description="skills.length ? '没有匹配的技能' : '暂无技能'">
          <template #icon><n-icon :size="48" class="text-slate-300 dark:text-slate-600"><Puzzle /></n-icon></template>
        </n-empty>
      </n-card>

      <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <n-card
          v-for="item in filtered"
          :key="item.path"
          :bordered="false"
          class="interactive-card shadow-sm rounded-2xl transition-opacity"
          :class="{ 'opacity-55': !item.enabled }"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="text-[14px] font-semibold text-slate-800 dark:text-slate-100 truncate">{{ item.title }}</div>
              <div class="code-chip text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">
                {{ item.name }}<span v-if="item.version"> · v{{ item.version }}</span>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <n-switch
                v-if="!item.essential"
                size="small"
                :value="item.enabled"
                :disabled="toggling === item.name"
                :loading="toggling === item.name"
                @update:value="(value) => toggle(item, value)"
              />
              <n-tag v-else size="small" :bordered="false">必需</n-tag>
              <n-dropdown
                v-if="!item.essential"
                trigger="click"
                :options="[{ label: '审计技能', key: 'audit' }, { label: '卸载技能', key: 'uninstall' }]"
                @select="(key) => (key === 'audit' ? audit(item) : uninstall(item))"
              >
                <n-button text size="small" class="!min-w-[28px] !min-h-[28px]">
                  <n-icon><Dots /></n-icon>
                </n-button>
              </n-dropdown>
            </div>
          </div>
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mt-1.5 line-clamp-2">{{ item.description || '无描述' }}</div>
          <div class="flex items-center justify-between mt-3">
            <n-tag size="small" :bordered="false" type="info">{{ item.category }}</n-tag>
            <n-button text size="small" class="!min-w-[28px] !min-h-[28px]" @click="copy(item.path)">
              <n-icon><Copy /></n-icon>
            </n-button>
          </div>
        </n-card>
      </div>
    </template>

    <!-- 安装技能 -->
    <n-modal v-model:show="installModal" preset="card" title="安装技能" class="w-[92vw] max-w-xl" :mask-closable="false">
      <div v-if="installStarted" class="space-y-3">
        <div class="flex items-center gap-2 text-[13px] text-slate-700 dark:text-slate-200">
          <n-spin v-if="installJob.state === 'running'" :size="14" />
          <span>{{ installJob.state === 'running' ? `正在安装 ${installJob.identifier}` : installJob.state === 'done' ? '安装完成，容器重启中' : '安装结束' }}</span>
        </div>
        <div class="rounded-xl bg-slate-50 dark:bg-[#12141a] border border-slate-100 dark:border-white/5 p-3 max-h-64 overflow-auto">
          <pre class="log-view text-slate-600 dark:text-slate-300 whitespace-pre-wrap">{{ (installJob.log || []).join('\n') || '等待输出…' }}</pre>
        </div>
        <n-alert v-if="installJob.error" type="error">{{ installJob.error }}</n-alert>
      </div>
      <div v-else class="space-y-3">
        <div>
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">技能标识 / SKILL.md URL</div>
          <div class="flex gap-2">
            <n-input v-model:value="installForm.identifier" placeholder="如 openai/skills/skill-creator 或 https://…/SKILL.md" />
            <n-button secondary :loading="previewing" @click="preview">预览</n-button>
          </div>
        </div>

        <div v-if="previewOutput" class="rounded-xl bg-slate-50 dark:bg-[#12141a] border border-slate-100 dark:border-white/5 p-3 max-h-52 overflow-auto">
          <pre class="log-view text-slate-600 dark:text-slate-300 whitespace-pre-wrap">{{ previewOutput }}</pre>
        </div>

        <div class="flex items-center gap-2">
          <n-checkbox v-model:checked="installForm.force">跳过审计强制安装</n-checkbox>
          <span class="text-[12px] text-slate-500 dark:text-slate-400">审计未通过时使用（等同 skills install --force）</span>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">分类（可选）</div>
            <n-input v-model:value="installForm.category" placeholder="custom" />
          </div>
          <div>
            <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">名称（可选）</div>
            <n-input v-model:value="installForm.name" placeholder="覆盖 SKILL.md 的 name" />
          </div>
        </div>
        <n-divider class="!my-2">或从技能市场搜索</n-divider>
        <div class="flex gap-2">
          <n-input v-model:value="searchQuery" placeholder="搜索技能市场" @keyup.enter="search" />
          <n-button secondary :loading="searching" @click="search">搜索</n-button>
        </div>
        <div v-if="searchResults.length" class="max-h-48 overflow-auto divide-y divide-slate-100 dark:divide-white/5">
          <button
            v-for="item in searchResults"
            :key="item.identifier"
            class="w-full text-left py-2 hover:bg-slate-50 dark:hover:bg-white/5 px-1 rounded"
            @click="installForm.identifier = item.identifier"
          >
            <div class="text-[13px] font-medium text-slate-800 dark:text-slate-100">{{ item.name || item.identifier }}</div>
            <div class="text-[12px] text-slate-500 dark:text-slate-400 truncate">{{ item.description }}</div>
          </button>
        </div>
        <n-alert v-if="installError" type="error">{{ installError }}</n-alert>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button v-if="!installStarted" @click="installModal = false">取消</n-button>
          <n-button v-if="!installStarted" type="primary" :loading="installing" @click="install">安装</n-button>
          <template v-else>
            <n-button v-if="installJob.state === 'running'" type="error" secondary @click="cancelInstall">取消安装</n-button>
            <n-button v-if="installJob.state === 'done'" type="primary" @click="finishInstall">完成</n-button>
            <n-button v-if="installJob.state === 'error' || installJob.state === 'cancelled'" @click="resetInstall">返回</n-button>
          </template>
        </div>
      </template>
    </n-modal>
    <!-- 审计结果 -->
    <n-modal v-model:show="auditModal" preset="card" :title="`审计：${auditTitle}`" class="w-[92vw] max-w-2xl">
      <pre class="log-view text-slate-600 dark:text-slate-300 whitespace-pre-wrap max-h-[55vh] overflow-auto">{{ auditOutput || '审计中…' }}</pre>
    </n-modal>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  NAlert, NButton, NCard, NCheckbox, NDivider, NDropdown, NEmpty, NIcon, NInput, NModal, NSelect, NSwitch, NTag,
  useDialog, useMessage
} from 'naive-ui'
import { Copy, Dots, Puzzle } from '@vicons/tabler'
import { copyText, get, post } from '../api'

const message = useMessage()
const dialog = useDialog()

const data = ref({})
const error = ref('')
const loading = ref(false)
const keyword = ref('')
const category = ref(null)
const installed = ref(false)
const toggling = ref('')
const installModal = ref(false)
const installing = ref(false)
const installError = ref('')
const searchQuery = ref('')
const searching = ref(false)
const searchResults = ref([])
const installForm = reactive({ identifier: '', category: '', name: '', force: false })
const installStarted = ref(false)
const installJob = reactive({ state: 'idle', identifier: '', log: [], error: '' })
let installTimer = null
const previewing = ref(false)
const previewOutput = ref('')
const auditModal = ref(false)
const auditTitle = ref('')
const auditOutput = ref('')

const skills = computed(() => data.value.skills || [])
const categories = computed(() => data.value.categories || 0)
const enabledCount = computed(() => skills.value.filter((s) => s.enabled).length)
const categoryOptions = computed(() => {
  const set = [...new Set(skills.value.map((s) => s.category))]
  return set.sort().map((c) => ({ label: c, value: c }))
})

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return skills.value.filter((s) => {
    if (category.value && s.category !== category.value) return false
    if (!kw) return true
    return `${s.title} ${s.name} ${s.description}`.toLowerCase().includes(kw)
  })
})

async function load() {
  loading.value = true
  try {
    data.value = await get('api/skills')
    installed.value = Boolean(data.value.installed)
    error.value = ''
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function toggle(item, enabled) {
  toggling.value = item.name
  try {
    await post('api/skills/toggle', { name: item.name, enabled })
    message.success(`${item.title} 已${enabled ? '启用' : '禁用'}，容器重启中`)
    setTimeout(load, 2500)
  } catch (err) {
    message.error(err.message)
  } finally {
    toggling.value = ''
  }
}

function uninstall(item) {
  dialog.warning({
    title: '卸载技能',
    content: `确定卸载 ${item.title}？内置技能卸载后会从 data/skills 中移除。`,
    positiveText: '卸载',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await post('api/skills/uninstall', { name: item.name })
        message.success('已卸载，容器重启中')
        setTimeout(load, 2500)
      } catch (err) {
        message.error(err.message)
      }
    }
  })
}

function resetInstall() {
  clearInterval(installTimer)
  installTimer = null
  installStarted.value = false
  Object.assign(installJob, { state: 'idle', identifier: '', log: [], error: '' })
}

function finishInstall() {
  installModal.value = false
  resetInstall()
  load()
}

async function pollInstall() {
  try {
    const job = await get('api/skills/install/status')
    Object.assign(installJob, job)
    if (job.state === 'done') {
      clearInterval(installTimer)
      installTimer = null
      message.success('安装完成，容器重启中')
      setTimeout(load, 2500)
    } else if (job.state === 'error' || job.state === 'cancelled') {
      clearInterval(installTimer)
      installTimer = null
    }
  } catch (err) {
    installJob.error = err.message
  }
}

function cancelInstall() {
  post('api/skills/install/cancel', {}).catch(() => {})
}

function openInstall() {
  resetInstall()
  installForm.force = false
  previewOutput.value = ''
  installForm.identifier = ''
  installForm.category = ''
  installForm.name = ''
  installError.value = ''
  searchResults.value = []
  installModal.value = true
}

async function preview() {
  if (!installForm.identifier.trim()) {
    installError.value = '请填写技能标识或 URL'
    return
  }
  previewing.value = true
  installError.value = ''
  try {
    const data = await post('api/skills/preview', { identifier: installForm.identifier.trim() })
    previewOutput.value = data.output || ''
  } catch (err) {
    installError.value = err.message
  } finally {
    previewing.value = false
  }
}

async function audit(item) {
  auditTitle.value = item.title
  auditOutput.value = ''
  auditModal.value = true
  try {
    const data = await post('api/skills/audit', { name: item.name })
    auditOutput.value = data.output || '（无输出）'
  } catch (err) {
    auditOutput.value = err.message
  }
}

async function install() {
  if (!installForm.identifier.trim()) {
    installError.value = '请填写技能标识或 URL'
    return
  }
  installing.value = true
  installError.value = ''
  try {
    await post('api/skills/install', { ...installForm })
    installStarted.value = true
    installJob.state = 'running'
    installJob.identifier = installForm.identifier.trim()
    installJob.log = []
    installTimer = setInterval(pollInstall, 1000)
    pollInstall()
  } catch (err) {
    installError.value = err.message
  } finally {
    installing.value = false
  }
}

async function search() {
  if (!searchQuery.value.trim()) return
  searching.value = true
  try {
    const data = await get(`api/skills/search?q=${encodeURIComponent(searchQuery.value.trim())}`)
    searchResults.value = data.results || []
  } catch (err) {
    installError.value = err.message
  } finally {
    searching.value = false
  }
}

async function copy(text) {
  if (!text) return
  await copyText(text)
  message.success('路径已复制')
}

onMounted(load)
onBeforeUnmount(() => clearInterval(installTimer))
</script>
