# lark-coding-agent-bridge 、CC Switch 与 Factory 兼容性核对

> 核对日期：2026-08-03
>
> Bridge 上游基准：`zarazhangrui/lark-coding-agent-bridge` commit `e5d3ce57ca95212cfa53965a6f2cc2d998aa691c`，package `0.7.0`
>
> CC Switch 上游基准：`farion1231/cc-switch` commit `f38722a440b2bda3df10929758e296f2cbcd96de`
> 范围：只使用上游 README、源码、package metadata 及飞书官方 SDK 资料；不将推测写成官方承诺。

## 结论

1. **Bridge 本身兼容“裸 `claude` 默认走 CC Switch”。** Bridge 不设置 `CLAUDE_CONFIG_DIR`，它启动 Claude 时继承 Bridge 进程环境。当 Bridge 从普通用户环境启动时，`claude` 会按默认规则读取 CC Switch 写入的 `~/.claude/settings.json`。
2. **当前 Factory 实现与这个默认要求冲突。** Factory 为 Claude 强制设置员工专属 `CLAUDE_CONFIG_DIR`，并且只继承少数白名单环境变量。这会让直接 `chat/run` 和 Bridge 内启动的 Claude 都绕开 CC Switch 的默认配置。
3. **飞书主流接入方式兼容，但 Factory 应以 PersonalAgent 扫码流程为准。** 官方 Bridge 使用 `registerApp` 扫码创建/绑定 PersonalAgent，使用 WebSocket 长连接收消息，不需要 Factory 自建 webhook。
4. **Factory 自己管理 launchd、运行 Bridge 前台 `run` 是可行的。** 这与 Bridge 官方支持的前台运行语义一致，也能保留 Factory 对 `LARK_CHANNEL_HOME`、日志和生命周期的控制。
5. **安全上还有一个必须处理的差距：Bridge 新 profile 默认为 `full`。** 对 Claude 会映射为 `bypassPermissions`，对 Codex 映射为 `danger-full-access`；这与 Factory 原定的 workspace 级约束不一致。

### 本次实施选择

核对完成后，Factory 没有直接共享个人 `~/.claude`，也没有采用报告最初建议的“移除员工 `CLAUDE_CONFIG_DIR`”。实际实现采用更严格的折中方案：每次 Claude chat、run、Agent Job 或 Bridge 启动前，只把 CC Switch live `settings.json` 中经过白名单允许的 Provider 字段同步到员工专属 Runtime Home。这样既会跟随 CC Switch 当前 Provider，又不会共享个人 OAuth、会话、历史、MCP、权限和主题。

同时，授权完成和服务启动前会把官方 Bridge profile 的 `permissions.defaultAccess/maxAccess` 固定为 `workspace/workspace`，并扩充对 `run`、`profile create`、`profile export` 与版本的能力探测。本节记录的是核对后落地方案；下文“当前 Factory”描述保留核对时发现问题的上下文。

## 1. 官方 CLI、profile 与环境变量

### 1.1 前台运行与 profile

官方 README 和 CLI 源码定义了以下主要命令：

```text
lark-channel-bridge run [--profile <name>] [--agent claude|codex]
                        [--workspace <path>] [-c <config>]
                        [--app-id <id>] [--tenant feishu|lark]

lark-channel-bridge profile create <name>
                        [--agent claude|codex]
                        [--workspace <path>]
                        [--app-id <id>] [--tenant feishu|lark]
lark-channel-bridge profile list
lark-channel-bridge profile use <name>
lark-channel-bridge profile remove <name>
lark-channel-bridge profile export <name>
```

