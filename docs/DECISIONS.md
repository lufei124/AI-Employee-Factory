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

## D-017：Chief 交叉审查用编排器单向搬运，不放开 D-003

> **⚠️ 已废弃（D-027）**：Chief 编排与 Todo 状态机已整体移除，本决策不再适用。

- 状态：Accepted（grilling 待实施）
- 日期：2026-08-05
- 决定：Todo/Chief 的「等待审查」态由 Chief 交叉审查，但 Chief **不直接读写任一 worker 的 workspace**。Node 编排器读 worker 的 `diff.patch`（受控工件）+ `logs/<workerId>/runs/<slug>/stdout.log`，经 `redactSecrets` 脱敏后拼进 Chief 的 REVIEW_PROMPT，Chief 返回评审结论。编排器单向搬运文本，Chief 自始至终零 worker 文件系统访问。
- 边界：D-003（「Agent 永不共享实时目录」）保持不动，无需放开。拒绝「显式授权只读挂载」方案（需新只读 runtime 模式，claude 无只读 flag / codex sandbox 写死 workspace-write，工程量大且直接放宽隔离）。
- 原因：Chief 交叉审查（用户选择）与 D-003 隔离模型冲突；编排器单向搬运是唯一两全路径——Chief 的「看到」是编排器喂文本，不是开文件系统。工人产物写自己 workspace（git 版本化），编排器只读受控工件 + 日志，脱敏后喂给 Chief。

## D-018：MCP 认证——MVP 用静态 bearer，OAuth AS 自建降级为后续阶段

> **⚠️ 已废弃（D-027）**：MCP 接入已整体移除，本决策不再适用。

- 状态：Accepted（已实施，T11）
- 日期：2026-08-05
- 决定：MCP 接入挂到现有 Fastify `POST/GET /mcp`，MVP 认证用**静态 bearer token**（随 `startWebConsole` 生成并打印，客户端用 `Authorization: Bearer <token>` 连接）。实现采用 `@modelcontextprotocol/sdk@^1.30.0` 的 `StreamableHTTPServerTransport`，经 `request.raw`/`reply.raw` 直接接到既有 Fastify 实例（共享进程生命周期）；认证为手写 `mcpAuthorized`（`Bearer` 正则 + `crypto.timingSafeEqual` 恒定时间比较）；loopback 边界复用既有全局 `onRequest` 的 127.0.0.1 校验。自建 OAuth Authorization Server（token 签发 + DCR + 授权码/设备流程）降级为后续阶段。
- 边界：MCP 是同一 loopback 边界上的第二个认证面——D-005「不提供账号系统」针对 Web 的语义不变，MCP 加 bearer 不改其语义（仍无账号、仍 loopback-only）。`/mcp` 不在 `/api/v1/*` 的 CSRF 钩子范围内（server.ts onRequest L136 对非 /api/v1/ 直接 return），互不干扰。
- 原因：用户最初倾向「OAuth 2.1 为主」，但经逐包核实，`@modelcontextprotocol/server@2.0.0` 只提供 **Resource Server（token 校验）侧**（`OAuthTokenVerifier` 接口、`verifyBearerToken`、RFC 9728 metadata），**不含 Authorization Server**——无 token 签发、无 DCR、无授权码流程，且 `@modelcontextprotocol/oauth` 包不存在（404）。「OAuth 为主」意味着从零自建 AS，远超 MCP 最小切片。Static bearer 是 MCP 三端（Claude Code/Cursor/VS Code）共同支持的最低公分母，先把能力接通。实现时另核实 `@modelcontextprotocol/fastify@2.0.0` 的 `createMcpFastifyApp` 会自建独立 Fastify 实例（无法挂进既有 /api/v1 控制台），且 `@modelcontextprotocol/server` 的 bearer 校验叠加非必要 OAuth 依赖链，故以 `@modelcontextprotocol/sdk` 的 StreamableHTTP transport + 手写恒定时间 bearer 落地（D-018 决定行据此于实施期修订）。OAuth AS 留作独立后续阶段。

## D-021：MCP 工具集——读 + 编排写，单一应用 seam，JSON 主路径响应

> **⚠️ 已废弃（D-027）**：MCP 接入已整体移除，本决策不再适用。

