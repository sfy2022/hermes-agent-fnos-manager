# 网关、内嵌与原生桥接

本文说明本应用如何接入**飞牛统一网关**，以及 Hermes Workbench 如何挂在子路径下。

## 一、拓扑

```
飞牛桌面 iframe（微应用）
   │  /app/hermes-agent/   管理端
   │  /app/hermes-agent/webapp/   工作台
   ▼
fnOS 统一网关（NAS 登录态、FnConnect、外部反代）
   │  unix socket: /vol1/@appcenter/hermes-agent/web.sock
   ▼
Node 管理端（app/manager/server.js）
   ├─ /              管理 SPA（截图、API）
   ├─ /api/*         管理端 REST + 状态/日志 WebSocket
   └─ /webapp/*      反代到 127.0.0.1:9121（HTTP + WebSocket）
   ▼
Hermes 容器（host 网络，Desktop Webapp，默认 9121）
```

直连 `http://<NAS_IP>:9121/` 不经过管理端与网关，Cookie Path 为 `/`，与网关入口互不影响。

## 二、桌面入口

fnOS 每个应用只有一个桌面快捷方式（`app_shortcut` 唯一），由 manifest 的 `desktop_applaunchname` 决定：

```ini
desktop_applaunchname = hermes-agent.Application
micro_app             = true
```

| 入口 | gatewayPrefix | url | 说明 |
| --- | --- | --- | --- |
| Hermes Admin | `/app/hermes-agent` | `/app/hermes-agent/` | 桌面图标（管理端） |
| Hermes Agent | `/app/hermes-agent` | `/app/hermes-agent/webapp/` | 应用中心第二打开方式（工作台） |

两个入口共用同一个 `gatewayPrefix`，仅 `url` 区分子路径；这是 fnOS 多入口的正常写法。

### `micro_app` 与原生能力

`micro_app = true` 让桌面以微应用方式加载 iframe，注入 micro-app 原生桥接（`__POWERED_BY_FNAPP__`）。`@trimjs/web-app` 的 `openFileManager(path)` 通过这条 IPC 调起飞牛文件管理：

- 工作区项目：容器路径 `/opt/data`、`/opt/workspace` 先映射为宿主机真实路径（`/vol1/@appshare/...`），再调用 SDK；
- 「数据目录」：调用 `dataLibraryPath`。

如果没有 `micro_app`，页面只是普通 iframe，SDK 会判定 `isStandaloneWeb`，只能复制路径。

## 三、路由与前缀

fnOS 网关可能把完整路径直接转给 socket，也可能**剥掉 `/app/hermes-agent`** 后转发。管理端两种都接受：

1. `GET /app/hermes-agent/webapp` 或 `/webapp` → `302` 补结尾斜杠；
2. `/app/hermes-agent/webapp/*` → 剥掉 `/app/hermes-agent/webapp` 后反代；
3. `/webapp/*` → 剥掉 `/webapp` 后反代（网关剥离前缀的形态）；
4. `GET /app/hermes-agent` 或 `/` → `302 /app/hermes-agent/`；
5. `/app/hermes-agent/*` → 管理端静态资源或 `/api/*`；
6. 不带前缀的根路径也支持（本地 TCP 调试）。

管理端静态资源使用相对路径（Vite `base: './'`），WebUI 由上游按 `X-Forwarded-Prefix` 生成前缀。

## 四、反代标头

| 请求头 | 转发值 | 目的 |
| --- | --- | --- |
| `Host` | `127.0.0.1:9121` | 命中上游同源校验 |
| `Origin` | `http://127.0.0.1:9121` | 浏览器 Origin 是 NAS 地址，不改会被 403 |
| `Referer` | `http://127.0.0.1:9121/` | WebSocket / 登录校验 |
| `X-Forwarded-Prefix` | `/app/hermes-agent/webapp` | 上游改写 index、`__HERMES_BASE_PATH__`、Location、Cookie |
| `X-Forwarded-Host` | 客户端 Host | 绝对地址生成 |
| `X-Forwarded-Proto` | `http` | 回调地址与 Cookie Secure 判定 |
| `X-Forwarded-For` / `X-Real-IP` | 客户端 IP | 审计 |
| `Forwarded` | 移除 | 避免覆盖 |
| `Cookie` | 去掉 `__Secure-` / `__Host-` 前缀 | HTTP 网关兼容 |
| `Connection` / `Keep-Alive` | 移除 | Node 管理连接 |

