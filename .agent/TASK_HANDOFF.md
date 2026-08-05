# 当前任务交接

## 身份

Task ID: TASK-024

Task title: MCP 工具集（spec-chief-todo-mcp 阶段3 issue 12/13：读 8 + 编排写 5 工具）

Outgoing/current agent: claude-20260803-01

Intended next role/agent: 用户或后续维护者（spec-chief-todo-mcp 承接：Web Todo 视图、MCP 增强路径——请求内 SSE progress / 推送订阅）

Branch/worktree: main

Status: DONE（切片已实现并通过 /code-review，提交后更新）

更新时间：2026-08-05 14:00 +0800（本地已提交，未 push）

## 已完成

- **MCP 工具注册（issue 12/13）**：`src/mcp/mcp-server.ts` 的 `createMcpEndpoint(backend: McpBackend)` 注册 **13 个工具**——读 8：`list_agents`/`get_agent`/`list_operations`/`get_operation`/`list_jobs`/`list_skills`/`read_latest_log`/`knowledge_recall`；编排写 5：`create_task_plan`/`run_task_plan`/`approve_plan`/`review_task_plan`/`cancel_operation`。工具是 `FactoryApplication` 的薄适配器（`McpBackend` 接口注入 `options.application`），穿过应用编排层单一入口，与 Web/CLI 共享行为。`server.ts` 一行接线：`createMcpEndpoint(options.application)`。
- **JSON 主路径响应**：transport 以 `enableJsonResponse: true` 运行，POST JSON-RPC 返回 JSON 响应体（简化轮询）；GET `/mcp` 的 SSE 流保留。客户端 initialize 后须携带 `mcp-session-id`（真实客户端自动处理）。偏离 spec 措辞的 SSE→MCP 已记入 D-021。
- **工具契约**：`run_task_plan` 返回排队态 `OperationDto`，客户端轮询 `get_operation`；`cancel_operation` 复用 `operationManager.cancel(id)`；`approve_plan`→confirmPlan（draft→active）；`review_task_plan`→reviewTaskPlan（Chief 交叉审查，D-017 单向传输）。zod 校验入参，未知工具/参数校验失败返回 `isError: true`。
- **脱敏回归守卫**：`AgentConfig`/`RegistryAgent` 均不含原始 Secret，MCP 层不新增 secret 读取面；`tests/mcp.test.ts` 新增「读工具不泄露注入工作区的 secret 形态 token」回归测试。
- **测试**：新增 `tests/mcp.test.ts`（5 组：bearer 拒绝 / 13 工具注册 / 读工具 / 编排写工具状态机 / 未知工具+参数失败+脱敏回归）；更新 `tests/web-mcp.test.ts`（T11 传输测改为 JSON 响应断言）。
- **文档**：`docs/DECISIONS.md` 记 D-021（MCP 工具集 + JSON 主路径响应偏离说明）；README「当前限制与 Roadmap」把 Chief 编排 + MCP 移出延期项。

## 验证

| 命令/检查          | 结果   | 相关输出                                                                                                 |
| ------------------ | ------ | -------------------------------------------------------------------------------------------------------- |
| `npm run build`    | 通过   | tsc 全绿 + vite 产物                                                                                     |
| `npx tsc --noEmit` | 通过   | 全绿                                                                                                     |
| `npm test`         | 1 失败 | 303/304 过；唯一失败为既有 date-sensitive `tests/experience.test.ts`（硬编码 2026-08-04，非本任务引入）  |
| lint + prettier    | 通过   | eslint 无错误；本切片源文件 prettier 全绿                                                                |
| /code-review       | 通过   | Standards（无硬违规，修 knowledgeRead 闲置 seam + 重复 schema + unknown 弱化）+ Spec（修脱敏无测试断言） |

## 安全边界与限制

- 未改动备份/回收站/CC Switch/隔离层语义；worker 工作区保持编排器只读（D-017/D-003 未放开）。
- **已知缺口（推迟）**：Web Todo 视图（issue 07/10，独立切片）；MCP 增强路径（请求内 SSE progress）与推送路径（subscriptions/listen）MVP 不做；无 `list_task_plans`/`add_task_item` 工具（run 前须经应用层或后续工具补 items）。
- `run_task_plan` 后台派发：sync 调用方必须 `waitOperation(op.id)` 等终态再 `getTaskPlan`，否则读到排队态 DTO 快照。
- 未 push；按用户常驻规则「任务完成即 commit」只提交不推送。
