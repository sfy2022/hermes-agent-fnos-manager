#!/usr/bin/env node
/*
 * Hermes Agent 管理端服务
 *
 * 职责：
 *   1. 在 fnOS 网关 socket（web.sock）上提供管理界面与 REST API；
 *   2. 托管 Hermes Agent 容器：启动 / 停止 / 重启 / 更新镜像；
 *   3. 读写运行配置（访问口令、模型服务、API、内存上限）；
 *   4. 提供容器日志与应用日志的查看、下载、清空；
 *   5. 提供数据目录信息与访问凭据。
 *
 * 只依赖 Node 内置模块，运行时不安装任何 npm 包。
 */

'use strict'

const http = require('node:http')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const { spawn } = require('node:child_process')

// ── 路径与常量 ───────────────────────────────────────────────────────────
const APP_NAME = process.env.HERMES_APP_NAME || 'hermes-agent'
const APP_DIR = process.env.HERMES_APP_DIR || `/var/apps/${APP_NAME}`
process.umask(0o027)
const VAR_DIR = process.env.TRIM_PKGVAR || path.join(APP_DIR, 'var')
const DEST_DIR = process.env.TRIM_APPDEST || path.join(APP_DIR, 'target')
const CHOICES_FILE = path.join(VAR_DIR, 'install-choices.env')
function readInstallChoices() {
  try {
    const map = {}
    for (const line of fs.readFileSync(CHOICES_FILE, 'utf8').split(/\r?\n/)) {
      const idx = line.indexOf('=')
      if (idx > 0) map[line.slice(0, idx)] = line.slice(idx + 1)
    }
    return map
  } catch {
    return {}
  }
}
const installChoices = readInstallChoices()
const dataLibraryType = installChoices.data_library_type || 'share'
const runUserChoice = installChoices.run_user || 'package'
const SHARE_DATA_DIR = path.join(APP_DIR, 'shares/hermes-agent/data')
const SHARE_WORKSPACE_DIR = path.join(APP_DIR, 'shares/hermes-agent/workspace')
const NATIVE_DATA_DIR = path.join(VAR_DIR, 'native/data')
const NATIVE_WORKSPACE_DIR = path.join(VAR_DIR, 'native/workspace')
const DATA_DIR_DEFAULT = process.env.HERMES_DATA_DIR || (dataLibraryType === 'data'
  ? path.join(VAR_DIR, 'data-root')
  : SHARE_DATA_DIR)
const WORKSPACE_DIR_DEFAULT = process.env.HERMES_WORKSPACE_DIR || (dataLibraryType === 'data'
  ? path.join(VAR_DIR, 'workspace-root')
  : SHARE_WORKSPACE_DIR)
const bootRuntime = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(VAR_DIR, 'runtime.json'), 'utf8')) } catch { return {} }
})()
let DATA_DIR = bootRuntime.mode === 'native' ? NATIVE_DATA_DIR : DATA_DIR_DEFAULT
let WORKSPACE_DIR = bootRuntime.mode === 'native' ? NATIVE_WORKSPACE_DIR : WORKSPACE_DIR_DEFAULT

const COMPOSE_FILE = process.env.HERMES_COMPOSE_FILE || path.join(DEST_DIR, 'docker/docker-compose.yaml')
const COMPOSE_ENV = path.join(DEST_DIR, 'docker/.env')
const CONFIG_ENV = path.join(VAR_DIR, 'config.env')
const APP_LOG = path.join(VAR_DIR, 'info.log')
const MANAGER_LOG = path.join(VAR_DIR, 'manager.log')
const ACCESS_INFO = path.join(VAR_DIR, 'access-info.txt')
const SOCKET_PATH = path.join(DEST_DIR, 'web.sock')
const PUBLIC_DIR = path.join(__dirname, 'public')

const PROJECT_NAME = process.env.HERMES_PROJECT || 'hermes-agent'
const CONTAINER_NAME = process.env.HERMES_CONTAINER || 'hermes-agent'
const IMAGE_REPO = process.env.HERMES_IMAGE_REPO || 'nousresearch/hermes-agent'
const IMAGE_TAG_DEFAULT = process.env.HERMES_IMAGE_TAG || 'main-desktop'
const IMAGE_MIRROR = process.env.HERMES_IMAGE_MIRROR || 'docker.fnnas.com'
const PREFIX = `/app/${APP_NAME.replace(/\./g, '-')}`
const APP_VERSION = process.env.TRIM_APPVER || '0.1.0'
const PORT = Number(process.env.MANAGER_PORT || 0)

// ── 小工具 ───────────────────────────────────────────────────────────────
function nowSec() { return Math.floor(Date.now() / 1000) }

function rotateLog(file, maxBytes) {
  try {
    const st = fs.statSync(file)
    if (st.size > maxBytes) fs.renameSync(file, `${file}.1`)
  } catch { /* 文件不存在时忽略 */ }
}

function logLine(level, message) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} [${level}] ${message}\n`
  try {
    rotateLog(MANAGER_LOG, 2 * 1024 * 1024)
    fs.appendFileSync(MANAGER_LOG, line)
  } catch { /* 日志失败不影响主流程 */ }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

function run(cmd, args, { timeout = 120000, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      if (!done) { done = true; child.kill('SIGKILL') }
    }, timeout)
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: String(err.message) })
    })
  })
}

async function compose(args, timeout = 180000) {
  if (getRuntimeMode() === 'native' && ['start', 'stop', 'restart', 'up', 'down'].includes(args[0])) {
    try {
      if (args[0] === 'stop' || args[0] === 'down') await nativeStop()
      else await nativeStart()
      return { code: 0, stdout: '', stderr: '' }
    } catch (err) {
      return { code: 1, stdout: '', stderr: err.message }
    }
  }
  return run('docker', ['compose', '-p', PROJECT_NAME, '-f', COMPOSE_FILE, ...args], { timeout })
}

// ── env 文件读写（compose 的 raw 格式：裸值，无引号）─────────────────────
function parseEnv(text) {
  const map = new Map()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    map.set(line.slice(0, eq), line.slice(eq + 1))
  }
  return map
}

async function readEnv(file) {
  try { return parseEnv(await fsp.readFile(file, 'utf8')) } catch { return new Map() }
}

async function writeEnv(file, map, header) {
  const headerLines = Array.isArray(header) ? header : header ? header.split('\n') : []
  const lines = headerLines.map((l) => `# ${l}`)
  for (const [key, value] of map) lines.push(`${key}=${value}`)
  const tmp = `${file}.tmp.${process.pid}`
  await fsp.writeFile(tmp, `${lines.join('\n')}\n`, { mode: 0o600 })
  await fsp.rename(tmp, file)
  await fsp.chmod(file, 0o600)
}

function cleanValue(value) {
  return String(value ?? '').replace(/[\r\n]/g, '').trim()
}

// ── 配置读取 ─────────────────────────────────────────────────────────────
async function readRuntimeConfig() {
  const env = await readEnv(CONFIG_ENV)
  const composeEnv = await readEnv(COMPOSE_ENV)

  const baseUrlKey = [...env.keys()].find((k) => k.endsWith('_BASE_URL') && k !== 'HERMES_BASE_URL')
  const provider = env.get('HERMES_PROVIDER') || guessProvider(baseUrlKey)
  const apiKey = await readDataSecret('API_SERVER_KEY')

  return {
    username: env.get('HERMES_DASHBOARD_BASIC_AUTH_USERNAME') || 'admin',
    apiEnabled: (env.get('API_SERVER_ENABLED') || 'false') === 'true',
    apiPort: Number(env.get('API_SERVER_PORT') || 8642),
    apiKey,
    model: env.get('HERMES_MODEL') || '',
    provider,
    baseUrl: baseUrlKey ? env.get(baseUrlKey) : '',
    imageTag: composeEnv.get('HERMES_DOCKER_IMAGE_TAG') || IMAGE_TAG_DEFAULT,
    memoryMb: Number(String(composeEnv.get('HERMES_DOCKER_MEMORY') || '3072').replace(/[^0-9]/g, '')) || 3072,
    port: 9121,
    imageRepo: composeEnv.get('HERMES_DOCKER_IMAGE_REPO') || IMAGE_REPO
  }
}

function guessProvider(baseUrlKey) {
  if (!baseUrlKey) return 'openrouter'
  return baseUrlKey.replace('_BASE_URL', '').toLowerCase()
}

async function readDataSecret(key) {
  const env = await readEnv(path.join(DATA_DIR, '.env'))
  return env.get(key) || ''
}

async function readAccessInfo() {
  try { return await fsp.readFile(ACCESS_INFO, 'utf8') } catch { return '' }
}

// ── 口令哈希（与上游 plugins/dashboard_auth/basic 参数一致）─────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const dk = crypto.scryptSync(password, salt, 32, { N: 2 ** 14, r: 8, p: 1, maxmem: 0 })
  return `scrypt$16384$8$1$${salt.toString('base64')}$${dk.toString('base64')}`
}

// ── 安装状态与安装作业 ───────────────────────────────────────────────────
function isInstalled() {
  try { return fs.statSync(CONFIG_ENV).size > 0 } catch { return false }
}

let installJob = { state: 'idle', step: '', percent: 0, message: '', log: [], error: '', startedAt: 0 }

function jobReset() {
  installJob = { state: 'idle', step: '', percent: 0, message: '', log: [], error: '', startedAt: 0 }
}

function jobLog(line) {
  const text = String(line).replace(/\r/g, '').trimEnd()
  if (!text) return
  installJob.log.push(text)
  if (installJob.log.length > 300) installJob.log.splice(0, installJob.log.length - 300)
}

function jobStep(step, message) {
  installJob.step = step
  installJob.message = message
  jobLog(`【${message}】`)
}

function spawnStream(cmd, args, env, onLine) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    const handle = (chunk) => {
      buf += chunk.toString()
      const parts = buf.split('\n')
      buf = parts.pop() || ''
      for (const line of parts) onLine(line)
    }
    child.stdout.on('data', handle)
    child.stderr.on('data', handle)
    child.on('close', (code) => {
      if (buf) onLine(buf)
      resolve(code)
    })
    child.on('error', (err) => {
      onLine(String(err.message))
      resolve(-1)
    })
  })
}

function pullPercent(line) {
  const matches = [...String(line).matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]))
  if (!matches.length) return
  installJob.percent = Math.max(installJob.percent, Math.min(99, Math.max(...matches)))
}

async function pullImage(tag, { onLine, timeout = 1800000 } = {}) {
  const mirror = (await getAppSettings()).imageMirror
  const canonical = `${IMAGE_REPO}:${tag}`
  const candidates = []
  if (mirror === 'docker.fnnas.com') {
    candidates.push({ ref: canonical, source: '飞牛官方镜像源', tag: false })
    candidates.push({ ref: `docker.m.daocloud.io/${IMAGE_REPO}:${tag}`, source: 'DaoCloud 加速站', tag: true })
  } else {
    candidates.push({ ref: `${mirror}/${IMAGE_REPO}:${tag}`, source: mirror, tag: true })
    candidates.push({ ref: canonical, source: '官方仓库', tag: false })
  }
  let lastOutput = ''
  for (const candidate of candidates) {
    if (onLine) onLine(`拉取镜像：${candidate.ref}（${candidate.source}）`)
    let code
    if (onLine) {
      code = await spawnStream('docker', ['pull', candidate.ref], process.env, onLine)
    } else {
      const r = await run('docker', ['pull', candidate.ref], { timeout })
      code = r.code
      lastOutput = `${r.stderr || ''}${r.stdout || ''}`.slice(-400)
    }
    if (code === 0) {
      if (candidate.tag) await run('docker', ['tag', candidate.ref, canonical], { timeout: 30000 })
      return { ok: true, source: candidate.source, ref: candidate.ref }
    }
  }
  return { ok: false, output: lastOutput }
}

async function ensureImageForInstall(tag) {
  const canonical = `${IMAGE_REPO}:${tag}`
  const exists = await run('docker', ['image', 'inspect', canonical], { timeout: 15000 })
  if (exists.code === 0) {
    installJob.percent = 100
    jobLog(`镜像已存在：${canonical}`)
    return
  }
  const pull = await pullImage(tag, {
    onLine: (line) => { jobLog(line); pullPercent(line) }
  })
  if (!pull.ok) throw new Error('镜像拉取失败：请检查网络或先在终端执行 tools/prepull.sh')
  jobLog(`镜像就绪（来源：${pull.source}）`)
  installJob.percent = 100
}

async function waitWebapp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000), redirect: 'manual' })
      if ([200, 302, 303, 401].includes(res.status)) return true
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 3000))
  }
  return false
}

function installerEnv(body) {
  const user = process.env.TRIM_USERNAME || os.userInfo().username || 'docker-hermes-agent'
  const group = process.env.TRIM_GROUPNAME || user
  return {
    ...process.env,
    TRIM_APPNAME: 'hermes-agent',
    TRIM_APPDEST: DEST_DIR,
    TRIM_PKGVAR: VAR_DIR,
    TRIM_USERNAME: user,
    TRIM_GROUPNAME: group,
    HERMES_MANAGER_INSTALL: '1',
    HERMES_IMAGE_TAG: body.imageTag,
    wizard_data_library_type: dataLibraryType,
    wizard_dsh_run_user: runUserChoice,
    wizard_dashboard_username: body.username,
    wizard_dashboard_password: body.password,
    wizard_provider: body.provider,
    wizard_api_key: body.modelKey || '',
    wizard_base_url: body.baseUrl || '',
    wizard_model: body.model || '',
    wizard_enable_api: body.apiEnabled ? 'true' : 'false',
    wizard_api_port: String(body.apiPort || 8642),
    wizard_enable_gateway: 'false',
    wizard_memory_limit: String(body.memoryMb || 3072)
  }
}

function validateInstall(body) {
  const username = cleanValue(body.username || 'admin')
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(username)) throw badRequest('用户名只能包含字母、数字、下划线、点或连字符')
  const password = String(body.password || '')
  if (password.length < 8) throw badRequest('登录口令至少 8 位')
  const imageTag = cleanValue(body.tag || (body.version ? `${body.version}-desktop` : '') || body.imageTag || '')
  if (!imageTag) throw badRequest('请选择要安装的官方版本')
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(imageTag)) throw badRequest('镜像标签格式不正确')
  if (/^(latest|latest-.*|stable|main)$/.test(imageTag)) throw badRequest('请选择具体的官方版本（如 v0.23.4-desktop）')
  const provider = cleanValue(body.provider || 'openrouter')
  if (!PROVIDER_KEYS[provider]) throw badRequest('未知的模型服务商')
  const memoryMb = Number(body.memoryMb || 3072)
  if (!Number.isInteger(memoryMb) || memoryMb < 512 || memoryMb > 16384) throw badRequest('内存上限需在 512-16384 MB 之间')
  return { ...body, username, password, imageTag, provider, memoryMb }
}

