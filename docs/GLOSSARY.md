# Glossary

统一术语表。命名领域概念时使用此处定义的词汇，不要漂移到同义词。新概念入表前确认它是项目真实使用的语言。

| 术语                   | 定义                                             | 状态   |
| ---------------------- | ------------------------------------------------ | ------ |
| Current implementation | 当前代码的实际行为（可能与产品规则不同，需标注） | 元约定 |
| Confirmed rule         | 已确认的产品/业务规则                            | 元约定 |
| Pending confirmation   | 尚未确认、待业务或数据证实的实现或规则           | 元约定 |

- **Factory Home**：`AI_EMPLOYEES_HOME`，保存本机私有运行数据。
- **Workspace Root**：`AI_EMPLOYEES_WORKSPACE_ROOT`，保存各个独立 Agent Git 仓库。
- **Runtime Home**：某 Agent 专属的 Claude/Codex 原生配置、会话和记忆目录。
- **Bridge Home**：某 Agent 专属的 lark-channel-bridge profile 与加密凭据目录。
- **Portable memory**：Agent 仓库中可经 Git/备份迁移的岗位、知识、决策、Skill 和任务。
- **Skill 作用域**：Skill 的归属级别。**项目级（project）** 存于 `workspace/skills/` 并投影到 `workspace/.claude/skills` / `workspace/.codex/skills`，随工作区版本管理和默认备份；**用户级（user）** 原位存于 `runtimeHome/skills/`（运行器原生用户级发现目录），属于员工运行时身份，仅随包含 Runtime 的备份打包。
- **Skill 商店**：把可配置的远端 GitHub 仓库源（`config.yaml` 的 `skill_store.repositories`）浅克隆到 `~/.ai-employees/skill-store/cache/<name>/`，用 `agent-skills.yaml/json` 清单或扫描 `SKILL.md` 发现技能，安装复用 `SkillService.install`。仅接受 `https://github.com/` 公开仓库。
- **ExecutionContext**：执行前生成的 command、argv、cwd、受控 env 和 timeout 合同。
- **FactoryApplication**：CLI 与 Web API 共用的应用用例编排层。
- **Web Console**：由 `agentctl web` 临时启动、仅监听 `127.0.0.1` 的 React 本地管理页面。
- **Operation**：Web 进程内表示 run、Doctor、Job、备份或恢复的异步状态及 SSE 事件流。
- **Chief**：主管——持久注册的特殊 Agent（自有 workspace/git/记忆/备份），接收目标、把目标拆解为任务计划、派发工人执行并汇总审查。编排是产品核心。
- **编排（Orchestration）**：Chief 的核心职能：目标 → 任务计划 → 派发 → 收集汇总 → 审查。
- **计划确认门（Planning gate）**：Chief 拆解目标产出任务计划后，须经人工确认（或驳回）才派发工人。这是 Todo 状态机「等待确认」态的落点。
- **MCP 接入**：把 Factory 的任务总线（runAgent / OperationManager）暴露为 MCP 服务器，挂在现有 Fastify 的 `POST /mcp`。MVP 认证用静态 bearer token。
- **静态 bearer token**：MCP 接入 MVP 的认证方式——随 `startWebConsole` 生成并打印，客户端用 `Authorization: Bearer <token>` 连接。实现用 `@modelcontextprotocol/sdk@^1.30.0` 的 `StreamableHTTPServerTransport` 挂到既有 Fastify（`request.raw`/`reply.raw`，共享进程生命周期），认证为手写恒定时间 `mcpAuthorized`；loopback 边界复用既有全局 onRequest 校验。自建 OAuth Authorization Server（token 签发 + DCR）降级为后续阶段。
