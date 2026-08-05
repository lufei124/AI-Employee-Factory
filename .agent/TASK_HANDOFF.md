# 当前任务交接

## 身份

Task ID: TASK-021

Task title: Chief/Todo/MCP 骨架（多 Agent 协作 spec 前端 6 票：T01/T02/T03/T04/T08/T11）

Outgoing/current agent: claude-20260803-01

Intended next role/agent: 用户或后续维护者（spec-chief-todo-mcp 剩余 7 票：T05-T07/T09/T10/T12/T13）

Branch/worktree: main

Status: DONE（前端 6 票已实现并通过 /code-review，已提交 56bcef6）

更新时间：2026-08-05 11:50 +0800（提交 56bcef6）

## 已完成

- **T01 Git 基础**：`src/core/git.ts`(新增) 受控封装（`gitStatusShort`/`gitAddCommit`/`gitDiff`/`snapshotWorkspaceHash`，execa `shell:false`、cwd 内、经审查门读工作区状态）。create-agent 在 git init 后做基线提交（`requireIdentity:false`），缺 git 身份不阻断创建，返回 false 时 `console.warn` 可恢复提示（说明如何补提交）。新增 `git.test.ts` no-identity 可恢复路径用例。
- **T02 结构化 result**：`src/core/usage.ts` 增 `parseClaudeResult`/`parseCodexResult`/`parseStructuredResult` 纯函数。修正 codex JSONL 事件 schema 读取（`event.item.type === 'agent_message'` → `event.item.text`）。
- **T03 取消单操作**：`src/web/operation-manager.ts` 增 `OperationManager.cancel(id)`（NOT_FOUND / CONFLICT 守卫 + `controller.abort()`）。
- **T04 Todo 领域核心**：`src/schemas/task-schema.ts`(新增) 7+2 状态机（`TASK_ITEM_STATES`/`TASK_ITEM_TRANSITIONS`/纯函数 `canTransition`）+ `taskItemSchema`/`taskPlanSchema`；`src/core/task-store.ts`(新增) `TaskStore`（`workspace/tasks/plans`，list/get/create/transitionItem/remove/reconcile，`derivePlanStatus` 从 nextItems 派生），原子落盘（沿用 JobStore 模式）。
- **T08 Chief 角色**：agent-schema/registry-schema 增 `agentRoleSchema`（'worker'|'chief'），create-agent `--role` 持久化，cli-program `--role` 选项 + list 角色列，factory-application AgentSummary 增 role。
- **T11 MCP 传输 + 静态 bearer**：`src/mcp/mcp-server.ts`(新增) `createMcpEndpoint`，用 `@modelcontextprotocol/sdk@^1.30.0` 的 `StreamableHTTPServerTransport` 经 `request.raw`/`reply.raw` 挂到既有 Fastify（共享进程生命周期；fastify@2.0.0/server@2.0.0 两包裁定不适用，见 D-018）；手写 `mcpAuthorized` 恒定时间 bearer 校验；web-server/start 增 `enableMcp`/`mcpToken`，guard 复用既有 loopback onRequest。新增 `tests/web-mcp.test.ts` 7 用例。
- **文档**：docs/DECISIONS.md 增 D-017（Chief 交叉审查编排器单向搬运，不放开 D-003）+ D-018 修订为实际实现（SDK StreamableHTTP + 手写 bearer）。

## 验证

| 命令/检查          | 结果   | 相关输出                                                                                                            |
| ------------------ | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `npm run build`    | 通过   | tsc 全绿                                                                                                            |
| `npx tsc --noEmit` | 通过   | 全绿                                                                                                                |
| `npm test`         | 1 失败 | 270/271 过；唯一失败为既有 date-sensitive `tests/experience.test.ts`（硬编码 2026-08-04，干净树复现，非本任务引入） |
| lint + prettier    | 通过   | --max-warnings=0 全绿                                                                                               |
| /code-review       | 通过   | Standards（D-018 文档对齐已修）+ Spec（T01 可恢复提示 + T11 依赖裁定已补）双轴通过                                  |

## 安全边界与限制

- 未改动备份/回收站/CC Switch/隔离层语义。
- D-017：Chief 交叉审查坚持编排器单向搬运（编排器读受控 diff 工件 + 日志，脱敏后喂 Chief），Chief 零 worker 文件系统访问，D-003 隔离不放开。
- D-018：MCP 与 Web 共享 loopback 边界；`/mcp` 不在 `/api/v1/*` CSRF 钩子范围内；静态 bearer，无 Authorization Server（OAuth AS 留后续阶段）。
- 未 push；按用户常驻规则「任务完成即 commit」只提交不推送。