async function runInstall(body) {
  try {
    jobStep('pull', body.imageTag === IMAGE_TAG_DEFAULT ? '准备镜像（首次约 3.76 GB）' : '准备镜像')
    await ensureImageForInstall(body.imageTag)

    jobStep('config', '生成访问口令与运行配置')
    const script = path.join(APP_DIR, 'cmd/install_callback')
    if (!fs.existsSync(script)) throw new Error(`安装脚本缺失：${script}`)
    let failed = false
    const code = await spawnStream('bash', [script], installerEnv(body), (line) => {
      jobLog(line)
      if (/(ERROR|Permission denied|cannot move|No such file)/i.test(line)) failed = true
    })
    if (code !== 0 || failed) throw new Error('配置生成失败，请查看安装日志')
    if (!fs.existsSync(CONFIG_ENV) || !fs.existsSync(path.join(DATA_DIR, 'config.yaml'))) {
      throw new Error('配置生成不完整（运行配置或 config.yaml 缺失），请检查数据目录权限')
    }

    jobStep('start', '启动 Hermes 容器')
    const up = await compose(['up', '-d', '--remove-orphans'], 600000)
    if (up.code !== 0) throw new Error((up.stderr || up.stdout || 'compose up 失败').slice(-500))
    await new Promise((r) => setTimeout(r, 3000))
    const container = await inspectContainer()
    if (!container.running) {
      const logs = await run('docker', ['logs', '--tail', '30', CONTAINER_NAME], { timeout: 20000 })
      jobLog(`${logs.stdout}${logs.stderr}`.trim())
      throw new Error('容器未能保持运行，请查看上方日志')
    }
    if (!(await rendererPresent())) {
      throw new Error(`镜像 ${body.imageTag} 不含 Desktop 渲染层，请换一个官方版本`)
    }

    jobStep('ready', '等待工作区就绪（首次初始化 1~2 分钟）')
    const ready = await waitWebapp(9121, 240000)
    if (!ready) throw new Error('工作区在 4 分钟内未就绪，请到「运行日志」查看容器输出')

    installJob.state = 'done'
    installJob.message = '安装完成'
    jobLog('安装完成')
    setLastMessage('Hermes 安装完成')
  } catch (err) {
    installJob.state = 'error'
    installJob.error = err.message
    jobLog(`ERROR: ${err.message}`)
  }
}

async function startInstall(body) {
  if (installJob.state === 'running') throw new Error('已有安装任务在进行')
  const clean = validateInstall(body)
  installJob = { state: 'running', step: 'prepare', percent: 0, message: '准备安装', log: [], error: '', startedAt: Date.now() }
  if (clean.runtime === 'native') {
    runNativeInstall(clean)
      .then(() => {
        installJob.state = 'done'
        installJob.percent = 100
        installJob.message = '原生运行时已就绪'
      })
      .catch((err) => {
        installJob.state = 'error'
        installJob.error = err.message
        installJob.message = '原生安装失败'
      })
    return { ok: true, runtime: 'native' }
  }
  runInstall(clean)
  return { ok: true, runtime: 'docker' }
}

async function doUninstall(body) {
  if (getRuntimeMode() === 'native') {
    await nativeStop().catch(() => {})
    await fsp.rm(NATIVE_HOME, { recursive: true, force: true }).catch(() => {})
    await setRuntimeState({ mode: 'docker', tag: '', version: '' })
    if (body && body.deleteData) {
      for (const dir of [DATA_DIR, WORKSPACE_DIR]) {
        try {
          const real = await fsp.realpath(dir)
          await run('rm', ['-rf', real], { timeout: 120000 })
        } catch { /* 不存在 */ }
      }
    }
    setLastMessage('Hermes 原生运行时已卸载')
    return { ok: true }
  }
  installJob = { state: 'idle', step: '', percent: 0, message: '', log: [], error: '', startedAt: 0 }
  await compose(['down', '--remove-orphans'], 180000)
  await run('docker', ['rm', '-f', CONTAINER_NAME], { timeout: 60000 })
  for (const file of [CONFIG_ENV, ACCESS_INFO, path.join(VAR_DIR, 'api_server.key')]) {
    try { await fsp.rm(file, { force: true }) } catch { /* 忽略 */ }
  }
  if (body && body.deleteData) {
    for (const dir of [DATA_DIR, WORKSPACE_DIR]) {
      try {
        const real = await fsp.realpath(dir)
        await run('rm', ['-rf', real], { timeout: 120000 })
      } catch { /* 目录不存在 */ }
    }
  }
  setLastMessage('Hermes 已卸载')
  logLine('INFO', `已卸载 Hermes${body && body.deleteData ? '（含数据目录）' : '（保留数据）'}`)
  return { ok: true }
}

// ── 工作区 / 技能 / 快照 ─────────────────────────────────────────────────
async function listDirEntries(dir) {
  try {
    const names = await fsp.readdir(dir)
    const items = []
    for (const name of names) {
      if (name.startsWith('.')) continue
      try {
        const st = await fsp.stat(path.join(dir, name))
        items.push({ name, isDir: st.isDirectory(), size: st.size, updatedAt: st.mtime.toISOString() })
      } catch { /* 忽略不可读项 */ }
    }
    return items
  } catch {
    return []
  }
}

const sessionsCache = new Map()

function getSessions(limit = 200) {
  const cached = sessionsCache.get(limit)
  if (cached && Date.now() - cached.ts < 5000) return cached.rows
  const dbFile = path.join(DATA_DIR, 'state.db')
  if (!fs.existsSync(dbFile)) return []
  try {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(dbFile, { readOnly: true })
    const rows = db.prepare(`
      SELECT id, title, display_name, source, model, message_count,
             last_activity_at, started_at, ended_at, archived, cwd
      FROM sessions
      WHERE hidden = 0
      ORDER BY last_activity_at DESC
      LIMIT ?
    `).all(limit)
    db.close()
    const mapped = rows.map((row) => ({ ...row }))
    sessionsCache.set(limit, { ts: Date.now(), rows: mapped })
    return mapped
  } catch (err) {
    logLine('WARN', `读取会话失败：${err.message}`)
    return []
  }
}

function sessionTime(value) {
  if (!value) return 0
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

async function realRoots() {
  const [workspace, data] = await Promise.all([
    fsp.realpath(WORKSPACE_DIR).catch(() => WORKSPACE_DIR),
    fsp.realpath(DATA_DIR).catch(() => DATA_DIR)
  ])
  return { workspace, data }
}

function toHostPath(value, roots) {
  const p = String(value || '')
  if (p === '/opt/workspace' || p.startsWith('/opt/workspace/')) {
    return roots.workspace + p.slice('/opt/workspace'.length)
  }
  if (p === '/opt/data' || p.startsWith('/opt/data/')) {
    return roots.data + p.slice('/opt/data'.length)
  }
  return p
}

async function getProjects() {
  const roots = await realRoots()
  const dbFile = path.join(DATA_DIR, 'projects.db')
  if (!fs.existsSync(dbFile)) return []
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbFile, { readOnly: true })
  const projects = db.prepare(`
    SELECT id, slug, name, description, icon, color, primary_path, created_at, archived
    FROM projects
    WHERE archived = 0
    ORDER BY created_at DESC
  `).all()
  const folders = db.prepare(`
    SELECT project_id, path, label, is_primary, added_at
    FROM project_folders
    ORDER BY is_primary DESC, added_at ASC
  `).all()
  db.close()

  const sessions = getSessions(1000)
  const byProject = new Map()
  for (const folder of folders) {
    if (!byProject.has(folder.project_id)) byProject.set(folder.project_id, [])
    byProject.get(folder.project_id).push({ ...folder })
  }

  return projects.map((project) => {
    const projectFolders = byProject.get(project.id) || []
    const paths = projectFolders.map((f) => f.path).filter(Boolean)
    const primary = project.primary_path || paths[0] || ''
    const matched = sessions.filter((session) => {
      const cwd = session.cwd || ''
      if (!cwd) return false
      return paths.some((path) => cwd === path || cwd.startsWith(`${path.replace(/\/$/, '')}/`))
    })
    const createdAt = project.created_at ? new Date(project.created_at * 1000).toISOString() : ''
    const folderAt = Math.max(0, ...projectFolders.map((f) => Number(f.added_at || 0) * 1000))
    const sessionAt = Math.max(0, ...matched.map((s) => sessionTime(s.last_activity_at || s.started_at)))
    const updatedAt = new Date(Math.max(folderAt, sessionAt, project.created_at ? project.created_at * 1000 : 0) || Date.now()).toISOString()
    return {
      id: project.id,
      slug: project.slug,
      title: project.name,
      description: project.description || '',
      icon: project.icon || '',
      color: project.color || '',
      path: primary,
      hostPath: toHostPath(primary, roots),
      folders: projectFolders.map((f) => ({
        path: f.path,
        hostPath: toHostPath(f.path, roots),
        label: f.label || '',
        primary: Boolean(f.is_primary)
      })),
      sessionIds: matched.map((s) => s.id),
      sessions: matched.length,
      createdAt,
      updatedAt
    }
  })
}

async function getWorkspace() {
  if (getRuntimeMode() === 'native') await ensureNativePerms()
  const [dataSize, workspaceSize, roots] = await Promise.all([dirSize(DATA_DIR), dirSize(WORKSPACE_DIR), realRoots()])
  let items = []
  try {
    items = await getProjects()
  } catch (err) {
    logLine('WARN', `读取项目失败：${err.message}`)
  }
  return {
    installed: isInstalled(),
    dataLibraryPath: roots.data,
    workspaceDir: roots.workspace,
    dataSize,
    workspaceSize,
    total: items.length,
    items
  }
}

async function getSessionsPayload(limit = 30) {
  const sessions = getSessions(limit).map((s) => ({
    id: s.id,
    title: s.title || s.display_name || s.id,
    source: s.source,
    model: s.model,
    messages: s.message_count || 0,
    cwd: s.cwd || '',
    updatedAt: new Date(sessionTime(s.last_activity_at || s.started_at)).toISOString(),
    archived: Boolean(s.archived)
  }))
  return { installed: isInstalled(), sessions }
}

