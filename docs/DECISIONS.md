# Decisions

## D-001：单包分层架构

v1 使用单 npm 包，通过 core/runtime/service/schema 边界保留扩展性，不引入 workspaces 发布成本。

## D-002：Factory 管理 launchd

Factory 启动 Bridge 的前台 `run` 命令，不委托 Bridge 自有 daemon，以强制注入隔离环境、统一日志和状态。

## D-003：Skill 按 Agent 复制与作用域分离

- 状态：Evolved（原 v1 为单一项目级源；现按作用域分离，见下）
- 决定：Skill 按 Agent 独立复制，并按作用域分为两级，两处存储互不共享：
  - **project（项目级）**：存于 `workspace/skills/<name>/`，投影到项目发现目录 `workspace/.claude/skills/<name>`（Claude）/ `workspace/.codex/skills/<name>`（Codex）。随 Agent 工作区 git 进入版本管理，进入默认备份。
  - **user（用户级）**：原位存于 `runtimeHome/skills/<name>/`（= CLAUDE_CONFIG_DIR/CODEX_HOME 的 skills，即运行器原生用户级发现目录）。属于员工运行时身份，默认不进备份（仅 `includeRuntime` 时打包）。
- 边界：不同 Agent 不得连接同一实时共享 Skill 目录；用户级 store 仅统计真实目录（跳过历史 Codex preset 投影软链）。安装复用 `SkillService.install`，拒绝源内软链接（R6）。
- 原因：原单一 `workspace/skills/` 造成 Claude（项目级）与 Codex（用户级）的 Provider 不对称；显式作用域让 UI 按项目级/用户级分类展示，并让备份语义清晰（项目级随工作区、用户级仅随 Runtime）。

## D-008：Skill 商店（远端 GitHub 仓库源）

- 状态：Accepted
- 日期：2026-08-04
- 决定：新增 `agentctl skill-store` 命令组与「Skill 商店」顶级页，把可配置的远端 GitHub 仓库源（`config.yaml` 的 `skill_store.repositories`）浅克隆到 `~/.ai-employees/skill-store/cache/<name>/`，用 `agent-skills.yaml/json` 清单或扫描 `SKILL.md` 发现技能，安装复用 `SkillService.install`（传递源路径）。
- 边界：仅接受 `https://github.com/` 公开仓库；仓库源上限 20 个；安装沿用既有作用域（project/user）与软链接拒绝规则。不改变任何既有安装方式（上传目录 / 本地路径 / CLI）。
- 原因：满足「连接远端 GitHub 仓库共享技能」的需求，同时不破坏既有安装方式；内置默认仓库源（superpowers、anthropic-skills）作为可配置列表的起点。

## D-004：非破坏归档和可验证备份

archive/remove 优先移入归档区。默认备份排除凭据和 runtime；包含 runtime 时强制 scrypt + AES-256-GCM 加密。
例外：Skill remove（D-003 演进）是用户决策的彻底卸载——直接删除技能目录（项目级含投影软链，用户级含 runtimeHome 原位目录），不可恢复、不再进归档区；Agent/Job 归档仍走归档区。

## D-005：本地临时 Web 控制面

- 状态：Accepted
- 日期：2026-08-03
- 决定：`agentctl web` 只绑定 `127.0.0.1`，使用一次性 fragment token 交换 HttpOnly 会话并对修改请求验证 Origin/CSRF。CLI 和 Web 共用 `FactoryApplication`。
- 边界：不提供 `--host`、常驻服务、账号系统或嵌入终端。Runtime 登录、飞书授权和交互聊天仍由隔离的 CLI 入口完成。
- 原因：保留本地单用户的低配置体验，同时避免将本机 Agent 管理面暴露到网络或在浏览器重做终端安全边界。

## D-006：Claude 默认同步 CC Switch Provider

- 状态：Accepted
- 日期：2026-08-03
- 决定：Claude 不执行官方 OAuth 登录。Factory 在运行前从 CC Switch 当前 live `settings.json` 读取 Provider 白名单字段，原子同步到员工专属 `CLAUDE_CONFIG_DIR`。
- 边界：只同步 API endpoint/token、模型别名和相关 Claude Provider 开关；不复制 OAuth、会话、历史、MCP、权限、主题或其他个人设置。摘要和日志只记录字段名，不记录值。
- 原因：满足 CC Switch 为默认 Provider 控制面的产品要求，同时保留不同员工的原生会话、Skills 和配置目录隔离。

