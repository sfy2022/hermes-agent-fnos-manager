import { TrimApp } from '@trimjs/web-app'

let sdkInstance = null

function getSdk() {
  if (!sdkInstance) sdkInstance = new TrimApp()
  return sdkInstance
}

/**
 * 飞牛桌面 SDK 封装：文件管理定位与打开。
 * 在普通浏览器（独立 Web）里调用会失败，调用方降级为复制路径。
 */
export const trimSdk = {
  async ready() {
    try {
      await getSdk().ready()
    } catch {
      /* 非微应用环境忽略 */
    }
  },

  async openURL(url, target = '_blank') {
    if (!url) return { success: false, message: '地址为空' }
    await this.ready()
    try {
      await getSdk().openURL(url, target)
      return { success: true }
    } catch {
      const opened = window.open(url, target)
      return { success: Boolean(opened), message: opened ? '' : '浏览器拦截了新窗口' }
    }
  },

  async openFileManager(path) {
    if (!path) return { success: false, message: '路径为空' }
    await this.ready()
    try {
      const sdk = getSdk()
      if (sdk.isStandaloneWeb) {
        return { success: false, message: '请在飞牛桌面内使用文件管理定位' }
      }
      await sdk.openFileManager(path)
      return { success: true }
    } catch (err) {
      return { success: false, message: err?.message || String(err) }
    }
  }
}