function parseFrontmatter(text) {
  const match = String(text).match(/^---\n([\s\S]*?)\n---/)
  const meta = {}
  if (match) {
    for (const line of match[1].split('\n')) {
      const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
      if (!m) continue
      meta[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  return meta
}

const ESSENTIAL_SKILLS = new Set(['hermes-agent'])

function yamlDisabledNames(text) {
  const lines = String(text).split('\n')
  const names = []
  let inSkills = false
  let inDisabled = false
  for (const line of lines) {
    if (/^skills:\s*$/.test(line)) { inSkills = true; inDisabled = false; continue }
    if (inSkills && /^\S/.test(line)) break
    if (!inSkills) continue
    if (/^  disabled:\s*$/.test(line)) { inDisabled = true; continue }
    if (inDisabled) {
      const m = line.match(/^    -\s*(.+?)\s*$/)
      if (m) { names.push(m[1].replace(/^["']|["']$/g, '')); continue }
      if (/^  \S/.test(line)) inDisabled = false
    }
  }
  return names
}

function setYamlDisabledNames(text, names) {
  const lines = String(text).split('\n')
  const items = names.map((n) => `    - ${n}`)
  let start = lines.findIndex((l) => /^skills:\s*$/.test(l))

  if (start === -1) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    lines.push('skills:', '  disabled:')
    lines.push(...items)
    return `${lines.join('\n')}\n`
  }

  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) { end = i; break }
  }
  const block = lines.slice(start + 1, end)
  const disabledIndex = block.findIndex((l) => /^  disabled:\s*(\[\])?\s*$/.test(l))
  const replacement = ['  disabled:', ...items]

  if (disabledIndex === -1) {
    block.splice(0, 0, ...replacement)
  } else {
    let count = 1
    while (disabledIndex + count < block.length && /^    -\s*/.test(block[disabledIndex + count])) count += 1
    block.splice(disabledIndex, count, ...replacement)
  }
  lines.splice(start + 1, end - start - 1, ...block)
  return lines.join('\n')
}

async function setSkillEnabled(name, enabled) {
  if (!isInstalled()) throw badRequest('Hermes 尚未安装')
  if (ESSENTIAL_SKILLS.has(name)) throw badRequest('该技能是必需技能，不能禁用')
  const file = path.join(DATA_DIR, 'config.yaml')
  let text = ''
  try { text = await fsp.readFile(file, 'utf8') } catch { throw badRequest('config.yaml 不存在') }
  const disabled = new Set(yamlDisabledNames(text))
  if (enabled) disabled.delete(name)
  else disabled.add(name)
  const next = setYamlDisabledNames(text, [...disabled].sort())
  await fsp.writeFile(file, next, { mode: 0o600 })
  await compose(['restart'], 180000)
  logLine('INFO', `技能 ${name} 已${enabled ? '启用' : '禁用'}`)
  return { ok: true, disabled: [...disabled].sort() }
}

let skillJob = { state: 'idle', identifier: '', log: [], error: '' }
let skillChild = null

async function startSkillInstall(body) {
  if (!isInstalled()) throw badRequest('Hermes 尚未安装')
  if (skillJob.state === 'running') throw new Error('已有技能安装任务进行中')
  const identifier = cleanValue(body.identifier)
  if (!/^[A-Za-z0-9._@/:-]{3,200}$/.test(identifier) && !/^https?:\/\//.test(identifier)) {
    throw badRequest('技能标识或 URL 不合法')
  }
  const args = ['skills', 'install', identifier, '--yes']
  if (cleanValue(body.name)) args.push('--name', cleanValue(body.name))
  if (cleanValue(body.category)) args.push('--category', cleanValue(body.category))
  if (body.force) args.push('--force')

  skillJob = { state: 'running', identifier, log: [], error: '' }
  skillChild = spawnHermes(args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let buffer = ''
  const handle = (chunk) => {
    buffer += chunk.toString()
    const parts = buffer.split('\n')
    buffer = parts.pop() || ''
    for (const line of parts) {
      const text = line.replace(/\r/g, '').trimEnd()
      if (!text) continue
      skillJob.log.push(text)
      if (skillJob.log.length > 300) skillJob.log.shift()
    }
  }
  skillChild.stdout.on('data', handle)
  skillChild.stderr.on('data', handle)
  skillChild.on('close', async (code) => {
    skillChild = null
    if (skillJob.state !== 'running') return
    if (code === 0) {
      skillJob.state = 'done'
      setLastMessage(`技能 ${identifier} 安装完成`)
      logLine('INFO', `已安装技能 ${identifier}`)
      await compose(['restart'], 180000).catch(() => {})
    } else {
      skillJob.state = 'error'
      skillJob.error = skillJob.log.slice(-4).join(' ') || `安装进程退出（${code}）`
    }
  })
  skillChild.on('error', (err) => {
    skillChild = null
    skillJob.state = 'error'
    skillJob.error = err.message
  })
  return { ok: true, state: 'running' }
}

function cancelSkillInstall() {
  if (skillChild) {
    try { skillChild.kill('SIGTERM') } catch { /* 忽略 */ }
    skillChild = null
  }
  if (skillJob.state === 'running') {
    skillJob.state = 'cancelled'
    skillJob.error = '已取消'
  }
  return { ok: true }
}

async function uninstallSkill(name) {
  if (!isInstalled()) throw badRequest('Hermes 尚未安装')
  if (ESSENTIAL_SKILLS.has(name)) throw badRequest('该技能是必需技能，不能卸载')
  const r = await hermesRun(['skills', 'uninstall', name, '--yes'], 180000)
  const output = `${r.stdout}\n${r.stderr}`.trim()
  if (r.code !== 0) throw new Error(output.slice(-600) || '卸载失败')
  await compose(['restart'], 180000)
  return { ok: true, output: output.slice(-2000) }
}

async function searchSkills(query) {
  const q = cleanValue(query)
  if (!q) return { results: [] }
  const r = await hermesRun(['skills', 'search', q, '--json', '--limit', '12'], 60000)
  if (r.code !== 0) throw new Error(`${r.stderr || r.stdout}`.slice(-400) || '搜索失败')
  try {
    const parsed = JSON.parse(r.stdout)
    const results = (Array.isArray(parsed) ? parsed : parsed.results || []).map((item) => ({
      identifier: item.identifier || item.id || item.name,
      name: item.name || item.title || '',
      description: item.description || '',
      source: item.source || ''
    }))
    return { results }
  } catch {
    return { results: [] }
  }
}

async function getSkills() {
  const root = path.join(DATA_DIR, 'skills')
  const skills = []
  let categories = []
  try {
    categories = (await fsp.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory())
  } catch {
    return { skills, categories: 0, installed: isInstalled() }
  }
  for (const cat of categories) {
    let dirs = []
    try {
      dirs = (await fsp.readdir(path.join(root, cat.name), { withFileTypes: true })).filter((e) => e.isDirectory())
    } catch { continue }
    for (const dir of dirs) {
      const file = path.join(root, cat.name, dir.name, 'SKILL.md')
      let text = ''
      try { text = await fsp.readFile(file, 'utf8') } catch { continue }
      const meta = parseFrontmatter(text)
      skills.push({
        name: meta.name || dir.name,
        title: dir.name,
        description: meta.description || '',
        category: cat.name,
        version: meta.version || '',
        path: path.dirname(file)
      })
    }
  }
  let disabled = []
  try { disabled = yamlDisabledNames(await fsp.readFile(path.join(DATA_DIR, 'config.yaml'), 'utf8')) } catch { /* 忽略 */ }
  const disabledSet = new Set(disabled)
  for (const skill of skills) {
    skill.enabled = !disabledSet.has(skill.name) || ESSENTIAL_SKILLS.has(skill.name)
    skill.essential = ESSENTIAL_SKILLS.has(skill.name)
  }
  skills.sort((a, b) => (a.category === b.category ? a.title.localeCompare(b.title) : a.category.localeCompare(b.category)))
  return { skills, categories: categories.length, disabled, installed: isInstalled() }
}

async function getAuth() {
  const env = await readEnv(path.join(DATA_DIR, '.env'))
  const cfg = await readRuntimeConfig()
  const providers = [
    ['openrouter', 'OpenRouter', 'OPENROUTER_API_KEY'],
    ['openai', 'OpenAI', 'OPENAI_API_KEY'],
    ['anthropic', 'Anthropic', 'ANTHROPIC_API_KEY'],
    ['deepseek', 'DeepSeek', 'DEEPSEEK_API_KEY'],
    ['kimi', 'Kimi / Moonshot', 'KIMI_API_KEY'],
    ['glm', '智谱 GLM', 'GLM_API_KEY']
  ].map(([id, label, key]) => ({ id, label, env: key, configured: Boolean(env.get(key)) }))

  let nous = { connected: false, updatedAt: '' }
  try {
    const st = await fsp.stat(path.join(DATA_DIR, 'auth.json'))
    nous = { connected: st.size > 0, updatedAt: st.mtime.toISOString() }
  } catch { /* 未登录 */ }

  return {
    installed: isInstalled(),
    username: cfg.username,
    providers,
    currentProvider: cfg.provider,
    currentModel: cfg.model,
    nous,
    api: { enabled: cfg.apiEnabled, port: cfg.apiPort, key: cfg.apiKey },
    port: cfg.port
  }
}

// ── 快照 ────────────────────────────────────────────────────────────────
const SNAPSHOT_DIR = path.join(VAR_DIR, 'snapshots')
const SNAPSHOT_EXCLUDES = ['cache', 'audio_cache', 'image_cache', '*.lock']

async function listSnapshots() {
  try {
    const names = (await fsp.readdir(SNAPSHOT_DIR)).filter((n) => n.endsWith('.tar.gz'))
    const items = []
    for (const name of names) {
      const st = await fsp.stat(path.join(SNAPSHOT_DIR, name))
      const id = name.replace(/\.tar\.gz$/, '')
      let meta = {}
      try { meta = JSON.parse(await fsp.readFile(path.join(SNAPSHOT_DIR, `${id}.json`), 'utf8')) } catch { /* 无元数据 */ }
      items.push({
        id,
        file: name,
        size: st.size,
        createdAt: meta.createdAt || st.mtime.toISOString(),
        name: meta.name || '',
        note: meta.note || ''
      })
    }
    items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return items
  } catch {
    return []
  }
}

async function createSnapshot(label, note = '') {
  if (!isInstalled()) throw badRequest('Hermes 尚未安装，无法创建快照')
  await fsp.mkdir(SNAPSHOT_DIR, { recursive: true })
  const id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  const file = path.join(SNAPSHOT_DIR, `${id}.tar.gz`)
  const args = ['-czf', file, '-C', DATA_DIR]
  for (const ex of SNAPSHOT_EXCLUDES) args.push(`--exclude=${ex}`)
  args.push('.')
  const stopped = await compose(['stop'], 120000)
  const tar = await run('tar', args, { timeout: 600000 })
  await compose(['up', '-d'], 600000)
  if (tar.code !== 0) throw new Error((tar.stderr || '打包失败').slice(-500))
  const st = await fsp.stat(file)
  const meta = { id, name: label || '', note: note || '', size: st.size, createdAt: st.mtime.toISOString() }
  await fsp.writeFile(path.join(SNAPSHOT_DIR, `${id}.json`), JSON.stringify(meta), { mode: 0o600 })
  logLine('INFO', `创建快照 ${id}（${Math.round(st.size / 1024)} KB）`)
  return meta
}

async function restoreSnapshot(id) {
  if (!/^[0-9]{8,20}$/.test(id)) throw badRequest('快照标识不合法')
  const file = path.join(SNAPSHOT_DIR, `${id}.tar.gz`)
  await fsp.access(file)
  await createSnapshot('restore-safety')
  await compose(['stop'], 120000)
  const entries = await fsp.readdir(DATA_DIR)
  for (const name of entries) {
    await fsp.rm(path.join(DATA_DIR, name), { recursive: true, force: true })
  }
  const tar = await run('tar', ['-xzf', file, '-C', DATA_DIR], { timeout: 600000 })
  await compose(['up', '-d'], 600000)
  if (tar.code !== 0) throw new Error((tar.stderr || '解包失败').slice(-500))
  logLine('INFO', `已恢复快照 ${id}`)
  return { ok: true }
}

async function deleteSnapshot(id) {
  if (!/^[0-9]{8,20}$/.test(id)) throw badRequest('快照标识不合法')
  await fsp.rm(path.join(SNAPSHOT_DIR, `${id}.tar.gz`), { force: true })
  await fsp.rm(path.join(SNAPSHOT_DIR, `${id}.json`), { force: true })
  return { ok: true }
}

// ── 应用级设置（访问方式 / 镜像源 / 网络代理 / 监听端口）────────────────
const APP_SETTINGS_FILE = path.join(VAR_DIR, 'settings.json')
const DEFAULT_APP_SETTINGS = {
  accessMode: 'gateway',
  customUrl: '',
  imageMirror: IMAGE_MIRROR,
  networkProxy: '',
  proxyRuntime: false,
  webappPort: 0
}
let appSettingsCache = null

function setWebappPortYaml(text, port) {
  const lines = String(text).split('\n')
  let inWebapp = false
  let replaced = false
  for (let i = 0; i < lines.length; i += 1) {
    if (/^webapp:\s*$/.test(lines[i])) { inWebapp = true; continue }
    if (!inWebapp) continue
    if (/^\S/.test(lines[i])) break
    if (/^\s*port:\s*\d+\s*$/.test(lines[i])) {
      lines[i] = lines[i].replace(/port:\s*\d+/, `port: ${port}`)
      replaced = true
      break
    }
  }
  if (!replaced) {
    lines.push('webapp:', '  enabled: true', '  host: 0.0.0.0', `  port: ${port}`)
  }
  return lines.join('\n')
}

function readWebappPort() {
  try {
    const text = fs.readFileSync(path.join(DATA_DIR, 'config.yaml'), 'utf8')
    const section = text.split(/\n(?=\S)/).find((chunk) => chunk.startsWith('webapp:'))
    if (!section) return 9121
    const match = section.match(/^\s*port:\s*(\d+)/m)
    const port = match ? Number(match[1]) : 9121
    return port >= 1024 && port <= 65535 ? port : 9121
  } catch {
    return 9121
  }
}

async function getAppSettings() {
  if (appSettingsCache) return appSettingsCache
  let stored = {}
  try { stored = JSON.parse(await fsp.readFile(APP_SETTINGS_FILE, 'utf8')) } catch { /* 默认 */ }
  appSettingsCache = { ...DEFAULT_APP_SETTINGS, ...stored }
  return appSettingsCache
}

async function writeAppSettings(next) {
  const tmp = `${APP_SETTINGS_FILE}.tmp.${process.pid}`
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
  await fsp.rename(tmp, APP_SETTINGS_FILE)
  appSettingsCache = next
}

function validateProxyUrl(value) {
  if (!value) return ''
  if (!/^(https?|socks5):\/\/[^\s]+$/i.test(value)) throw badRequest('代理地址需以 http://、https:// 或 socks5:// 开头')
  return value
}

async function saveAppSettings(body) {
  if (!isInstalled()) throw badRequest('Hermes 尚未安装')
  const current = await getAppSettings()
  const next = { ...current }

  if (body.accessMode !== undefined) {
    const mode = cleanValue(body.accessMode)
    if (!['gateway', 'port', 'custom'].includes(mode)) throw badRequest('未知的打开方式')
    next.accessMode = mode
  }
  if (body.customUrl !== undefined) {
    const url = cleanValue(body.customUrl)
    if (url && !/^https?:\/\/[^\s]+$/.test(url)) throw badRequest('自定义地址需以 http:// 或 https:// 开头')
    next.customUrl = url
  }
  if (next.accessMode === 'custom' && !next.customUrl) throw badRequest('自定义地址不能为空')

  if (body.imageMirror !== undefined) {
    const mirror = cleanValue(body.imageMirror).replace(/\/$/, '')
    if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(mirror)) throw badRequest('镜像源格式不正确')
    next.imageMirror = mirror
  }
  if (body.networkProxy !== undefined) next.networkProxy = validateProxyUrl(cleanValue(body.networkProxy))
  if (body.proxyRuntime !== undefined) next.proxyRuntime = Boolean(body.proxyRuntime)

  let restart = false
  if (body.webappPort !== undefined) {
    const port = Number(body.webappPort)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw badRequest('监听端口需在 1024-65535 之间')
    if (port === 8642) throw badRequest('监听端口不能与 OpenAI API 端口相同')
    if (port !== readWebappPort()) {
      const file = path.join(DATA_DIR, 'config.yaml')
      const text = await fsp.readFile(file, 'utf8')
      await fsp.writeFile(file, setWebappPortYaml(text, port), { mode: 0o600 })
      WEBAPP_PORT = port
      restart = true
      logLine('INFO', `WebUI 监听端口已改为 ${port}`)
    }
    next.webappPort = port
  }

  const proxyChanged = next.networkProxy !== current.networkProxy || next.proxyRuntime !== current.proxyRuntime
  if (proxyChanged) {
    const env = await readEnv(CONFIG_ENV)
    if (next.proxyRuntime && next.networkProxy) {
      env.set('HTTP_PROXY', next.networkProxy)
      env.set('HTTPS_PROXY', next.networkProxy)
      env.set('NO_PROXY', 'localhost,127.0.0.1,::1')
      env.set('NODE_USE_ENV_PROXY', '1')
    } else {
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY']) env.delete(key)
    }
    await writeEnv(CONFIG_ENV, env, [
      'Hermes Agent 运行时环境变量',
      '由管理端写入（cmd/install_callback 提供初始值）',
      '本文件含密钥，权限 0600，请勿外传'
    ])
    restart = true
  }

  await writeAppSettings(next)
  if (restart) await compose(['restart'], 180000)
  logLine('INFO', '应用设置已保存')
  return { ok: true, settings: next, restarted: restart }
}


// ── 原生运行时（实验）────────────────────────────────────────────────────
const RUNTIME_FILE = path.join(VAR_DIR, 'runtime.json')
const NATIVE_DIR = path.join(VAR_DIR, 'native')
const NATIVE_HOME = path.join(NATIVE_DIR, 'hermes')
const NATIVE_LOG = path.join(NATIVE_DIR, 'gateway.log')
const NATIVE_ERR_LOG = path.join(NATIVE_DIR, 'gateway.err.log')
const NATIVE_PID_FILE = path.join(NATIVE_DIR, 'gateway.pid')
let runtimeCache = null
let nativeChild = null

function getRuntimeMode() {
  if (runtimeCache) return runtimeCache.mode === 'native' ? 'native' : 'docker'
  try {
    runtimeCache = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'))
  } catch {
    runtimeCache = { mode: 'docker' }
  }
  return runtimeCache.mode === 'native' ? 'native' : 'docker'
}

function applyRuntimePaths(mode) {
  if (mode === 'native') {
    DATA_DIR = NATIVE_DATA_DIR
    WORKSPACE_DIR = NATIVE_WORKSPACE_DIR
  } else {
    DATA_DIR = DATA_DIR_DEFAULT
    WORKSPACE_DIR = WORKSPACE_DIR_DEFAULT
  }
}

async function setRuntimeState(next) {
  runtimeCache = { ...(runtimeCache || {}), ...next }
  applyRuntimePaths(runtimeCache.mode)
  await fsp.mkdir(VAR_DIR, { recursive: true })
  const tmp = `${RUNTIME_FILE}.tmp.${process.pid}`
  await fsp.writeFile(tmp, JSON.stringify(runtimeCache, null, 2), { mode: 0o600 })
  await fsp.rename(tmp, RUNTIME_FILE)
}

function nativeBin() {
  return path.join(NATIVE_HOME, '.venv/bin/hermes')
}

function nativeEnv() {
  return {
    ...process.env,
    HOME: DATA_DIR,
    HERMES_HOME: DATA_DIR,
    HERMES_WEBAPP_DIST: path.join(NATIVE_HOME, 'apps/desktop/dist-webapp'),
    HERMES_DASHBOARD: '1',
    PATH: `${path.join(NATIVE_HOME, '.venv/bin')}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${process.env.PATH ? `:${process.env.PATH}` : ''}`
  }
}

function findNativePid() {
  try {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        const cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' ')
        if (cmd.includes(NATIVE_HOME) && cmd.includes('gateway') && cmd.includes('run')) return Number(name)
      } catch { /* 进程已退出 */ }
    }
  } catch { /* /proc 不可读 */ }
  return 0
}

function nativePid() {
  try {
    const pid = Number(fs.readFileSync(NATIVE_PID_FILE, 'utf8').trim())
    if (pid > 0 && pidAlive(pid)) return pid
  } catch { /* 无 pid */ }
  const found = findNativePid()
  if (found) {
    try { fs.writeFileSync(NATIVE_PID_FILE, String(found), { mode: 0o600 }) } catch { /* 忽略 */ }
  }
  return found
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode) })
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')) })
    req.on('error', reject)
  })
}

async function nativeHealth(port = readWebappPort()) {
  try {
    const status = await httpGet(`http://127.0.0.1:${port}/`, 2500)
    return status < 500
  } catch { return false }
}

async function nativeRunning() {
  if (!(await nativeHealth())) return false
  const pid = nativePid()
  return Boolean(pid)
}

async function pathHasData(dir) {
  try {
    return fs.existsSync(path.join(dir, 'config.yaml')) || fs.existsSync(path.join(dir, 'state.db'))
  } catch { return false }
}