## D-007：Bridge 使用官方 PersonalAgent 并固定 workspace 权限

- 状态：Accepted
- 日期：2026-08-03
- 决定：沿用 `lark-coding-agent-bridge profile create` 的扫码/已有 App ID 流程及 WebSocket 长连接；授权后把 profile `permissions.defaultAccess/maxAccess` 固定为 `workspace`。
- 边界：首次授权只在终端进行，App Secret 不进 agentctl argv；Factory 管理前台 `run` 的 launchd，不同时使用 Bridge daemon。
- 原因：官方新 profile 默认 `full/full`，会映射为 Claude `bypassPermissions` 或 Codex `danger-full-access`，与 Factory 的 workspace 安全默认冲突。

## D-008：Factory 自管七天员工回收站

- 状态：Accepted
- 日期：2026-08-03
- 决定：一键移除员工时不立即永久删除，而是停止全部服务、移出六类受管路径并从 Registry 移除；7 天内允许恢复。
- 清理：不安装后台 daemon。条目到期后，在下次启动 Web 或运行公开 CLI 时永久清理。
- 存储：组件移动到原父目录下隐藏的 `.agentctl-trash`，中心 manifest 以 0600 保存且不包含文件内容或 Secret。
- 原因：测试员工需要立即从活动列表和路径中消失，同时必须避免误操作导致 Workspace、飞书凭据或正式记忆不可恢复。

## D-009：封存不变量与版本化契约的演进流程

- 状态：Accepted
- 日期：2026-08-03
- 决定：把对外契约分两类管理。**封存不变量（frozen）**：语义对外固定，实现可经安全评审升级--典型为 `assertInside` 的「路径包含由核心执行」语义、Bridge profile `workspace/workspace` 权限不放宽、D-006「SyncSummary 只返回字段名不返回值」。frozen 实现升级须同时满足：(a) 记 ADR；(b) 对外语义不变；(c) 补回归测试；(d) 不放宽安全默认。**版本化契约（versioned）**：可经 schema 版本号 bump + 显式分派调整--典型为 env 白名单（`runtime.ts` `safeInheritedVariables`，及 OP5-B 起外置到 `presets/cc-switch-allowlist.json` 的 CC Switch 白名单）与配置 schema；调整须版本号 bump、显式分派与迁移说明，禁止静默全局改写（与红队 B2 一致）。
- 边界：本决策不改变任何既有不变量的语义，只确立其演进流程。`assertInside`（`paths.ts:77`）保持 frozen 语义，实现允许升级为 realpath 补全（OP2-B）；env 白名单从隐含 frozen 降为 versioned，为后续白名单调整铺路。
- 原因：原 `extension-surface.md` 把上述项笼统标为「封存不变量 frozen」，但安全实现需迭代（realpath 抵抗符号链接、白名单收紧），缺乏「语义不变、实现可演进」的流程会导致要么不敢改、要么静默改坏对外契约。frozen/versioned 二分让安全实现可迭代而不破坏对外承诺。

## D-010：agent.yaml 为 runtime 块单一可写源 + config_hash 漂移检测

