# dsh-web-submit

让命令行驱动**正在运行的** `dsh web` 实例的 DeepSeek Harness 插件 —— 任务在 web 进程内执行,
因此 Web UI 实时可见(同一会话存储、同一事件流),权限/审批提示也会出现在 Web UI 里。

不需要另起 headless 进程,也不需要 webhook 串联:一个插件、四个端点。

> English documentation: [README.en.md](README.en.md)

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/x/headless` | `{"task":"...","cwd":"...","preset":"coding","mode":"queue"}` → `{"ok":true,"sessionId":"session-..."}` |
| `GET` | `/x/headless/status?sessionId=...` | 会话最新事件(非流式轮询) |
| `GET` | `/x/headless/events?sessionId=...` | SSE 实时事件流,`turn/end` 后结束 |
| `GET` | `/x/headless/health` | 插件状态与凭证模式 |

仅接受回环请求(`127.0.0.1` / `localhost`),与内置 `/api` 同等信任姿态:
`Host` 头不是回环地址时一律返回 403。

## 与 harness 的通信方式

插件运行在 `dsh web` 进程内,因此能做到外部 CLI 做不到的事:用进程自己的启动令牌换取 `/api` 凭证。

- **dsh >= 0.2.1-alpha.4**:`/api` 由 `Connection.admit()` 把关,必须带签名 Cookie,而启动令牌只存在于进程内、不落盘。
  插件向 `connection` 服务索取带令牌的 URL(`HostConnectionService.authenticatedUrl`),
  在 `GET /connect?token=...&interactions=answer` 换一次 Cookie,之后每个 `/api` 请求都带上它;
  遇到 401 会丢弃 Cookie 并自动重换一次。
- **旧版 0.2.x**:`/api` 在回环上开放,插件自动跳过换取,直接裸请求。

凭证完全来自进程内部,无需任何手工配置,也不用复制令牌。

**端点拼写**:旧版注册 `session.create`,当前版本注册 typert 拼写 `session/create`。
插件两种都试,首次成功后记住该 harness 的拼写并复用。

## 安装

```bash
dsh plugin --profile web add file:/path/to/dsh-web-submit
```

Windows:`dsh plugin --profile web add file:C:/path/to/dsh-web-submit`。

`dsh plugin add` 会自动应用 bundle patch 规则(`cordis.patch.yml`),无需手工修改宿主 profile。
重启 `dsh web` 后生效。

## 命令行示例

```bash
# 提交一个任务
curl -s -X POST http://127.0.0.1:3080/x/headless \
  -H 'content-type: application/json' \
  -d '{"task":"总结 README","cwd":"/home/me/project","preset":"coding"}'

# 实时跟踪该会话
curl -sN "http://127.0.0.1:3080/x/headless/events?sessionId=session-xxx"

# 查看插件是否加载、凭证处于什么模式
curl -s http://127.0.0.1:3080/x/headless/health
```

任务执行期间打开 Web UI:该会话与你手工输入的任务一样实时可见。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `routePrefix` | `/x` | 所有端点的路由前缀 |
| `maxBodyBytes` | `1048576` | 请求体上限 |
| `pollIntervalMs` | `1500` | SSE 背后的轮询间隔 |

## 本 fork 的改动(ccwssy/dsh-web-submit,0.2.0)

- **修复失效的 `/api` 通路**:原版不带任何凭证 POST `/api/<method>`;自 dsh 0.2.1-alpha.4 起该通路返回
  `401 unauthorized`(已在真实 3080 实例上复现),于是 `POST /x/headless` 永远返回 500。
  现在插件在进程内铸取并复用签名 Cookie,并在每次请求上自动重认证一次。
- **适配端点拼写**:新版 typert 端点为 `session/create` 形式,插件自动在点号与斜杠两种拼写间选择并缓存。
- **新增 `GET /x/headless/health`**:可判断插件是否加载、凭证处于什么模式。
- **更清晰的 `/api` 错误**:非 JSON 响应(例如 401 正文)会报成 `HTTP <状态码>: <正文>`,不再是 JSON 解析错误。
- **声明依赖**(`@deepseek-ai/schemastery`、peer `@deepseek-ai/dsh`、Node `>=20`),不再依赖宿主提升。
- **文档**:补全 Linux/macOS 与 Windows 的真实安装路径、配置表,删除过时的 `ApiProxyService` 说法;
  README 默认中文,英文版见 [README.en.md](README.en.md)。

已对照 dsh 0.2.1-alpha.4 核对 RPC 契约:`session.create`(`cwd`、`agentPreset`)、
`session.prompt`(`mode: queue|steer`、`content`)、`session.history`(`maxMessages`),
以及 `{type:"server-response", rpcId, result:{ok, value}}` 响应封套均未改变。

## 许可证

MIT
