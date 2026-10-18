# dsh-web-submit

让命令行驱动**正在运行的** `dsh web` 实例的 DeepSeek Harness 插件 —— 任务在 web 进程内执行,
因此 Web UI 实时可见(同一会话存储、同一事件流),权限/审批提示也会出现在 Web UI 里。

不需要另起 headless 进程,也不需要 webhook 串联:一个插件、四个端点。

> English documentation: [README.en.md](README.en.md)

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/x/headless` | `{"task":"...","cwd":"...","preset":"coding","mode":"queue","permission":"danger-full-access","provider":"...","model":"...","reasoningEffort":"high"}` → `{"ok":true,"sessionId":"session-...","model":{"provider":"...","model":"...","reasoningEffort":"high"}}`;三个模型字段可选,不传即不指定模型 |
| `GET` | `/x/headless/status?sessionId=...` | 会话最新事件(非流式轮询) |
| `GET` | `/x/headless/events?sessionId=...` | SSE 实时事件流,`turn/end` 后结束 |
| `GET` | `/x/headless/health` | 插件状态与凭证模式 |
| `GET` | `/x/headless/active` | 仍在本轮运行的会话(`{ok,count,active[]}`),重启前可用它确认没有任务在跑 |
| `POST` | `/x/headless/adopt` | `{"sessionId":"session-..."}`:把已存在但没进侧栏的会话按 `cwd` 补登记到对应 workspace |

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

## 实际使用(端到端)

按「是否需要盯进度」分三种用法。示例统一用 `BASE=http://127.0.0.1:3080`。

### A. 交互式:边跑边看

```bash
BASE=http://127.0.0.1:3080

# 1) 提交,拿会话号
SID=$(curl -s -X POST $BASE/x/headless \
  -H 'content-type: application/json' \
  -d '{"task":"总结 README 并给出改进建议","cwd":"/path/to/repo","preset":"coding"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["sessionId"])')

# 2) 跟流(SSE;turn/end 后自动结束)
curl -sN "$BASE/x/headless/events?sessionId=$SID"

# 3) 随时查状态(非流式)
curl -s "$BASE/x/headless/status?sessionId=$SID"
```

也可以什么都不跟:任务提交后**打开 Web UI**,该会话就在侧栏对应 workspace 下,
实时流与思考计时和你手工输入的任务完全一样。
示例里的 `preset` 填你 profile 里实际配置的预设名,省略则用 profile 默认预设;
`cwd` 是任务的工作目录(也是沙箱写边界)。

### 指定模型(可选)

提交时可以带上 `provider` / `model` / `reasoningEffort`,任务就在该模型下运行:

| 字段 | 类型 | 含义 |
|---|---|---|
| `provider` | string | 供应商 id |
| `model` | string | 模型 id |
| `reasoningEffort` | string | 可选,如 `off` / `low` / `medium` / `high` / `max`;不传则由 harness 按模型自己的默认档位解析 |

只做类型校验(非空字符串),不维护模型白名单:名字不存在时由 harness 拒绝,并把它的报错原样带回来。
三个字段**任一存在**就要同时给 `provider` 与 `model`(只给 `reasoningEffort` 返回 `400`)。

```bash
# 在指定模型下跑这个任务
curl -s -X POST http://127.0.0.1:3080/x/headless \
  -H 'content-type: application/json' \
  -d '{"task":"总结 README 并给出改进建议","cwd":"/path/to/repo","permission":"danger-full-access",
       "provider":"your-provider","model":"your/model-id","reasoningEffort":"high"}'
# → {"ok":true,"sessionId":"session-...","agentPreset":null,"permission":"danger-full-access",
#    "model":{"provider":"your-provider","model":"your/model-id","reasoningEffort":"high"}}
```

响应里的 `model` 是实际生效的归一化选择(取自 harness 的返回值;返回值结构不符时回退请求值);
**未指定时为 `null`**。模型选择失败时返回 `500`,body 带 `error`(内含 harness 的 message)、
`sessionId` 与 `cleanup`,此时会话已建但**没有**派发任务:该 harness 没有删除/移除会话的 RPC,
所以会话会留在 Web UI 里,需要手工删掉。

> **副作用(harness 既有行为)**:指定模型时会同时**更新默认模型选择**——harness 的
> `session.selectModel` 会把这次选择写成全局默认,因此之后再提交不带模型字段的任务,也会用这次选的模型。
> **不传这三个字段 = 完全不调用它 = 零副作用**,现有调用方的行为与响应里的 `model: null` 之外的一切都不变。

### B. 无人值守:脚本 / CI

**关键**:提交时带 `permission`(或在插件配置里设 `defaultPermission`,见下节)。
否则遇到需要审批的操作会挂起等人点,而不是自动放行。

