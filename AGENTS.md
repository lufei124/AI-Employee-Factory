# AGENTS.md - AI 协作统一入口

本文件是 Claude、Codex、Cursor、Gemini 及其他 AI Coding Agent 的共同入口。平台专属文件（如 `CLAUDE.md`）只能指向这里，不得复制项目规范。若文档与代码冲突，先以已验证的代码和测试为准，同时修正文档或明确提出冲突。

## 项目简介

AI Employee Factory 是一个 macOS 优先的 TypeScript CLI 与本地 Web 控制台，用于创建和管理配置、记忆、飞书身份、日志和定时任务彻底隔离的本地 Claude Code/Codex AI 员工。

## 开始前必须阅读

1. 本文件。
2. [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md)：产品背景、范围、术语与约束。
3. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：模块、数据流和依赖边界。
4. [docs/DEVELOPMENT_RULES.md](docs/DEVELOPMENT_RULES.md)：强制、推荐、例外规则与任务规模分级。
5. 与任务相关的 [docs/TESTING.md](docs/TESTING.md)、[docs/DECISIONS.md](docs/DECISIONS.md) 和 [skills/](skills/)。
6. 中途接手任务时先读 [.agent/TASK_HANDOFF.md](.agent/TASK_HANDOFF.md)。

决策依据见 [docs/DECISIONS.md](docs/DECISIONS.md)，统一名词见 [docs/GLOSSARY.md](docs/GLOSSARY.md)。

## 技术栈

- 技术栈：Node.js 20.19+、TypeScript strict、Commander、Zod、YAML、Execa、Fastify 5、React 19、Vite、Vitest、Playwright、ESLint、Prettier。

## 常用命令

```bash
# 安装依赖
npm ci
# 运行测试
npm test
# 构建
npm run build
# 代码检查
npm run lint
# 浏览器端到端验收
npm run test:e2e
```

这些命令是本项目的完成门禁；安装后应优先使用 `npm ci` 保证 lockfile 一致性。

## 最高优先级规则（多 Agent 协作硬性规则）

本仓库可能被多个 AI Agent 并发编辑，或在任意时刻被交接。仓库是持久的事实来源；聊天上下文是临时的。

- 编辑前先读取 `.agent/` 下的持久状态。
- 改动文件前先认领任务，并在 `.agent/TASK_BOARD.md` 登记归属。
- 多个 Agent 并行时，每个进行中的任务使用一个独立分支或 Git worktree。
- 编辑前声明预期的文件范围，并在 `.agent/FILE_LOCKS.md` 登记。
- 不得编辑被其他任务实时持有的文件，除非执行显式的集成或接管。
- 改动保持最小，且仅限于已认领的任务范围内。
- 永不擦除、重置、重新格式化或覆盖其他 Agent 未合并的成果。
- 未真正执行过的测试，绝不得声称其已通过。
- 除非用户或协调 Agent 明确要求，否则不得提交或推送。
- 工作一旦暂停、易主、受阻、进入审查或完成，都要更新持久状态。

不得运行此类破坏性命令：`git reset --hard`、`git clean -fd`、`git push --force`。

详细协议见 `.agent/` 下簿记文件与对应 skill。

## 禁止操作

- 未经用户明确授权，不提交、推送、发布、执行生产 DDL、修改生产数据或扩大任务范围。
- 不读取、输出或提交密钥、数据库密码、用户标识明细和运行数据。
- 不用破坏性 Git 命令覆盖用户改动，不回滚不属于当前任务的工作树变更。
- 不因旧文档存在就恢复已被源码、测试和决策记录替代的方案。
- 不把构建产物、调试日志、一次性错误和聊天过程沉淀为长期规范。

## 标准任务流程

开始时：

1. 读取必读文档与 `.agent/TASK_HANDOFF.md`。
2. 检查 `git status`，区分既有改动与本任务改动。
3. 定位真实调用链、测试和数据边界；中大型任务先给出计划。
4. 明确代码影响和需要同步的文档，再开始修改。
5. 需求、权限、数据口径或破坏性操作不明确时停止并询问。

结束时：

1. 按风险补测试并运行对应检查。
2. 检查 diff，确认无敏感信息、生成物和任务外修改。
3. 更新受影响的文档（见下方映射表）与 `.agent/` 状态。
4. 按固定结构更新 `.agent/TASK_HANDOFF.md`。
5. 汇报改动、验证、风险、待确认项；仅在得到授权时执行 Git 提交或外部操作。

## 完成标准

任务只有在需求已实现、影响范围已核对、相关测试通过、构建可用、文档同步、无未解释风险且 `.agent/TASK_HANDOFF.md` 可供无聊天记录的下一位 AI 接手时才算完成。

## 代码-文档映射

| 变更                 | 必须检查                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 目录、模块、依赖方向 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、本文件                                                               |
| 技术栈、依赖         | 本文件、[docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md)、[docs/DEVELOPMENT_RULES.md](docs/DEVELOPMENT_RULES.md) |
| 启动、构建、测试、CI | [README.md](README.md)、本文件、[docs/TESTING.md](docs/TESTING.md)、CI 配置                                        |
| 命令、测试策略       | [docs/TESTING.md](docs/TESTING.md)                                                                                 |
| 重要技术取舍         | [docs/DECISIONS.md](docs/DECISIONS.md)                                                                             |
| 术语                 | [docs/GLOSSARY.md](docs/GLOSSARY.md)                                                                               |
| 当前进展             | [.agent/TASK_HANDOFF.md](.agent/TASK_HANDOFF.md)                                                                   |

文档不能替代代码验证；文档只能描述已验证实现、已确认规范、待优化、待确认或已废弃事实。
