# 当前任务交接

## 身份

Task ID: TASK-027

Task title: Web 编排写面 + 单轮对话（放开 D-022/D-023 只读边界：Todo 创建/加项/派发 + Chief 发起 + 对话标签）

Outgoing/current agent: claude-20260803-01

Intended next role/agent: 用户或后续维护者（S3 飞书入站创建 todo 单独立项；如需要 Web 展示原始 diff，属后续增强，见 D-022/D-024）

Branch/worktree: main

Status: 实现完成，验证/评审中（提交后更新）

更新时间：2026-08-05 16:04 +0800

## 已完成

- **后端应用层**：`startPlanWithChief(chiefId, goal)`（把阻塞的 `planWithChief` 放进后台 Operation，完成停在 draft 等人工确认——等价 CLI inquirer 门）；`runChat(id, prompt, timeoutSeconds)`（走 `runLogged` 复用 transcript/experience 管线——`structured: true` 与 runAgent 一致、`provider`/`structured` 透传供 OP4-C usage 上报、`transcript_persist` opt-in、`experience_extraction` opt-in 时提取经验写回 knowledge/lessons/；`parseStructuredResult ?? raw` 降级为原始 stdout）。
- **Web 写路由（5 个）**：`POST /agents/:id/task-plans`（建计划）、`.../task-plans/:planId/items`（加任务项）、`.../actions/run`（派发，202 + OperationDto）、`.../actions/chief-run`（Chief 发起，后台拆解）、`.../actions/chat`（单轮对话，进度 + 完成时最终回答作为 output 事件写入）。全部走既有 `operations.start` 后台模式 + 202 + 前端轮询 events。
- **前端**：`api.ts` 5 个方法；`TodoTab` 新建计划表单（planId 前端生成 `plan-<8hex>`）+ draft 展开加任务项（执行员工选择器）+ active「派发执行」；`ChiefPipelineTab` 发起目标表单（goal + 可选并发）+ 派发执行按钮；新「对话」标签（所有员工）——Enter 发送、busy 禁用、1s 轮询 events 流式渲染、会话只存内存。
- **样式**：`.todo-add-item`（draft 加项表单）、`.chat-thread/.chat-bubble/.chat-composer` 等对话类。
- **测试**：web-server.test.ts 3 新测（建计划/加项/确认/派发 202 + 后台跑完 item 离开 pending；payload 校验 400；chat 进度/output 事件流——`runAgent`/`runChat` 被 mock 不 spawn 真实进程；setup 重构为共享 OperationManager 返回 `{server, application}`）；web-ui.test.tsx 3 新测（Todo 写面、Chief 发起、对话轮询读回）+ mock 补齐 6 个方法；experience.test.ts 1 新测（runChat 自动提取经验写回）+ 修复既有 date-sensitive 硬编码日期。
- **文档**：DECISIONS D-024（Web 编排写面开放）+ D-022/D-023 边界措辞更新（「Web 只读」被取代，原始 diff 不持久化保持）；ARCHITECTURE「Chief 编排与 Todo 状态机」Web 视图段补写面 + 对话标签；TESTING 补覆盖。

## 验证

| 命令/检查                                 | 结果   | 相关输出                                                                                       |
| ----------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `npx tsc --noEmit`                        | 通过   | 全绿                                                                                           |
| `npm run build`                           | 通过   | tsc + vite 全绿                                                                                |
| `npm run lint`                            | 通过   | eslint 无错误 + prettier 全绿（`startPlanWithChief` 的 `_options` 前缀处理未使用参数）         |
| `npx vitest run tests/web-server.test.ts` | 8 过   | 含新增 3 个 D-024 写端点测试（建计划/加项/确认/派发 + payload 校验 + chat 进度/output 事件流） |
| `npx vitest run tests/web-ui.test.tsx`    | 22 过  | 含新增 3 个（Todo 写面、Chief 发起、对话轮询）                                                 |
| `npm test`                                | 318 过 | 全绿（含修复既有 date-sensitive `tests/experience.test.ts`——硬编码 2026-08-04 改为动态日期）   |

## 安全边界与限制

- **原始 diff 不持久化/不展示（D-022 保持）**：Web 编排写面只写计划文件与派发，审查结论仍只持久化 verdict+note；对话会话记录不落盘（D-006 transcript 边界，`runChat` 无锁、`mirror: false` 与 CLI chat 一致）。
- **全部写操作后台 Operation**：无同步长请求；202 + OperationDto，前端轮询 `/api/v1/operations/:id/events`（D-021 单一应用 seam——Web/CLI/MCP 共享 `FactoryApplication` 同一编排层）。
- **Chief 发起不自动派发**：`startPlanWithChief` 拆解完停在 draft 等确认；`concurrency` 仅作派发参数透传。
- **S3 飞书入站创建 todo 未实现**：`lark-channel-bridge` 无 send/webhook 子命令、无入站路径，属全新网络面 + 安全评审，单独立项（D-024 记录）。
- 未 push；按用户常驻规则「任务完成即 commit」只提交不推送。