- 状态：Accepted（已实施，T12/T13）
- 日期：2026-08-05
- 决定：在 D-018 的 MCP 端点注册 **13 个工具**——读 8：`list_agents`/`get_agent`/`list_operations`/`get_operation`/`list_jobs`/`list_skills`/`read_latest_log`/`knowledge_recall`；编排写 5：`create_task_plan`/`run_task_plan`/`approve_plan`/`review_task_plan`/`cancel_operation`。工具是 `FactoryApplication` 的**薄适配器**（`McpBackend` 接口注入 `options.application`），穿过应用编排层单一入口，与 Web/CLI 共享同一行为（spec 阶段 3 的测试 seam 原则）。`run_task_plan` 返回排队态 `OperationDto`，客户端轮询 `get_operation`（主路径轮询）；`cancel_operation` 复用 `operationManager.cancel(id)`。
- **JSON 主路径响应（偏离 spec 措辞的 SSE→MCP）**：transport 以 `enableJsonResponse: true` 运行，POST JSON-RPC 请求返回 JSON 响应体（而非 SSE 帧），简化轮询客户端集成；GET `/mcp` 的 SSE 流保留。spec 阶段 3 的「SSE→MCP / 主路径轮询 = 工具返回 OperationDto + 轮询 get_operation」语义不变，仅传输槽位从 SSE 帧改为 JSON 响应。客户端仍须在 initialize 后携带 `mcp-session-id`。
- 边界：脱敏约束由应用 seam 保证——`AgentConfig`/`RegistryAgent` 均不含原始 Secret（token/app_secret 不进入便携配置），MCP 层不新增任何 secret 读取面；测试固定「读工具不泄露注入工作区的 secret 形态 token」作为回归守卫。`list_operations`/`run_task_plan`/`read_latest_log` 的过滤/并发/行长参数为 spec 之外的合理性 affordance，不改变 spec 工具语义。
- 原因：spec 阶段 3 的 grilling Q9 明确读+编排写工具集；thin-adapter 保证三面（CLI/Web/MCP）共用同一行为与脱敏约束，避免 MCP 形成第二套逻辑。JSON 主路径响应降低 MCP 客户端（Claude Code/Cursor/VS Code）轮询成本，SSE 增强路径（请求内 progress）与推送路径（subscriptions/listen）均留作后续。

## D-022：Web Todo 视图渲染审查结论，不持久化原始 diff

> **⚠️ 已废弃（D-027）**：Web Todo 视图随 Chief 编排/Todo 移除，本决策不再适用。

- 状态：Accepted（已实施，issue 07）
- 日期：2026-08-05
- 决定：Web 员工详情页「Todo」标签渲染**已存储的审查结论** `item.review { verdict, note }`（verdict 本地化为已通过/已驳回），**不展示原始 diff**。原因：按 D-017，`reviewTaskPlan` 由编排器从 worker workspace **实时读取** `diff.patch` 与运行日志、脱敏后喂 Chief，原始 diff **不写回计划文件**——计划文件只持久化 Chief 返回的结构化 verdict+note。因此 Web 无从读取 diff（它只读计划文件），展示 verdict+note 是唯一不新增网面的选择。
- 边界：issue 07 的「走完 Todo 流程」原只含看状态、确认/驳回计划、确认合并/驳回审查——**创建/派发/Chief 发起由 D-024 于 TASK-027 放开**（Web 可编排）；本决策的「Web 不实现派发与任务项创建」措辞被 D-024 取代，但「不展示原始 diff」边界保持。若需 Web 展示原始 diff，属后续增强（读 worker 产物路径，见 ARCHITECTURE「Chief 编排与 Todo 状态机」）。
- 原因：避免 scope creep（派发是 CLI 范畴）与避免为展示 diff 而放开隔离语义/新增读面；保持 Web 只读 + 两种闸门（计划级确认/驳回、审查级合并/驳回）的最小网面。

## D-024：Web 编排写面开放——创建/派发/Chief 发起/单轮对话，全部后台 Operation

> **⚠️ 已废弃（D-027）**：Web 编排写面（建计划/加任务项/派发/Chief 发起）随 Chief 编排/Todo 移除；「单轮对话」部分保留（`/actions/chat`，D-024 的对话语义不变）。