上游依赖 `X-Forwarded-Prefix`：

- 注入 `window.__HERMES_BASE_PATH__="/app/hermes-agent/webapp"`；
- 未登录 `Location: /app/hermes-agent/webapp/login?next=...`；
- 登录页用 `prefix + '/auth/password-login'`；
- 登录 Cookie `Path=/app/hermes-agent/webapp/`。

代理层兜底：

- `Location` 仍是根路径时补前缀；
- `Set-Cookie` 去掉 `Domain`、`Secure`、`__Secure-`/`__Host-` 前缀，`Path` 统一为 `/app/hermes-agent/webapp/`；
- 登录响应额外把根路径 `/` 上的旧 `hermes_*` Cookie 置为过期，避免旧会话覆盖新会话。

## 五、Frame 与 CSP

Hermes 上游的 CSP 含 `frame-ancestors 'none'`，`X-Frame-Options: DENY`。适配层只放宽 frame 相关指令，**不改响应体**（避免破坏内联脚本 sha256 白名单）：

| 响应头 | 处理 |
| --- | --- |
| `X-Frame-Options` | 改为 `SAMEORIGIN` |
| `Content-Security-Policy` | 仅把 `frame-ancestors` 改为 `'self'` |

直连 9121 不经过适配，仍保持上游最严格设置。

## 六、WebSocket

管理端日志流：`GET /app/hermes-agent/api/logs/ws?source=container|app&tail=300`，由管理端直接推送。

Hermes 实时通道：`GET /app/hermes-agent/webapp/api/ws?ticket=<ticket>`：

1. 前端先 `POST /api/webapp/socket-ticket?socket=gateway` 取票据；
2. 带票据与 Cookie 升级 WebSocket。

`server.on('upgrade')` 同时支持完整与剥离前缀，注入 `X-Forwarded-*` 与回环 Origin，101 后双向 `pipe`。

## 七、失败形态与排查

| 现象 | 原因/处理 |
| --- | --- |
| 登录成功但回 `/login` | 旧 Cookie（Path `/` 或不同前缀）冲突；管理端已自动清理根路径旧 Cookie，仍不行就清站点 Cookie/无痕窗口 |
| iframe 白屏/拒绝显示 | 页面没有经过适配层，CSP 仍是 `frame-ancestors 'none'`；确认走 `/app/hermes-agent/...` |
| 静态资源 404 | 入口少了结尾斜杠；先 302 补 `/` |
| WebSocket 403 | 握手 Host/Origin/Referer 未改写，或 ticket 失效 |
| `/webapp` 502 | 容器未安装/未运行，或 9121 未监听 |
| 文件管理不弹出、只复制路径 | 页面不在微应用 iframe（`micro_app` 未生效）或路径不是宿主机路径 |

验收命令：

```bash
# 管理端
curl -s -o /dev/null -w '%{http_code}\n' http://<NAS>/app/hermes-agent/

# 工作台（应 302 登录）
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://<NAS>/app/hermes-agent/webapp/

# 登录（替换口令），保存 Cookie 后访问首页
curl -s -c /tmp/c -X POST -H 'Content-Type: application/json' \
  -d '{"provider":"basic","username":"admin","password":"***","next":"/app/hermes-agent/webapp/"}' \
  http://<NAS>/app/hermes-agent/webapp/auth/password-login
curl -s -b /tmp/c http://<NAS>/app/hermes-agent/webapp/ | grep __HERMES_BASE_PATH__

# 管理端 socket 直连排查
curl --unix-socket /vol1/@appcenter/hermes-agent/web.sock http://localhost/app/hermes-agent/api/status
```

## 八、已知限制

- 反代依赖上游 `X-Forwarded-Prefix`；Hermes 升级后需复查；
- `Origin` 改写为回环，等价于信任 fnOS 网关已完成鉴权，不要把管理端直接暴露公网；
- 管理端与工作台共用 `web.sock`，管理端异常会同时影响两个入口；容器异常只影响 `/webapp`；
- 原生文件管理只在飞牛桌面微应用 iframe 内可用。