async function migrateDataDir(src, dst, label) {
  if (!fs.existsSync(src) || !(await pathHasData(src))) return { migrated: false, reason: '源目录没有数据' }
  if (await pathHasData(dst)) return { migrated: false, reason: '目标目录已有数据，保留现有数据' }
  const image = `${IMAGE_REPO}:${await currentTag()}`
  const uid = process.env.TRIM_UID || String(process.getuid?.() || 1000)
  const gid = process.env.TRIM_GID || String(process.getgid?.() || 1000)
  const r = await run('docker', [
    'run', '--rm',
    '-v', `${src}:/src:ro`,
    '-v', `${dst}:/dst`,
    '--entrypoint', 'sh',
    image, '-lc', `mkdir -p /dst && cp -a /src/. /dst/ && chown -R ${uid}:${gid} /dst`
  ], { timeout: 600000 })
  if (r.code !== 0) throw new Error(`${label}数据迁移失败：${(r.stderr || '').slice(-300)}`)
  if (!(await pathHasData(dst))) throw new Error(`${label}数据迁移后校验失败：目标目录没有有效数据`)
  logLine('INFO', `${label}数据已迁移：${src} → ${dst}`)
  return { migrated: true }
}

async function ensureNativePerms() {
  const APP_GID = 901
  async function walk(dir) {
    let entries = []
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    try { await fsp.chmod(dir, 0o2750) } catch { /* 忽略 */ }
    try { await fsp.chown(dir, -1, APP_GID) } catch { /* 忽略 */ }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else {
        const sensitive = /^(\.env|config\.yaml|.*\.key|.*\.lock)$/.test(entry.name)
        try { await fsp.chmod(full, sensitive ? 0o600 : 0o640) } catch { /* 忽略 */ }
        try { await fsp.chown(full, -1, APP_GID) } catch { /* 忽略 */ }
      }
    }
  }
  for (const root of [NATIVE_DATA_DIR, NATIVE_WORKSPACE_DIR]) {
    if (fs.existsSync(root)) await walk(root)
  }
}

async function nativeStart() {
  if (await nativeRunning()) { await ensureNativePerms(); return { ok: true } }
  if (!fs.existsSync(nativeBin())) throw new Error('原生运行时尚未安装')
  await fsp.mkdir(NATIVE_DIR, { recursive: true })
  const out = fs.openSync(NATIVE_LOG, 'a')
  const err = fs.openSync(NATIVE_ERR_LOG, 'a')
  nativeChild = spawn(nativeBin(), ['gateway', 'run', '--no-supervise', '--force'], {
    cwd: DATA_DIR,
    env: nativeEnv(),
    detached: true,
    stdio: ['ignore', out, err]
  })
  nativeChild.unref()
  await fsp.writeFile(NATIVE_PID_FILE, String(nativeChild.pid), { mode: 0o600 })
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    if (await nativeHealth()) {
      const real = findNativePid()
      if (real) {
        try { await fsp.writeFile(NATIVE_PID_FILE, String(real), { mode: 0o600 }) } catch { /* 忽略 */ }
      }
      await ensureNativePerms()
      await setRuntimeState({ stopped: false })
      setLastMessage('Hermes 原生运行时已启动')
      return { ok: true }
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`原生运行时启动超时：${nativeLogTail() || '请查看运行日志'}`)
}

async function nativeStop() {
  const pid = nativePid()
  if (pid) {
    try { process.kill(-pid, 'SIGTERM') } catch {
      try { process.kill(pid, 'SIGTERM') } catch { /* 已退出 */ }
    }
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && pidAlive(pid)) await new Promise((r) => setTimeout(r, 500))
    if (pidAlive(pid)) {
      try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* 忽略 */ } }
    }
  }
  nativeChild = null
  try { await fsp.rm(NATIVE_PID_FILE, { force: true }) } catch { /* 忽略 */ }
  setLastMessage('Hermes 原生运行时已停止')
  return { ok: true }
}

function nativeLogTail(lines = 30) {
  try {
    const text = fs.readFileSync(NATIVE_LOG, 'utf8').split('\n').filter(Boolean)
    return text.slice(-lines).join('\n')
  } catch { return '' }
}

async function fixNativeInterpreter() {
  const toolsDir = path.join(NATIVE_HOME, 'tools')
  const dirs = (await fsp.readdir(toolsDir).catch(() => [])).filter((name) => name.startsWith('python-'))
  if (!dirs.length) throw new Error('原生运行时缺少 Python')
  const py = path.join('../../tools', dirs[0], 'bin/python3')
  const venvPython = path.join(NATIVE_HOME, '.venv/bin/python')
  await fsp.rm(venvPython, { force: true })
  await fsp.symlink(py, venvPython)
}

async function nativeWriteConfig(body) {
  const port = readWebappPort()
  const username = cleanValue(body.username) || 'admin'
  if (!body.password || String(body.password).length < 8) throw badRequest('原生安装需要至少 8 位登录口令')
  const passwordHash = hashPassword(String(body.password))
  const secret = crypto.randomBytes(32).toString('base64')
  const config = [
    '# Hermes Agent 配置（原生运行时）',
    'webapp:',
    '  enabled: true',
    '  host: 0.0.0.0',
    `  port: ${port}`,
    'dashboard:',
    '  basic_auth:',
    `    username: ${username}`,
    `    password_hash: "${passwordHash}"`,
    `    secret: "${secret}"`,
    '_config_version: 54',
    'display:',
    '  language: zh',
    ''
  ].join('\n')
  await fsp.mkdir(DATA_DIR, { recursive: true })
  await fsp.writeFile(path.join(DATA_DIR, 'config.yaml'), config, { mode: 0o600 })

  const env = await readEnv(path.join(DATA_DIR, '.env'))
  if (!env.get('API_SERVER_KEY')) env.set('API_SERVER_KEY', crypto.randomBytes(32).toString('hex'))
  if (body.modelKey) {
    const envName = body.provider === 'openrouter' ? 'OPENROUTER_API_KEY'
      : body.provider === 'anthropic' ? 'ANTHROPIC_API_KEY'
      : body.provider === 'openai' ? 'OPENAI_API_KEY'
      : body.provider === 'deepseek' ? 'DEEPSEEK_API_KEY'
      : body.provider === 'kimi' ? 'KIMI_API_KEY'
      : body.provider === 'glm' ? 'GLM_API_KEY'
      : 'OPENAI_API_KEY'
    env.set(envName, String(body.modelKey))
  }
  if (body.baseUrl) env.set('OPENAI_BASE_URL', String(body.baseUrl))
  env.set('API_SERVER_ENABLED', body.apiEnabled ? 'true' : 'false')
  env.set('API_SERVER_PORT', String(body.apiPort || 8642))
  await writeEnv(path.join(DATA_DIR, '.env'), env, ['Hermes Agent 原生运行时环境变量'])

  const runtimeEnv = await readEnv(CONFIG_ENV)
  runtimeEnv.set('HERMES_DASHBOARD_BASIC_AUTH_USERNAME', username)
  runtimeEnv.set('HERMES_PROVIDER', body.provider || 'openrouter')
  runtimeEnv.set('HERMES_MODEL', body.model || '')
  runtimeEnv.set('API_SERVER_ENABLED', body.apiEnabled ? 'true' : 'false')
  runtimeEnv.set('API_SERVER_PORT', String(body.apiPort || 8642))
  await writeEnv(CONFIG_ENV, runtimeEnv, ['Hermes Agent 原生运行时配置'])

  const composeEnv = await readEnv(COMPOSE_ENV)
  composeEnv.set('HERMES_DOCKER_IMAGE_TAG', body.imageTag || IMAGE_TAG_DEFAULT)
  composeEnv.set('HERMES_DOCKER_IMAGE_REPO', IMAGE_REPO)
  await writeEnv(COMPOSE_ENV, composeEnv, ['Hermes Agent 原生运行时镜像来源'])
  return { username, port }
}

async function runNativeInstall(body) {
  const requested = cleanValue(body.imageTag || (body.version ? `${body.version}-desktop` : '') || IMAGE_TAG_DEFAULT)
  const canonical = `${IMAGE_REPO}:${requested}`
  jobLog(`原生运行时目标：${canonical}`)
  const exists = await run('docker', ['image', 'inspect', canonical], { timeout: 30000 })
  if (exists.code !== 0) {
    const pull = await pullImage(requested, { onLine: jobLog })
    if (!pull.ok) throw new Error(`拉取镜像失败：${pull.output || '请检查网络'}`)
    jobLog(`镜像就绪（来源：${pull.source}）`)
  }
  installJob.percent = 20
  installJob.message = '提取原生运行时（Python/Webapp）'
  jobLog('从镜像提取 /opt/hermes 到应用私有目录…')
  await fsp.rm(NATIVE_HOME, { recursive: true, force: true })
  await fsp.mkdir(NATIVE_HOME, { recursive: true })
  const created = await run('docker', ['create', canonical], { timeout: 60000 })
  if (created.code !== 0) throw new Error(`docker create 失败：${created.stderr.slice(-300)}`)
  const cid = created.stdout.trim()
  try {
    const cp = await run('docker', ['cp', `${cid}:/opt/hermes/.`, NATIVE_HOME], { timeout: 600000 })
    if (cp.code !== 0) throw new Error(`提取运行时失败：${cp.stderr.slice(-300)}`)
  } finally {
    await run('docker', ['rm', '-f', cid], { timeout: 60000 })
  }
  const uid = process.env.TRIM_UID || String(process.getuid?.() || 1000)
  const gid = process.env.TRIM_GID || String(process.getgid?.() || 1000)
  await run('docker', ['run', '--rm', '--entrypoint', 'chown',
    '-v', `${NATIVE_HOME}:/target`,
    '-v', `${DATA_DIR}:/data`,
    '-v', `${WORKSPACE_DIR}:/workspace`,
    canonical, '-R', `${uid}:${gid}`, '/target', '/data', '/workspace'], { timeout: 300000 })
  installJob.percent = 55
  installJob.message = '修复解释器与配置'
  await setRuntimeState({ mode: 'native', tag: requested, version: requested.replace(/-desktop$/, '') })
  await fixNativeInterpreter()
  jobLog('解释器链接已修复')
  await nativeWriteConfig(body)
  jobLog('config.yaml / .env 已写入')
  installJob.percent = 75
  installJob.message = '启动原生运行时'
  await nativeStop().catch(() => {})
  // 若同端口仍被 Docker 容器占用，先停容器，避免原生进程绑定失败
  await run('docker', ['stop', CONTAINER_NAME], { timeout: 120000 }).catch(() => {})
  await nativeStart()
  installJob.percent = 100
  installJob.message = '原生运行时已就绪'
  jobLog('Hermes 原生运行时已启动（无容器）')
}

let lastMessage = ''
let metricsCache = { ts: 0, data: { cpu: '-', memory: '-', memoryPercent: '-' } }
let diskCache = { ts: 0, data: null }
let versionCache = { ts: 0, key: '', data: { full: '', short: '' } }

async function getDiskUsage() {
  if (diskCache.data && Date.now() - diskCache.ts < 30000) return diskCache.data
  const [dataSize, workspaceSize] = await Promise.all([dirSize(DATA_DIR), dirSize(WORKSPACE_DIR)])
  diskCache = { ts: Date.now(), data: { data: dataSize, workspace: workspaceSize } }
  return diskCache.data
}

async function getAppVersion(container) {
  if (!container.running) return { full: '', short: '' }
  if (versionCache.key === container.id && Date.now() - versionCache.ts < 15000) return versionCache.data
  const version = await readAppVersion()
  versionCache = { ts: Date.now(), key: container.id, data: version }
  return version
}

function setLastMessage(text) {
  lastMessage = String(text || '').slice(0, 300)
}

async function getMetrics() {
  if (!isInstalled()) return { cpu: '-', memory: '-', memoryPercent: '-' }
  if (getRuntimeMode() === 'native') {
    const pid = nativePid()
    if (!pidAlive(pid)) return { cpu: '-', memory: '-', memoryPercent: '-' }
    const r = await run('ps', ['-o', '%cpu=,rss=', '-p', String(pid)], { timeout: 5000 })
    if (r.code !== 0) return { cpu: '-', memory: '-', memoryPercent: '-' }
    const [cpu, rss] = r.stdout.trim().split(/\s+/)
    const mb = (Number(rss || 0) / 1024).toFixed(0)
    return { cpu: `${Number(cpu || 0).toFixed(1)}%`, memory: `${mb}MiB`, memoryPercent: '-' }
  }
  if (Date.now() - metricsCache.ts < 4000) return metricsCache.data
  const r = await run('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}', CONTAINER_NAME], { timeout: 20000 })
  if (r.code === 0) {
    const [cpu = '-', memory = '-', memoryPercent = '-'] = r.stdout.trim().split('\t')
    metricsCache = { ts: Date.now(), data: { cpu, memory, memoryPercent } }
  }
  return metricsCache.data
}

async function buildStatus(host) {
  const container = await inspectContainer()
  const cfg = await readRuntimeConfig()
  const disk = await getDiskUsage()
  const version = await getAppVersion(container)
  const appSettings = await getAppSettings()
  const webappPort = appSettings.webappPort || readWebappPort()
  const metrics = container.running ? await getMetrics() : { cpu: '-', memory: '-', memoryPercent: '-' }
  const uptime = container.running && container.startedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(container.startedAt)) / 1000))
    : 0
  return {
    installed: isInstalled(),
    installJob: { state: installJob.state, step: installJob.step, percent: installJob.percent, message: installJob.message, error: installJob.error },
    snapshotJob: { state: snapJob.state, kind: snapJob.kind, percent: snapJob.percent, message: snapJob.message },
    app: {
      name: 'Hermes Agent',
      version: APP_VERSION,
      managerPid: process.pid,
      managerUptime: Math.floor(process.uptime()),
      prefix: PREFIX
    },
    container,
    version: version.full,
    versionShort: version.short,
    metrics,
    uptime,
    lastMessage,
    access: {
      port: webappPort,
      webui:
        appSettings.accessMode === 'port'
          ? `http://${host}:${webappPort}/`
          : appSettings.accessMode === 'custom' && appSettings.customUrl
            ? appSettings.customUrl
            : `${PREFIX}/webapp/`,
      direct: `http://${host}:${webappPort}/`,
      admin: `${PREFIX}/`,
      api: cfg.apiEnabled ? `http://${host}:${cfg.apiPort}/v1` : ''
    },
    config: {
      imageTag: cfg.imageTag,
      memoryMb: cfg.memoryMb,
      username: cfg.username,
      apiEnabled: cfg.apiEnabled,
      apiPort: cfg.apiPort,
      model: cfg.model,
      provider: cfg.provider
    },
    disk,
    busy: Boolean(actionLock)
  }
}

// ── 容器状态 ─────────────────────────────────────────────────────────────
async function inspectContainer() {
  if (getRuntimeMode() === 'native') {
    const running = await nativeRunning()
    return {
      exists: fs.existsSync(NATIVE_HOME),
      running,
      status: running ? 'running' : 'exited',
      startedAt: running ? new Date().toISOString() : '',
      image: runtimeCache?.tag ? `${IMAGE_REPO}:${runtimeCache.tag}` : 'native',
      imageId: 'native',
      id: 'native',
      restartCount: 0,
      health: running ? 'healthy' : ''
    }
  }
  const r = await run('docker', ['inspect', CONTAINER_NAME], { timeout: 15000 })
  if (r.code !== 0) return { exists: false, running: false, status: 'missing' }
  try {
    const data = JSON.parse(r.stdout)[0]
    return {
      exists: true,
      running: Boolean(data.State && data.State.Running),
      status: data.State ? data.State.Status : 'unknown',
      startedAt: data.State ? data.State.StartedAt : '',
      image: data.Config ? data.Config.Image : '',
      imageId: data.Image || '',
      id: (data.Id || '').slice(0, 12),
      restartCount: data.RestartCount || 0,
      health: data.State && data.State.Health ? data.State.Health.Status : ''
    }
  } catch {
    return { exists: false, running: false, status: 'unknown' }
  }
}

