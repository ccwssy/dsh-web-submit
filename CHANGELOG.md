# Changelog

本仓库是 `deepseek-ai/dsh-web-submit` 的 fork（维护者维护）。版本号跟随插件自身 `package.json`。
用法与安装见 [README.md](README.md)。

## v0.2.4

- **`POST /x/headless` 支持可选模型**:body 新增 `provider` / `model` / `reasoningEffort`,
  三者任一存在时在 `session/create` 之后、`session/prompt` 之前调用 `session.selectModel`,
  任务在指定模型下运行;响应新增 `model`(未指定为 `null`)。`reasoningEffort` 不传时该键缺席,
  由 harness 按模型自身默认档位解析。
- **不传即完全不变**:三个字段都不传时不调用 `session.selectModel`,零副作用,既有调用方行为不变。
- **失败不静默**:模型选择失败返回 `500` + `error`(含 harness 的 message) + `sessionId` +
  `cleanup`,会话不会被当成已提交任务;因为 harness 没有删会话的 RPC,body 里明说会话已创建、未派任务、未自动清理。

## v0.2.3

- **`defaultPermission` 配置**:插件配置里给一个权限预设名,所有经 `POST /x/headless` 提交的会话默认套用
  它(请求体的 `permission` 优先);默认空 = 行为不变。用于让无人值守入口一次配置、永不弹审批。
- **权限文档**:端点表与新增的「权限预设与无人值守」一节写清 `permission` 语义、验证命令与沙箱代价。

## v0.2.2

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