- 状态：Accepted（已实施，TASK-027）
- 日期：2026-08-05
- 决定：放开 D-022/D-023 的「Web 只读」边界，Web 控制台新增编排写面与单轮对话：
  - **Todo 写面**：`POST /api/v1/agents/:id/task-plans`（建计划，planId 由 Web 生成 `plan-<8hex>`）、`POST .../task-plans/:planId/items`（加任务项）、`POST .../task-plans/:planId/actions/run`（派发）。
  - **Chief 发起**：`POST /api/v1/agents/:id/actions/chief-run` —— `startPlanWithChief` 把阻塞的 `planWithChief` 放进后台 Operation（拆解耗时几十秒不阻塞 HTTP），完成后停在 draft 等人工确认；确认/驳回是独立显式步骤（等价 CLI inquirer 门）。
  - **单轮对话**：`POST /api/v1/agents/:id/actions/chat` —— 走 `runLogged`（复用 transcript/experience 管线，`transcript_persist` opt-in），`claude -p`/`codex exec` 非交互单轮，无需新 adapter；Operation 完成时把最终回答作为 output 事件写入，前端轮询读回。
  - **统一模式**：全部写操作返回 202 + `OperationDto`（后台 Operation），前端轮询 `/api/v1/operations/:id/events`；不引入同步长请求。Web 与 CLI/MCP 共享 `FactoryApplication` 同一编排层（D-021 单一应用 seam 原则）。
- 边界：**原始 diff 仍不持久化**（D-022 保持——Web 仍不展示 diff，审查结论 verdict+note 是唯一持久化形态）；对话会话记录不落盘（D-006 的 transcript 边界——`runChat` 无锁、`mirror: false`，与 CLI chat 一致）；`concurrency` 仅作派发参数，Chief 发起时不自动派发。S3（飞书入站创建 todo）无入站基础设施，单独立项。
- 原因：用户要求「相关功能可以在 Web 使用、以及与 agent 对话生效」。后端编排方法全齐（MCP 写工具已直连，D-021），Web 只缺写端点与按钮；运行时本就支持非交互单轮（`claude -p`/`codex exec`），无新 adapter 面。飞书入站是全新网络面 + 安全评审，超本任务范围。

## D-023：Chief Web 编排流水线视图——派生状态，不新增写面

> **⚠️ 已废弃（D-027）**：Chief 编排视图随 Chief 编排/Todo 移除，本决策不再适用。

- 状态：Accepted（已实施，issue 10）
- 日期：2026-08-05
- 决定：Web 新增「Chief 编排」视图（仅 `role=chief` 员工显示该标签），把 Chief 拥有的每个目标（plan）渲染成一条流水线卡片：**阶段条**（拆解 → 计划确认 → 执行 → 审查 → 结果）与**聚合整体进度**（如 `2/3 完成 · 1 待审查`）。阶段点亮与整体状态均为**纯派生**（`derivePipeline`/`summarizePlan`，从 plan.status + item 状态分布计算，无副作用、可单测）——不落盘、不改后端 schema、不新增端点，计划文件仍是唯一事实源。
- 阶段条语义（**累计到达门**）：每个阶段一旦达成即常亮、不随执行结束熄灭——完成计划的五段全亮，中途终止（cancelled 且曾派发）亮到已执行阶段，驳回未派发（cancelled 且全项 pending）仅亮「拆解」。**「曾派发」= 任一任务实际运行过（离开 pending 且非 cancelled）**——计划内被单独取消的项不算派发。进度聚合排除 cancelled 项（不进分母，不可能完成）。
- 边界：**本视图本身仍纯派生**（阶段点亮/聚合进度不落盘、不改 schema）；Web 编排写面由 D-024 放开（创建/派发/Chief 发起走 Web，均后台 Operation）——本决策的「不含发起编排入口」措辞被 D-024 取代，但派生语义不变；Chief 视角不替代 Todo 标签（Todo 是逐项操作视图，Chief 编排是目标级流水线仪表）。
- 原因：issue 07 已覆盖任务项级渲染，issue 10 的真正增量是目标为中心的流水线呈现与进度聚合；派生态避免为「是否来自 Chief 拆解」新增持久化字段（plan 有 items 即视为拆解完成），保持切片最小。

## D-025：CURRENT_STATE.md 自动更新——系统侧生命周期事件 + 员工自维护，自动 git 提交