async function dirSize(dir) {
  const r = await run('du', ['-sh', dir], { timeout: 10000 })
  if (r.code !== 0) return ''
  return r.stdout.split(/\s+/)[0] || ''
}

async function readAppVersion() {
  if (getRuntimeMode() === 'native' && runtimeCache?.version) {
    return { full: `Hermes Agent ${runtimeCache.version}`, short: runtimeCache.version }
  }
  const r = getRuntimeMode() === 'native'
    ? await run(nativeBin(), ['--version'], { timeout: 30000, env: nativeEnv() })
    : await hermesRun(['--version'], 15000)
  if (r.code !== 0) return { full: '', short: '' }
  const line = r.stdout.split('\n').find((l) => l.includes('Hermes Agent'))
  if (!line) return { full: '', short: '' }
  const full = line.trim()
  const match = full.match(/Hermes Agent\s+(v[0-9][0-9.]*)/)
  return { full, short: match ? match[1] : '' }
}

// ── 动作 ─────────────────────────────────────────────────────────────────
let actionLock = null

async function withLock(fn) {
  if (actionLock) throw new Error('已有操作正在进行，请稍候')
  actionLock = fn()
  try { return await actionLock } finally { actionLock = null }
}

async function ensureImage() {
  const tag = await currentTag()
  const canonical = `${IMAGE_REPO}:${tag}`
  const local = await run('docker', ['image', 'inspect', canonical], { timeout: 15000 })
  if (local.code === 0) return { ok: true, pulled: false }
  logLine('INFO', '本地无镜像，开始拉取')
  const pull = await pullImage(tag)
  if (!pull.ok) throw new Error(`镜像拉取失败：${pull.output || '请检查网络'}`)
  logLine('INFO', `镜像已就绪（来源：${pull.source}）`)
  return { ok: true, pulled: true }
}

async function currentTag() {
  const composeEnv = await readEnv(COMPOSE_ENV)
  return composeEnv.get('HERMES_DOCKER_IMAGE_TAG') || IMAGE_TAG_DEFAULT
}

async function hermesRun(args, timeout = 60000) {
  if (getRuntimeMode() === 'native') {
    return run(nativeBin(), args, { timeout, env: nativeEnv() })
  }
  return run('docker', ['exec', CONTAINER_NAME, 'hermes', ...args], { timeout })
}

function spawnHermes(args, options = {}) {
  if (getRuntimeMode() === 'native') {
    return spawn(nativeBin(), args, { ...options, env: nativeEnv() })
  }
  return spawn('docker', ['exec', CONTAINER_NAME, 'hermes', ...args], options)
}

async function doStart() {
  if (getRuntimeMode() === 'native') {
    setLastMessage('正在启动 Hermes 原生运行时…')
    await setRuntimeState({ stopped: false })
    await nativeStart()
    return { ok: true }
  }
  setLastMessage('正在启动 Hermes…')
  await ensureImage()
  const r = await compose(['up', '-d', '--remove-orphans'], 600000)
  logLine(r.code === 0 ? 'INFO' : 'ERROR', `启动容器：${r.code === 0 ? '成功' : '失败'}`)
  setLastMessage(r.code === 0 ? 'Hermes 已启动' : '启动失败，请查看运行日志')
  if (r.code !== 0) throw new Error(`启动失败：${r.stderr.slice(-500) || r.stdout.slice(-500)}`)
  return { ok: true }
}

async function doStop() {
  if (getRuntimeMode() === 'native') {
    await setRuntimeState({ stopped: true })
    await nativeStop()
    return { ok: true }
  }
  const r = await compose(['stop'], 180000)
  logLine('INFO', '停止容器')
  setLastMessage(r.code === 0 ? 'Hermes 已停止' : '停止失败')
  if (r.code !== 0) throw new Error(`停止失败：${r.stderr.slice(-400)}`)
  return { ok: true }
}

async function doRestart() {
  if (getRuntimeMode() === 'native') {
    await nativeStop()
    await nativeStart()
    setLastMessage('Hermes 原生运行时已重启')
    return { ok: true }
  }
  // 用强制重建而不是 compose restart：restart 不会重新读取 env_file / .env，
  // 设置保存后重启会看起来「没生效」。
  setLastMessage('正在重建容器…')
  const r = await compose(['up', '-d', '--force-recreate', '--remove-orphans'], 600000)
  logLine('INFO', '按当前配置重建容器')
  setLastMessage(r.code === 0 ? '容器已重启' : '重启失败，请查看运行日志')
  if (r.code !== 0) throw new Error(`重启失败：${r.stderr.slice(-400)}`)
  return { ok: true }
}

async function rendererPresent() {
  if (getRuntimeMode() === 'native') {
    return fs.existsSync(path.join(NATIVE_HOME, 'apps/desktop/dist-webapp/assets'))
  }
  const r = await run('docker', ['exec', CONTAINER_NAME, 'sh', '-c', '[ -d /opt/hermes/apps/desktop/dist-webapp/assets ]'], { timeout: 20000 })
  return r.code === 0
}

async function doUpgrade(body = {}) {
  if (getRuntimeMode() === 'native') {
    installJob = { state: 'running', step: 'native', percent: 0, message: '准备原生运行时', log: [], error: '', startedAt: Date.now() }
    try {
      await runNativeInstall(body)
      installJob.state = 'done'
      installJob.percent = 100
      installJob.message = '原生运行时已更新'
      return { ok: true, tag: runtimeCache?.tag }
    } catch (err) {
      installJob.state = 'error'
      installJob.error = err.message
      throw err
    }
  }
  const oldTag = await currentTag()
  const requested = cleanValue(body.tag || (body.version ? `${body.version}-desktop` : '') || oldTag)
  const tag = requested
  logLine('INFO', `更新镜像：${oldTag} → ${tag}`)
  const pull = await pullImage(tag)
  if (!pull.ok) throw new Error(`拉取镜像失败：${pull.output || '网络不可用'}`)

  const composeEnv = await readEnv(COMPOSE_ENV)
  composeEnv.set('HERMES_DOCKER_IMAGE_TAG', tag)
  composeEnv.set('HERMES_DOCKER_IMAGE_REPO', IMAGE_REPO)
  composeEnv.set('HERMES_DOCKER_CONTAINER', CONTAINER_NAME)
  composeEnv.set('HERMES_DATA_HOST', DATA_DIR)
  composeEnv.set('HERMES_WORKSPACE_HOST', WORKSPACE_DIR)
  await writeEnv(COMPOSE_ENV, composeEnv, ['Hermes Agent —— compose 插值通道（不含密钥）'])

  const up = await compose(['up', '-d', '--force-recreate', '--remove-orphans'], 600000)
  if (up.code !== 0) {
    await rollbackTag(oldTag)
    throw new Error(`重建失败：${up.stderr.slice(-400)}`)
  }

  await new Promise((r) => setTimeout(r, 3000))
  const container = await inspectContainer()
  if (!container.running || !(await rendererPresent())) {
    await rollbackTag(oldTag)
    throw new Error(`镜像 ${tag} 不含可用的 Desktop 渲染层，已回滚到 ${oldTag}`)
  }

  logLine('INFO', `已更新到 ${tag}`)
  return { ok: true, tag }
}

async function rollbackTag(tag) {
  const composeEnv = await readEnv(COMPOSE_ENV)
  composeEnv.set('HERMES_DOCKER_IMAGE_TAG', tag)
  await writeEnv(COMPOSE_ENV, composeEnv, ['Hermes Agent —— compose 插值通道（不含密钥）'])
  await compose(['up', '-d', '--force-recreate', '--remove-orphans'], 600000)
}

async function doRepair() {
  if (getRuntimeMode() === 'native') {
    await nativeStop()
    await nativeStart()
    if (!(await rendererPresent())) throw new Error('原生运行时缺少 Desktop 渲染层')
    setLastMessage('原生运行时已修复')
    return { ok: true }
  }
  const down = await compose(['down', '--remove-orphans'], 180000)
  const up = await compose(['up', '-d', '--remove-orphans'], 600000)
  if (up.code !== 0) throw new Error((up.stderr || up.stdout || '修复失败').slice(-500))
  await new Promise((r) => setTimeout(r, 3000))
  const container = await inspectContainer()
  if (!container.running || !(await rendererPresent())) throw new Error('修复后容器未能正常运行')
  setLastMessage('修复完成，容器已重建')
  logLine('INFO', '已执行修复（重建容器）')
  return { ok: true }
}

async function doRecreate() {
  const up = await compose(['up', '-d', '--force-recreate', '--remove-orphans'], 600000)
  if (up.code !== 0) throw new Error(`重建失败：${up.stderr.slice(-400)}`)
  return { ok: true }
}

// ── Nous Portal 登录（设备码流程）────────────────────────────────────────
let accountJob = { state: 'idle', code: '', url: '', message: '', log: [], error: '' }
let accountChild = null

function accountStatusText() {
  return hermesRun(['auth', 'status', 'nous'], 30000)
}

async function getAccount() {
  const status = await accountStatusText()
  const text = `${status.stdout}${status.stderr}`
    .split('\n')
    .filter((line) => line && !/^⚠|install out of sync/i.test(line.trim()))
    .join('\n')
    .trim()
  const connected = /logged in/i.test(text) && !/logged out/i.test(text)
  let credentials = []
  try {
    const list = await hermesRun(['auth', 'list'], 30000)
    credentials = `${list.stdout}${list.stderr}`
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^⚠|installed|├|└|┌|│|─/i.test(l))
      .slice(0, 12)
  } catch { /* 忽略 */ }
  return {
    installed: isInstalled(),
    connected,
    provider: 'nous',
    status: text,
    credentials,
    login: { state: accountJob.state, code: accountJob.code, url: accountJob.url, message: accountJob.message, error: accountJob.error }
  }
}

async function startAccountLogin() {
  if (!isInstalled()) throw badRequest('Hermes 尚未安装')
  if (accountJob.state === 'running') throw new Error('登录流程已在进行')
  accountJob = { state: 'running', code: '', url: '', message: '正在向 Nous Portal 申请设备码…', log: [], error: '' }
  accountChild = spawnHermes(['auth', 'upgrade', '--no-browser', '--timeout', '900'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let buffer = ''
  const handle = (chunk) => {
    buffer += chunk.toString()
    const parts = buffer.split('\n')
    buffer = parts.pop() || ''
    for (const line of parts) {
      const text = line.replace(/\r/g, '').trimEnd()
      if (!text) continue
      accountJob.log.push(text)
      if (accountJob.log.length > 200) accountJob.log.shift()
      const codeMatch = text.match(/user_code=([A-Z0-9-]+)/i) || text.match(/enter code:\s*([A-Z0-9-]+)/i)
      if (codeMatch) accountJob.code = codeMatch[1]
      const urlMatch = text.match(/Open:\s*(https?:\/\/\S+)/i)
      if (urlMatch) accountJob.url = urlMatch[1]
      if (/Waiting for sign-in/i.test(text)) accountJob.message = '已生成设备码，等待你在浏览器中确认'
      if (/success|signed in|logged in/i.test(text)) accountJob.message = '授权成功，正在保存凭据'
    }
  }
  accountChild.stdout.on('data', handle)
  accountChild.stderr.on('data', handle)
  accountChild.on('close', (code) => {
    accountChild = null
    if (accountJob.state !== 'running') return
    if (code === 0) {
      accountJob.state = 'done'
      accountJob.message = '已登录 Nous Portal'
      logLine('INFO', 'Nous Portal 登录成功')
    } else {
      accountJob.state = 'error'
      accountJob.error = accountJob.log.slice(-3).join(' ') || `登录进程退出（${code}）`
    }
  })
  accountChild.on('error', (err) => {
    accountChild = null
    accountJob.state = 'error'
    accountJob.error = err.message
  })
  return { ok: true, state: 'running' }
}

function cancelAccountLogin() {
  if (accountChild) {
    try { accountChild.kill('SIGTERM') } catch { /* 忽略 */ }
    accountChild = null
  }
  if (accountJob.state === 'running') {
    accountJob.state = 'cancelled'
    accountJob.message = '已取消登录'
  }
  return { ok: true }
}

async function getAccountPool() {
  if (!isInstalled()) return { installed: false, providers: [] }
  const r = await hermesRun(['auth', 'list'], 30000)
  const text = `${r.stdout}${r.stderr}`
  const providers = []
  let current = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r/g, '')
    const header = line.match(/^(\S+)\s+\((\d+)\s+credentials?\):\s*$/)
    if (header) {
      current = { provider: header[1], count: Number(header[2]), items: [] }
      providers.push(current)
      continue
    }
    if (!current) continue
    const item = line.match(/^\s*#(\d+)\s+(.+?)\s{2,}(\S+)\s+id=(\S+)\s+priority=(\d+)(.*)$/)
    if (item) {
      current.items.push({
        index: Number(item[1]),
        label: item[2].trim(),
        type: item[3],
        id: item[4],
        priority: Number(item[5]),
        active: /←/.test(item[6])
      })
    }
  }
  return { installed: true, providers }
}

async function switchAccountCredential(provider, target) {
  const p = cleanValue(provider)
  const t = cleanValue(target)
  if (!p || !t) throw badRequest('缺少服务商或凭据标识')
  const r = await hermesRun(['auth', 'priority', p, t, '0'], 60000)
  const out = `${r.stdout}${r.stderr}`.trim()
  if (r.code !== 0) throw new Error(out.slice(-400) || '切换失败')
  logLine('INFO', `已切换 ${p} 的凭据：${t}`)
  return { ok: true, output: out.slice(-800) }
}

async function removeAccountCredential(provider, target) {
  const p = cleanValue(provider)
  const t = cleanValue(target)
  if (!p || !t) throw badRequest('缺少服务商或凭据标识')
  const r = await hermesRun(['auth', 'remove', p, t], 60000)
  const out = `${r.stdout}${r.stderr}`.trim()
  if (r.code !== 0) throw new Error(out.slice(-400) || '移除失败')
  logLine('INFO', `已移除 ${p} 的凭据：${t}`)
  return { ok: true, output: out.slice(-800) }
}

async function logoutAccount() {
  if (!isInstalled()) throw badRequest('Hermes 尚未安装')
  const r = await hermesRun(['auth', 'logout', 'nous'], 60000)
  if (r.code !== 0) throw new Error(`${r.stdout}${r.stderr}`.trim().slice(-400) || '登出失败')
  logLine('INFO', '已登出 Nous Portal')
  return { ok: true }
}

// ── 环境变量（data/.env）─────────────────────────────────────────────────
function isSecretKey(key) {
  return /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)
}

function maskSecret(value) {
  const text = String(value || '')
  if (!text) return ''
  if (text.length <= 8) return '••••••••'
  return `${text.slice(0, 4)}••••${text.slice(-4)}`
}

async function getEnvVars() {
  const env = await readEnv(path.join(DATA_DIR, '.env'))
  const items = [...env].map(([key, value]) => ({
    key,
    value,
    secret: isSecretKey(key)
  }))
  return { installed: isInstalled(), items }
}

