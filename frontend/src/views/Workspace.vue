<template>
  <div class="w-full flex-1 flex flex-col gap-4 sm:gap-6 pb-20 sm:pb-8">
    <!-- 页头 -->
    <div class="sticky top-0 z-20 -mx-4 sm:-mx-8 px-4 sm:px-8 pt-5 pb-3 bg-[#f4f6fb]/90 dark:bg-[#12141a]/90 backdrop-blur-md flex items-center justify-between gap-3">
      <div class="flex items-baseline gap-2.5 min-w-0">
        <h1 class="text-xl font-bold text-slate-800 dark:text-slate-100 tracking-tight shrink-0">工作区</h1>
        <span v-if="items.length" class="text-xs text-slate-500 dark:text-slate-400 font-medium truncate">
          共 {{ items.length }} 个
        </span>
      </div>
      <n-button secondary size="small" :disabled="!data.dataLibraryPath" @click="openPath(data.dataLibraryPath)">
        数据目录
      </n-button>
    </div>

    <n-alert v-if="error" type="error" closable @close="error = ''">{{ error }}</n-alert>

    <n-card v-if="!installed" :bordered="false" class="py-12 text-center shadow-sm rounded-2xl">
      <n-empty description="Hermes 尚未安装">
        <template #icon><n-icon :size="48" class="text-slate-300 dark:text-slate-600"><Folder /></n-icon></template>
        <template #extra><span class="text-xs text-slate-500 dark:text-slate-400">安装 Hermes 后这里会显示项目工作区</span></template>
      </n-empty>
    </n-card>

    <n-card v-else-if="!items.length && !loading" :bordered="false" class="py-12 text-center shadow-sm rounded-2xl">
      <n-empty description="暂无项目">
        <template #icon><n-icon :size="48" class="text-slate-300 dark:text-slate-600"><Folder /></n-icon></template>
        <template #extra>
          <span class="text-xs text-slate-500 dark:text-slate-400">
            在 Hermes Desktop 里新建项目（可多目录），这里会显示项目工作区与会话数
          </span>
        </template>
      </n-empty>
    </n-card>

    <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <n-card
        v-for="item in items"
        :key="item.id"
        hoverable
        :bordered="false"
        class="cursor-pointer interactive-card select-none shadow-sm group !h-full rounded-2xl"
        @click="openPath(item.hostPath || item.path)"
      >
        <n-thing>
          <template #avatar>
            <div class="w-10 h-10 rounded-xl bg-slate-100 dark:bg-white/[0.06] group-hover:bg-blue-50 dark:group-hover:bg-blue-950/40 text-slate-500 dark:text-slate-400 group-hover:text-fnos-blue dark:group-hover:text-blue-400 flex items-center justify-center transition-all duration-200 group-hover:scale-105">
              <n-icon :size="22"><Folder /></n-icon>
            </div>
          </template>

          <template #header>
            <div class="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate transition-colors group-hover:text-fnos-blue dark:group-hover:text-blue-400">
              <n-ellipsis :line-clamp="1">{{ item.title || item.slug || '-' }}</n-ellipsis>
            </div>
          </template>

          <template #header-extra>
            <n-tag size="tiny" round :bordered="false" type="info" class="font-mono">
              {{ item.sessions || 0 }} 会话
            </n-tag>
          </template>

          <template #description>
            <div class="text-xs text-slate-500 dark:text-slate-400 mt-1">
              <n-ellipsis :line-clamp="1">{{ item.hostPath || item.path || '未设置主目录' }}</n-ellipsis>
            </div>
            <div v-if="item.description" class="text-[12px] text-slate-500 dark:text-slate-400 mt-1 line-clamp-1">
              {{ item.description }}
            </div>
          </template>

          <template #footer>
            <div class="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400 pt-0.5 w-full min-w-0">
              <div v-if="item.updatedAt" class="flex items-center gap-1 shrink-0">
                <n-icon :size="12"><Clock /></n-icon>
                <span class="whitespace-nowrap">更新于 <n-time :time="new Date(item.updatedAt)" type="relative" /></span>
              </div>
              <div v-if="item.createdAt" class="flex items-center gap-1 min-w-0 truncate justify-end">
                <n-icon :size="12" class="shrink-0"><Calendar /></n-icon>
                <span class="truncate">创建于 <n-time :time="new Date(item.createdAt)" format="yyyy-MM-dd" /></span>
              </div>
            </div>
          </template>
        </n-thing>
      </n-card>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import {
  NAlert, NButton, NCard, NEllipsis, NEmpty, NIcon, NTag, NThing, NTime, useMessage
} from 'naive-ui'
import { Calendar, Clock, Folder } from '@vicons/tabler'
import { copyText, get } from '../api'
import { trimSdk } from '../utils/trimSdk'

const message = useMessage()
const data = ref({})
const error = ref('')
const loading = ref(true)

const items = computed(() => data.value.items || [])
const installed = computed(() => Boolean(data.value.installed))

async function load() {
  loading.value = true
  try {
    data.value = await get('api/workspace')
    error.value = ''
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function openPath(path) {
  if (!path) {
    message.warning('该项目还没有设置主目录')
    return
  }
  const result = await trimSdk.openFileManager(path)
  if (!result.success) {
    await copyText(path)
    message.info(`${result.message || '无法打开文件管理'}，路径已复制`)
  }
}

onMounted(load)
</script>
