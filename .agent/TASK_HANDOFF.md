# 当前任务交接

## 身份

Task ID: TASK-026

Task title: Chief Web 编排流水线视图（spec-chief-todo-mcp issue 10：纯流水线视图——目标流水线卡片 + 阶段条 + 聚合进度 + role 门控 + 2s 轮询）

Outgoing/current agent: claude-20260803-01

Intended next role/agent: 用户或后续维护者（spec-chief-todo-mcp 承接：MCP 增强路径——请求内 SSE progress / 推送订阅；如需 Web 发起编排（创建目标/派发），须先放开 D-022/D-023 边界并拆同步 orchestrate）

Branch/worktree: main

Status: DONE（切片已实现并通过 /code-review，提交后更新）

更新时间：2026-08-05 15:08 +0800（本地已提交，未 push）

## 已完成

- **Chief 编排视图（issue 10）**：`web/src/pages/AgentDetailPage.tsx` 新增「Chief 编排」标签（仅 `detail.registry.role === 'chief'` 时插入标签并渲染，worker 不显示）。`ChiefPipelineTab` 把 Chief 拥有的每个目标（plan）渲染成流水线卡片：**阶段条**（拆解 → 计划确认 → 执行 → 审查 → 结果，按派生状态点亮）+ **聚合整体进度**（`summarizePlan`：如 `2/3 完成 · 1 待审查`）。展开复用任务项渲染与两种闸门（计划级确认/驳回、审查级确认合并/驳回返工），2s 轮询。
- **纯派生（不落盘、不改后端）**：`derivePipeline`/`summarizePlan` 从 plan.status + item 状态分布纯计算，无副作用；`getAgent` 响应本就含 `registry.role`（RegistryAgent），仅补 web 端 `AgentDetail.registry.role` 类型声明——**后端零改动、零新端点**（D-023）。
- **共享抽取**：轮询/闸门执行逻辑抽为 `useTaskPlansPolling` hook（TodoTab 与 ChiefPipelineTab 复用）；任务项卡片抽为 `TaskItemRow`（两标签复用）；展开状态抽为 `useExpandSet`（两标签复用）。Standards 评审三项 judgement call（run/轮询重复、PipelineStages 接口与组件同名、展开状态重复）均已修复。
- **样式**：`web/src/styles.css` 新增 `.pipeline-stages/.pipeline-stage(.done)/.pipeline-arrow`，复用 panel/status-badge/button 设计系统。
- **测试**：`tests/web-ui.test.tsx` 19 过（含新增 4 个 Chief 测试——流水线渲染+role 门控（worker 不显示）、展开审查结论+确认合并/驳回返工、2s 轮询、阶段条累计到达门回归）。
- **文档**：ARCHITECTURE「Chief 编排与 Todo 状态机」Web 视图段补 Chief 编排视图；TESTING 补覆盖；DECISIONS 记 D-023（派生状态不落盘 + 不新增写面 + 阶段语义）。

## 验证

| 命令/检查                              | 结果   | 相关输出                                                                                                                                                                                                                                                                                |
| -------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                        | 通过   | tsc + vite 全绿（含 web tsconfig exactOptionalPropertyTypes，busy prop 用 `string \| undefined`）                                                                                                                                                                                       |
| `npx tsc --noEmit`                     | 通过   | 全绿                                                                                                                                                                                                                                                                                    |
| `npx vitest run tests/web-ui.test.tsx` | 19 过  | 含新增 4 个 Chief 测试（流水线渲染+role 门控、展开审查门、2s 轮询、阶段条累计到达门回归）                                                                                                                                                                                               |
| `npm test`                             | 1 失败 | 310 过 1 失败；唯一失败为既有 date-sensitive `tests/experience.test.ts`（硬编码 2026-08-04，非本任务引入）                                                                                                                                                                              |
| lint + prettier                        | 通过   | eslint 无错误；源文件 prettier 全绿（.agent/TASK_BOARD.md 表格行宽与既有提交宽度对齐，diff 仅 +1 行）                                                                                                                                                                                   |
| /code-review                           | 通过   | Standards（无硬违规；修 3 项 judgement call：hook 抽取 useTaskPlansPolling、PipelineStages→PipelineStageFlags、展开状态抽 useExpandSet）+ Spec（修 4：进度分母排除 cancelled、anyDispatched 排除单独取消项、active 未派发显示「待派发」、有失败进度补执行中；阶段条累计语义记入 D-023） |

## 安全边界与限制

- **纯流水线视图（D-023）**：Web 只读 + 两种闸门，**不含发起编排入口**——目标创建/派发走 CLI `agentctl chief run`；后端 `src/` 零改动；原始 diff 仍不持久化（D-022）。
- **派生语义**：阶段「拆解完成 = plan.items 非空」（不区分 Chief 拆解 vs 手工创建，plan 不持久化 source）；「结果 = 全部非 cancelled 项 completed」；「曾派发 = 任一任务离开 pending 且非 cancelled」（单独取消的项不算派发，D-023）。若未来需要「是否来自 Chief 拆解」指示，须先加持久化字段（D-023 记录）。
- Chief 编排视图与 Todo 标签并存：前者目标级流水线仪表，后者逐项操作视图，不互相替代。
- 未 push；按用户常驻规则「任务完成即 commit」只提交不推送。