async function saveEnvVars(body) {
  if (!isInstalled()) throw badRequest('Hermes 尚未安装')
  const incoming = Array.isArray(body.items) ? body.items : []
  if (incoming.length > 200) throw badRequest('环境变量过多')
  const current = await readEnv(path.join(DATA_DIR, '.env'))
  const next = new Map()
  for (const item of incoming) {
    const key = cleanValue(item.key)
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw badRequest(`变量名不合法：${key}`)
    if (next.has(key)) throw badRequest(`变量名重复：${key}`)
    const raw = String(item.value ?? '')
    if (raw.includes('\n') || raw.includes('\r')) throw badRequest(`变量值不能换行：${key}`)
    next.set(key, raw)
  }
  const lines = [...next].map(([k, v]) => `${k}=${v}`)
  const file = path.join(DATA_DIR, '.env')
  const tmp = `${file}.tmp.${process.pid}`
  await fsp.writeFile(tmp, `${lines.join('\n')}\n`, { mode: 0o600 })
  await fsp.rename(tmp, file)
  await fsp.chmod(file, 0o600)
  await compose(['restart'], 180000)
  logLine('INFO', `已保存 ${next.size} 项环境变量`)
  return { ok: true, count: next.size }
}

// ── 快照任务（进度 / 取消）──────────────────────────────────────────────
let snapJob = { state: 'idle', kind: '', phase: '', percent: 0, message: '', id: '', error: '' }
let snapChild = null
let snapTimer = null

function snapshotBusy() {
  if (snapJob.state === 'running') throw new Error('快照任务进行中，请稍候')
}

function setSnapJob(patch) {
  Object.assign(snapJob, patch)
}

async function startSnapshotCreate(name, note) {
  if (!isInstalled()) throw badRequest('Hermes 尚未安装，无法创建快照')
  if (snapJob.state === 'running') throw new Error('快照任务进行中')
  const id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  snapJob = { state: 'running', kind: 'create', phase: 'stop', percent: 3, message: '停止容器…', id, error: '' }
  runSnapshotCreate(id, name, note).catch((err) => {
    setSnapJob({ state: 'error', error: err.message })
    logLine('ERROR', `快照失败：${err.message}`)
  })
  return { ok: true, id }
}

async function countFiles(dir) {
  const r = await run('find', [dir, '-type', 'f'], { timeout: 120000 })
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean).length : 0
}

async function runSnapshotCreate(id, name, note) {
  await fsp.mkdir(SNAPSHOT_DIR, { recursive: true })
  const file = path.join(SNAPSHOT_DIR, `${id}.tar.gz`)
  const partial = `${file}.partial`
  await compose(['stop'], 120000)
  setSnapJob({ phase: 'archive', percent: 8, message: '统计文件…' })
  const total = await countFiles(DATA_DIR)
  const args = ['-czvf', partial, '-C', DATA_DIR]
  for (const ex of SNAPSHOT_EXCLUDES) args.push(`--exclude=${ex}`)
  args.push('.')

  let done = 0
  let stderr = ''
  await new Promise((resolve, reject) => {
    snapChild = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    snapChild.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      done += chunk.toString().split('\n').filter(Boolean).length
      const pct = total ? Math.min(90, 8 + (done / total) * 82) : 50
      setSnapJob({ percent: Math.round(pct), message: `打包中 ${done}/${total} 个文件` })
    })
    snapChild.on('close', (code) => {
      snapChild = null
      if (snapJob.state === 'cancelled') return resolve()
      code === 0 ? resolve() : reject(new Error(stderr.slice(-400) || `tar 退出 ${code}`))
    })
    snapChild.on('error', reject)
  })
  if (snapJob.state === 'cancelled') {
    await fsp.rm(partial, { force: true })
    await compose(['up', '-d'], 600000)
    setSnapJob({ percent: 0, message: '已取消' })
    return
  }
  await fsp.rename(partial, file)
  const st = await fsp.stat(file)
  const meta = { id, name: name || '', note: note || '', size: st.size, createdAt: new Date().toISOString() }
  await fsp.writeFile(path.join(SNAPSHOT_DIR, `${id}.json`), JSON.stringify(meta), { mode: 0o600 })
  setSnapJob({ phase: 'start', percent: 94, message: '启动容器…' })
  await compose(['up', '-d'], 600000)
  setSnapJob({ state: 'done', percent: 100, message: `快照完成（${Math.round(st.size / 1024)} KB）` })
  setLastMessage(`快照已完成（${Math.round(st.size / 1024)} KB）`)
  logLine('INFO', `创建快照 ${id}（${Math.round(st.size / 1024)} KB）`)
}

async function startSnapshotRestore(id) {
  if (!isInstalled()) throw badRequest('Hermes 尚未安装')
  if (!/^[0-9]{8,20}$/.test(id)) throw badRequest('快照标识不合法')
  await fsp.access(path.join(SNAPSHOT_DIR, `${id}.tar.gz`))
  if (snapJob.state === 'running') throw new Error('快照任务进行中')
  snapJob = { state: 'running', kind: 'restore', phase: 'safety', percent: 3, message: '创建安全快照…', id, error: '' }
  runSnapshotRestore(id).catch((err) => {
    setSnapJob({ state: 'error', error: err.message })
    logLine('ERROR', `恢复失败：${err.message}`)
  })
  return { ok: true, id }
}

async function runSnapshotRestore(id) {
  const safetyId = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  const realData = await fsp.realpath(DATA_DIR).catch(() => DATA_DIR)
  const parent = path.dirname(realData)
  const base = path.basename(realData)
  const stamp = `${Date.now()}`
  const tempDir = path.join(parent, `.${base}.restore-${stamp}`)
  const backupDir = path.join(parent, `.${base}.backup-${stamp}`)

  try {
  setSnapJob({ percent: 6, message: '备份当前数据…' })
  await createSnapshot('恢复前自动备份', `restore ${id}`)
  setSnapJob({ phase: 'stop', percent: 30, message: '停止服务…' })
  await compose(['stop'], 120000)
  if (snapJob.state === 'cancelled') {
    await compose(['up', '-d'], 600000).catch(() => {})
    return
  }

  setSnapJob({ phase: 'extract', percent: 45, message: '解包到临时目录…' })
  await fsp.rm(tempDir, { recursive: true, force: true })
  await fsp.mkdir(tempDir, { recursive: true })
  const code = await new Promise((resolve, reject) => {
    snapChild = spawn('tar', ['-xzf', path.join(SNAPSHOT_DIR, `${id}.tar.gz`), '-C', tempDir], { stdio: ['ignore', 'ignore', 'pipe'] })
    let errText = ''
    snapChild.stderr.on('data', (chunk) => { errText += chunk.toString() })
    snapChild.on('close', (c) => {
      snapChild = null
      if (snapJob.state === 'cancelled') return resolve(-1)
      c === 0 ? resolve(0) : reject(new Error(errText.slice(-400) || `tar 退出 ${c}`))
    })
    snapChild.on('error', (err) => { snapChild = null; reject(err) })
  })
  if (code === -1 || snapJob.state === 'cancelled') {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    await compose(['up', '-d'], 600000).catch(() => {})
    return
  }
  if (!fs.existsSync(path.join(tempDir, 'config.yaml')) && !fs.existsSync(path.join(tempDir, 'state.db'))) {
    throw new Error('快照内容不完整（缺少 config.yaml / state.db），已中止恢复')
  }

  setSnapJob({ phase: 'swap', percent: 85, message: '替换数据目录…' })
  await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {})
  await fsp.rename(realData, backupDir)
  try {
    await fsp.rename(tempDir, realData)
  } catch (err) {
    await fsp.rename(backupDir, realData).catch(() => {})
    throw err
  }
  setSnapJob({ phase: 'start', percent: 94, message: '启动服务…' })
  await compose(['up', '-d'], 600000)
  await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {})
  sessionsCache.clear()
  setSnapJob({ state: 'done', percent: 100, message: '恢复完成' })
  setLastMessage('快照已恢复')
  logLine('INFO', `已恢复快照 ${id}（安全快照 ${safetyId}）`)
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

function cancelSnapshotJob() {
  if (snapJob.state !== 'running') return { ok: true }
  if (snapJob.kind === 'restore' && ['swap', 'start'].includes(snapJob.phase)) {
    return { ok: false, error: '恢复已进入替换阶段，无法取消' }
  }
  setSnapJob({ state: 'cancelled', message: '正在取消…' })
  if (snapTimer) { clearInterval(snapTimer); snapTimer = null }
  if (snapChild) {
    try { snapChild.kill('SIGTERM') } catch { /* 忽略 */ }
  }
  compose(['up', '-d'], 600000).catch(() => {})
  return { ok: true }
}

// ── 设置保存 ─────────────────────────────────────────────────────────────
const PROVIDER_KEYS = {
  openrouter: 'OPENROUTER',
  openai: 'OPENAI',
  anthropic: 'ANTHROPIC',
  deepseek: 'DEEPSEEK',
  kimi: 'KIMI',
  glm: 'GLM',
  custom: 'OPENAI'
}

function badRequest(message) { const e = new Error(message); e.statusCode = 400; return e }

async function saveSettings(body) {
  if (!isInstalled()) throw badRequest('Hermes 尚未安装，请先完成安装')
  const current = await readRuntimeConfig()
  const username = cleanValue(body.username || current.username)
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(username)) throw badRequest('用户名只能包含字母、数字、下划线、点或连字符')

  const apiPort = Number(body.apiPort || current.apiPort)
  if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535) throw badRequest('API 端口需在 1024-65535 之间')
  if (apiPort === current.port) throw badRequest('API 端口不能与 Desktop 端口相同')

  const memoryMb = Number(body.memoryMb || current.memoryMb)
  if (!Number.isInteger(memoryMb) || memoryMb < 512 || memoryMb > 16384) throw badRequest('内存上限需在 512-16384 MB 之间')

  const provider = cleanValue(body.provider || current.provider)
  if (!PROVIDER_KEYS[provider]) throw badRequest('未知的模型服务商')

  const imageTag = cleanValue(body.imageTag || current.imageTag)
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(imageTag)) throw badRequest('镜像标签格式不正确')
  if (/^(latest|latest-.*)$/.test(imageTag)) throw badRequest('latest 系列镜像不含 Desktop 渲染层，请使用 main-desktop')

  const env = await readEnv(CONFIG_ENV)
  env.set('HERMES_DASHBOARD_BASIC_AUTH_USERNAME', username)
  env.set('API_SERVER_ENABLED', body.apiEnabled ? 'true' : 'false')
  env.set('API_SERVER_PORT', String(apiPort))
  env.set('HERMES_MODEL', cleanValue(body.model || ''))
  env.set('HERMES_PROVIDER', provider)

  for (const key of [...env.keys()]) {
    if (key.endsWith('_BASE_URL') && key !== 'HERMES_BASE_URL') env.delete(key)
  }
  const baseUrl = cleanValue(body.baseUrl || '')
  if (baseUrl && !/^https?:\/\/[^\s]+$/.test(baseUrl)) throw badRequest('接口地址需以 http:// 或 https:// 开头')
  if (baseUrl) env.set(`${PROVIDER_KEYS[provider]}_BASE_URL`, baseUrl)

  if (body.apiKey) {
    const key = cleanValue(body.apiKey)
    if (!/^[A-Za-z0-9._-]{4,128}$/.test(key)) throw badRequest('API 密钥格式不正确')
    env.set('API_SERVER_KEY_HINT', key.slice(0, 4))
    await writeDataSecret('API_SERVER_KEY', key)
  }

  const modelKey = cleanValue(body.modelKey || '')
  if (modelKey) {
    if (!/^[^\s]{4,512}$/.test(modelKey)) throw badRequest('模型 Key 格式不正确')
    const secretName = provider === 'custom' ? 'OPENAI_API_KEY' : `${PROVIDER_KEYS[provider]}_API_KEY`
    await writeDataSecret(secretName, modelKey)
  }

  await writeEnv(CONFIG_ENV, env, [
    'Hermes Agent 运行时环境变量',
    '由管理端写入（cmd/install_callback 提供初始值）',
    '本文件含密钥，权限 0600，请勿外传',
    '格式：KEY=VALUE（compose env_file format: raw），值不要加引号'
  ])

  const composeEnv = await readEnv(COMPOSE_ENV)
  composeEnv.set('HERMES_DOCKER_MEMORY', String(memoryMb))
  composeEnv.set('HERMES_DOCKER_IMAGE_REPO', IMAGE_REPO)
  composeEnv.set('HERMES_DOCKER_CONTAINER', CONTAINER_NAME)
  composeEnv.set('HERMES_DATA_HOST', DATA_DIR)
  composeEnv.set('HERMES_WORKSPACE_HOST', WORKSPACE_DIR)
  await writeEnv(COMPOSE_ENV, composeEnv, ['Hermes Agent —— compose 插值通道（不含密钥）'])

  const imageChanged = imageTag !== current.imageTag
  logLine('INFO', `设置已保存（用户名 ${username} / API ${body.apiEnabled ? '开' : '关'}:${apiPort} / 内存 ${memoryMb}MB / 镜像 ${imageTag}）`)
  return { ok: true, restartNeeded: true, imageChanged, imageTag }
}

async function writeDataSecret(key, value) {
  const file = path.join(DATA_DIR, '.env')
  const env = await readEnv(file)
  env.set(key, value)
  const lines = [...env].map(([k, v]) => `${k}=${v}`)
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const tmp = `${file}.tmp.${process.pid}`
  await fsp.writeFile(tmp, `${lines.join('\n')}\n`, { mode: 0o600 })
  await fsp.rename(tmp, file)
  await fsp.chmod(file, 0o600)
}

async function resetPassword(body) {
  const password = String(body.password || '')
  if (password.length < 8) throw badRequest('密码至少 8 位')
  const hash = hashPassword(password)
  const env = await readEnv(CONFIG_ENV)
  env.set('HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH', hash)
  if (env.has('HERMES_DASHBOARD_BASIC_AUTH_PASSWORD')) env.delete('HERMES_DASHBOARD_BASIC_AUTH_PASSWORD')
  await writeEnv(CONFIG_ENV, env)
  await updateConfigYamlPassword(hash)

  // 同步访问信息里的口令，保持唯一可查
  try {
    const info = await readAccessInfo()
    if (info) {
      const next = info.replace(/^密码\s*:.*$/m, `密码     : ${password}`)
      await fsp.writeFile(ACCESS_INFO, next, { mode: 0o600 })
    }
  } catch { /* 访问信息不存在时忽略 */ }

  logLine('INFO', '已重置 Desktop 登录口令')
  return { ok: true, restartNeeded: true }
}

async function updateConfigYamlPassword(hash) {
  const file = path.join(DATA_DIR, 'config.yaml')
  let text = ''
  try { text = await fsp.readFile(file, 'utf8') } catch { return }
  if (/^\s*password_hash:/m.test(text)) {
    text = text.replace(/^(\s*password_hash:\s*).*$/m, (match, prefix) => `${prefix}"${hash}"`)
  } else if (/^dashboard:/m.test(text)) {
    text = text.replace(/^dashboard:$/m, `dashboard:\n  basic_auth:\n    password_hash: "${hash}"`)
  } else {
    text += `\ndashboard:\n  basic_auth:\n    password_hash: "${hash}"\n`
  }
  await fsp.chmod(file, 0o600).catch(() => {})
  await fsp.writeFile(file, text)
}

// ── 更新检查 ─────────────────────────────────────────────────────────────
const GITHUB_REPO = 'NousResearch/hermes-agent'
const VERSIONS_CACHE = path.join(VAR_DIR, 'versions-cache.json')
let versionsMem = null

function parseSemver(value) {
  const m = String(value).match(/v?(\d+)\.(\d+)\.(\d+)/)
  return m ? m.slice(1).map(Number) : null
}

function cmpSemver(a, b) {
  const A = parseSemver(a)
  const B = parseSemver(b)
  if (!A || !B) return 0
  for (let i = 0; i < 3; i += 1) {
    if (A[i] !== B[i]) return A[i] - B[i]
  }
  return 0
}