- 状态：Accepted
- 日期：2026-08-04
- 决定：`agent.yaml` 的 `runtime` 块（provider/locked/model）为唯一可写真相；Registry 的 `runtime` 块降级为派生缓存，新增 `config_hash`（runtime 块的 sha256）做漂移指纹。`RegistryStore.updateAgent` 拒绝 `model` 直改（`CONFLICT`，提示经 `agentctl repair`）；新增 `RegistryStore.resyncRuntime` 作为 repair 的受信重建路径--允许 model 从 agent.yaml 同步，但 provider/locked 不变量仍强制（违则 `CONFLICT`，不覆盖）。`agentctl repair <id>` 以 agent.yaml 重建 Registry runtime 块 + 刷新 config_hash；doctor 增 `config-drift` 检查（hash 不等或缺失 -> warn，remediation 指向 repair）。create/restore 流程在写 agent.yaml 后即记 config_hash。
- 边界（本批非破坏性增量）：Registry `runtime` 块**不移除**（长期项，需破坏性 schema-bump + migrate，deferred）；`loadPortableConfig` **不启用** I-5 model 收紧校验（框架「待 OP3-A 长期完成 + repair 就绪」，repair 虽就绪但长期未完成）；`agentctl migrate` 命令不实现（属 OP3-B 范畴）；adapter 仍读 `RegistryAgent.runtime.model` 缓存，单源化不改读路径。
- config_hash 取 runtime 块 sha256（非整文件）的裁定理由：精确覆盖 OP3-A 的 runtime 单源范围，避免 archive（写 lifecycle 块）/ identity 文档变更等合法 agent.yaml 改写误报漂移；框架原文「agent.yaml 的 sha256」在此细化为 runtime 块 sha256。
- 原因：红队 B3/W5 指出 Registry 与 agent.yaml 各持 runtime 块（双真相源），`updateAgent` 允许改 model 不同步 agent.yaml -> 静默漂移；收紧校验（I-5）只会把「静默漂移」变「硬砖」而无修复路径。本决策以 agent.yaml 为唯一可写真相 + config_hash 漂移检测 + repair 重建路径，从根因消解双写，而非加校验。经核实四处 `updateAgent` 调用均不动 model、restore 用 `registry.add` 非 `updateAgent`，故 model 守卫零破坏。

## D-011：OP1 Stage A authority_order 运行时强制 + 派生 stance 注入

- 状态：Accepted
- 日期：2026-08-04
- 决定：`agent.yaml.memory` 增 `enforced: boolean`（optional，向后兼容旧 agent.yaml 视为未声明）。`enforced:true` 时 `FactoryApplication.prepareRuntime` 在 spawn 前经 `validateMemoryConfig` 强制校验 `authority_order` 不变量--非空、`'agent'` 必须在场且居首（R26「新层不得排在 agent 之前」）、无重复层；违则 `VALIDATION_ERROR` 硬失败，不让误配 agent 跑起来。`enforced` 缺失（旧）或 `false` 不硬失败（doctor warn），保留降级逃生口。权威顺序 stance 从 `authority_order` 派生为 markdown 段，写入 CLAUDE.md / AGENTS.md（CLI 读取的系统提示文件），替代 ENTRY.md.tmpl 的硬编码散文--改 agent.yaml 即改注入立场。doctor 增 `memory-enforcement` 检查（4 态：undefined warn / false warn / true+无效 fail / true+有效 pass）。新建员工默认 `enforced:true`。
- 边界（本批仅 OP1 Stage A）：不实现 Stage B（knowledge 索引 + recall）/ Stage C（transcript 持久化）/ Stage D（ExperienceExtractor）/ Stage E（archival 后端）--数据可达性门控，逐 Stage 立项；不接 `resolveConflict` 热路径（无 KnowledgeIndex 调用方）；不做 CLAUDE.md/AGENTS.md 内容漂移检测（脆弱，仅 config 级一致性，stance 重建留待未来 repair 扩展）；`schema_version` 不 bump（additive optional 字段）；不动隔离层 / CC Switch / 备份回收。
- documentFile 偏离裁定：框架提及「documentFile 路径强制校验」，经核实 documentFile 已强制身份文档路径不变量（assertInside + realpath + 拒符号链接），即身份文档层（authority 'agent'）的写入约束已就位；在 documentFile 再叠 memory 校验会令误配 agent 无法修复自身身份文档（损害可恢复性）。故 Stage A 的 memory 强制只在 prepareRuntime（pre-run 硬门），documentFile 维持既有路径校验。
- 原因：红队 W1 指出 `authority_order` 硬编码（create-agent.ts）但无任何代码运行时强制，`knowledge/` 5 子目录为空骨架--认知记忆层「声明型、不强制、随 schema 演进被误删」（maintainability-review §2.5）。设计原则「先让既有声明型字段成为运行时强制项，再谈新增检索层」（A1）：本决策先把 authority_order 从声明升级为运行时强制 + 派生注入，避免新增检索层（Stage B）重蹈「声明不强制」覆辙。enforced 三态保证向后兼容（旧 agent.yaml 不硬砖）+ 可降级（false 逃生口）。