注意 profile 名是 `profile create` 的**位置参数**，不是 `--profile` 选项。官方命令定义见 [Bridge CLI source](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/cli/index.ts#L38-L101)，命令概览见 [Bridge README](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/README.md#L112-L136)。

Factory 当前生成的授权命令：

```text
lark-channel-bridge profile create <agent-id>
  --agent claude
  --workspace <agent-workspace>
```

在 argv 形状上与官方命令一致，见本项目 [`src/core/bridge.ts`](../../src/core/bridge.ts#L34-L50)。

### 1.2 授权时的交互行为

- 不传 `--app-id`：调用 `registerApp` 进入终端二维码流程。
- 传 `--app-id`但不传 `--app-secret`：在 TTY 中隐藏输入 App Secret。
- 非 TTY 无法完成首次扫码或隐藏密码输入，因此 Web/launchd 不应直接执行首次授权。
- App Secret 不应出现在 `agentctl` argv；上游 CLI 虽提供 `--app-secret`，也明确建议共享机器优先交互输入。

官方 profile bootstrap 和 TTY 分支见 [profile-runtime.ts](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/runtime/profile-runtime.ts#L429-L469)，CLI 选项说明见 [cli/index.ts](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/cli/index.ts#L38-L62)。Factory 当前使用交互进程运行 `profile create`，这一点是兼容的，见 [`FactoryApplication.bridgeAuthorize`](../../src/application/factory-application.ts#L271-L291)。

### 1.3 Bridge 环境变量

Bridge 明确使用：

| 变量                            | 用途                                           |
| ------------------------------- | ---------------------------------------------- |
| `LARK_CHANNEL_HOME`             | 整棵 Bridge 状态根目录，默认 `~/.lark-channel` |
| `LARK_CHANNEL_PROFILE`          | 当前 profile 名，传给 Agent/lark-cli 上下文    |
| `LARK_CHANNEL_CONFIG`           | Bridge 根配置文件路径                          |
| `LARK_CHANNEL_LOG_DAYS`         | 日志保留天数覆盖                               |
| `LARK_CHANNEL_TELEMETRY_MODULE` | 可选自定义 telemetry adapter                   |
| `LARK_CHANNEL_CODEX_BIN`        | Codex 可执行文件覆盖                           |
| `LARKSUITE_CLI_CONFIG_DIR`      | profile 专属 lark-cli 配置目录                 |

Bridge 传给 Agent 的 channel 上下文实现见 [lark-channel-env.ts](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/agent/lark-channel-env.ts#L11-L30)；状态根目录解析见 [app-paths.ts](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/config/app-paths.ts#L45-L69)；数据目录说明见 [README](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/README.md#L221-L237)。

## 2. Claude/Codex 是怎样被启动的

### 2.1 Claude

Bridge 执行的核心形状是：

```text
claude -p
  --output-format stream-json
  --verbose
  --permission-mode <mode>
  --append-system-prompt-file <temporary-file>
  [--resume <session-id>]
  [--model <model>]
```

prompt 通过 stdin 传入，不放在 argv。子进程环境是 `mergeProcessEnv(process.env, bridgeOverrides)`，因此会继承 Bridge 进程已有的 `CLAUDE_CONFIG_DIR`、`HOME` 和其他变量。上游 Bridge 自身没有设置 `CLAUDE_CONFIG_DIR`。证据见 [Claude adapter](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/agent/claude/adapter.ts#L54-L90) 和 [environment merge](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/platform/spawn.ts#L26-L39)。

### 2.2 Codex

Bridge 使用 `codex exec --json ... -C <cwd> -`，并可显式设置 `CODEX_HOME`；不设时 profile 默认继承用户 Codex Home。实现见 [Codex argv](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/agent/codex/argv.ts#L14-L59) 和 [Codex adapter](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/agent/codex/adapter.ts#L85-L108)。

## 3. CC Switch 默认 Provider 的实际冲突

CC Switch 官方实现的 Claude 配置目录默认为 `~/.claude`，当用户切换 Provider 时会把当前 Provider 配置写入该目录的 `settings.json`；如果用户在 CC Switch 中设置了 `claudeConfigDir`，则写入那个自定义目录。证据见 [CC Switch config path](https://github.com/farion1231/cc-switch/blob/f38722a440b2bda3df10929758e296f2cbcd96de/src-tauri/src/config.rs#L36-L43) [and settings path](https://github.com/farion1231/cc-switch/blob/f38722a440b2bda3df10929758e296f2cbcd96de/src-tauri/src/config.rs#L166-L180)，切换时的写入见 [sync_claude_live](https://github.com/farion1231/cc-switch/blob/f38722a440b2bda3df10929758e296f2cbcd96de/src-tauri/src/services/config.rs#L212-L235)。CC Switch 官方手册也说明 Provider 的 API key/base URL 位于 `settings.json.env`，见 [CC Switch configuration manual](https://github.com/farion1231/cc-switch/blob/f38722a440b2bda3df10929758e296f2cbcd96de/docs/user-manual/zh/5-faq/5.1-config-files.md#L70-L103)。

Factory 当前的行为是：

- 构造受控环境时只继承 `HOME/PATH/...` 等白名单变量；
- Claude 员工始终注入 `CLAUDE_CONFIG_DIR=<employee runtime home>`；
- Bridge 前台运行和 Factory launchd plist 都使用同一环境。

对应代码见 [`src/core/runtime.ts`](../../src/core/runtime.ts#L7-L41)、[`src/core/bridge.ts`](../../src/core/bridge.ts#L74-L85) 和 [`src/services/factory-services.ts`](../../src/services/factory-services.ts#L14-L36)。

因此，在当前实现中：

```text
CC Switch -> ~/.claude/settings.json
Factory   -> CLAUDE_CONFIG_DIR=~/.ai-employees/runtimes/<id>/claude
Claude    -> 读员工目录，不读 ~/.claude/settings.json
```

`agentctl runtime login <id>` 还会执行 `claude auth login`，这是官方账号登录语义，与“Claude 默认使用 CC Switch Provider”的产品要求不一致，见 [`src/runtimes/claude-adapter.ts`](../../src/runtimes/claude-adapter.ts#L18-L23)。

### 建议的产品语义

按用户已明确的“Claude 默认走 CC Switch”，建议将 Claude 默认接入模式定义为 `cc-switch-default`：

1. Claude `chat/run/bridge/job` 默认不注入 `CLAUDE_CONFIG_DIR`，保留用户真实 `HOME`，从而使 `claude` 读取 CC Switch 的当前 live Provider。
2. `runtime login` 不再对 Claude 调用 `claude auth login`，改为说明/检查 CC Switch 当前配置是否可被 Claude 看到，不输出 API key。
3. Bridge 仍必须保留员工专属 `LARK_CHANNEL_HOME`；这使飞书凭据、会话和日志继续按员工隔离。
4. Web 引导从“登录 Claude”改为“确认/切换 CC Switch Provider”；不在 Web 中读取或展示 Provider Secret。
5. 需要明确记录取舍：这个默认模式共享 CC Switch/Claude 用户级 Provider 配置，不再是“每员工独立 Claude native home”。Workspace、正式记忆、Bridge home 仍可保持隔离。

CC Switch 也支持全局设置一个自定义 `claudeConfigDir`，但它是 CC Switch 的当前设备级目录，不是 Factory 可随每次 Agent 运行自动切换的 per-agent 接口。所以不应未经额外同步设计就宣称“CC Switch + 每员工独立 runtime home”同时成立。

## 4. 飞书官方接入流程

### 4.1 应用类型与凭据

官方 Bridge README 要求 **Feishu/Lark PersonalAgent app**。首次 `lark-channel-bridge run` 调用 `@larksuite/channel` 的 `registerApp`：

1. 终端显示二维码；
2. 用飞书/Lark 扫码；
3. 选择或创建 PersonalAgent；
4. SDK 返回 `client_id` 和 `client_secret`；
5. Bridge 将凭据保存在 profile 本地状态中。

见 [Bridge README first run](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/README.md#L22-L57) 和 [Bridge registration wizard](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/bot/wizard.ts#L57-L112)。飞书官方 Node SDK 也将 `registerApp` 定义为基于 OAuth 2.0 Device Authorization Grant 的一键应用注册，返回可扫描 URL 并自动注册应用，见 [Lark Node SDK App Registration](https://github.com/larksuite/node-sdk#app-registration)。

已有 PersonalAgent 可用 `--app-id cli_xxx`，Bridge 用 App ID + App Secret 换取 `tenant_access_token`并读取 bot 信息来验证凭据，见 [feishu-auth.ts](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/utils/feishu-auth.ts#L30-L71)。Lark 国际版传 `--tenant lark`。

### 4.2 权限和事件订阅

这个上游方案的基线是 **PersonalAgent + `registerApp` + `@larksuite/channel`**，不是要求用户手工创建传统 webhook 应用。Bridge 通过 `createLarkChannel(...).connect()` 建立 WebSocket 长连接，监听 SDK 抽象的 `message`、`cardAction`、`comment` 与重连事件，见 [channel construction](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/bot/channel.ts#L231-L272) 和 [event handlers/connect](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/bot/channel.ts#L335-L468)。

官方 Bridge 仓库没有列出一份要求用户手工勾选的“基线全量 scope + event key”清单，因此 Factory 不应自行编造这份清单。已能从上游确认的只有：

- 群里默认需要 `@bot`；
- 如需在群里不 `@bot` 也收到消息，需要增量 scope `im:message.group_msg`；
- Bridge 使用 `registerApp({ appId, addons: { scopes: { tenant: [...] }}})` 生成增量授权链接。

见 [app-scope.ts](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/bot/app-scope.ts#L4-L50) 和 [incremental grant wizard](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/bot/wizard.ts#L16-L48)。会议 Agent 是额外的可选功能，上游源码明确它还需 `vc:meeting.bot.join:write` 并可监听 `vc.bot.meeting_invited_v1`，不应把这些当成基础 IM 必需项，见 [profile-schema.ts](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/config/profile-schema.ts#L75-L91)。

### 4.3 Secret 和 profile 隔离

当前上游版本将 profile Secret 保存在 `<LARK_CHANNEL_HOME>/profiles/<profile>/secrets.enc`，并使用 profile-local 会话、workspace、lark-cli 和日志目录。具体路径见 [app-paths.ts](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/config/app-paths.ts#L45-L69) 和 [README data directories](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/README.md#L221-L237)。加密是本机同用户边界下的 defense-in-depth，不是 OS 级隔离，见 [keystore.ts](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/config/keystore.ts#L8-L27)。

Factory 为每个员工注入不同 `LARK_CHANNEL_HOME`，因此与上游 profile/Secret 隔离机制兼容。

## 5. launchd 兼容性

Bridge 官方后台服务在 macOS 上使用：

```text
label: ai.lark-channel-bridge.bot.<profile>
program: node <bridge-entry> run --profile <profile>
environment: PATH, LARK_CHANNEL_HOME
RunAtLoad: true
KeepAlive: true
```

官方 plist 实现见 [daemon/launchd.ts](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/daemon/launchd.ts#L34-L90)，服务命名见 [daemon/paths.ts](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/daemon/paths.ts#L38-L56)。

Factory 不使用 Bridge 自带 daemon，而是由 `com.aiemployees.<agent-id>` 调用内部 `_service bridge <id>`，再运行 Bridge 前台 `run`。这不违反 Bridge 的运行边界，并且避免同一 profile 同时被两套 launchd 管理。

但要注意：官方 plist 也只保留 `PATH` 和 `LARK_CHANNEL_HOME`。因此，如果某种 Provider 只依赖交互 shell 临时的 `ANTHROPIC_*` 环境变量，launchd 不会自动获得它们；CC Switch 的常规模式是写入 `~/.claude/settings.json`，不需依赖这些 shell-only 变量。

## 6. 当前 Factory 的兼容性差距

| 项目                                      | 结果                        | 说明/建议                                                                                                                                                                                  |
| ----------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `profile create <id> --agent --workspace` | 兼容                        | 当前 argv 符合官方 CLI。                                                                                                                                                                   |
| 无 App ID 的 QR 授权                      | 兼容                        | 必须保持在交互终端中执行。                                                                                                                                                                 |
| 已有 App ID                               | 基本兼容                    | Factory 只传 `--app-id`/`--tenant`，Secret 由 Bridge 隐藏输入，这是正确边界。                                                                                                              |
| `LARK_CHANNEL_HOME` 隔离                  | 兼容                        | 每员工不同 Bridge Home 与上游路径机制匹配。                                                                                                                                                |
| Factory 管理 launchd + Bridge `run`       | 兼容                        | 不要同时使用 Bridge `start` 管理同一 profile。                                                                                                                                             |
| Claude 默认 CC Switch                     | **不兼容**                  | 移除 Claude 默认路径上的 per-agent `CLAUDE_CONFIG_DIR`，调整 runtime 引导/doctor。                                                                                                         |
| Bridge profile 默认权限                   | **不符合 Factory 安全默认** | profile 创建后需将 `permissions.defaultAccess/maxAccess` 收紧为 `workspace`，否则 Claude 是 `bypassPermissions`。                                                                          |
| 能力探测                                  | **不完整**                  | 当前只检查 `run --help` 的 `--profile/--agent/--workspace`，还应检查 `profile create/export`、`--app-id`、`--tenant`和安装版本。                                                           |
| Bridge 授权状态                           | **语义偏弱**                | `profile export` 成功只能证明 profile 可导出，不能证明 WebSocket 能连接或 bot 能收发。                                                                                                     |
| 版本保证                                  | **已加固（TASK-051）**      | 上游 main 是 0.7.0；本机 `lark-channel-bridge --version` 已由 0.5.9 升级到 0.7.0。0.7.0 与 0.5.9 的 JSONL 事件名/字段（intake/run/agent/card）与 CLI 面（`--version`/`run`/`profile create | export`）经 bundle 比对全保留，`usage audit` parser 无感；doctor 能力探测对 0.7.0 报 pass。 |

Bridge 新 profile 默认 `full/full`，且权限映射为 Claude `bypassPermissions` / Codex `danger-full-access`，见 [Bridge permissions implementation](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/config/permissions.ts#L93-L128) 和 [defaultPermissions](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/src/config/permissions.ts#L176-L181)。Factory 当前能力检查只查三个 `run` 参数，见 [`BridgeAdapter.inspectCapabilities`](../../src/core/bridge.ts#L58-L71)；`bridge status` 把 `profile export` 成功当成 ready，见 [`FactoryApplication.bridgeStatus`](../../src/application/factory-application.ts#L294-L305)。

## 7. 建议的实施顺序

1. 先把 Claude 默认 runtime 语义改为 `cc-switch-default`，同步 CLI/Web/doctor/README，明确共享 Provider 配置与独立 Workspace/Bridge 的边界。
2. 保留 `agentctl bridge authorize <id>` 交互终端入口，使用官方 `profile create <id>` PersonalAgent 扫码流程。
3. profile 创建后以官方可支持的配置更新方式把权限收紧到 `workspace`，不直接猜测不稳定的 JSON 内部结构；若 CLI 无对应公共命令，应先锁定并测试支持版本。
4. 扩充能力探测和 doctor，分开“profile 存在”“凭据存在”“服务正在运行”“WebSocket/bot 实际可用”四个状态。
5. 用临时 `HOME`、fake `claude`、fake Bridge 和 fake `launchctl` 回归验证：Claude 路径不再注入 per-agent `CLAUDE_CONFIG_DIR`，Bridge 仍只使用员工专属 `LARK_CHANNEL_HOME`，且 Secret 不进 argv/plist/日志。

## 来源

- [lark-coding-agent-bridge repository](https://github.com/zarazhangrui/lark-coding-agent-bridge/tree/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c)
- [lark-coding-agent-bridge README](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/README.md)
- [lark-coding-agent-bridge package.json 0.7.0](https://github.com/zarazhangrui/lark-coding-agent-bridge/blob/e5d3ce57ca95212cfa53965a6f2cc2d998aa691c/package.json#L1-L8)
- [Lark official Node SDK: App Registration and Channel](https://github.com/larksuite/node-sdk)
- [CC Switch repository](https://github.com/farion1231/cc-switch/tree/f38722a440b2bda3df10929758e296f2cbcd96de)
- [CC Switch configuration manual](https://github.com/farion1231/cc-switch/blob/f38722a440b2bda3df10929758e296f2cbcd96de/docs/user-manual/zh/5-faq/5.1-config-files.md)