async function fetchReleases() {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`, {
    headers: { 'User-Agent': 'hermes-agent-fnos', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(12000)
  })
  if (!res.ok) throw new Error(`GitHub Releases 请求失败（HTTP ${res.status}）`)
  return res.json()
}

async function getOfficialVersions(force = false) {
  const now = Date.now()
  let base = null

  if (!force && versionsMem && now - versionsMem.ts < 10 * 60 * 1000) {
    base = versionsMem.data
  } else if (!force) {
    try {
      const cached = JSON.parse(await fsp.readFile(VERSIONS_CACHE, 'utf8'))
      if (now - cached.ts < 10 * 60 * 1000) {
        versionsMem = cached
        base = cached.data
      }
    } catch { /* 无缓存 */ }
  }

  if (!base) {
    const releases = await fetchReleases()
    const stables = releases
      .filter((r) => !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name))
      .slice(0, 8)
    // 只列官方稳定版本，不做逐个镜像探测（探测一次要数秒，8 个版本会把接口拖到一分钟）。
    // 版本标签统一映射到 -desktop 变体；可用性在安装/更新时由拉取与渲染层校验确认。
    const versions = stables.map((r) => ({
      version: r.tag_name,
      tag: `${r.tag_name}-desktop`,
      published: (r.published_at || '').slice(0, 10)
    }))
    base = { versions, latest: versions[0] || null, checkedAt: new Date().toISOString() }
    versionsMem = { ts: now, data: base }
    try { await fsp.writeFile(VERSIONS_CACHE, JSON.stringify({ ts: now, data: base }), { mode: 0o600 }) } catch { /* 忽略 */ }
  }

  // installed 与 updateAvailable 每次按当前状态重算，避免缓存把「刚安装」显示成「未安装」
  const installedTag = (await readEnv(COMPOSE_ENV)).get('HERMES_DOCKER_IMAGE_TAG') || ''
  let installedVersion = (installedTag.match(/v\d+\.\d+\.\d+/) || [''])[0]
  if (isInstalled()) {
    const v = await readAppVersion()
    if (v.short) installedVersion = (v.short.match(/v\d+\.\d+\.\d+/) || [installedVersion])[0]
  }
  const latest = base.latest || null
  const updateAvailable = Boolean(installedVersion && latest && cmpSemver(installedVersion, latest.version) < 0)

  return {
    versions: base.versions,
    latest,
    installed: { version: installedVersion, tag: installedTag },
    current_version: installedVersion,
    recommended_version: latest ? latest.version : '',
    updateAvailable,
    checkedAt: base.checkedAt
  }
}


// ── HTTP 处理 ────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname
  if (!path.extname(rel)) rel = '/index.html'
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''))
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' })
  try {
    const data = await fsp.readFile(file)
    const ext = path.extname(file).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
    })
    res.end(data)
  } catch {
    // SPA 回退
    try {
      const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'))
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
      res.end(html)
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('管理界面尚未构建：缺少 app/manager/public/index.html')
    }
  }
}

function requestHost(req) {
  const host = String(req.headers.host || '')
  return host.split(':')[0] || '127.0.0.1'
}

async function handleApi(req, res, pathname, url) {
  const method = req.method || 'GET'

  if (method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, ts: nowSec() })
  }

  if (method === 'GET' && pathname === '/api/status') {
    return json(res, 200, await buildStatus(requestHost(req)))
  }

  if (method === 'POST' && pathname === '/api/action') {
    const body = await readBody(req)
    const action = cleanValue(body.action)
    if (snapJob.state === 'running') return json(res, 409, { error: '快照任务进行中，请稍候' })
    const handlers = { start: doStart, stop: doStop, restart: doRestart, upgrade: () => doUpgrade(body), recreate: doRecreate, repair: doRepair }
    if (!handlers[action]) return json(res, 400, { error: '未知操作' })
    try {
      const result = await withLock(handlers[action])
      return json(res, 200, { ok: true, action, result })
    } catch (err) {
      logLine('ERROR', `${action} 失败：${err.message}`)
      return json(res, 500, { error: err.message })
    }
  }

  if (method === 'GET' && pathname === '/api/install/status') {
    return json(res, 200, {
      state: installJob.state,
      step: installJob.step,
      percent: installJob.percent,
      message: installJob.message,
      error: installJob.error,
      log: installJob.log.slice(-120),
      installed: isInstalled()
    })
  }

  if (method === 'GET' && pathname === '/api/runtime') {
    return json(res, 200, {
      mode: getRuntimeMode(),
      native: {
        installed: fs.existsSync(nativeBin()),
        running: await nativeRunning(),
        tag: runtimeCache?.tag || '',
        version: runtimeCache?.version || ''
      }
    })
  }

  if (method === 'POST' && pathname === '/api/runtime') {
    try {
      const body = await readBody(req)
      const mode = cleanValue(body.mode)
      if (!['docker', 'native'].includes(mode)) throw badRequest('未知运行时')
      if (mode === getRuntimeMode()) return json(res, 200, { ok: true, mode, changed: false })
      if (mode === 'native' && !fs.existsSync(nativeBin())) throw badRequest('原生运行时尚未安装')

      const result = await withLock(async () => {
        let migrated = false
        let warning = ''
        if (mode === 'native') {
          if (await pathHasData(DATA_DIR_DEFAULT)) {
            try {
              await createSnapshot('切换运行时时自动备份', 'before native switch')
            } catch (err) {
              warning = `自动备份失败：${err.message}`
              logLine('WARN', warning)
            }
          }
          await run('docker', ['stop', CONTAINER_NAME], { timeout: 120000 }).catch(() => {})
          try {
            const move = await migrateDataDir(DATA_DIR_DEFAULT, NATIVE_DATA_DIR, '切换原生')
            migrated = move.migrated
            if (!move.migrated && move.reason) warning = [warning, move.reason].filter(Boolean).join('；')
          } catch (err) {
            await compose(['up', '-d', '--remove-orphans'], 600000).catch(() => {})
            throw err
          }
          const tag = await currentTag()
          await setRuntimeState({
            mode: 'native',
            tag: runtimeCache?.tag || tag,
            version: runtimeCache?.version || tag.replace(/-desktop$/, ''),
            stopped: false
          })
          await nativeStart()
        } else {
          if (await pathHasData(NATIVE_DATA_DIR)) {
            try {
              await createSnapshot('切换运行时时自动备份', 'before docker switch')
            } catch (err) {
              warning = `自动备份失败：${err.message}`
              logLine('WARN', warning)
            }
          }
          await nativeStop().catch(() => {})
          try {
            const move = await migrateDataDir(NATIVE_DATA_DIR, DATA_DIR_DEFAULT, '切换 Docker')
            migrated = move.migrated
            if (!move.migrated && move.reason) warning = [warning, move.reason].filter(Boolean).join('；')
          } catch (err) {
            await nativeStart().catch(() => {})
            throw err
          }
          await setRuntimeState({ mode: 'docker', stopped: false })
          const up = await compose(['up', '-d', '--remove-orphans'], 600000)
          if (up.code !== 0) throw new Error((up.stderr || 'Docker 启动失败').slice(-400))
        }
        return { migrated, warning }
      })
      return json(res, 200, { ok: true, mode, changed: true, ...result })
    } catch (err) {
      return json(res, err.statusCode || 500, { error: err.message })
    }
  }

  if (method === 'POST' && pathname === '/api/install') {
    try {
      const body = await readBody(req)
      return json(res, 200, await startInstall(body))
    } catch (err) {
      return json(res, err.statusCode || 500, { error: err.message })
    }
  }

  if (method === 'POST' && pathname === '/api/uninstall') {
    try {
      const body = await readBody(req)
      const result = await withLock(() => doUninstall(body))
      return json(res, 200, result)
    } catch (err) {
      return json(res, 500, { error: err.message })
    }
  }

  if (method === 'GET' && pathname === '/api/settings') {
    const cfg = await readRuntimeConfig()
    return json(res, 200, { ...cfg, installed: isInstalled() })
  }

  if (method === 'POST' && pathname === '/api/settings') {
    try {
      const body = await readBody(req)
      const result = await saveSettings(body)
      return json(res, 200, result)
    } catch (err) {
      return json(res, err.statusCode || 500, { error: err.message })
    }
  }

  if (method === 'POST' && pathname === '/api/password') {
    try {
      const body = await readBody(req)
      const result = await resetPassword(body)
      return json(res, 200, result)
    } catch (err) {
      return json(res, err.statusCode || 500, { error: err.message })
    }
  }

  if (method === 'GET' && pathname === '/api/logs') {
    const source = url.searchParams.get('source') === 'app' ? 'app' : 'container'
    const tail = Math.min(Math.max(Number(url.searchParams.get('tail') || 300), 20), 2000)
    if (source === 'app') {
      try {
        const text = await fsp.readFile(APP_LOG, 'utf8')
        const lines = text.split(/\r?\n/).filter(Boolean).slice(-tail)
        return json(res, 200, { source, lines })
      } catch {
        return json(res, 200, { source, lines: [] })
      }
    }
    if (getRuntimeMode() === 'native') {
      const text = fs.existsSync(NATIVE_LOG) ? fs.readFileSync(NATIVE_LOG, 'utf8') : ''
      const lines = text.split(/\r?\n/).filter(Boolean).slice(-tail)
      return json(res, 200, { source, lines })
    }
    const r = await run('docker', ['logs', '--tail', String(tail), '--timestamps', CONTAINER_NAME], { timeout: 30000 })
    if (r.code !== 0) return json(res, 200, { source, lines: [] })
    const text = `${r.stdout}${r.stderr}`
    const lines = text.split(/\r?\n/).filter(Boolean).slice(-tail)
    return json(res, 200, { source, lines })
  }

  if (method === 'GET' && pathname === '/api/logs/download') {
    const source = url.searchParams.get('source') === 'app' ? 'app' : 'container'
    const name = `hermes-${source}-${new Date().toISOString().slice(0, 10)}.log`
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`
    })
    if (source === 'app') {
      try {
        res.end(await fsp.readFile(APP_LOG))
      } catch {
        res.end('')
      }
      return
    }
    if (getRuntimeMode() === 'native') {
      try { res.end(fs.readFileSync(NATIVE_LOG)) } catch { res.end('') }
      return
    }
    const child = spawn('docker', ['logs', '--timestamps', CONTAINER_NAME])
    child.stdout.pipe(res)
    child.stderr.pipe(res)
    child.on('close', () => res.end())
    return
  }

  if (method === 'DELETE' && pathname === '/api/logs') {
    try { await fsp.writeFile(APP_LOG, '') } catch { /* 忽略 */ }
    return json(res, 200, { ok: true })
  }

  if (method === 'GET' && pathname === '/api/data') {
    const [dataSize, workspaceSize, accessInfo] = await Promise.all([
      dirSize(DATA_DIR),
      dirSize(WORKSPACE_DIR),
      readAccessInfo()
    ])
    const cfg = await readRuntimeConfig()
    return json(res, 200, {
      installed: isInstalled(),
      dataDir: DATA_DIR,
      workspaceDir: WORKSPACE_DIR,
      accessInfoPath: ACCESS_INFO,
      accessInfo,
      webui: `${PREFIX}/webapp/`,
      direct: `http://${requestHost(req)}:${cfg.port}/`,
      dataSize,
      workspaceSize,
      apiKey: cfg.apiKey,
      username: cfg.username,
      port: cfg.port
    })
  }

  if (method === 'GET' && pathname === '/api/app-settings') {
    return json(res, 200, { installed: isInstalled(), settings: await getAppSettings(), webappPort: readWebappPort() })
  }

  if (method === 'POST' && pathname === '/api/app-settings') {
    try {
      const body = await readBody(req)
      return json(res, 200, await saveAppSettings(body))
    } catch (err) {
      return json(res, err.statusCode || 500, { error: err.message })
    }
  }

  if (method === 'GET' && pathname === '/api/account') {
    return json(res, 200, await getAccount())
  }

  if (method === 'POST' && pathname === '/api/account/login') {
    try {
      return json(res, 200, await startAccountLogin())
    } catch (err) {
      return json(res, err.statusCode || 500, { error: err.message })
    }
  }

  if (method === 'POST' && pathname === '/api/account/login/cancel') {
    return json(res, 200, cancelAccountLogin())
  }

  if (method === 'GET' && pathname === '/api/account/pool') {
    return json(res, 200, await getAccountPool())
  }

  if (method === 'POST' && pathname === '/api/account/pool/switch') {
    try {
      const body = await readBody(req)
      return json(res, 200, await switchAccountCredential(body.provider, body.target))
    } catch (err) {
      return json(res, err.statusCode || 500, { error: err.message })
    }
  }

  if (method === 'POST' && pathname === '/api/account/pool/remove') {
    try {
      const body = await readBody(req)
      return json(res, 200, await removeAccountCredential(body.provider, body.target))
    } catch (err) {
      return json(res, err.statusCode || 500, { error: err.message })
    }
  }

  if (method === 'POST' && pathname === '/api/account/logout') {
    try {
      return json(res, 200, await logoutAccount())
    } catch (err) {
      return json(res, 500, { error: err.message })
    }
  }

  if (method === 'GET' && pathname === '/api/env-vars') {
    return json(res, 200, await getEnvVars())
  }

  if (method === 'POST' && pathname === '/api/env-vars') {
    try {
      const body = await readBody(req)
      return json(res, 200, await saveEnvVars(body))
    } catch (err) {
      return json(res, err.statusCode || 500, { error: err.message })
    }
  }

  if (method === 'GET' && pathname === '/api/workspace') {
    return json(res, 200, await getWorkspace())
  }

  if (method === 'GET' && pathname === '/api/auth') {
    return json(res, 200, await getAuth())
  }

  if (method === 'POST' && pathname === '/api/auth/key') {
    try {
      if (!isInstalled()) throw badRequest('Hermes 尚未安装')
      const body = await readBody(req)
      const provider = cleanValue(body.provider)
      const secretName = {
        openrouter: 'OPENROUTER_API_KEY',
        openai: 'OPENAI_API_KEY',
        anthropic: 'ANTHROPIC_API_KEY',
        deepseek: 'DEEPSEEK_API_KEY',
        kimi: 'KIMI_API_KEY',
        glm: 'GLM_API_KEY'
      }[provider]
      if (!secretName) throw badRequest('未知的服务商')
      const key = cleanValue(body.key)
      if (!/^[^\s]{4,512}$/.test(key)) throw badRequest('API Key 格式不正确')
      await writeDataSecret(secretName, key)
      logLine('INFO', `已更新 ${provider} 的 API Key`)
      return json(res, 200, { ok: true })
    } catch (err) {
      return json(res, err.statusCode || 500, { error: err.message })
    }
  }

  if (method === 'GET' && pathname === '/api/skills') {
    return json(res, 200, await getSkills())
  }

  if (method === 'POST' && pathname === '/api/skills/toggle') {
    try {
      const body = await readBody(req)
      const result = await withLock(() => setSkillEnabled(cleanValue(body.name), Boolean(body.enabled)))
      return json(res, 200, result)
    } catch (err) {
      return json(res, err.statusCode || 500, { error: err.message })
    }
  }

  if (method === 'POST' && pathname === '/api/skills/preview') {
    try {
      const body = await readBody(req)
      return json(res, 200, await previewSkill(body.identifier))
    } catch (err) {
      return json(res, 500, { error: err.message })
    }
  }

  if (method === 'POST' && pathname === '/api/skills/audit') {
    try {
      const body = await readBody(req)
      return json(res, 200, await auditSkills(body.name))
    } catch (err) {
      return json(res, 500, { error: err.message })
    }
  }

  if (method === 'POST' && pathname === '/api/skills/install') {
    try {
      const body = await readBody(req)
      return json(res, 200, await startSkillInstall(body))
    } catch (err) {
      return json(res, err.statusCode || 500, { error: err.message })
    }
  }

  if (method === 'GET' && pathname === '/api/skills/install/status') {
    return json(res, 200, skillJob)
  }

  if (method === 'POST' && pathname === '/api/skills/install/cancel') {
    return json(res, 200, cancelSkillInstall())
  }

  if (method === 'POST' && pathname === '/api/skills/uninstall') {
    try {
      const body = await readBody(req)
      const result = await withLock(() => uninstallSkill(cleanValue(body.name)))
      return json(res, 200, result)
    } catch (err) {
      return json(res, 500, { error: err.message })
    }
  }

  if (method === 'GET' && pathname === '/api/skills/search') {
    try {
      return json(res, 200, await searchSkills(url.searchParams.get('q') || ''))
    } catch (err) {
      return json(res, 500, { error: err.message })
    }
  }

  if (method === 'GET' && pathname === '/api/sessions') {
    return json(res, 200, await getSessionsPayload(Math.min(Number(url.searchParams.get('limit') || 30), 200)))
  }

  if (method === 'GET' && pathname === '/api/snapshots') {
    return json(res, 200, { items: await listSnapshots() })
  }

  if (method === 'POST' && pathname === '/api/snapshots') {
    try {
      const body = await readBody(req)
      const result = await startSnapshotCreate(cleanValue(body.name), cleanValue(body.note))
      return json(res, 200, result)
    } catch (err) {
      return json(res, 500, { error: err.message })
    }
  }

  if (method === 'GET' && pathname === '/api/snapshots/progress') {
    return json(res, 200, snapJob)
  }

  if (method === 'POST' && pathname === '/api/snapshots/cancel') {
    const result = cancelSnapshotJob()
    if (result.ok === false) return json(res, 409, { error: result.error })
    return json(res, 200, result)
  }

  if (method === 'POST' && pathname === '/api/snapshots/restore') {
    try {
      const body = await readBody(req)
      const result = await startSnapshotRestore(cleanValue(body.id))
      return json(res, 200, result)
    } catch (err) {
      return json(res, 500, { error: err.message })
    }
  }

  if (method === 'DELETE' && pathname.startsWith('/api/snapshots/')) {
    try {
      const id = decodeURIComponent(pathname.slice('/api/snapshots/'.length))
      return json(res, 200, await withLock(() => deleteSnapshot(id)))
    } catch (err) {
      return json(res, 500, { error: err.message })
    }
  }

  if (method === 'GET' && pathname === '/api/versions') {
    try {
      return json(res, 200, await getOfficialVersions(url.searchParams.get('refresh') === '1'))
    } catch (err) {
      return json(res, 200, { error: err.message, versions: [], all: [], latest: null, updateAvailable: null })
    }
  }

  return json(res, 404, { error: '接口不存在' })
}