- 状态：Accepted（已实施，TASK-028）
- 日期：2026-08-05
- 决定：`agent/CURRENT_STATE.md` 从「创建时写一次、之后全靠 Web 人工编辑」升级为**系统自动维护 + 员工自维护**双通道：
  - **文件结构**：`<!-- factory-auto:begin -->`/`<!-- factory-auto:end -->` 标记块内为行级 KV（状态/运行器/飞书/最近事件），由系统管理；块外「工作进展」段由员工维护，系统不覆盖。
  - **系统侧覆盖面 = 仅关键状态**：运行器登录成功（`runtimeAuth`）、飞书授权成功（`bridgeAuthorize`）、服务启停（`lifecycleAction`）、归档与恢复（`archiveAgent`/`restoreTrash`/`restoreBackup`）时自动更新标记块内相关行；**任务/对话完成不自动写**（避免频繁刷屏，任务进展属「工作进展」段员工自维护）。
  - **更新语义**：有标记块只重写目标 key 的行、块外内容原样保留；无标记块且内容等于旧种子模板 → 自动升级为标记块格式；无标记块且被人工改过 → **跳过并警告**（永不覆盖他人成果）。
  - **自动 git 提交**：系统更新后 `git add -- agent/CURRENT_STATE.md` + commit（**绝不用 `add -A`**，防误收员工未提交的工作成果；缺 git 身份不阻断，best-effort）。Web 人工保存**不触发**自动提交（保持「Git 未提交」badge 语义——badge 是单文件 `git status`，自动提交后不再因系统写入常亮）。
  - **员工侧通道 = 引导约定 + 权限放行**：CLAUDE.md/AGENTS.md 模板追加「工作开始/结束时更新工作进展段」指令（标记块为系统管理勿改、无需手动 git 提交）；claude 侧工作区 `.claude/settings.json` 放行 `Edit/Write(agent/CURRENT_STATE.md)`（`defaultMode` 保持，避免员工每次编辑弹权限确认）；存量员工由 `prepareRuntime`（chat/run/runJob/start 前都会调用）幂等补放行。
- 边界：状态更新不落 `saveDocument` Web 通道（事件路径走同构的直接调用 + git 提交）；不加锁（与 Web 人类保存独立，atomic 替换防损坏）；员工运行中系统并发写入靠标记块边界隔离。任务完成/对话不自动写状态。
- 原因：员工详情状态文档与实际情况脱节（登录/授权/启停/归档后仍显示「已创建」）；系统侧生命周期事件产生结构化信号但无写入通道；员工（AI）子进程跑在工作区、天然能编辑文件，缺的只是引导指令与权限。

## D-026：员工自我进化——岗位/目标/工作系统/规则 + knowledge 自动提交

- 状态：Accepted（已实施，TASK-029）
- 日期：2026-08-05
- 背景：员工是 Claude/Codex 子进程，可编辑工作区文件，但只有 `CURRENT_STATE.md` 被放行且自动提交，岗位/目标/工作系统/规则文档既无修改引导、也无权限放行、改动了也不自动提交；员工的学习成果没有持久化通道，每次执行都从默认文档重新开始，无法积累。
- 决定：
  - **员工自我进化**：员工可在任务执行（developing）阶段更新 `agent/ROLE.md`（岗位）、`GOALS.md`（目标）、`OPERATING_SYSTEM.md`（工作系统）、`POLICIES.md`（规则）与 `knowledge/` 知识，让下次执行更准确。两个 ENTRY.md.tmpl 追加「自我进化」引导节（只在 developing 更新，保持文件结构；变更记录到 CURRENT_STATE.md「工作进展」；不手动 git 提交）。
  - **权限放行**：`ensureAgentDocsAllowed(workspace, relPaths)` 参数化复用 CURRENT_STATE 放行模式，为四份自维护文档生成 `Edit/Write` 规则幂等合并；`prepareRuntime` 调用放行（存量员工自动升级）。员工不可修改 `.claude/settings.json` 扩大自身权限。
  - **自动 git 提交**：`commitSelfEvolution` 在 `runAgent`/`runChat`/`runJob` 成功后检测四份文档变更并单文件提交（`evolve: 更新 <basename>`）；`knowledgeWrite`（含经验提取写回 `knowledge/lessons/`）提交 `evolve: 更新知识`。均 best-effort（缺 git 身份/抛错仅 console.warn 不阻断主流程），单文件提交绝不用 `add -A`。
