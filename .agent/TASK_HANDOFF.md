# 当前任务交接

## 身份

Task ID: TASK-022

Task title: Chief 编排核心闭环（spec-chief-orchestration 4 票：01 计划+派发 / 02 规划门脏审计 / 03 审查门单向搬运 / 04 拆解回落与 orchestrate）

Outgoing/current agent: claude-20260803-01

Intended next role/agent: 用户或后续维护者（spec-chief-orchestration 承接：Web Todo 视图、MCP 读/编排写工具、编排 Operation 可观测性）

Branch/worktree: main

Status: DONE（4 票已实现并通过 /code-review，提交后更新）

更新时间：2026-08-05 12:35 +0800（本地已提交，未 push）

## 已完成

- **T01 计划 + 派发**：`TaskStore` 扩展 `addItem`/`updateItem`/`setPlanStatus(planId, status, note?)` + `PLAN_STATUS_TRANSITIONS` 门控；`FactoryApplication` 新增 `createTaskPlan`/`listTaskPlans`/`getTaskPlan`/`addTaskItem`/`confirmPlan`/`rejectPlan(planId, note?)`/`runTaskPlan(planId, {concurrency, timeoutSeconds})`。波次调度：依赖阻塞（仅 completed 放行）、失败不阻塞同级、已成功/终态跳过。**细粒度计划锁**：仅计划文件状态机读改写加 `withPlanLock` 短锁串行化，worker 执行（planning/developing 的 runAgent）在锁外并发——`--concurrency` 真实生效（测试用闸门验证 maxActive===2）。`withPlanLock` 成功/失败两路 release，避免 fn 抛错死锁。
- **T02 规划门脏审计**：`planning` 阶段 worker 被指示只出计划不改文件，`snapshotWorkspaceHash` + `gitStatusShort` 前后快照硬兜底；违背只读 → `planning→failed`（review 注明原因）。
- **T03 审查门**：`reviewTaskPlan(ownerId, chiefId, planId)` 对 `awaiting_review` 项读 worker `gitDiff` + 计划目录 `<planId>/<itemId>.result`，`redactSecrets` 脱敏后拼进评审提示词喂 Chief（claude/codex 结构化输出经 `parseStructuredResult`），verdict+note 写 `item.review`；解析失败回落「驳回待人工」。`confirmReview`→completed / `rejectReview(note?)`→developing（返工）。Chief 自始至终零 worker 文件系统访问（守 D-017/D-003）。
- **T04 拆解回落 + orchestrate**：`planWithChief(chiefId, goal)` 新建计划 → 跑 Chief 拆解提示词 → 解析 JSON 数组逐项写 `item-N`；解析失败回落可编辑空计划（不抛错）。`decomposePrompt` 明确依赖用 `item-N`（第 N 个任务）引用，Chief 依赖 id 与生成的 id 对齐。`orchestrate(chiefId, goal, {concurrency, confirm})` 顶层一句话闭环：拆解 → 确认门（confirm 回调，可驳回停在 draft）→ 派发 → 交叉审查；`runTaskPlan` 开头 `store.reconcile()` 处理重启孤独儿（user story 17）。
- **CLI**：`agentctl plan` 组（list/create/add/get/confirm/reject[-n]/run[--concurrency]/review[--chief]/confirm-review/reject-review[-n]）+ `agentctl chief run <chief-id> "<goal>" [--concurrency]`（打印计划含 prompt 后交互确认）。
- **验证**：`tsc --noEmit` 全绿；`npm run build` 通过；lint+prettier --max-warnings=0 全绿；单测 `tests/orchestration.test.ts`（21 用例：TaskStore 扩展/编排动作/派发/脏审计/审查门/拆解/orchestrate/真实并发/重启 reconcile）+ `tests/cli-structure.test.ts` 通过。

## 验证

| 命令/检查          | 结果   | 相关输出                                                                                                            |
| ------------------ | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `npm run build`    | 通过   | tsc 全绿 + vite 产物                                                                                                 |
| `npx tsc --noEmit` | 通过   | 全绿                                                                                                                |
| `npm test`         | 1 失败 | 292/293 过；唯一失败为既有 date-sensitive `tests/experience.test.ts`（硬编码 2026-08-04，干净树复现，非本任务引入） |
| lint + prettier    | 通过   | --max-warnings=0 全绿                                                                                                |
| /code-review       | 通过   | Standards（无硬违规；并发锁/错误路径/重复 find 已修）+ Spec（rejectPlan note/确认门 prompt/reconcile/拆解依赖契约/真并发已修；Operation 可观测性推迟） |

## 安全边界与限制

- 未改动备份/回收站/CC Switch/隔离层语义；worker 工作区保持编排器只读（D-017/D-003 未放开）。
- **已知缺口（推迟）**：spec 要求编排动作返回 `OperationDto`（进度/取消，user story 16）——当前仅生成 `operationId`/`traceId` 穿线给 runAgent，未注册 OperationStore/OperationManager。属独立可观测性切片，留待后续。
- 规划门无法强制只读（claude 无只读 flag / codex 写死 workspace-write），强制力来自沙箱 runtime，本项目只有软信任 + 脏审计兜底（spec 已知边界）。
- 未 push；按用户常驻规则「任务完成即 commit」只提交不推送。