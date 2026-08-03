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