- 边界：`config_hash` 只含 runtime 块，员工改 `agent/*.md` 不触发漂移告警；Web 人工保存 `agent/*.md` 仍不自动提交（保持「Git 未提交」badge 语义）。
- 原因：员工的学习成果没有持久化通道，每次执行都从默认文档重新开始，无法积累。
- 注：本决策原含「派发进度可观测」半（`OperationDto.summary` + CLI 进度行），该半随 Chief 编排/Todo 移除而一并移除，见 D-027。

- 状态：Accepted
- 日期：2026-08-03
- 背景：本项目需要被多个 AI Agent 并行编辑或在任意时刻交接，必须有持久化的事实来源替代易失的聊天上下文。
- 候选方案：仅依赖聊天记录；仅用 Git 分支无簿记；铺设 `.agent/` 协作簿记 + 文档体系骨架。
- 最终选择：通过 `multi-agent-project-skill` 的 `init_workspace.py` 生成完整骨架（入口层 + docs + skills + `.agent/` + 技术栈基线）。
- 选择原因：仓库是持久事实来源；簿记层让无聊天记录的 Agent 也能接手；文档体系让规则与代码不漂移。
- 影响范围：项目根、`docs/`、`skills/`、`.agent/`、`.github/workflows/ci.yml`、`.gitignore`。
- 后续注意：`.agent/` 必须提交到仓库；平台适配文件只指向 AGENTS.md，不复制规则。

## D-027：移除 Chief 编排 / Todo 状态机 / MCP 接入

- 状态：Accepted（已实施，TASK-030）
- 日期：2026-08-05
- 背景：用户经使用后明确判断「Chief 编排 + Todo 状态机 + MCP 接入都去掉，没啥用，不是我想要的东西」。这三块是此前按 spec-chief-orchestration / spec-chief-todo-mcp 逐步加进来的协作编排层，复杂且非目标。
- 决定：
  - **移除 Todo 状态机 + Chief 编排（合并）**：删除 `task-schema.ts`/`task-store.ts` 与全部 plan/编排方法（`createTaskPlan`/`runTaskPlan`/`orchestrate`/`reviewTaskPlan`/`planWithChief`/`waitOperation` 等）及私有辅助（派发/审查/拆解提示词、`parseReview`/`parseDecompose`、`isDone`/`progressOf`/`summaryOf`、`withPlanLock`）。`runAgent` 的 `commitSelfEvolution` 改无条件调用（去掉 `skipSelfEvolution` 守卫）。
  - **移除 MCP 接入（整块）**：删除 `mcp-server.ts`、`POST/GET /mcp` 路由、`enableMcp`/`mcpToken` 选项、`web --mcp` 与 `@modelcontextprotocol/sdk` 依赖。
  - **移除派发进度反馈（D-026 半，用户拍板一并移除）**：`OperationDto`/`OperationEvent` 去掉 `summary` 字段，CLI 进度行一并删除。
  - **保留**：`OperationManager`/`OperationStore`/`OperationDto` 共享基础设施（run/chat/job/backup/doctor/restore 与 Web 操作中心依赖）；`runAgent`/`runChat`/`runJob`、`commitSelfEvolution`、knowledge/skills/backup/trash/prune/doctor、Web「任务」标签（= 定时 Job）。`AgentRole`/`role` 字段（worker/chief）保留 schema 位（前向兼容），不再有 Chief 编排/UI/CLI 特殊化。
- 边界：只删上述三块及其直接依赖；共享基础设施原样保留。删除后 `OperationDto.summary` 无消费方。
- 原因：用户明确判断这三块复杂且非目标；回退到「单一 AI 员工 + 定时 Job + 对话」的核心模型，聚焦用户真正想要的东西。
- 影响：废弃 D-017、D-018、D-021、D-022、D-023、D-024（已标注）；D-026 改写为仅保留「员工自我进化」半。

---

## D-028：员工自我配置定时任务（按需）

