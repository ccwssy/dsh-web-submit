# Changelog

本仓库是 `deepseek-ai/dsh-web-submit` 的 fork（维护者维护）。版本号跟随插件自身 `package.json`。
用法与安装见 [README.md](README.md)。

## v0.2.6

- **限定 dsh 版本**:`dsh.engines.dsh`(与 `peerDependencies`)由 `>=0.2.0-rc.2` 收紧为
  `>=0.2.1-alpha.4 <0.3.0`,与实测范围一致 —— dsh 的 plugin loader 在安装/启动时评估该范围,
  不满足直接拒绝(并提示用 `dsh plugin allow-version` 做精确版本豁免)。
- **运行期自查**:`apply()` 推导宿主版本(`DSH_VERSION` → `process.argv[1]` 真实路径向上找
  `@deepseek-ai/dsh/package.json` → 一次 import 解析);超出范围时 `POST /x/headless` 返回 `409`,
  body 带 `dshVersion`/`supportedDsh`。新增配置 `allowUnsupportedDsh`(默认 `false`)可显式放行;
  版本探测不到按「未知」处理,只上报、不拦截。
- **`health` 新增字段**:`dshVersion`、`supportedDsh`、`compatible`(`null` = 版本未知)。
- **实测**:版本比较 8 组边界(alpha.3 / alpha.4 / rc.2 / 0.2.0 / 0.2.9 / 0.3.0 / 非法串)全部符合预期;
  dsh 0.2.1-rc.2 下 `detectDshVersion()` 返回真实版本。

## v0.2.5

- **`examples/headless-shim.sh` 入库**:把 `dsh headless "任务"` 转成 `POST /x/headless` 的参考 shim
  从维护者本机搬进仓库。支持任务级选项 `-C/--cwd`、`--preset`、`--permission`、
  `--provider`/`--model`、`--effort`、`--timeout`;`--json`/`--session-id`/`-h`/`--help`、未知选项
  与非 headless 子命令一律原样回退真实 CLI;插件 health 失败时告警并回退;检测
  `DSH_HEADLESS_CLI` 自指,避免把真实 dsh 解析成 shim 自己而无限递归。
- **安装文档重写(中英)**:明确插件与 shim 是两件独立的事 —— `dsh plugin` 只装插件,
  不会也无法注册 `dsh` 命令(它只是把参数转发给 profile 里的 pnpm);裸 `dsh headless`
  即便装了插件仍是独立进程、UI 不可见。新增「给调用方的最短说明」、`type -a dsh` 校验、
  回退规则表与卸载步骤。
- **实测**:dsh `0.2.1-rc.2` + 插件 0.2.4,shim 以参数与 stdin 两种方式提交真实任务,
  stdout 契约与退出码均通过;`--help`/`--version` 等形态回退真实 CLI 正常。

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
