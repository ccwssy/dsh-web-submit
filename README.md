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
| `GET` | `/x/headless/active` | 仍在本轮运行的会话(`{ok,count,active[]}`),重启前可用它确认没有任务在跑 |

仅接受回环请求:`Host` 头不是回环地址(`127.0.0.1` / `localhost`)时一律返回 403。
这里只做回环校验、不额外鉴权(面向本机 CLI);插件内部调用 `/api` 所需的签名 Cookie 由插件自己换取,见下节。

## 与 harness 的通信方式

插件运行在 `dsh web` 进程内,因此能做到外部 CLI 做不到的事:用进程自己的启动令牌换取 `/api` 凭证。

- **dsh >= 0.2.1-alpha.4**:`/api` 由 `Connection.admit()` 把关,必须带签名 Cookie,而启动令牌只存在于进程内、不落盘。
  插件向 `connection` 服务索取带令牌的 URL(`HostConnectionService.authenticatedUrl`),
  在 `GET /connect?token=...&interactions=answer` 换一次 Cookie,之后每个 `/api` 请求都带上它;
  遇到 401 会丢弃 Cookie 并自动重换一次。
- **旧版 0.2.x**:`/api` 在回环上开放,插件自动跳过换取,直接裸请求。

凭证完全来自进程内部,无需任何手工配置,也不用复制令牌。

**RPC 契约**:旧版注册点号端点(`session.create`),参数直接放在 payload 顶层;当前版本注册 typert 拼写(`session/create`),
参数包在 `args.request` 里,历史读取改用 `session.page`(需要 `address` 与日志切点 `throughSeq`)。
插件会逐层探测并记住该 harness 实际使用的拼写与信封,两代都能工作。

## 适配的 dsh 版本

| dsh 版本 | `/api` 鉴权 | 端点与参数 | 状态 |
|---|---|---|---|
| `0.2.1-alpha.4`(本仓库实测版本) | 必须带签名 Cookie,插件用进程内启动令牌自动换取 | typert 端点 `session/create`、`session/prompt`;参数包在 `args.request`;历史读取走 `session.page`(`address` + `throughSeq`) | 已端到端实测通过 |
| 更早的 `0.2.x` | `/api` 在回环上开放,插件跳过换取直接请求 | 点号端点 `session.create`、`session.prompt`;参数放 payload 顶层;历史走 `session.history` | 保留兼容分支,未逐版回归 |

`package.json` 声明 `dsh.engines.dsh >= 0.2.0-rc.2`、Node `>=20`。插件自身的 npm 依赖只有
`@deepseek-ai/schemastery`;`@deepseek-ai/dsh` 是宿主提供的 peer,已标记 `optional`,
避免安装时被 pnpm 连带拉下整个 dsh 依赖树。
插件不写死某一代契约:首次调用时按 404 与信封报错逐层探测(端点拼写 / `args` 包装 / `request` 包装),
成功一次后缓存复用,因此新老两代 harness 都能工作。

## 安装

直接安装本仓库:

```bash
dsh plugin --profile web add git+https://github.com/ccwssy/dsh-web-submit.git
```

或先克隆,再用**绝对路径**安装 —— `dsh plugin` 的 pnpm 在 profile 目录(`$DSH_HOME/profiles/web`)下运行,
`file:` 写相对路径会被解析到 profile 目录里,而不是你当前所在的 shell 目录:

```bash
git clone https://github.com/ccwssy/dsh-web-submit.git
dsh plugin --profile web add "file:$PWD/dsh-web-submit"
```

Windows:`dsh plugin --profile web add file:C:/path/to/dsh-web-submit`(换成克隆后的绝对路径)。

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

示例里的 `preset` 由你的 profile 决定(填 profile 里实际配置的预设名),省略则用 profile 的默认预设。

任务执行期间打开 Web UI:该会话与你手工输入的任务一样实时可见。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `routePrefix` | `/x` | 所有端点的路由前缀 |
| `maxBodyBytes` | `1048576` | 请求体上限 |
| `pollIntervalMs` | `1500` | SSE 背后的轮询间隔 |

## 本 fork 的改动(ccwssy/dsh-web-submit,0.2.1)

- **修复失效的 `/api` 通路**:原版不带任何凭证 POST `/api/<method>`;自 dsh 0.2.1-alpha.4 起该通路返回
  `401 unauthorized`(已在真实 3080 实例上复现),于是 `POST /x/headless` 永远返回 500。
  现在插件在进程内铸取并复用签名 Cookie,并在每次请求上自动重认证一次。
- **适配新的 RPC 契约**:新版端点为 `session/create` 形式、参数包在 `args.request` 里,历史读取走 `session.page`(需要 `address` + `throughSeq`,超出游标时按 Host 回报的游标重试)。插件自动探测端点拼写与信封并缓存。
- **新增 `GET /x/headless/health`**:可判断插件是否加载、凭证处于什么模式。
- **新增 `GET /x/headless/active`**:列出仍在本轮运行的会话,便于重启前确认没有任务被打断。
- **会话会自动登记进 workspace**:创建前先 `workspace/create` 取 `cwd` 对应的 `workspaceId`,再以该 id 建会话,因此 Web UI 侧栏能直接看到。
- **更清晰的 `/api` 错误**:非 JSON 响应(例如 401 正文)会报成 `HTTP <状态码>: <正文>`,不再是 JSON 解析错误。
- **声明依赖**(`@deepseek-ai/schemastery`、peer `@deepseek-ai/dsh`、Node `>=20`),不再依赖宿主提升。
- **文档**:补全 Linux/macOS 与 Windows 的真实安装路径、配置表,删除过时的 `ApiProxyService` 说法;
  README 默认中文,英文版见 [README.en.md](README.en.md)。
- **插件描述中英双语**:`package.json` 的 `description` 一行内同时给出中文与英文,GUI 组件面板与插件市场直接可见。

在 dsh 0.2.1-alpha.4 上端到端实测:`POST /x/headless` 创建会话并排队任务、`/status` 读回完整事件、`/events` 正常流出 SSE。
实际使用的契约是 `session/create`(`request.cwd`、`request.agentPreset`)、
`session/prompt`(`request: { requestId, sessionId, mode: queue|steer, content }`)、
`session/page`(`request: { address, throughSeq, maxMessages }`),响应封套为
`{type:"server-response", rpcId, result:{ok, value}}`。

## 许可证

MIT