## D-012：OP3-A 长期——Registry 移除 runtime 块 + config_hash 硬校验 + SOFT 版本化迁移

- 状态：Accepted
- 日期：2026-08-04
- 决定：把 D-010 的中期收敛推进到长期目标——**从 Registry 彻底移除 `runtime` 块**（provider/locked/model），使 `agent.yaml` 成为 runtime 的**唯一**来源；同时启用 D-010 推迟的 **I-5 model 收紧**（model 一致性纳入强制校验）；并新增破坏性 `agentctl migrate` 命令处理 schema v1→v2 升级。删除 registry runtime 块是安全的：其中所有数据（provider/locked/model）都存在于 agent.yaml，它纯粹是派生缓存。
  - **I-5 = HARD 硬校验**：`loadPortableConfig` 校验 `config.id === agent.id` 且 `computeConfigHash(config.runtime) === agent.config_hash`；任一不符（含 config_hash 缺失）抛 `CONFLICT` 阻断运行，remediation 指向 `agentctl repair`。`repairAgent` 是逃生口——绕过 `loadPortableConfig` 直接 `readAgentConfigFile` 读 agent.yaml 原样，重算 config_hash 并 `registry.refreshConfigHash` 修复。
  - **Registry migrate = SOFT 版本化读取**：`read()` 对 v1 文件在内存中规范化为 v2（丢弃 runtime 块、保留 config_hash 与其余字段，零数据丢失），命令照常可用；`agentctl migrate --dry-run` 预览、`agentctl migrate` 重写磁盘为 v2 清理残留。未知版本抛 `VALIDATION_ERROR`。
  - **list()/dashboard() provider = N+1 读 agent.yaml**：逐个读每个 agent.yaml 取实时 provider（单一真相源，派生缓存永不漂移）；缺失/无效 yaml 容错显示 `unknown`。
- 边界：`migrate` 为破坏性命令（改磁盘格式），但 SOFT 语义保证 v1 文件不迁移也能继续运行（内存规范化），故不强制用户立即迁移；旧 v1 备份的 `registry-agent.yaml` 在 restore 时用 `registryAgentSchema`（v2）解析，provider 从恢复的 agent.yaml 读取。
- 原因：D-010 是中期收敛（registry runtime 块仍为派生缓存、`loadPortableConfig` 未启用 I-5、`migrate` 未实现、adapter 仍读缓存）；长期目标要求单一真相源不再有派生缓存副本，消除双真相源残余与「缓存永漂移」问题。HARD 校验把「静默漂移」变「硬砖」，但 D-010 已就绪的 repair 逃生口保证可恢复；SOFT 迁移避免破坏性升级强行打断 v1 用户。

状态使用 Accepted、Superseded、Proposed。日期来自已验证的实现或提交；无法证明的动机不写成事实。

## D-013：OP2-F 扩展面能力隔离——扩展点限定为 data-only / adapter-interface

- 状态：Accepted
- 日期：2026-08-04
- 决定：把可扩展点（`BackupFilter`、`PathLayout`、`PortableMemorySchema`、未来的 `CredentialProvider`）收敛为**纯数据（data-only）或 adapter 接口**契约，禁止同进程 JS 模块直接持有 `fs`/`execa`。代码型扩展（若未来需要）必须运行在子进程/Worker 并经 IPC 限制能力。具体落地：
  - `src/core/extensions.ts`：定义 `ExtensionKind = 'data-only' | 'adapter-interface' | 'subprocess'` 与评审用 `ExtensionSandbox` 契约类型（v1 不固化加载器）。
  - `src/core/backup.ts`：`shouldCopy`/排除名单从模块级硬编码收敛为 `BackupFilter` 接口 + `defaultBackupFilter()`（纯函数、零 I/O），`BackupService` 构造注入。
  - `src/core/paths.ts`：`PathLayout` 接口（根必须位于 home/workspaceRoot 树内）+ `resolvePathLayout` 派生助手。
  - `src/schemas/agent-schema.ts`：导出 `PortableMemorySchema` 类型（memory 块权威类型，供扩展点引用）。
