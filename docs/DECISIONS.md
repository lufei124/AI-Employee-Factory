# Decisions

## D-001：单包分层架构

v1 使用单 npm 包，通过 core/runtime/service/schema 边界保留扩展性，不引入 workspaces 发布成本。

## D-002：Factory 管理 launchd

Factory 启动 Bridge 的前台 `run` 命令，不委托 Bridge 自有 daemon，以强制注入隔离环境、统一日志和状态。

## D-003：Skill 按 Agent 复制

Agent 根目录 `skills/` 是唯一正式源；运行器只使用该 Agent 内部投影。不同 Agent 不得连接同一实时共享 Skill 目录。

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
