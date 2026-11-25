/**
 * 统一 API 客户端。
 * 使用相对路径：管理界面挂在 /app/hermes-agent/ 下时，'api/status' 会解析到
 * /app/hermes-agent/api/status；本地直连根路径时解析到 /api/status。
 */
export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  })
  const type = res.headers.get('content-type') || ''
  const data = type.includes('application/json') ? await res.json() : await res.text()
  if (!res.ok) {
    const message = data && data.error ? data.error : `请求失败（HTTP ${res.status}）`
    throw new Error(message)
  }
  return data
}

export const get = (path) => api(path)
export const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) })
export const del = (path) => api(path, { method: 'DELETE' })

export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text)
  const input = document.createElement('textarea')
  input.value = text
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.select()
  document.execCommand('copy')
  document.body.removeChild(input)
  return Promise.resolve()
}