// ── 日志 WebSocket（/api/logs/ws）────────────────────────────────────────
function wsAccept(key) {
  return crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
}

function wsFrame(text) {
  const payload = Buffer.from(String(text))
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

function streamStatus(req, socket, url) {
  const key = req.headers['sec-websocket-key']
  if (!key) return socket.destroy()
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  )
  socket.setNoDelay(true)
  const host = String(req.headers.host || '').split(':')[0] || '127.0.0.1'
  let closed = false
  const tick = async () => {
    if (closed) return
    try {
      const payload = await buildStatus(host)
      socket.write(wsFrame(JSON.stringify(payload)))
    } catch { /* 忽略单次失败 */ }
  }
  tick()
  const timer = setInterval(tick, 2000)
  const stop = () => {
    closed = true
    clearInterval(timer)
  }
  socket.on('close', stop)
  socket.on('error', stop)
}

function streamLogs(req, socket, head, url) {
  const key = req.headers['sec-websocket-key']
  if (!key) return socket.destroy()
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  )
  socket.setNoDelay(true)

  const source = url.searchParams.get('source') === 'app' ? 'app' : 'container'
  const tail = Math.min(Math.max(Number(url.searchParams.get('tail') || 300), 20), 2000)
  const child = source === 'app'
    ? spawn('tail', ['-n', String(tail), '-F', APP_LOG])
    : getRuntimeMode() === 'native'
      ? spawn('tail', ['-n', String(tail), '-F', NATIVE_LOG])
      : spawn('docker', ['logs', '--follow', '--tail', String(tail), '--timestamps', CONTAINER_NAME])

  let buffer = ''
  const emit = (chunk) => {
    buffer += chunk.toString()
    const parts = buffer.split('\n')
    buffer = parts.pop() || ''
    for (const line of parts) {
      if (!line.trim()) continue
      if (socket.writableLength > 1000000) return
      try { socket.write(wsFrame(line)) } catch { /* 连接已断开 */ }
    }
  }
  child.stdout.on('data', emit)
  child.stderr.on('data', emit)
  child.on('error', (err) => { try { socket.write(wsFrame(`[stream error] ${err.message}`)) } catch { /* 忽略 */ } })

  const stop = () => { try { child.kill('SIGTERM') } catch { /* 已退出 */ } }
  socket.on('close', stop)
  socket.on('error', stop)
  child.on('close', () => { try { socket.end() } catch { /* 忽略 */ } })
}

// ── Hermes WebUI 反向代理（fnOS 网关子路径 /webapp）──────────────────────
// 上游原生支持 X-Forwarded-Prefix：index.html 会被改写成带前缀的资源地址，
// 运行时通过 __HERMES_BASE_PATH__ 拼 API/WebSocket 路径。因此这里只做：
// 前缀剥离、标头注入、Location/Cookie 兜底改写、WebSocket 透传。
const WEBAPP_PREFIX = `${PREFIX}/webapp`
const WEBAPP_HOST = '127.0.0.1'
let WEBAPP_PORT = 9121

function forwardHeaders(req, prefix) {
  const headers = { ...req.headers }
  delete headers.host
  delete headers.connection
  delete headers['proxy-connection']
  delete headers['keep-alive']
  headers.host = `${WEBAPP_HOST}:${WEBAPP_PORT}`
  headers['x-forwarded-prefix'] = prefix
  headers['x-forwarded-host'] = req.headers.host || ''
  headers['x-forwarded-proto'] = 'http'
  delete headers.forwarded
  const ip = req.socket.remoteAddress || ''
  headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${ip}` : ip
  headers['x-real-ip'] = ip
  // 反向代理后浏览器 Origin 是 NAS 地址，而上游看到的是回环 Host。
  // 上游按 Host 校验 Origin（WebSocket 尤其严格），这里统一改成回环，
  // 与参考实现一致；外层鉴权由 fnOS 网关与子路径 Cookie 负责。
  if (req.headers.origin) headers.origin = `http://${WEBAPP_HOST}:${WEBAPP_PORT}`
  if (req.headers.referer) headers.referer = `http://${WEBAPP_HOST}:${WEBAPP_PORT}/`
  if (req.headers.cookie) headers.cookie = stripCookiePrefixes(req.headers.cookie)
  return headers
}

function prefixLocation(value) {
  if (!value) return value
  if (value.startsWith('/') && value !== WEBAPP_PREFIX && !value.startsWith(`${WEBAPP_PREFIX}/`)) {
    return `${WEBAPP_PREFIX}${value}`
  }
  return value
}

function stripCookiePrefixes(cookieHeader) {
  return String(cookieHeader)
    .split(';')
    .map((pair) => pair.replace(/^\s*(__Secure-|__Host-)/, ''))
    .join(';')
}

function prefixCookie(cookie) {
  let out = String(cookie).replace(/;\s*domain=[^;]*/ig, '')
  out = out.replace(/^(__Secure-|__Host-)/, '')
  out = out.replace(/;\s*secure/ig, '')
  if (/;\s*path=/i.test(out)) out = out.replace(/;\s*path=[^;]*/ig, `; Path=${WEBAPP_PREFIX}/`)
  else out += `; Path=${WEBAPP_PREFIX}/`
  return out
}

function staleCookieDeletes(cookie) {
  const name = String(cookie).split('=')[0].trim()
  if (!/^(__Secure-|__Host-)?hermes_(session|webapp_signin)/.test(name)) return []
  const names = [name, `__Secure-${name.replace(/^(__Secure-|__Host-)/, '')}`, `__Host-${name.replace(/^(__Secure-|__Host-)/, '')}`]
  const paths = ['/']
  const out = []
  for (const n of names) {
    for (const path of paths) out.push(`${n}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=${path}`)
  }
  return out
}

function relaxCsp(value) {
  let out = String(value)
  if (/frame-ancestors[^;]*/i.test(out)) out = out.replace(/frame-ancestors[^;]*/i, "frame-ancestors 'self'")
  return out
}

function stripWebappPrefix(pathname) {
  if (pathname === WEBAPP_PREFIX || pathname === '/webapp') return ''
  if (pathname.startsWith(`${WEBAPP_PREFIX}/`)) return pathname.slice(WEBAPP_PREFIX.length)
  if (pathname.startsWith('/webapp/')) return pathname.slice('/webapp'.length)
  return null
}

function proxyWebapp(req, res, url, targetPath) {
  const upstream = http.request(
    { host: WEBAPP_HOST, port: WEBAPP_PORT, method: req.method, path: targetPath || '/', headers: forwardHeaders(req, WEBAPP_PREFIX) },
    (up) => {
      const outHeaders = { ...up.headers }
      if (outHeaders['x-frame-options']) outHeaders['x-frame-options'] = 'SAMEORIGIN'
      if (outHeaders['content-security-policy']) {
        outHeaders['content-security-policy'] = relaxCsp(outHeaders['content-security-policy'])
      }
      if (outHeaders.location) outHeaders.location = prefixLocation(outHeaders.location)
      if (outHeaders['set-cookie']) {
        const cookies = outHeaders['set-cookie'].map(prefixCookie)
        for (const cookie of outHeaders['set-cookie']) cookies.push(...staleCookieDeletes(cookie))
        outHeaders['set-cookie'] = cookies
      }
      if (!/\/assets\/|\/fonts\//.test(targetPath)) {
        const cookieCount = req.headers.cookie ? String(req.headers.cookie).split(';').length : 0
        logLine('INFO', `WEBAPP ${req.method} ${targetPath} -> ${up.statusCode} cookies=${cookieCount}`)
      }
      res.writeHead(up.statusCode || 502, outHeaders)
      up.pipe(res)
    }
  )
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('<h1>Hermes WebUI 不可用</h1><p>容器未运行或尚未安装，请回到管理端查看状态。</p>')
    } else {
      res.end()
    }
  })
  req.pipe(upstream)
}

function proxyWebappUpgrade(req, socket, head, targetPath) {
  const headers = forwardHeaders(req, WEBAPP_PREFIX)
  headers.connection = 'Upgrade'
  headers.upgrade = req.headers.upgrade || 'websocket'

  const upstream = http.request({ host: WEBAPP_HOST, port: WEBAPP_PORT, method: req.method, path: targetPath || '/', headers })
  const writeHead = (source) => {
    const lines = [`HTTP/1.1 ${source.statusCode} ${source.statusMessage}`]
    for (let i = 0; i < source.rawHeaders.length; i += 2) lines.push(`${source.rawHeaders[i]}: ${source.rawHeaders[i + 1]}`)
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  }
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    writeHead(upRes)
    if (upHead && upHead.length) socket.write(upHead)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
    upSocket.on('error', () => socket.destroy())
    socket.on('error', () => upSocket.destroy())
  })
  upstream.on('response', (upRes) => {
    writeHead(upRes)
    upRes.pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  upstream.end()
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    let pathname = url.pathname

    const webappRest = stripWebappPrefix(pathname)
    if (webappRest !== null) {
      if (webappRest === '') {
        res.writeHead(302, { Location: `${WEBAPP_PREFIX}/${url.search || ''}` })
        return res.end()
      }
      if (!isInstalled()) {
        res.writeHead(302, { Location: `${PREFIX}/` })
        return res.end()
      }
      return proxyWebapp(req, res, url, webappRest + (url.search || ''))
    }
    if (pathname === PREFIX) {
      res.writeHead(302, { Location: `${PREFIX}/` })
      return res.end()
    }
    if (pathname.startsWith(`${PREFIX}/`)) pathname = pathname.slice(PREFIX.length)
    if (!pathname.startsWith('/')) pathname = `/${pathname}`

    if (process.env.MANAGER_DEBUG === '1') {
      logLine('DEBUG', `${req.method} ${url.pathname} host=${req.headers.host} ua=${String(req.headers['user-agent'] || '').slice(0, 40)}`)
    }
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, url)
    return await serveStatic(req, res, pathname)
  } catch (err) {
    logLine('ERROR', `未处理异常：${err.message}`)
    if (!res.headersSent) json(res, 500, { error: '服务内部错误' })
    else res.end()
  }
})

WEBAPP_PORT = readWebappPort()
if (getRuntimeMode() === 'native' && isInstalled()) {
  if (runtimeCache?.stopped !== true) {
    nativeStart().catch((err) => logLine('ERROR', `原生运行时启动失败：${err.message}`))
  }
}

let nativeHealing = false
setInterval(async () => {
  if (getRuntimeMode() !== 'native' || !isInstalled()) return
  if (runtimeCache?.stopped === true) return
  if (actionLock || snapJob.state === 'running' || installJob.state === 'running') return
  if (nativeHealing) return
  nativeHealing = true
  try {
    if (!(await nativeRunning())) {
      logLine('WARN', '原生运行时不在线，尝试自动拉起')
      await nativeStart()
    }
  } catch (err) {
    logLine('ERROR', `原生运行时自愈失败：${err.message}`)
  } finally {
    nativeHealing = false
  }
}, 30000)

function listen() {
  if (PORT) {
    server.listen(PORT, '0.0.0.0', () => {
      logLine('INFO', `管理端已监听 TCP ${PORT}`)
      console.log(`manager listening on 0.0.0.0:${PORT}`)
    })
    return
  }
  try { fs.unlinkSync(SOCKET_PATH) } catch { /* socket 不存在 */ }
  server.listen(SOCKET_PATH, () => {
    try { fs.chmodSync(SOCKET_PATH, 0o666) } catch { /* 权限位失败不影响监听 */ }
    logLine('INFO', `管理端已监听 socket ${SOCKET_PATH}`)
    console.log(`manager listening on ${SOCKET_PATH}`)
  })
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const webappRest = stripWebappPrefix(url.pathname)
  if (webappRest !== null) {
    if (!isInstalled()) return socket.destroy()
    return proxyWebappUpgrade(req, socket, head, webappRest + (url.search || ''))
  }
  const pathname = url.pathname.startsWith(`${PREFIX}/`) ? url.pathname.slice(PREFIX.length) : url.pathname
  if (pathname === '/api/status/ws') return streamStatus(req, socket, url)
  if (pathname === '/api/logs/ws') return streamLogs(req, socket, head, url)
  socket.destroy()
})

server.on('error', (err) => {
  logLine('ERROR', `监听失败：${err.message}`)
  console.error('listen error:', err.message)
  process.exit(1)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    logLine('INFO', `收到 ${signal}，管理端退出`)
    nativeStop().catch(() => {})
    try { if (!PORT) fs.unlinkSync(SOCKET_PATH) } catch { /* 忽略 */ }
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2500)
  })
}

listen()