- 状态：Accepted（已实施，TASK-031）
- 日期：2026-08-05
- 背景：用户需求「允许员工给自己配置定时任务 按需」。现状是 Job 定义存员工 workspace `automation/jobs/*.yaml`，由 launchd plist 定时触发，但只有管理员能创建/调度（`setJobEnabled` → `enableScheduled`）——员工即使写了 YAML 也不会产生任何调度。
- 决定：
  - **managed_by 标记**：`jobConfigSchema` 加 `managed_by: 'admin' | 'employee'`（缺省 admin，向后兼容）。同一目录，Web 显示 `[管理员]/[员工]` 徽标。
  - **自动生效**：员工 `enabled: true` 的 job 在每次 run/chat/job 结束后自动 reconcile（`src/core/job-reconcile.ts` 的 `reconcileEmployeeJobs`，best-effort），安装 launchd 调度，无需人工审批。
  - **文件 YAML 自我进化**（D-026 模式延伸）：员工在任务中写/改 `automation/jobs/*.yaml`，系统自动检测→调度→单文件 git 提交（`git add -- <relPath>`，绝不用 `add -A`）。
  - **清单**：`schedules/<agent>/.employee-jobs.json` 记录上次已调度的 employee job 及其 `schedule.time`，用于检测删除/停用/改时间：删除或 `enabled:false` → 反注册（bootout + 删 plist）；`schedule.time` 变更 → 先反注册再重装（让 launchd 重新加载日历）。
  - **权限放行**：`prepareRuntime` 幂等放行 `automation/jobs/**` 与 `automation/prompts/**`（仅 UX 平滑，非硬权限门——员工本就在 workspace 权限内）。
  - **引导**：ENTRY 模板加「定时任务自我配置」节；种子 `automation/jobs/README.md` 说明 managed_by 协议。
- 边界：
  - 只对 `managed_by: employee` reconcile；管理员 job 不受自动 reconcile 影响。
  - 单 job 校验失败（schema/路径逃逸 `assertInsideReal`）仅跳过该 job，不阻断其余。
  - 脚本/job 仍以员工 runtime 的 workspace 权限运行，路径限制在 workspace 内，不扩大权限；员工不可改 `.claude/settings.json` 扩大权限。
- 原因：把「员工自我进化」从「改文档」扩展到「配置自己的定时任务」，让例行工作自动化而无需每次人工；同时用 managed_by 明确边界，防止员工意外改动管理员任务。
- 影响：新增 `JobStore.listTolerant()`（容错列举）；`factory-application.ts` 的 runAgent/runChat/runJob 后接 reconcile。

---

## D-029：描述生成员工 + 拓宽自进化（移除预设）

- 状态：Accepted（已实施，TASK-032）
- 日期：2026-08-05
- 背景：用户提出方向转变——创建员工不应靠预设（用户运营/商业化等），而应由用户按需描述、AI 自动生成可编辑的员工蓝图；且员工应能在使用中自我进化、减少人工修改的模块。调研确认现创建是纯预设驱动、且无任何「模型生成」能力。
- 决定：
  - **描述 → 生成员工蓝图**：用户在 Web（或 CLI `--describe`）一句话描述员工用法 → 调用本地 Claude CLI（`claude -p --output-format json`，用户默认环境，**不设 CLAUDE_CONFIG_DIR**，与员工隔离 runtime 无关）→ 生成结构化蓝图（`id`/`name`/`description`/`goals`/`responsibilities`/`policies`/`escalation_conditions`/`skills`）→ 表单可编辑 → 确认创建。新模块 `src/core/employee-generator.ts`，复用 `parseStructuredResult` 抽正文、剥离 markdown 代码围栏后按 `generatedProfileSchema` 校验；失败抛 `OPERATION_FAILED`，remediation 提示重试或手动 `--description/--goal`。
  - **完全移除预设**：删除 `presets/*.yaml` 与 `loadPreset`；`CreateAgentInput` 去 `preset` 字段，新增 `responsibilities/policies/escalation_conditions/skills`；`resolvePreset` → `synthesizeProfile`（始终从 `description`+`goals` 合成，缺省 responsibilities/policies/skills 有安全默认）。`presets/cc-switch-allowlist.json`（CC Switch 白名单）与员工预设无关，保留。
  - **拓宽自进化**：`commitSelfEvolution` 从四份身份文档扩展到内容目录 `skills/**`、`workflows/**`、`knowledge/**`——员工在一次 run/chat/job 中新建/修改的任何内容（含未跟踪新文件）自动单文件提交，沿用 `git add -- <relPath>`，绝不用 `add -A`。不扫 `tasks/`、`reports/`、`scripts/`、`config/`、`logs/`（gitignore 已排除敏感/派生文件）。
- 边界：
  - 生成 prompt 仅含用户本人输入的描述，不读秘密；模型被要求只输出 JSON；蓝图权限边界（policies）由系统提示锁定为 workspace 沙箱内 + 高危操作人工审批。
  - 自进化只扫内容目录，单文件提交，不收未提交流程产物；员工权限不变（workspace 沙箱，生产写入/对外发布/推 Git/删数据须审批），员工仍不可改 `.claude/settings.json` 扩大权限。