- 边界：本批只确立契约与默认实现，不实现加载器、不新增任何可执行扩展；`assertInside`/`assertInsideReal` 不变量语义不变；`RuntimeAdapter`/`ServiceAdapter` 等已固化扩展点保持接口形态（`buildExecEnv` 委托 adapter 属 OP3-C 已落地）。
- 原因：红队 R23 指出扩展点若以同进程 JS 模块加载并直接持有 `fs`/`execa`，会在扩展机制建立的瞬间引入「插件可触碰宿主文件系统/进程」的权限面。把扩展点约化为纯数据或受限 adapter 接口，从根因消除该面，而非事后加校验。与 D-009（frozen/versioned 二分）一致：data-only 契约不放松安全默认。

## D-014：OP1 Stage E archival 后端写入前置约束（frozen 不变量，先于任何后端实现）

- 状态：Accepted
- 日期：2026-08-04
- 决定：把 archival 后端的写入约束写成 **frozen 不变量**，在任何后端实现之前先确立契约。`src/core/archival.ts`（新增）仅定义 `ArchivalBackend` 接口（`kind: 'local-sqlite' | 'external' | 'none'`，默认 `none`），不实现任何后端。未来新增后端的 **写入硬约束**（frozen，实现不得放宽）：
  1. **Secret 过滤**：写入前必须经核心 secret 正则（`SECRET_PATTERN`）过滤，禁止原始 Secret 落盘。
  2. **per-entry 显式授权**：必须经用户显式 per-entry 授权，不得隐式归档用户未确认的内容。
  3. **范围隔离**：不得传输 `runtime_home` / `bridge` 内容；仅工作区可迁移身份知识（`knowledge/`、identity 文档）可归档。
  4. **威胁模型评审**：网络面 / 多租户威胁模型须经安全评审（external 后端尤其如此）。
- 边界：本批只确立契约与文档，不实现 `local-sqlite` / `external` 后端，不接入任何调用方，不改变既有 `PruneService` 归档区清理语义（`archives` 清理范围照旧）。archival 后端与既有本地归档区（archive/trash）是不同概念：前者是外部/持久化归档目标，后者是本地可恢复目录。
- 原因：OP1 Stage E 的目标是把「归档到外部后端」这个未来能力的安全边界先钉死，避免实现时引入 secret 泄露（写原始 transcript/内存）或越权传输（把 runtime_home/bridge 内容带出）。与 D-006（不落盘 Secret）、D-009（frozen/versioned 二分）、D-013（扩展点限定 data-only/adapter-interface）一致——先约束后实现。

## D-015：换机重授权成本（OP5-C 调研裁定）

- 状态：Accepted
- 日期：2026-08-04
- 决定：换机重授权可显著降低但不为零，保留「交互授权」为硬边界。调研结论（详见 `.scratch/op5-c-migration.md`）：
  1. **Codex OAuth token 可迁移**：`~/.codex/auth.json`（0600，含 `id_token`/`access_token`/`refresh_token`/`account_id`）官方文档确认**不绑定主机**，可在换机时复制；但 token 会轮换（文件随时间变化），且若用户配置 Keychain 存储（`cli_auth_credentials_store = "keyring"`）则复制法不适用，须重新登录。
  2. **飞书非扫码路径存在**：`lark-channel-bridge profile create --app-id --app-secret --tenant` 用既有 Feishu/Lark 应用凭据建 profile（App Secret 进加密 keystore `profiles/<name>/secrets.enc`，0600），无需扫码；但 `--app-secret` 建议交互输入，扫码路径仍须人在场（D-005）。
  3. **Claude 已非交互**：CC Switch 同步（OP5-B 起带 mtime 缓存 + `.cc-switch.env` 降级）换机 0 次交互，仅需新机配置 CC Switch。
  4. **不实现 `agentctl migrate` 向导**（`MigrationWizard` 接口保持设计级草图）：OP5-C 原始为「立项评估，非承诺」，当前交付以文档明确换机清单与可降低路径，而非强推自动化。推荐配置下每员工 0 次交互，最坏情形每员工 2 次（Codex 重登 + 飞书扫码）。
