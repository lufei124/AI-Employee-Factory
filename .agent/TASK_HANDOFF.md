# 当前任务交接

## 身份

Task ID: TASK-025

Task title: Web Todo 视图（spec-chief-todo-mcp issue 07：员工详情 Todo 标签 + 计划级确认/驳回门 + 审查门合并/驳回 + 2s 轮询）

Outgoing/current agent: claude-20260803-01

Intended next role/agent: 用户或后续维护者（spec-chief-todo-mcp 承接：Web Chief 编排视图 issue 10，MCP 增强路径——请求内 SSE progress / 推送订阅）

Branch/worktree: main

Status: DONE（切片已实现并通过 /code-review，提交后更新）

更新时间：2026-08-05 14:35 +0800（本地已提交，未 push）

## 已完成

- **Web Todo 标签（issue 07）**：`web/src/pages/AgentDetailPage.tsx` 新增「Todo」标签（与「任务」= 定时 Job 区分），`TodoTab` 组件 2 秒 `setInterval` 轮询 `api.listTaskPlans`（`busyRef` 在闸门操作期间暂停轮询）。draft 计划展开后展示任务项状态，计划级提供**确认计划/驳回计划**（驳回带 window.prompt 反馈 note）；`awaiting_review` 项渲染审查结论（`item.review.verdict+note`，verdict 本地化为已通过/已驳回）并提供**确认合并/驳回返工**。复用既有 status-badge/panel 设计系统类。
- **服务端路由**：`src/web/server.ts` 新增 `/api/v1/agents/:id/task-plans`（GET 列表/单计划）+ `actions/confirm`、`actions/reject`（计划级门）+ `items/:itemId/actions/confirm-review`、`reject-review`（审查门），全部经 `options.application` 单一 seam 透传。**未实现 Web 派发执行**（run 属 CLI 范畴，issue 07 不含派发，避免 scope creep，见 D-022 边界）。
- **客户端**：`web/src/api.ts` 新增 `TaskItemState`/`TaskItem`/`TaskPlan`/`TaskPlanStatus` 类型与 `listTaskPlans`/`getTaskPlan`/`confirmPlan`/`rejectPlan`/`confirmReview`/`rejectReview` 方法。
- **测试**：`tests/web-ui.test.tsx` 新增 3 个测试——Todo 标签展示待确认计划并可确认/驳回、待审查任务渲染审查结论并可确认合并/驳回、2 秒轮询刷新（`vi.useFakeTimers` + `advanceTimersByTime`）。覆盖两种闸门的确认**与**驳回路径（window.prompt spy）。
- **文档**：`docs/ARCHITECTURE.md` 增「Chief 编排与 Todo 状态机」段（计划/任务项状态机 + D-017 单向搬运 + Web 视图 + MCP）；`docs/TESTING.md` React 组件测试补 Todo 标签覆盖；`docs/DECISIONS.md` 记 D-022（Web Todo 视图渲染存储的审查结论 verdict+note，原始 diff 不持久化）。

## 验证

| 命令/检查                              | 结果   | 相关输出                                                                                                                                                   |
| -------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                        | 通过   | vite 产物 + tsc 全绿                                                                                                                                       |
| `npx tsc --noEmit`                     | 通过   | 全绿                                                                                                                                                       |
| `npx vitest run tests/web-ui.test.tsx` | 15 过  | 含新增 3 个 Todo 测试（确认+驳回+轮询）                                                                                                                    |
| `npm test`                             | 1 失败 | 305/306 过；唯一失败为既有 date-sensitive `tests/experience.test.ts`（硬编码 2026-08-04，非本任务引入）                                                    |
| lint + prettier                        | 通过   | eslint 无错误；本切片源文件 prettier 全绿                                                                                                                  |
| /code-review                           | 通过   | Standards（无硬违规；补 ARCHITECTURE/TESTING 文档同步门禁）+ Spec（修 R2 缺口补驳回测试、R3 移除派发 scope creep、R5 审查结论中文本地化、R7 轮询遇忙暂停） |

## 安全边界与限制

- 未改动备份/回收站/CC Switch/隔离层语义；worker workspace 保持编排器只读（D-017/D-003 未放开）。
- **Web 仅闸门 + 只读**：Todo 标签不实现派发（run）与计划/任务项创建——创建走 CLI `plan`/`chief run`，派发走 `agentctl plan run`（issue 07 明确「走完 Todo 流程」只含看状态、确认/驳回计划、确认合并/驳回审查）。Web Chief 编排视图（issue 10）留待后续切片。
- **审查 diff 边界（D-022）**：Web 渲染 `item.review`（verdict+note）——原始 diff 由 `reviewTaskPlan` 从 worker workspace 实时读取、脱敏后喂 Chief，不持久化进计划文件；若需 Web 展示原始 diff，属后续增强（读 worker 产物路径）。
- 未 push；按用户常驻规则「任务完成即 commit」只提交不推送。
