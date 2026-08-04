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
- 决定：把对外契约分两类管理。**封存不变量（frozen）**：语义对外固定，实现可经安全评审升级--典型为 `assertInside` 的「路径包含由核心执行」语义、Bridge profile `workspace/workspace` 权限不放宽、D-006「SyncSummary 只返回字段名不返回值」。frozen 实现升级须同时满足：(a) 记 ADR；(b) 对外语义不变；(c) 补回归测试；(d) 不放宽安全默认。**版本化契约（versioned）**：可经 schema 版本号 bump + 显式分派调整--典型为 env 白名单（`runtime.ts` `safeInheritedVariables`/`ccSwitchClaudeProviderVariables`）与配置 schema；调整须版本号 bump、显式分派与迁移说明，禁止静默全局改写（与红队 B2 一致）。
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

状态使用 Accepted、Superseded、Proposed。日期来自已验证的实现或提交；无法证明的动机不写成事实。

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