- 原因：预设是「固定岗位模板」，无法覆盖用户的长尾自定义需求；让员工按需一次性描述、AI 生成蓝图，并把「员工自我进化」从文档扩展到员工写的所有内容，是最小人工的路径。
- 影响：新增 `generateEmployeeProfile`/`generateProfile`；Web 创建页步骤 0 改为「描述 + AI 生成 + 可编辑表单」；CLI `create` 加 `--describe`、去 `--preset`；自进化钩子覆盖内容目录。

---

## D-034：AI 员工自建 Skill（完整闭环：触发 + 生成 + 校验 + 投影 + 回滚）

- 状态：Accepted（已实施，TASK-034）
- 日期：2026-08-06
- 背景：员工在任务中无法让自己真正用上新 skill。已有 skill 存储/投影/版本化基础设施（`SkillService.install`、D-029 `commitSelfEvolution`、`experience_extraction`），但缺「员工自主生成 + 注册 + 校验 + 回滚」的编排层。调研确认 Claude 里「注册 skill」的本质 = 把合法 `SKILL.md` 放进发现目录（无编程式 API，下次会话自动发现）；参考 Voyager（技能库版本化）、Claude Agent SDK skills（注册=落盘契约）、PraisonAI（Shadow Git Checkpoints 回滚）。
- 关键缺口：员工手写 `workspace/skills/<name>/SKILL.md` 只被 D-033 fallback 识别为「可见」，不会被软链投影到 `.claude/skills/<name>`（投影只在 `install()` 时做）→ Claude 实际发现不到、用不了。
- 决定：
  - **生成器** `src/core/skill-generator.ts`：复用 employee-generator（D-029）的 `claude -p --output-format json` + `parseStructuredResult` + `extractJson` + Zod 范式；`generateSkill(brief)` 产出 `GeneratedSkill`（name/version/instructions/triggers），`renderSkillFile` 渲染 SKILL.md。安全 prompt 锁定 workspace 沙箱。
  - **SkillService 扩展**（`src/core/skills.ts`）：`upsert`（同名版本化替换，不抛 CONFLICT；digest 相同幂等 no-op）；`adopt`（给已写盘 manual skill 补写 `.agentctl.yaml` + 投影，零 LLM）；`rollback`（从 `.archive` 恢复历史版本）；`project()` 幂等化。替换前旧版备份到 `skills/.archive/<name>-<version>-<ts>/`（保留最近 5 版）。
  - **触发层**（`runJob` 后，`commitSelfEvolution` 之前）：`autoAdoptSelfSkills`（纯修复、始终开启，扫描 `skills/*/` adopt/upsert 并投影）+ `maybeAutoCreateSkill`（opt-in `memory.skill_self_creation`，复用 `readTranscriptSummary` 检测重复模式，`knowledge/.skill-signals.jsonl` 累计，阈值命中后 `generateSkill` + `upsert`）。两者 best-effort，失败仅 `console.warn` 不阻断 runJob。
  - **按需/任务驱动**：CLI 新增 `agentctl skill create-self/adopt/rollback` 子命令；`prepareRuntime` 为 `skills/**` 幂等补 Edit/Write 放行（员工任务中可直接写 `skills/`）。
- 边界：`install` 保持外部导入的 CONFLICT 语义不变；生成/校验失败绝不写 store，回滚只发生在版本化替换瞬间；自动生成仅当 `skill_self_creation=true` 且 `transcript_persist=true` 且 provider=claude。
- 原因：员工自建 skill 是「把重复劳动沉淀为可复用能力」的最小人工路径；投影是让 Claude 真正用上的关键一环。
- 影响：新增 `skill-generator.ts`/`skill-opportunity.ts`；`skills.ts` 增 `parseSkillFrontmatter`/`upsert`/`adopt`/`rollback`；`factory-application.ts` 挂双 hook + 公开方法 `createSkillForAgent`/`adoptSkill`/`rollbackSkill`；schema 增 `skill_self_creation`；CLI 增三子命令。

---

> 后续决策按 `D-XXX - 标题` 格式追加。模板见 [.agent/decisions/ADR-0000-template.md](../.agent/decisions/ADR-0000-template.md)。重要技术取舍（架构、API、数据、依赖、跨模块规则）须记录于此。