- 边界：本裁定不引入任何代码改动；Factory 不自动复制/注入凭据（守 D-006——复制 `auth.json`/App 凭据属用户在换机时的主动运维行为，不在 Factory 自动传输面）。`agentctl migrate` 仍指 Registry schema v1→v2 迁移（OP3-A 长期，TASK-019），不扩展为换机向导。
- 原因：C4 评估「10 员工 × 3 次交互授权」过高——实际调研显示 Codex token 可迁移、飞书有 App 凭据路径、Claude 已非交互，推荐配置下可降至 0 次/员工。文档交付比强推向导更符合「非承诺」立项边界，避免为实现而实现。

## D-016：OP5-D per-agent Provider 绑定（Registry 本机侧，不进便携文件）

- 状态：Accepted
- 日期：2026-08-04
- 决定：为 Claude 员工新增「绑定 CC Switch 中具体 Provider（而非当前 live）」的能力。`registryAgentSchema` 增 `credential_provider?: string`（Registry 本机绑定侧）；`syncCcSwitchClaudeProvider` 增 `providerName` 参数，指定时从 `~/.cc-switch/cc-switch.db`（SQLite）读取该 Provider 的 `settings_config`（白名单过滤，复用 OP5-B），否则沿用 live `settings.json`。`agentctl runtime sync <id> --provider <name>` 写绑定并同步，`--provider live` 清除绑定回退 live；spawn 前 `prepareRuntime` 把 `registry.credential_provider` 透传给同步。doctor 增 `credential-provider` 检查：有绑定 → warn（短期语义，长期将按 provider 不匹配 fail），无绑定 → pass。
- 读库机制：CI/运行时基线 Node 20.19 无 `node:sqlite`（Node 22.5+），不引入原生依赖；改用 `sqlite3` CLI 只读查询（`-readonly -json`，macOS/ubuntu CI 均自带）。sqlite3 打开不存在的文件失败（退出码 1）→ 报 NOT_FOUND 并列出可用 Provider；不存在的 Provider → NOT_FOUND。名称经单引号转义（`''`）嵌入 SQL，避免注入。sqlite3 缺失/读取失败时回退为 NOT_FOUND（比静默绑定错误 Provider 更安全）。
- 边界（本批短期语义）：`credential_provider` **不进便携文件** `agent.yaml`——属 Registry 本机绑定侧（守 D-006 与 OP3-A「agent.yaml 为 runtime 唯一真相」的便携面），换机不迁移该绑定；`--provider live` 显式清除。不实现「自动读取 live」外的任何多 Provider 指纹校验（研究提案 C5 明确不采用 `pinned_provider` 指纹方案）。doctor 短期为 warn（非 fail），长期语义（provider 不匹配 fail）留待后续批次。
- 原因：让不同员工可绑定不同 CC Switch Provider（如 A 员工用 DeepSeek、B 员工用 Kimi），独立于当前 live Provider 切换，且不复制凭据到便携文件、不改任何既有 live 同步语义（缺省 providerName 时零行为变更）。CI 无 sqlite3 时的 NOT_FOUND 回退符合「显式绑定不可达则失败」的最小惊讶原则，避免静默同步到错误 Provider。

## D-001 - 引入多 Agent 协作骨架

- 状态：Accepted
- 日期：2026-08-03
- 背景：本项目需要被多个 AI Agent 并行编辑或在任意时刻交接，必须有持久化的事实来源替代易失的聊天上下文。
- 候选方案：仅依赖聊天记录；仅用 Git 分支无簿记；铺设 `.agent/` 协作簿记 + 文档体系骨架。
- 最终选择：通过 `multi-agent-project-skill` 的 `init_workspace.py` 生成完整骨架（入口层 + docs + skills + `.agent/` + 技术栈基线）。
- 选择原因：仓库是持久事实来源；簿记层让无聊天记录的 Agent 也能接手；文档体系让规则与代码不漂移。
- 影响范围：项目根、`docs/`、`skills/`、`.agent/`、`.github/workflows/ci.yml`、`.gitignore`。
- 后续注意：`.agent/` 必须提交到仓库；平台适配文件只指向 AGENTS.md，不复制规则。

---

> 后续决策按 `D-XXX - 标题` 格式追加。模板见 [.agent/decisions/ADR-0000-template.md](../.agent/decisions/ADR-0000-template.md)。重要技术取舍（架构、API、数据、依赖、跨模块规则）须记录于此。
