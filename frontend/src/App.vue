<template>
  <n-config-provider :theme="naiveTheme" :theme-overrides="overrides">
    <n-global-style />
    <n-message-provider>
      <n-dialog-provider>
        <n-layout has-sider position="absolute" class="h-screen w-screen bg-[#f4f6fb] dark:bg-[#12141a]">
          <!-- 侧边栏 -->
          <n-layout-sider
            bordered
            :width="236"
            :native-scrollbar="false"
            class="hidden md:block select-none z-10"
            content-style="display: flex; flex-direction: column; justify-content: space-between; height: 100%;"
          >
            <div class="flex flex-col gap-3 p-3">
              <n-tooltip trigger="hover" placement="right">
                <template #trigger>
                  <div
                    @click="tab = 'overview'"
                    class="flex items-center gap-3 px-3 py-3 rounded-2xl bg-slate-50 dark:bg-white/[0.04] border border-slate-100/80 dark:border-white/[0.06] transition-all duration-200 hover:border-slate-200 dark:hover:border-white/[0.12] hover:bg-slate-100/50 dark:hover:bg-white/[0.07] cursor-pointer group select-none"
                  >
                    <img :src="iconUrl" alt="Hermes" class="w-9 h-9 rounded-xl object-cover shrink-0 transition-transform duration-200 group-hover:scale-105" />
                    <div class="min-w-0 flex-1">
                      <div class="text-sm font-bold text-slate-800 dark:text-slate-100 leading-tight truncate">Hermes Admin</div>
                      <div class="text-[12px] text-slate-500 dark:text-slate-400 font-medium truncate mt-0.5">管理器</div>
                    </div>
                  </div>
                </template>
                <span>返回概览</span>
              </n-tooltip>

              <n-menu :value="tab" :options="menuOptions" @update:value="handleMenuSelect" />
            </div>

            <div class="p-3">
              <n-divider class="!my-2" />
              <n-menu :value="tab" :options="settingsMenuOptions" @update:value="handleMenuSelect" />
              <div class="mt-2 flex items-center justify-between px-2">
                <n-button text size="small" class="!min-w-[28px] !min-h-[28px]" @click="toggleTheme">
                  <template #icon><n-icon><component :is="theme === 'dark' ? Sun : Moon" /></n-icon></template>
                  {{ theme === 'dark' ? '浅色模式' : '深色模式' }}
                </n-button>
                <span class="text-[12px] text-slate-500 dark:text-slate-400">v{{ appVersion }}</span>
              </div>
            </div>
          </n-layout-sider>

          <!-- 主内容 -->
          <n-layout class="h-full flex-1 flex flex-col overflow-hidden bg-[#f4f6fb] dark:bg-[#12141a]">
            <n-layout-content
              :native-scrollbar="false"
              content-class="app-content-scroll"
              content-style="min-height: 100%;"
              class="flex-1"
            >
              <div class="w-full max-w-6xl mx-auto px-4 sm:px-8 pb-24 sm:pb-8">
                <Transition name="view-fade-slide" mode="out-in">
                  <KeepAlive>
                    <component :is="currentView" :key="tab" />
                  </KeepAlive>
                </Transition>
              </div>
              <n-back-top :bottom="70" :right="20" class="sm:!bottom-8 sm:!right-8" />
            </n-layout-content>

            <!-- 移动端底部导航 -->
            <n-layout-footer bordered position="absolute" class="sm:hidden z-50 !bg-white/95 dark:!bg-[#181b22]/95 !backdrop-blur-md px-0.5 pt-1">
              <div class="flex w-full">
                <button v-for="item in mobileTabs" :key="item.key" class="flex-1 flex flex-col items-center gap-0.5 py-1.5" @click="tab = item.key">
                  <n-icon :size="19" :class="tab === item.key ? 'text-fnos-blue scale-110' : 'text-slate-500 dark:text-slate-400'">
                    <component :is="item.icon" />
                  </n-icon>
                  <span class="text-[12px] leading-tight whitespace-nowrap" :class="tab === item.key ? 'font-bold text-fnos-blue' : 'text-slate-500 dark:text-slate-400'">
                    {{ item.label }}
                  </span>
                </button>
              </div>
            </n-layout-footer>
          </n-layout>
        </n-layout>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup>
import { computed, h, ref, watch, watchEffect } from 'vue'
import {
  NBackTop, NButton, NConfigProvider, NDialogProvider, NDivider, NGlobalStyle, NIcon,
  NLayout, NLayoutContent, NLayoutFooter, NLayoutSider, NMenu, NMessageProvider, NTooltip, darkTheme
} from 'naive-ui'
import { Dashboard, Folder, History, Key, Puzzle, FileText, Settings, Moon, Sun } from '@vicons/tabler'
import iconUrl from './assets/icon.png'
import { getThemeOverrides } from './theme.js'
import Overview from './views/Overview.vue'
import Workspace from './views/Workspace.vue'
import Auth from './views/Auth.vue'
import Plugins from './views/Plugins.vue'
import Snapshots from './views/Snapshots.vue'
import Logs from './views/Logs.vue'
import SettingsView from './views/Settings.vue'

const appVersion = '0.29.1'

const TABS = {
  overview: { title: '概览', icon: Dashboard, view: Overview, label: '概览' },
  workspace: { title: '工作区', icon: Folder, view: Workspace, label: '工作区' },
  auth: { title: '授权管理', icon: Key, view: Auth, label: '授权' },
  plugins: { title: '插件管理', icon: Puzzle, view: Plugins, label: '插件' },
  snapshots: { title: '快照管理', icon: History, view: Snapshots, label: '快照' },
  logs: { title: '运行日志', icon: FileText, view: Logs, label: '日志' },
  settings: { title: '应用设置', icon: Settings, view: SettingsView, label: '设置' }
}

const renderIcon = (icon) => () => h(NIcon, null, { default: () => h(icon) })
const mainKeys = ['overview', 'workspace', 'auth', 'plugins', 'snapshots', 'logs']
const menuOptions = mainKeys.map((key) => ({ key, label: TABS[key].title, icon: renderIcon(TABS[key].icon) }))
const settingsMenuOptions = [{ key: 'settings', label: TABS.settings.title, icon: renderIcon(TABS.settings.icon) }]
const mobileTabs = Object.entries(TABS).map(([key, item]) => ({ key, label: item.label, icon: item.icon }))

const queryTab = new URLSearchParams(location.search).get('tab')
const storedTab = queryTab || localStorage.getItem('hermes.tab')
const tab = ref(TABS[storedTab] ? storedTab : 'overview')
const currentView = computed(() => TABS[tab.value].view)

function handleMenuSelect(key) {
  tab.value = key
}

const storedTheme = localStorage.getItem('hermes.theme')
const theme = ref(storedTheme === 'dark' || storedTheme === 'light' ? storedTheme : 'light')
const naiveTheme = computed(() => (theme.value === 'dark' ? darkTheme : null))
const overrides = computed(() => getThemeOverrides(theme.value))

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
}

watch(tab, (value) => localStorage.setItem('hermes.tab', value), { immediate: true })

watchEffect(() => {
  document.documentElement.classList.toggle('dark', theme.value === 'dark')
  localStorage.setItem('hermes.theme', theme.value)
})
</script>
