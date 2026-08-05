# 当前任务交接

## 身份

Task ID: TASK-030

Task title: 移除 Chief 编排 / Todo 状态机 / MCP 接入（D-027）

Outgoing/current agent: claude-20260803-01

Intended next role/agent: 用户或后续维护者（TASK-030 已实施并提交；后续增强：任务完成自动写状态、飞书入站等其他立项）

Branch/worktree: main

Status: 三块移除 + 文档 + /code-review 双轴（修复后验证全绿），已提交 main

更新时间：2026-08-05 21:00 +0800

## 已完成

- **删除文件**（git rm）：
  - `src/schemas/task-schema.ts`、`src/core/task-store.ts`（Todo 状态机）
  - `src/mcp/mcp-server.ts`（MCP 整块）
  - `tests/orchestration.test.ts`、`tests/task-store.test.ts`、`tests/mcp.test.ts`、`tests/web-mcp.test.ts`

- **`src/application/factory-application.ts`**：移除全部 plan/编排方法与私有辅助（createTaskPlan/list/get/addItem/confirm/reject/runTaskPlan/review/confirmReview/rejectReview/planWithChief/startPlanWithChief/orchestrate/waitOperation + plans()/withPlanLock/findItem/dispatchPlan/dispatchItem/planningPrompt/reviewPrompt/decomposePrompt/parseReview/parseDecompose/isDone/progressOf/summaryOf/DispatchEmit/DecomposedTask + planLocks 字段 + 相关 import）。`runAgent` 的 `commitSelfEvolution` 改为**无条件**调用（去掉 read-only 探针的 skipSelfEvolution 守卫）。

- **`src/core/process-runner.ts`**：`LoggedRunOptions` 移除 `skipSelfEvolution` 字段。

- **`src/core/operation-manager.ts`**：`OperationDto`/`OperationEvent` 移除 `summary?: string`；execute 的 emit 包装删掉 `dto.summary` 同步行。

- **`src/cli-program.ts`**：删除 `plan` 命令组 + `chief` 命令组 + `plan run`/`chief run` 的 `\r` 进度订阅；`web` 命令删 `--mcp` 选项。

- **`src/web/server.ts`**：删 `enableMcp`/`mcpToken` 选项、`mcpAuthorized`、`POST/GET /mcp` 路由 + onClose、task-plans 路由 + chief-run 路由。

- **`src/web/start.ts`**：删 `enableMcp`/`mcpToken` 透传与 token 生成；返回改 `{ server, origin, url }`。

- **`package.json`**：移除 `@modelcontextprotocol/sdk` 依赖（已 `npm install` 清理 71 个包）。

- **Web 前端**：`api.ts` 删 `summary` + TaskItem/TaskPlan 类型与 plan/chief 方法；`AgentDetailPage.tsx` 删 TodoTab/ChiefPipelineTab/PlanActionButtons/useTaskPlansPolling/TaskItemCard；`OperationsDrawer.tsx` 删 summary 展示；`styles.css` 删 `.operation-summary`。

- **测试裁剪**：`self-evolution.test.ts`（删跳过规划门 + skipSelfEvolution 用例，保留 3 核心）、`web-ui.test.tsx`（删 plan/chief 约 9 用例）、`web-server.test.ts`（删 2 plan 用例，chat 用 `application.operationManager.wait` 替换去掉的 `waitOperation`）、`cli-structure.test.ts`（删 plan/chief 组断言）。

- **文档**：`docs/DECISIONS.md` D-027 ADR + 改写 D-026（只留自我进化半）+ 标记 D-017/D-018/D-021/D-022/D-023/D-024 废弃；`docs/ARCHITECTURE.md` 删 Chief/Todo/MCP + D-026 派发进度半；`README.md` 删进度行 + roadmap；`docs/GLOSSARY.md` 删 Chief/编排/计划确认门/MCP/静态 bearer。

- **/code-review 双轴（已完结）**：Standards 0 硬违规、1 判断性气味（`git.ts` 遗留死导出 `gitDiff`/`snapshotWorkspaceHash`，唯一消费者为已删编排 helper）→ 已删除两函数 + 私有 helper（collectFiles/WorkspaceFile/isIgnoredTemp）+ 不再需要的 path/createHash/fs-extra import + 对应 3 个测试用例；`AgentRole`/role 保留系 D-027 明确记录的 deliberate forward-compat（判断性，保留）。Spec 0 缺陷、0 越删；cosmetic 修复：`web-server.test.ts` 描述块由「Web orchestration write surface (D-024)」改名「Web chat operation」（D-024 编排写面已删，仅剩对话测试）。

## 验证

| 命令/检查                                                                                                                                                                                                                              | 结果   | 相关输出                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------- |
| `npx tsc --noEmit`（tsconfig.json + tsconfig.web.json）                                                                                                                                                                                | 通过   | 全绿                                                        |
| `npm run lint`（eslint+prettier）                                                                                                                                                                                                      | 通过   | 全绿                                                        |
| `npm test`                                                                                                                                                                                                                             | 272 过 | 40 文件全绿（自 343 降至 272，含 review 删除 3 死导出测试） |
| 孤儿引用 grep（task-schema/task-store/createTaskPlan/runTaskPlan/summaryOf/progressOf/skipSelfEvolution/createMcpEndpoint/enableMcp/mcpToken/@modelcontextprotocol/chief-run/orchestrate/waitOperation/gitDiff/snapshotWorkspaceHash） | 无残留 | 保留 `chief` 仅 role 字段/--role 选项/角色传播测试，均合法  |
| `/code-review`                                                                                                                                                                                                                         | 完成   | Standards 0 硬违规 / Spec 0 缺陷；修复已应用并复验          |

## 安全边界与限制

- **共享基础设施原样保留**：OperationManager/OperationStore/OperationDto/OperationEvent、runAgent/runChat/runJob、commitSelfEvolution/prepareRuntime、knowledge/skills/backup/trash/prune/doctor、Web「任务」tab（= 定时 Job）、AgentRole/role 字段（前向兼容）均未删。
- **单文件 git 提交**：自我进化提交仍只 `git add -- <relPath>`，绝不用 `add -A`。
- **MCP 依赖已彻底移除**：`@modelcontextprotocol/sdk` 从 package.json + lockfile 清除，无残留导入。
- 未 push，按用户常驻规则等待明确要求。
