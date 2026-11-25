# Hermes Agent for fnOS

[下载最新版](https://github.com/sfy2022/hermes-agent-fnos-manager/releases/latest) · [GitHub 仓库](https://github.com/sfy2022/hermes-agent-fnos-manager)

飞牛 NAS（fnOS）上的 **Hermes Agent 管理器**。先安装本应用，再在管理端里选择官方版本安装 Hermes，最后从桌面进入 Hermes Desktop 工作台。

## 功能概览

- 管理端：概览状态与指标、启停/重启/检查更新/在线部署、状态 WebSocket；
- 工作区：读取 Hermes Projects，路径映射到宿主机，直接打开飞牛文件管理；
- 授权：Nous Portal 登录/切换/登出、账号池、环境变量、模型 Key；
- 插件：技能启用/禁用、预览/审计、安装进度与取消；
- 快照：异步创建/恢复、进度与取消、恢复前安全快照；
- 日志：WebSocket 实时推送、过滤、下载、清空；
- 设置：端口、内存、口令、打开方式、镜像源、网络代理、Docker/原生运行时。

## 安装

1. 应用中心 → 右上角「手动安装」→ 选择 `hermes-agent.fpk`；
2. 安装向导选择：
   - **存储位置**：共享目录（文件管理可见，便于备份）或数据目录（应用私有）；
   - **运行权限**：普通用户 Package（推荐）或超级管理员 Root（数据归 root，快照/配置编辑可能受限）；
3. 安装完成，桌面出现 **Hermes Admin**。

安装 fpk 只装管理器：不拉 Hermes 镜像、不建容器、不配置 Hermes。

安装 Hermes 时可选两种运行时：

- **Docker 容器（默认）**：官方镜像、隔离性好；
- **原生运行时（实验）**：从官方镜像提取 Python 与 Webapp 到应用私有目录，由管理端直接托管 `hermes gateway run`，不启动容器；隔离性弱，首次仍需本地存在对应镜像。

## 首次使用

1. 打开 **Hermes Admin** → 概览 →「安装 Hermes Agent」；
2. 选择官方稳定版本（来自 GitHub Releases，如 `v0.23.4`），填写：
   - 工作区登录用户名 / 口令（至少 8 位）；
   - 容器内存上限；
   - 模型服务商、默认模型、接口地址、API Key（可留空后补）；
   - 是否开启 OpenAI 兼容 API；
3. 安装进度：准备镜像（首次约 3.8 GB）→ 生成配置 → 启动容器 → 等待就绪，日志实时滚动；
4. 完成后：
   - 管理端「进入 Hermes」→ 系统浏览器新窗口打开工作台；
   - 应用中心打开方式 → **Hermes Agent** → 工作台；
   - 直连 `http://<NAS_IP>:9121/` 也可作为兜底。

> fnOS 每个应用只有一个桌面快捷方式（`app_shortcut` 唯一）。桌面图标固定为 **Hermes Admin**；工作台通过第二入口或管理端按钮进入。

## 桌面入口与原生能力

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| **Hermes Admin**（桌面图标） | 网关 `/app/hermes-agent/` | 管理端，桌面微应用 iframe |
| **Hermes Agent** | 网关 `/app/hermes-agent/webapp/` | 工作台（官方 Webapp 渲染层），应用中心第二打开方式 |
| 直连 | `http://<NAS_IP>:9121/` | 不过网关，Hermes 账号鉴权 |

原生运行时下，Hermes 进程由管理端启动/停止（`hermes gateway run --no-supervise`），监听同一端口，Webapp 资源取自提取出的 `apps/desktop/dist-webapp`。管理端「应用设置 → 运行时」可查看当前模式；切换运行时需要安装时选择或卸载重装。

### `micro_app` 与原生桥接

manifest 中的：

```ini
desktop_applaunchname = hermes-agent.Application
micro_app             = true
```

告诉 fnOS 以**微应用**方式加载桌面 iframe，注入 `__POWERED_BY_FNAPP__` / micro-app 原生桥接。`@trimjs/web-app` 的 `openFileManager(path)` 走的就是这条原生 IPC：

- 工作区项目卡片：把容器路径映射到宿主机后打开对应目录；
- 「数据目录」：打开 `dataLibraryPath`（`/vol1/@appshare/hermes-agent/data` 或数据模式下的 `var/data-root`）。

普通浏览器标签页里 SDK 会判定 `isStandaloneWeb`，此时降级为复制路径；这是 fnOS 的安全边界，不是接口未调用。

## 管理端功能

- **概览**：状态核心卡（版本/镜像/进入 Hermes）、五项指标（状态/容器 ID/CPU/内存/运行时间）、运行控制四卡（停止启动/重启/检查更新/在线部署）、部署与更新弹窗、状态 WebSocket 实时刷新。
- **工作区**：读取 Hermes **Projects**（`projects.db`，命名多目录工作区），显示项目名、主目录、描述、会话数、创建/更新时间；容器路径映射为宿主机路径，点击直接打开飞牛文件管理。
- **授权管理**：Nous Portal 设备码登录/切换/登出、账号池（切换优先级/移除）、环境变量名称与值完整编辑、模型服务、各服务商 Key、OpenAI 兼容 API。
- **插件管理**：技能启用/禁用、安装前预览/审计、安装进度与取消、强制安装（`--force`）、市场搜索、卸载。
- **快照管理**：异步创建/恢复、进度与阶段消息、取消、恢复前安全快照、命名/备注。
- **运行日志**：容器日志与应用日志、WebSocket 实时推送、过滤、暂停、下载、清空。
- **应用设置**：监听端口、容器内存、登录用户名/口令、打开方式（网关/直连/自定义）、官方版本、OpenAI API、镜像源、网络代理、修复与卸载。

## 内嵌与网关适配

```
飞牛桌面 iframe
      │  /app/hermes-agent/ 或 /app/hermes-agent/webapp/
      ▼
fnOS 统一网关（NAS 登录态 / FnConnect / 外部反代）
      │  unix socket: target/web.sock
      ▼
Node 管理端
  ├─ 管理 SPA + /api/*
  └─ /webapp/* → 127.0.0.1:9121（HTTP + WebSocket）
      ▼
Hermes 容器（host 网络，Desktop Webapp）
```

管理端做这些适配（详见 [GATEWAY.md](GATEWAY.md)）：

- 同时接受网关完整路径与剥离 `/app/hermes-agent` 后的 `/webapp/...`；
- 注入 `X-Forwarded-Prefix`，重写 `Host`、`Origin`、`Referer`；
- 只放宽 frame 指令：`CSP frame-ancestors` → `'self'`，`X-Frame-Options` → `SAMEORIGIN`，不改响应体；
- HTTP 模式下移除 Cookie 的 `Secure` 与 `__Secure-`/`__Host-` 前缀，并清理根路径上的旧 `hermes_*` Cookie；
- WebSocket 握手头透传，101 后双向转发。

## 数据位置

| 内容 | 共享目录模式 | 数据目录模式 |
| --- | --- | --- |
| Hermes 数据 | `/vol1/@appshare/hermes-agent/data` | `/vol1/@appdata/hermes-agent/data-root` |
| 工作区 | `/vol1/@appshare/hermes-agent/workspace` | `/vol1/@appdata/hermes-agent/workspace-root` |
| 运行配置/日志 | `/vol1/@appdata/hermes-agent` | 同左 |
| 原生运行时数据 | `/vol1/@appdata/hermes-agent/native/data` | 同左（原生始终使用应用私有目录） |
| 原生运行时工作区 | `/vol1/@appdata/hermes-agent/native/workspace` | 同左 |

容器内路径：

- `/opt/data` → 数据目录
- `/opt/workspace` → 工作区目录

管理端工作区会把 `/opt/data`、`/opt/workspace` 映射到上表宿主机真实路径后再交给文件管理。

## 权限与安全

- Hermes 容器监听 `0.0.0.0:9121`，WebUI 强制账号口令；
- 网关外网访问由飞牛统一网关负责登录与 HTTPS，管理端只处理已鉴权请求；
- Root 运行权限下数据归 root，管理端（普通用户）读写会受限，快照/配置编辑可能失败；需要完整管理能力请选 Package；
- 不要把管理端或 9121 直接暴露到公网。

## 更新与卸载

- 管理端「检查更新」对比 GitHub Releases，升级会拉取对应 `-desktop` 镜像、校验 Desktop 渲染层，失败回滚；
- 卸载通过应用中心 Web UI 完成；数据是否删除由卸载向导选择。

## 已知限制

- fnOS 每个应用只有一个桌面快捷方式，无法同时放 Hermes Admin 和 Hermes Agent 两个桌面图标；
- 版本通道只同步 GitHub 稳定版（canary tag 无法映射为 Docker 镜像 tag）；
- 普通浏览器标签页里无法调用原生文件管理，只能复制路径；
- 若内嵌登录后反复回 `/login`，清除该 NAS 站点的旧 Cookie 或无痕窗口重试，管理端会自动清理根路径旧 Cookie。

## 构建

```bash
# 安装依赖、构建管理端前端并打包
./scripts/build.sh

# 或手动：
npm ci --prefix frontend
npm run build --prefix frontend
./tools/fnpack build -d .
```

产物：`hermes-agent.fpk`。GitHub Actions（`.github/workflows/build.yml`）会在 push 到 `main` 时自动构建并上传 artifact。

版本与功能记录见 `manifest` 的 `changelog`。

## 维护者与许可

- 维护者 / 发布者：[hermes-agent-fnos-manager](https://github.com/sfy2022/hermes-agent-fnos-manager)
- 许可证：MIT（见 [LICENSE](LICENSE)）