```bash
#!/usr/bin/env bash
# 无人值守提交 → 等待 → 判成败。退出码:0=完成,1=失败/被中止
set -euo pipefail
BASE=${DSH_WEB_SUBMIT_URL:-http://127.0.0.1:3080}
TASK=${1:?用法: run-task.sh "任务文本" [cwd]}
CWD=${2:-$PWD}

BODY=$(python3 -c 'import json,sys; print(json.dumps({"task":sys.argv[1],"cwd":sys.argv[2],"permission":"danger-full-access"}))' "$TASK" "$CWD")
SID=$(curl -s -X POST "$BASE/x/headless" -H 'content-type: application/json' -d "$BODY" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("sessionId","") if d.get("ok") else "")')
[ -n "$SID" ] || { echo "提交被拒" >&2; exit 1; }
echo "sessionId=$SID" >&2

while :; do
  REASON=$(curl -s "$BASE/x/headless/status?sessionId=$SID" | python3 -c '
import json,sys
ev=(json.load(sys.stdin).get("events") or [])
for e in reversed(ev):
    if e.get("type")=="turn/end":
        print(((e.get("data") or {}).get("reason") or {}).get("kind","")); break
')
  case "$REASON" in
    "") sleep 2 ;;
    completed) echo "完成 ✓"; break ;;
    *) echo "结束: $REASON" >&2; exit 1 ;;
  esac
done
```

### 取任务结果

任务产出的**最终文本**在 `assistant/message` 事件里(取最后一条):

```bash
curl -s "$BASE/x/headless/status?sessionId=$SID" | python3 -c '
import json,sys
ev=(json.load(sys.stdin).get("events") or [])
texts=[]
for e in ev:
    if e.get("type")!="assistant/message": continue
    m=(e.get("data") or {}).get("message") or {}
    t="".join(p.get("text","") for p in (m.get("content") or []) if p.get("type")=="text")
    if t.strip(): texts.append(t.strip())
print(texts[-1] if texts else "")'
```

判成败**看 `turn/end` 的 `reason.kind`**(`completed` 为正常;`aborted` / `failed` 为异常)——
不要只看提交时返回的 HTTP 200(那只说明任务被接受了)。

### 排障自查

| 想确认 | 怎么看 |
|---|---|
| 任务真的走了插件? | 会话应出现在 Web UI 侧栏对应 workspace 下;落到"未分组"说明走的是裸 `dsh headless` CLI(独立进程) |
| 插件是否加载、凭证模式 | `GET /x/headless/health` → `credential: session-cookie`(首次成功调用后) |
| 有没有弹审批 / 挂起 | 会话事件流里 `approval` 出现次数应为 0(带 `permission` 时) |
| 现在有没有任务在跑 | `GET /x/headless/active` → `{ok,count,active[]}`(重启 `dsh web` 前先确认 count=0) |

## 权限预设与无人值守(`permission`)

`permission` 是**每个新会话**在 `session/prompt` 之前套用的权限预设名,任务从第一步起就在该预设下运行:

| `permission` | 沙箱模式 | 审批策略 | 效果 |
|---|---|---|---|
| 省略 | 跟随 profile 默认(`workspace-write` + `ask`) | 需要审批的操作弹 Web UI 审批卡 | 没人点就挂起,浏览器没连时为 `unavailable` 直接失败 |
| `workspace-write` | `workspace-write` | `ask` | 同上,显式版 |
| `danger-full-access` | `danger-full-access` | `never` | 不发任何审批请求:写沙箱外路径直接成功;沙箱外写入不再要求升级 |

```bash
# 无人值守:不会向 Web UI 发任何审批请求
curl -s -X POST http://127.0.0.1:3080/x/headless \
  -H 'content-type: application/json' \
  -d '{"task":"跑一遍测试并汇报结果","cwd":"/path/to/repo","permission":"danger-full-access"}'
```

验证(新会话开头的三个事件):

```bash
zstdcat ~/.dsh/sessions/<workspace>/<sessionId>/session.v4.jsonl*.zstd |
  grep -E '"type":"(permission/preset|sandbox/mode|approval/policy)"' | head -6
# permission/preset {"preset":"danger-full-access"}
# sandbox/mode      {"mode":"danger-full-access"}
# approval/policy   {"policy":"never"}
```

预设名必须是 profile 里 `@deepseek-ai/dsh-permission-presets` 配置的键;名字不存在时端点返回
`500 cannot apply permission preset '<name>'`,任务不会被提交。

**注意**:`danger-full-access` 同时关掉该会话(及其派生子代理)的文件沙箱边界。若只需要"不弹审批"
而想保住沙箱,应改用别的办法(例如把任务产物放在会话工作区内),而不是这个预设。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `routePrefix` | `/x` | 所有端点的路由前缀 |
| `maxBodyBytes` | `1048576` | 请求体上限 |
| `pollIntervalMs` | `1500` | SSE 背后的轮询间隔 |
| `defaultPermission` | `""`(不套用) | 提交的会话默认套用的权限预设名;请求体带 `permission` 时以请求体为准 |

## 变更历史

各版本的改动见 **[CHANGELOG.md](CHANGELOG.md)**。

## 许可证

MIT
