# 当前任务交接

## 身份

Task ID: TASK-023

Task title: 编排 Operation 可观测性（spec-chief-todo-mcp user story 16/23/25：runTaskPlan/orchestrate 注册 Operation 返回 OperationDto + cancel 单例复用）

Outgoing/current agent: claude-20260803-01

Intended next role/agent: 用户或后续维护者（spec-chief-todo-mcp 承接：阶段 0 剩余共性前置、Web Todo 视图、MCP 读/编排写工具）

Branch/worktree: main

Status: DONE（切片已实现并通过 /code-review，提交后更新）

更新时间：2026-08-05 12:55 +0800（本地已提交，未 push）

## 已完成

- **OperationManager 迁移 `src/web/` → `src/core/`**：零 web 依赖（仅 EventEmitter/AbortController/crypto/core 模块），迁后 `application/` 可用而不违反分层。更新 3 处 import（server.ts、operation-manager.test.ts、web-server.test.ts）。`cancel(id)` 单例在 TASK-021 已存在（T03），本切片直接复用，无行为变更。
- **编排可观测（spec user story 16/23/25）**：`FactoryApplication` 增加可选 `operationManager` 注入 + `operationManager` getter（懒加载默认 store-backed 实例）。`runTaskPlan` pre-flight 校验（计划未确认/员工不存在/reconcile）留在同步段仍 reject，通过后后台注册 `kind='task_plan'` Operation 并返回 `OperationDto`；派发主循环抽为私有 `dispatchPlan`，逐项 emit 进度事件，`signal` 透传 runAgent（取消传播）+ 循环顶检查 `signal.aborted` 停调度新波次。个别 item 失败不使操作失败（`exitCode:0`，item 级状态是唯一事实源）。`orchestrate` 保持同步（交互确认门），内部 await 派发终态后返回 live `operation` 句柄（`operation?` 可选字段，向后兼容）。新增 `waitOperation(id)`（failed→OPERATION_FAILED / cancelled→CANCELLED）。
- **错误码**：`AgentCtlErrorCode` 增 `'CANCELLED'`（exit 130，与 OperationManager finishCancelled 一致）。
- **web 共享实例**：`web/start.ts` 把 `application.operationManager` 传给 `buildWebServer`，编排操作在 web 控制台 operations 列表/API 可见。
- **CLI**：`plan run` 打印 `操作 <id> 已启动（<state>）` → `waitOperation` → `getTaskPlan` 打印逐项状态；`chief run` 打印 `编排操作 <id> 完成（<state>）`。
- **验证**：`tsc --noEmit` 全绿；`npm run build` 通过；lint（eslint 无错误）+ prettier（本切片源文件全绿）通过；单测 296/297（唯一失败为既有 date-sensitive `tests/experience.test.ts`，硬编码 2026-08-04，干净树复现，非本任务引入）。`tests/orchestration.test.ts` 新增 4 个可观测性用例 + 既有 21 用例改用 `runPlan` 助手（runTaskPlan→等终态→取计划）。

## 验证

| 命令/检查          | 结果   | 相关输出                                                                                                |
| ------------------ | ------ | ------------------------------------------------------------------------------------------------------- |
| `npm run build`    | 通过   | tsc 全绿 + vite 产物                                                                                    |
| `npx tsc --noEmit` | 通过   | 全绿                                                                                                    |
| `npm test`         | 1 失败 | 296/297 过；唯一失败为既有 date-sensitive `tests/experience.test.ts`（硬编码 2026-08-04，非本任务引入） |
| lint + prettier    | 通过   | eslint 无错误；本切片源文件 prettier 全绿（.agent/*.md 为 HEAD 既有 prettier 脏，已随簿记一并格式化）   |
| /code-review       | 通过   | 待聚合（Standards + Spec 两轴结论）                                                                     |

## 安全边界与限制

- 未改动备份/回收站/CC Switch/隔离层语义；worker 工作区保持编排器只读（D-017/D-003 未放开）。
- **已知缺口（推迟）**：spec user story 16「看到每个任务的状态」当前以计划级 `task_plan` Operation + 逐项 progress 事件表达，item 级状态仍须 `getTaskPlan` 查询；未为每个 item 独立注册 Operation。MCP `run_task_plan`/`cancel_operation` 工具（阶段 3）与 Web Todo 视图（独立切片）未实现——本切片只交付可观测底座，供其消费。
- `runTaskPlan` 后台派发：sync 调用方必须 `waitOperation(op.id)` 等终态再 `getTaskPlan`，否则读到的是排队态 DTO 快照（orchestrate 内部已正确处理）。
- 未 push；按用户常驻规则「任务完成即 commit」只提交不推送。
