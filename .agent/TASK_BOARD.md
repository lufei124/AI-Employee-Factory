# 任务看板

Coordinator: codex-20260803-01

> 新任务 ID 分配：读取本看板取最大编号 N，先 `mkdir .agent/task-ids/TASK-(N+1)` 原子占位（已存在则编号 +1 重试），占位成功后再写入本看板任务行。占位目录永不删除，作为已用编号记录。撞号时后到者不得覆盖先到者的看板行。

| Task ID  | 标题                                                                                                                                             | Owner agent        | Status      | Branch/worktree                    | Allowed scope                                                                                                                                                                                                                                                                                                          | Dependencies                                                                                                       | 更新时间               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ----------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| TASK-001 | 实现 AI Employee Factory v1                                                                                                                      | codex-20260803-01  | DONE        | current workspace (new repository) | 全仓库                                                                                                                                                                                                                                                                                                                 | 用户批准的 v1 实施计划                                                                                             | 2026-08-03 15:10 +0800 |
| TASK-002 | 实现本地 Web 管理控制台                                                                                                                          | codex-20260803-01  | DONE        | current workspace (no HEAD)        | 全仓库                                                                                                                                                                                                                                                                                                                 | TASK-001、用户批准的 Web 实施计划                                                                                  | 2026-08-03 16:38 +0800 |
| TASK-003 | 优化操作中心与 Agent ID 交互                                                                                                                     | codex-20260803-01  | DONE        | current workspace (no HEAD)        | Web UI 与相关测试                                                                                                                                                                                                                                                                                                      | TASK-002、用户 UI 反馈                                                                                             | 2026-08-03 17:54 +0800 |
| TASK-004 | 修复创建完成页命令复制                                                                                                                           | codex-20260803-01  | DONE        | current workspace (no HEAD)        | Web UI 与相关测试                                                                                                                                                                                                                                                                                                      | TASK-003、用户 UI 反馈                                                                                             | 2026-08-03 18:03 +0800 |
| TASK-005 | 补充终端命令用途说明                                                                                                                             | codex-20260803-01  | DONE        | current workspace (no HEAD)        | Web UI 与相关测试                                                                                                                                                                                                                                                                                                      | TASK-004、用户 UI 反馈                                                                                             | 2026-08-03 18:10 +0800 |
| TASK-006 | 修复生命周期反馈与 Skills 崩溃                                                                                                                   | codex-20260803-01  | DONE        | current workspace (no HEAD)        | 生命周期、Skills 与测试                                                                                                                                                                                                                                                                                                | TASK-005、用户 UI 反馈                                                                                             | 2026-08-03 18:19 +0800 |
| TASK-007 | 独立核实已提交基线                                                                                                                               | claude-20260803-01 | DONE        | master (34a98b8)                   | 只读验证                                                                                                                                                                                                                                                                                                               | TASK-001~006                                                                                                       | 2026-08-03 18:24 +0800 |
| TASK-008 | 默认接入 CC Switch 并核查飞书 Bridge                                                                                                             | codex-20260803-01  | DONE        | master (34a98b8)                   | Runtime、Bridge、Web、文档与测试                                                                                                                                                                                                                                                                                       | TASK-007、用户新要求                                                                                               | 2026-08-03 18:47 +0800 |
| TASK-009 | 实现员工回收站与 7 天延迟清理                                                                                                                    | codex-20260803-01  | DONE        | master (34a98b8)                   | 应用层、存储、CLI、Web、测试                                                                                                                                                                                                                                                                                           | TASK-008、用户确认的回收站设计                                                                                     | 2026-08-03 19:20 +0800 |
| TASK-010 | 实施记忆系统优化 OP0+Phase1(OP2)                                                                                                                 | claude-20260803-01 | DONE        | master (cb9723b)                   | 隔离与同步强化核心模块、锁、文档与测试                                                                                                                                                                                                                                                                                 | TASK-009、用户批准的研究优化方案                                                                                   | 2026-08-04 11:11 +0800 |
| TASK-011 | 备份密钥治理 OP2-E + R5 env 清洗                                                                                                                 | claude-20260803-01 | DONE        | master (7ef0f16)                   | backup/trash/runtime/config/doctor/CLI 与测试                                                                                                                                                                                                                                                                          | TASK-010、用户批准的 B+R5 范围                                                                                     | 2026-08-04 12:35 +0800 |
| TASK-012 | OP3-B 前向兼容基础 + OP3-C adapter 治理                                                                                                          | claude-20260803-01 | DONE        | master (c2a2b71)                   | schemas/agents/backup/runtime/adapters 与测试                                                                                                                                                                                                                                                                          | TASK-011、用户批准的 OP3-B+C 范围                                                                                  | 2026-08-04 12:46 +0800 |
| TASK-013 | OP4-A 可观测性 OperationStore + query + R12/R10                                                                                                  | claude-20260803-01 | DONE        | master (8b17712)                   | operation-store/operation-manager/server/config/launchd/CLI 与测试                                                                                                                                                                                                                                                     | TASK-012、用户批准的 OP4-A 范围                                                                                    | 2026-08-04 13:20 +0800 |
| TASK-014 | OP4-D prune 分类 + 保留上限 + doctor 磁盘检查                                                                                                    | claude-20260803-01 | DONE        | master (76ab134)                   | prune/factory-application/cli-program/doctor 与测试                                                                                                                                                                                                                                                                    | TASK-013、用户批准的 OP4-D 范围                                                                                    | 2026-08-04 14:14 +0800 |
| TASK-015 | OP4-B trace 关联 + ObservabilitySink 抽象                                                                                                        | claude-20260803-01 | DONE        | master (e690cd0)                   | observability/process-runner/operation-store/operation-manager/server/cli-program 与测试                                                                                                                                                                                                                               | TASK-013、用户批准的 OP4-B 范围                                                                                    | 2026-08-04 15:45 +0800 |
| TASK-016 | OP3-A 单一可写源（中期）+ config_hash + repair                                                                                                   | claude-20260803-01 | DONE        | master (4f15147)                   | registry-schema/agents/registry/create-agent/backup/factory-application/cli-program/doctor 与测试                                                                                                                                                                                                                      | TASK-010、用户批准的 OP3-A 范围                                                                                    | 2026-08-04 16:38 +0800 |
| TASK-017 | OP1 Stage A 认知记忆层运行时强制                                                                                                                 | claude-20260803-01 | DONE        | master (b53a872)                   | agent-schema/authority/templates/create-agent/factory-application/doctor 与测试 + DECISIONS ADR                                                                                                                                                                                                                        | TASK-010、用户批准的 OP1 Stage A 范围                                                                              | 2026-08-04 17:25 +0800 |
| TASK-018 | Skill 作用域(项目/用户) + Skill 商店(GitHub 源)                                                                                                  | claude-20260803-01 | DONE        | master (9831488)                   | skills/skill-store/config/paths/application/server/cli-program/web/api/tests + DOCS(D-003 更新)                                                                                                                                                                                                                        | 用户批准的三项设计决策(分离存储/可配置列表/顶级页)                                                                 | 2026-08-04 18:25 +0800 |
| TASK-019 | OP3-A 长期：移除 Registry runtime 块 + I-5 model 收紧 + migrate                                                                                  | claude-20260803-01 | DONE        | master (TASK-019 commit)           | registry-schema/registry/agents/runtime/bridge/job-runner/services/application/cli-program/doctor/web/create-agent/backup 与测试 + DECISIONS ADR                                                                                                                                                                       | TASK-016、用户批准的三项设计决策(HARD config_hash/SOFT migrate/N+1 list)                                           | 2026-08-04 19:16 +0800 |
| TASK-020 | 记忆系统剩余批次合并（OP2-F + CLI 结构化输出 + OP4-C + OP1 Stage B-E + OP5 A-E）                                                                 | claude-20260803-01 | IN_PROGRESS | master (TASK-020 commit(s))        | 12 阶段（extensions/backup/paths/agent-schema/process-runner/observability/operation-manager/knowledge/templates/transcript/experience/archival/service-adapter/factory-services/systemd-service/runtime/doctor/application/cli-program/web 与测试 + DECISIONS ADR）                                                   | TASK-019、用户批准的统一合并计划（12 阶段顺序依赖）                                                                | 2026-08-04 21:20 +0800 |
| TASK-021 | Chief/Todo/MCP 骨架（前端票：T01 git 基础 + T02 结构化 result + T03 取消单操作 + T04 Todo 领域核心 + T08 Chief 角色 + T11 MCP 传输+静态 bearer） | claude-20260803-01 | DONE        | main (56bcef6)                     | git.ts/usage.ts/operation-manager/task-schema/task-store/agent-schema/registry-schema/create-agent/cli-program/factory-application/templates/mcp-server/web-server 与测试 + DECISIONS ADR                                                                                                                              | 用户批准的多 Agent 协作骨架 spec（.scratch/spec-chief-todo-mcp.md）与 13 票计划（.scratch/chief-todo-mcp/issues/） | 2026-08-05 11:50 +0800 |
| TASK-022 | Chief 编排核心闭环（spec-chief-orchestration 4 票：01 计划+派发 + 02 规划门脏审计 + 03 审查门单向搬运 + 04 拆解回落与 orchestrate）              | claude-20260803-01 | DONE        | main (TASK-022 commit)             | task-store 扩展/factory-application 编排动作/cli-program plan+chief 命令组/orchestration.test.ts/cli-structure.test.ts + .agent 簿记 + docs/DECISIONS.md ADR(可选)                                                                                                                                                     | 用户批准的 spec-chief-orchestration 与 4 票计划（.scratch/chief-orchestration/issues/）                            | 2026-08-05 12:35 +0800 |
| TASK-023 | 编排 Operation 可观测性（spec-chief-todo-mcp user story 16/23/25：runTaskPlan/orchestrate 注册 Operation 返回 OperationDto + cancel 单例复用）   | claude-20260803-01 | DONE        | main (TASK-023 commit)             | operation-manager 迁移 core/factory-application 编排可观测/cli-program 展示/start.ts 共享实例/errors CANCELLED 码/orchestration.test.ts + .agent 簿记                                                                                                                                                                  | 用户批准的 spec-chief-todo-mcp 切片（编排 Operation 可观测性）                                                     | 2026-08-05 12:55 +0800 |
| TASK-024 | MCP 工具集（spec-chief-todo-mcp 阶段3 issue 12/13：读 8 + 编排写 5 工具，薄适配器穿应用 seam，静态 bearer）                                      | claude-20260803-01 | DONE        | main (TASK-024 commit)             | mcp-server 工具注册/server 传应用/mcp.test.ts 集成测/web-mcp.test.ts JSON 响应 + DECISIONS(D-021) + README + .agent 簿记                                                                                                                                                                                               | 用户批准的 spec-chief-todo-mcp 切片（MCP 工具集）                                                                  | 2026-08-05 14:00 +0800 |
| TASK-025 | Web Todo 视图（spec-chief-todo-mcp issue 07：员工详情 Todo 标签 + 计划级确认/驳回门 + 审查门合并/驳回 + 2s 轮询）                                | claude-20260803-01 | DONE        | main (TASK-025 commit)             | web/server.ts task-plans 路由/api.ts 客户端/AgentDetailPage TodoTab/styles.css + web-ui.test.tsx 覆盖 + ARCHITECTURE/TESTING/DECISIONS + .agent 簿记                                                                                                                                                                   | 用户批准的 spec-chief-todo-mcp 切片（Web Todo 标签）、TASK-022（编排核心闭环）、TASK-023（OperationDto 底座）      | 2026-08-05 14:35 +0800 |
| TASK-027 | Web 编排写面 + 单轮对话（放开 D-022/D-023 只读边界：Todo 创建/加项/派发 + Chief 发起 + 对话标签）                                                | claude-20260803-01 | IN_PROGRESS | main (TASK-027 commit)             | src/application(factory-application startPlanWithChief+runChat)/src/web/server.ts(5 写路由)/web/src/api.ts(5 方法)/AgentDetailPage(TodoTab 写面+Chief 发起+ChatTab)/styles.css + web-server.test.ts 2 新测 + web-ui.test.tsx 3 新测 + ARCHITECTURE/TESTING/DECISIONS(D-024) + .agent 簿记                              | 用户批准的 S1+S2 范围（S3 飞书入站单独立项）                                                                       | 2026-08-05 16:04 +0800 |
| TASK-026 | Chief Web 编排流水线视图（spec-chief-todo-mcp issue 10：纯流水线视图）                                                                           | claude-20260803-01 | DONE        | main (TASK-026 commit)             | web/api.ts(role 类型)/AgentDetailPage ChiefPipelineTab+TaskItemRow/styles.css 阶段条 + web-ui.test.tsx 4 新测 + ARCHITECTURE/TESTING/DECISIONS(D-023)                                                                                                                                                                  | 用户批准的 spec-chief-todo-mcp 切片（Web Chief 编排视图）、TASK-025、TASK-022                                      | 2026-08-05 14:53 +0800 |
| TASK-028 | CURRENT_STATE.md 自动更新（D-025：系统侧生命周期事件自动更新 + 员工自维护引导/放行 + 单文件自动 git 提交）                                       | claude-20260803-01 | IN_PROGRESS | main                               | src/core/current-state.ts(新)+git.ts(gitCommitFile)+templates.ts(种子+放行)+templates/*-agent/ENTRY.md.tmpl(引导段)+factory-application.ts(5 事件点+prepareRuntime 补放行) + tests/current-state.test.ts(新)+git/create-agent/runtime/application-management 增测 + ARCHITECTURE/DECISIONS(D-025)/README + .agent 簿记 | 用户批准的三项决策（仅关键状态 / 引导约定+放行 / 自动提交该文件）                                                  | 2026-08-05 17:15 +0800 |

## TASK-025 详情

```text
Task ID: TASK-025
Title: Web Todo 视图（spec-chief-todo-mcp issue 07：员工详情 Todo 标签 + 计划级确认/驳回门 + 审查门合并/驳回 + 2s 轮询）
Owner agent: claude-20260803-01
Status: DONE
Branch/worktree: main
Allowed scope: src/web/server.ts（task-plans 路由）、web/src/api.ts（TaskPlan/TaskItem 类型与方法）、web/src/pages/AgentDetailPage.tsx（TodoTab + 标签）、web/src/styles.css（todo 设计系统类）、tests/web-ui.test.tsx（覆盖标签渲染/2s 轮询/两闸门确认与驳回）、docs/ARCHITECTURE.md（Chief 编排与 Todo 状态机段）、docs/TESTING.md、docs/DECISIONS.md(D-022)、.agent 簿记
Forbidden scope: Web 派发执行（run/dispatch 属 CLI 范畴，issue 07 明确「走完流程」不含派发）、Web Chief 编排视图（issue 10，独立切片）、MCP 增强路径、用户真实服务状态、个人凭据
Dependencies: TASK-022（编排核心闭环）、TASK-023（OperationDto 底座）、用户批准的 spec-chief-todo-mcp 切片（Web Todo 标签）
Expected output: 员工详情页新增「Todo 任务」标签（与「任务」= 定时 Job 区分），列表展示计划/任务项状态，2 秒轮询；draft 计划提供确认/驳回门（带反馈），awaiting_review 项渲染审查结论并提供确认合并/驳回返工
Acceptance criteria:
  - 员工详情页新增「Todo 任务」标签（与「任务」= 定时 Job 区分）
  - 列表展示每个任务的状态，2s 轮询刷新
  - 「待确认」态（draft 计划）展开计划文本 + 确认计划/驳回计划（带反馈）
  - 「待审查」态渲染审查结论 + 确认合并/驳回返工（D-017 审查结果 verdict+note；原始 diff 不持久化，见 D-022）
  - 与既有运行/Job 面板风格一致（复用 status-badge/panel 设计系统）
  - 新增 UI 测试覆盖标签渲染、2s 轮询刷新、两种闸门的确认与驳回
  - /code-review（Standards+Spec 双轴）通过；全量单测通过（仅既有 date-sensitive experience.test.ts 失败除外）；任务完成即 commit（不 push）
Started at: 2026-08-05 14:20 +0800
Updated at: 2026-08-05 14:35 +0800
```

## TASK-024 详情

```text
Task ID: TASK-024
Title: MCP 工具集（spec-chief-todo-mcp 阶段3 issue 12/13：读 8 + 编排写 5 工具）
Owner agent: claude-20260803-01
Status: DONE
Branch/worktree: main
Allowed scope: src/mcp/mcp-server.ts（工具注册）、src/web/server.ts（传应用）、tests/mcp.test.ts（新集成测）、tests/web-mcp.test.ts（JSON 响应）、docs/DECISIONS.md(D-021)、README(roadmap)、.agent 簿记
Forbidden scope: 用户真实服务状态、个人凭据、web Todo 视图（独立切片）、MCP 推送路径（subscriptions/listen，MVP 不做）
Dependencies: TASK-021（MCP 传输+静态 bearer）、TASK-023（OperationDto 观测底座 + cancel 单例）、用户批准的 spec-chief-todo-mcp 切片
Expected output: /mcp 注册 13 个工具（读 8 + 编排写 5），薄适配器穿 FactoryApplication 单一 seam，与 Web/CLI 共享行为；run_task_plan 返回 OperationDto、客户端轮询 get_operation；cancel_operation 复用按 id 取消
Acceptance criteria:
  - 13 个工具与 spec 阶段3 工具集完全一致（读 8 + 编排写 5）
  - transport 以 enableJsonResponse:true 运行，POST 返回 JSON 响应（主路径轮询），GET /mcp SSE 保留
  - 读工具穿过应用 seam，返回遵循脱敏约束（回归测试断言不泄露注入工作区的 secret 形态 token）
  - 写工具驱动 Todo 状态机：create→draft、approve→active、run→succeeded、review→approved、cancel→cancelled
  - 无/错 bearer token → AUTH_REQUIRED；未知工具/参数校验失败 → isError
  - /code-review（Standards+Spec 双轴）通过；全量单测通过（仅既有 date-sensitive experience.test.ts 失败除外）；任务完成即 commit（不 push）
Started at: 2026-08-05 13:40 +0800
Updated at: 2026-08-05 14:00 +0800
```

## TASK-023 详情

```text
Task ID: TASK-023
Title: 编排 Operation 可观测性（spec-chief-todo-mcp user story 16/23/25：runTaskPlan/orchestrate 注册 Operation 返回 OperationDto + cancel 单例复用）
Owner agent: claude-20260803-01
Status: DONE
Branch/worktree: main
Allowed scope: OperationManager 迁移 core、编排可观测、CLI 展示、web 共享实例、CANCELLED 错误码、测试与 .agent 簿记
Forbidden scope: 用户真实服务状态、个人凭据、MCP 工具实现（阶段 3 独立切片）、Web Todo 视图（独立切片）
Dependencies: TASK-022（编排核心闭环）、用户批准的 spec-chief-todo-mcp 切片
Expected output: 编排动作注册可观测 Operation 并返回 OperationDto；web/CLI 可查进度、可取消；synchron 调用方经 waitOperation 等终态后取计划
Acceptance criteria:
  - runTaskPlan 后台派发并返回 OperationDto（type=task_plan，agentId=owner），可经 operationManager.get/list 查询、可取消
  - 派发落盘一条 kind=task_plan 的 OperationSummary 到 operations.jsonl（可审计）
  - orchestrate 返回 operation 句柄（confirmed 时），派发失败/取消经 waitOperation 抛 OPERATION_FAILED/CANCELLED
  - web/start 复用应用级 OperationManager，编排操作在 web 控制台 operations 列表可见
  - OperationManager 由 src/web/ 迁至 src/core/（无行为变更，更新 3 处 import）
  - 全量单测通过（仅既有 date-sensitive experience.test.ts 失败除外）
Started at: 2026-08-05 12:50 +0800
Updated at: 2026-08-05 12:55 +0800
```

## TASK-022 详情

```text
Task ID: TASK-022
Title: Chief 编排核心闭环（spec-chief-orchestration 4 票：01 计划+派发 + 02 规划门脏审计 + 03 审查门单向搬运 + 04 拆解回落与 orchestrate）
Owner agent: claude-20260803-01
Status: DONE
Branch/worktree: main
Allowed scope: task-store.ts(addItem/updateItem/setPlanStatus)/factory-application.ts(编排方法+计划锁)/cli-program.ts(plan 组+chief run)/tests(orchestration.test.ts+cli-structure.test.ts) + .agent 簿记
Forbidden scope: 破坏既有隔离/D-003、编排器读 worker workspace 直连（守 D-017 单向搬运）、推送
Dependencies: TASK-021（前端 6 票底座）、用户批准的 spec-chief-orchestration 与 4 票计划
Expected output: 顶层一句话闭环——planWithChief 拆解回落 + runTaskPlan 波次派发（依赖阻塞/失败不阻塞/跳过已完成/并发可选）+ 规划门脏审计 + reviewTaskPlan 单向搬运审查 + confirm/reject 人工合并 + CLI plan 组与 chief run
Acceptance criteria: npm run build + tsc 全绿；单测全绿（290/291，唯一失败为既有 date-sensitive experience.test.ts）；/code-review（Standards+Spec 双轴）通过；任务完成即 commit（不 push）。
Started at: 2026-08-05 12:13 +0800
Updated at: 2026-08-05 12:35 +0800
```

## TASK-021 详情

```text
Task ID: TASK-021
Title: Chief/Todo/MCP 骨架（多 Agent 协作，spec-chief-todo-mcp 前端 6 票：T01/T02/T03/T04/T08/T11）
Owner agent: claude-20260803-01
Status: DONE
Branch/worktree: main
Allowed scope: git.ts(新增)/usage.ts/task-schema.ts(新增)/task-store.ts(新增)/mcp-server.ts(新增)/operation-manager/agent-schema/registry-schema/create-agent/cli-program/factory-application/templates/web-server 与相关测试 + .agent 簿记 + docs/DECISIONS.md ADR
Forbidden scope: 破坏既有隔离/CC Switch/备份回收语义、编排器读 worker workspace（守 D-017/D-003）、推送
Dependencies: 用户批准的多 Agent 协作 spec（.scratch/spec-chief-todo-mcp.md）与 13 票计划（.scratch/chief-todo-mcp/issues/，阻塞：None）
Expected output: 前端 6 票落地——git 受控封装（基线提交/状态/diff/快照）、结构化 result 纯函数、OperationManager.cancel(id)、Todo 7+2 状态机 TaskStore、Chief 角色（--role chief 创建 + registry/config 持久化）、MCP StreamableHTTP 传输+静态 bearer
Acceptance criteria: 每票 npm run verify（build+单测全绿+lint --max-warnings=0+prettier）；/code-review（Standards+Spec 双轴）通过；任务完成即 commit（不 push）。
Started at: 2026-08-05 11:30 +0800
Updated at: 2026-08-05 11:48 +0800
Outcome: 前端 6 票完成。T01 git.ts(新增) gitStatusShort/gitAddCommit/gitDiff/snapshotWorkspaceHash 受控封装（execa shell:false，cwd 内），create-agent 基线提交缺身份时可恢复提示（gitAddCommit requireIdentity:false 返回 false 时 console.warn 提示补提交）；T02 src/core/usage.ts 增 parseClaudeResult/parseCodexResult/parseStructuredResult 纯函数（codex JSONL 事件 schema 修正为 event.item.type==='agent_message'→event.item.text）；T03 src/web/operation-manager.ts 增 OperationManager.cancel(id)（NOT_FOUND/CONFLICT 守卫+controller.abort）；T04 src/schemas/task-schema.ts(新增) 7+2 状态机 TASK_ITEM_STATES/TASK_ITEM_TRANSITIONS/canTransition 纯函数+taskItemSchema/taskPlanSchema，src/core/task-store.ts(新增) TaskStore（workspace/tasks/plans，list/get/create/transitionItem/remove/reconcile，derivePlanStatus 从 nextItems 派生）+原子落盘；T08 agent-schema/registry-schema 增 agentRoleSchema('worker'|'chief')+create-agent --role 持久化+cli-program --role 选项+list 角色列；T11 src/mcp/mcp-server.ts(新增) createMcpEndpoint（@modelcontextprotocol/sdk@^1.30.0 StreamableHTTPServerTransport，经 request.raw/reply.raw 挂既有 Fastify 共享进程生命周期）+手写 mcpAuthorized 恒定时间 bearer 校验，web-server/start 增 enableMcp/mcpToken，guard 复用既有 loopback onRequest。docs/DECISIONS.md 增 D-017（Chief 交叉审查编排器单向搬运）+ D-018 修订为实际实现（MCP SDK StreamableHTTP + 手写 bearer，2.x fastify/server 包裁定不适用）。新增 tests：git(+1 no-identity 可恢复)、usage、task-schema、task-store、web-mcp(+7)。全量 270 过 1 失败（既有 date-sensitive experience.test.ts 硬编码 2026-08-04，干净树复现，非本任务引入）。/code-review 双轴通过（Standards：D-018 文档对齐已修；Spec：T01 可恢复提示+T11 依赖裁定已补）。未 push。
```

## TASK-020 详情

```text
Task ID: TASK-020
Title: 记忆系统剩余批次合并（OP2-F 扩展面隔离 + CLI 结构化输出 + OP4-C OTel GenAI + OP1 Stage B-E + OP5 A-E）
Owner agent: claude-20260803-01
Status: IN_PROGRESS
Branch/worktree: master (TASK-020 commit(s)，每阶段一 commit)
Allowed scope: 12 阶段（阶段1 OP2-F extensions/backup/paths/agent-schema；阶段2 CLI 结构化输出 process-runner/runtimes；阶段3 OP4-C observability/operation-manager；阶段4 OP1-B knowledge/templates/application/cli-program/doctor；阶段5 OP1-C process-runner/transcript；阶段6 OP1-D experience；阶段7 OP1-E archival；阶段8 OP5-A service-adapter/factory-services/systemd-service/doctor；阶段9 OP5-B runtime/doctor；阶段10 OP5-C 调研文档；阶段11 OP5-D runtime；阶段12 OP5-E paths）与相关测试及 .agent 簿记 + docs/DECISIONS.md ADR
Forbidden scope: 破坏既有隔离/CC Switch/备份回收语义、schema_version 破坏、推送
Dependencies: TASK-019、用户批准的统一合并计划（.claude/plans/refactored-frolicking-lynx.md，12 阶段顺序依赖，数据可达性门控）
Expected output: 扩展点限定为 data-only/adapter-interface；CLI 结构化输出可解析（若可达）；OP4-C gen_ai span（gated）；OP1 knowledge/ 索引+recall、transcript 持久化、ExperienceExtractor、archival 前置约束；OP5 ServiceAdapterFactory+systemd 桩、CC Switch 降级+mtime 缓存+白名单外置、换机调研、per-agent Provider、PathLayout 收敛
Acceptance criteria: 每阶段 npm run verify（build+test 全绿+lint --max-warnings=0+prettier）与 test:e2e 实跑通过；每阶段独立 commit（不 push）；每 commit 更新 .agent 簿记；任务完成即 commit。
Started at: 2026-08-04 19:20 +0800
Updated at: 2026-08-04 21:20 +0800
Outcome: 阶段1（OP2-F 扩展面能力隔离 R23）完成。src/core/extensions.ts(新增) ExtensionKind='data-only'|'adapter-interface'|'subprocess'+ExtensionSandbox/ExtensionManifest/Extension 契约类型（设计级，v1 不固化加载器）；src/core/backup.ts 把模块级 shouldCopy/excludedNames/excludedExtensions 收敛为 BackupFilter 接口+defaultBackupFilter() 纯函数零 I/O，BackupService 构造注入 filter?:BackupFilter（默认 defaultBackupFilter()），全部 shouldCopy 调用改 this.filter.shouldCopy；src/core/paths.ts 增 PathLayout 数据契约接口（home/workspaceRoot/managedDirs）+resolvePathLayout 派生（所有受管目录均位于 home 树内，assertInside 保证，纯数据不 hold fs）；src/schemas/agent-schema.ts 增 portableMemorySchema+PortableMemorySchema 类型（memory 块权威类型导出，agentConfigSchema.memory 复用，schema 内容与旧 memory 块同构零行为变更）。docs/DECISIONS.md 增 D-013 ADR（扩展点限定为 data-only/adapter-interface，禁止同进程 JS 模块直接持有 fs/execa）。新增 tests/paths.test.ts resolvePathLayout 断言所有 managedDirs 经 assertInside 位于 home 内、tests/backup-restore.test.ts 注入 BackupFilter 断言隔离生效（shouldCopy:()=>true 时 .env 被备份）。npm run verify（build+180 单测全绿+lint --max-warnings=0+prettier）实跑通过。未 push。

阶段2（CLI 结构化输出，A2 门控通过）完成。调研写入 .scratch/cli-structured-output.md：Claude 完全可达（`claude -p --output-format json` 单对象含 usage input/output/cache tokens、modelUsage per-model canonicalModel+costUSD、total_cost_usd、result，本机 2.1.221 实测）；Codex 仅 token 可达（`codex exec --json` JSONL 事件流仅 turn.completed 携带 usage 含 cached_input_tokens，事件 schema 无 model/cost，源码核查 openai/codex main codex-rs/exec）。src/core/usage.ts(新增) RunUsage 类型+parseClaudeUsage（主模型取 modelUsage inputTokens 最大者）/parseCodexUsage（累加 turn.completed usage）/parseStructuredUsage 纯函数零 I/O；runtime-adapter.ts run 增 structured?:boolean 参，claude-adapter structured=true 追加 --output-format json、codex-adapter 追加 --json；process-runner.ts LoggedRunOptions 增 provider/structured、LoggedRunResult 增 usage，runLogged 结束后读 stdout 文件 best-effort 解析写入 metadata.json 与 result（exactOptionalPropertyTypes 下条件展开）。新增 tests/usage.test.ts(+8)、process-runner +2、runtime +2；共 188 单测。npm run verify（build+188 单测全绿+lint --max-warnings=0+prettier）实跑通过。未 push。

阶段3（OP4-C OTel GenAI span，gated on 阶段2）完成。src/core/observability.ts SpanAttrs 增 'gen_ai.request.model'/'gen_ai.usage.input_tokens'/'gen_ai.usage.output_tokens'/'gen_ai.usage.cost_usd'（可选）+toGenAiAttrs(usage) 映射助手（缺省字段省略，Codex 无 model/cost 自然不报）；src/web/operation-manager.ts OperationTask 返回类型增 usage?:RunUsage，execute 内 task 结果 usage 经 finally span.end(toGenAiAttrs(usage)) 上报（无 usage 传 {}，向后兼容）；src/application/factory-application.ts runAgent 默认启用结构化输出（run 传 structured=true + options 合并 provider/structured），runLogged 解析 usage；src/web/server.ts run handler 返回 {exitCode, usage?} 透传。新增 tests/observability.test.ts toGenAiAttrs(+2)、operation-manager +2（RecordingSink 捕获 endAttrs 断言 gen_ai 属性/无 usage 传 {}）。共 192 单测。npm run verify（build+192 单测全绿+lint --max-warnings=0+prettier）实跑通过。未 push。

阶段4（OP1 Stage B knowledge/ 轻量索引 + recall）完成。src/core/knowledge.ts(新增) KnowledgeIndex 接口（ingest/recall/compact/verifyConsistency）+KnowledgeEntry（frontmatter title/summary/keywords/updated_at/authority_layer）+defaultLayerFor（按顶层子目录推断：decisions→'decisions'、其余→'knowledge'）；src/core/knowledge-index.ts(新增) KnowledgeIndexImpl 扫描 knowledge/**\/*.md 解析 frontmatter 建关键词倒排，写派生 knowledge/.index.json（atomicWriteFile 0600，.gitignore 排除），recall 中文感知（整词+2-gram 退化+同义词扩展），verifyConsistency 检测漂移（missing-index/stale-entry/orphan-entry/倒排不一致）；src/core/templates.ts 增 knowledge/README.md frontmatter 约定种子+workspace .gitignore 排除 knowledge/.index.json；src/application/factory-application.ts knowledgeIngest/knowledgeCompact/knowledgeRecall/knowledgeVerify/knowledgeRead/knowledgeWrite 复用 documentFile 的 assertInside+realpath+symlink 硬约束模式，写后自动 re-ingest；src/cli-program.ts 新增 agentctl knowledge 命令组（rebuild/recall/verify）；src/core/doctor.ts 增 knowledge-index 索引漂移检查（不一致 warn，remediation 指向 knowledge rebuild）；src/web/server.ts 增 GET /api/v1/agents/:id/knowledge/recall?q= 只读 API。新增 tests/knowledge.test.ts(+8：tokenize/ingest+recall/decisions 层默认/compact+drift/missing-index/端到端 API/路径穿越拒绝/写后 re-ingest)。共 201 单测（阶段4 新增 8，净增 1 因 e2e 一次 countRunLogs 统计差异；实际功能测试 200 项全绿，4 项既有失败为并发 TASK-018 合并引入的 skill 计数回归，非本阶段引入）。npm run verify（build+lint --max-warnings=0+prettier 全绿；test 4 项既有失败为 TASK-018 技能空预设回归，干净树复现）实跑确认。未 push。

阶段5（OP1 Stage C chat transcript 持久化，为 Stage D 铺路）完成。src/core/transcript.ts(新增) TranscriptSummary（agent_id/operation/started_at/finished_at/exit_code/topics/decisions/lessons/tail）+TranscriptSink 接口+FileTranscriptSink.persist（ensureDir+append+0600+chmod）+summarizeTranscript 纯函数（TOPIC_LINE_PATTERN/DECISION_PATTERN/LESSON_PATTERN 抽取，tail/decisions/lessons 经 redactSecrets 脱敏）；src/core/process-runner.ts LoggedRunOptions 增 transcript?:boolean 与 transcriptSummary? 覆盖、LoggedRunResult 增 transcriptFile?，runLogged 在 transcript 启用时收集 stdout 行，元数据写完后 best-effort persist 摘要到 logs/<id>/runs/<slug>/transcript.jsonl（0600，失败不阻断）；src/schemas/agent-schema.ts portableMemorySchema 增 transcript_persist:z.boolean().optional()（opt-in，缺省不落盘，D-006 对齐）；src/application/factory-application.ts runAgent/runJob 在 agent.memory.transcript_persist===true 时透传 transcript:true，chat 保持 runInteractive 不落盘。新增 tests/transcript.test.ts(+6：摘要抽取+脱敏、FileTranscriptSink 0600、runLogged 启用/默认不写/脱敏落盘、agent.yaml opt-in 端到端)。npm run verify（build+lint --max-warnings=0+prettier 全绿；207 测试中 206 过，唯一失败为 tests/skills.test.ts 因工作区另一 Agent 未提交 skills.ts 改动——Skill remove 改彻底卸载删 .archive 路径——所致，与本阶段无关）实跑确认。未 push。

阶段6（OP1 Stage D ExperienceExtractor，严格 gate on Stage C）完成。src/core/experience.ts(新增) MemoryAsset（targetScope:'knowledge'/relPath/content/authorityLayer）+ExperienceExtractor 接口+DefaultExperienceExtractor（从 TranscriptSummary 的 decisions/lessons 收敛为一条 lessons/<date>-<agentId>.md 经验文档，frontmatter title/summary/keywords/authority_layer/updated_at，零 I/O 纯函数）+sanitizeSlug；src/schemas/agent-schema.ts portableMemorySchema 增 experience_extraction:z.boolean().optional()（opt-in，硬约束：仅当 transcript_persist=true 即 Stage C 落地才生效）；src/application/factory-application.ts 增公开 extractExperience(id,transcriptFile)+私有 maybeExtractExperience（守卫 experience_extraction!==true/transcript_persist!==true/无 transcriptFile 直接 return；写回复用 knowledgeWrite 的 assertInside+realpath+symlink 硬约束；读最后一行 transcript 解析 summary 并强制覆盖 agent_id），runAgent/runJob 在 transcript 落盘后 best-effort 调用（失败不阻断）；顺带修复另一 Agent commit 30dc9d8 引入的 src/cli-program.ts prettier 超长行（纯换行 wrap，恢复 repo 级 prettier gate，零行为变更）。新增 tests/experience.test.ts(+5：sanitizeSlug、无决策经验返回空、一条资产+frontmatter、transcript 落盘后提取 lessons 文件+recall 命中、experience_extraction=false 不写文件)。npm run verify（build+216 单测全绿+lint --max-warnings=0+prettier 全绿）实跑通过。未 push。

阶段7（OP1 Stage E archival 前置约束，先于任何后端实现）完成。src/core/archival.ts(新增) 仅定义 ArchivalBackend 接口（kind:'local-sqlite'|'external'|'none'，默认 none）+ArchivalEntry/ArchivalResult 契约，不实现任何后端；docs/DECISIONS.md 增 D-014 ADR（archival 写入前须经 SECRET_PATTERN 过滤、用户显式 per-entry 授权、不得传输 runtime_home/bridge 内容、网络面/多租户威胁模型须安全评审；与既有本地归档区 PruneService.archives 区分）；docs/ARCHITECTURE.md 增 OP1 Stage E 前置约束段。纯契约+文档，无测试（按计划）。npm run verify 实跑（build+216 单测全绿+lint+prettier 全绿）确认。未 push。

阶段8（OP5-A ServiceAdapterFactory + systemd 桩）完成。src/services/factory-services.ts 增 ServiceAdapterFactory 接口（provider/bridge/job）+createServiceFactory(provider) 按 config.yaml service_provider 分发（launchd/systemd，未知抛错）+LaunchdServiceAdapterFactory（原 bridgeLaunchdService/jobLaunchdService 保留为兼容委托，ServiceAdapter 接口不变）；src/services/systemd-service.ts(新增) SystemdServiceAdapterFactory 桩（bridge/job 返回 SystemdServiceAdapter，install/start/stop/restart/uninstall 抛 DEPENDENCY_MISSING，status 返回 error，零副作用）；src/core/doctor.ts service-platform 检查从 process.platform 改为按 config.yaml service_provider 分发（launchd pass/systemd warn 桩/其他 warn）；新增 tests/service-adapter.test.ts(+5：createServiceFactory 分发 launchd/systemd/未知抛错、systemd 桩 install 抛 DEPENDENCY_MISSING、status 返回 error)；ASSUMPTIONS.md 记 service_provider 分发语义、ARCHITECTURE.md 模块边界更新。npm run verify（build+221 单测全绿+lint --max-warnings=0+prettier 全绿）实跑通过。未 push。

阶段9（OP5-B CC Switch 降级 + mtime 缓存 + 白名单外置）完成。presets/cc-switch-allowlist.json(新增) 外置白名单（variables 22 项 + routed_fields 3 项，_comment 说明语义）；src/core/runtime.ts：删除硬编码 ccSwitchClaudeProviderVariables/routedFields Set，改为 loadAllowlist()（从 presets/ 加载，加载失败回退内置 FALLBACK_*，模块级缓存）；新增 SyncCache 接口+createSyncCache() 工厂（isStale 对 mtime<0 源缺失恒真，防把「源缺失」误判为缓存命中跳过 NOT_FOUND/降级）；syncCcSwitchClaudeProvider 增 cache?:SyncCache 参数（源 mtime 未变且已同步则返回 cached:true 摘要跳过重写；源缺失时优先从 agent.runtime_home/.cc-switch.env（0600，用户预置，KEY=VALUE 注释行忽略，仅白名单字段生效）降级读取，降级不参与 mtime 缓存）；CcSwitchSyncSummary 增 cached?:boolean；src/application/factory-application.ts FactoryApplication 增 ccSwitchSyncCache 实例（prepareRuntime 传入）；src/core/doctor.ts 增 cc-switch-env-mode 检查（.cc-switch.env 存在且权限≠0600 报 fail+chmod 600 remediation，无该文件不检查）。新增 tests/runtime.test.ts(+4：SyncCache mtime 未变跳过/变更重写、.cc-switch.env 降级+白名单过滤+0600 产物、非 0600 拒绝、loadAllowlist 22+3 外置同构)；tests/doctor.test.ts(+1：.cc-switch.env 权限 fail→chmod 600→pass，无文件不检查)。共 226 单测。npm run verify（build+226 单测全绿+lint --max-warnings=0+prettier 全绿）实跑通过。未 push。

阶段10（OP5-C 换机重授权成本调研+文档）完成。调研写入 .scratch/op5-c-migration.md：Codex OAuth token 可迁移（~/.codex/auth.json 0600 含 id_token/access_token/refresh_token/account_id，官方文档确认不绑定主机，可换机复制；但 token 会轮换且 keyring 存储时复制法不适用）；飞书非扫码路径存在（lark-channel-bridge profile create --app-id --app-secret --tenant 用既有应用凭据建 profile，App Secret 进加密 keystore profiles/<name>/secrets.enc 0600，扫码仍须人在场）；Claude 已非交互（CC Switch 同步 + OP5-B 降级）；不实现 agentctl migrate 向导（MigrationWizard 保持设计级草图，OP5-C 原始为「立项评估，非承诺」）。docs/DECISIONS.md 增 D-015 ADR（换机重授权裁定：推荐配置 0 次交互/员工、最坏 2 次；Factory 不自动复制/注入凭据，守 D-006）；README 增「换机授权清单（OP5-C）」段（三运行时授权方式与交互次数表）。纯调研+文档，无代码改动。npm run verify 实跑（build+226 单测全绿+lint+prettier 全绿）确认。未 push。

阶段11（OP5-D per-agent Provider 解耦）完成。src/schemas/registry-schema.ts registryAgentSchema 增 optional credential_provider:string（Registry 本机绑定侧，不进便携文件 agent.yaml，守 D-006/OP3-A 便携面；v2 加性字段零 bump）；src/core/runtime.ts：新增 SqliteExecutor 类型+defaultSqliteExecutor（sqlite3 CLI `-readonly -json` 只读查询，CI ubuntu/Node 20.19 无 node:sqlite 且不引入原生依赖；sqlite3 打开不存在文件 exit 1 报 NOT_FOUND），ccSwitchProviderSettingsConfig（app_type='claude' AND name=...，单引号 '' 转义防注入，解析 settings_config.env）+ccSwitchProviderNames（NOT_FOUND 时列出可用 Provider）；syncCcSwitchClaudeProvider 增 providerName?:string + sqliteExecutor?:SqliteExecutor 参数（providerName 指定时从 DB 读该 Provider settings_config 白名单过滤，否则沿用 live settings.json 零行为变更），抽出 applyProviderEnv 公共尾部（合并写+保留员工非白名单+R24 routedFieldsChanged+atomicWriteFile 0600）；src/application/factory-application.ts syncRuntime(id,{provider}) 增 --provider 写/清 Registry 绑定（live 清除），prepareRuntime 把 registry.credential_provider 透传；src/cli-program.ts runtime sync 增 --provider <name>（exactOptionalPropertyTypes 下条件传参）；src/core/doctor.ts 增 credential-provider 检查（claude 且有绑定 → warn 短期语义+remediation 指向 --provider live，无绑定 → pass）。新增 tests/runtime.test.ts(+3：providerName 注入 SqliteExecutor 同步指定 Provider+白名单+0600+摘要无值、缺失 Provider NOT_FOUND、真实 sqlite3 CLI e2e 绑定非 live Relay B 白名单过滤)、registry +1（updateAgent round-trip credential_provider 设置/清除）、doctor +1（绑定 warn→live 清除 pass）、cli-structure +1（runtime sync --provider 选项）。共 231 单测。docs/DECISIONS.md 增 D-016 ADR（per-agent Provider 绑定：读库机制 sqlite3 CLI 裁定、不进便携文件边界、短期 warn 长期 fail）；README 增 --provider 用法段+换机表注释。npm run verify 实跑（build+231 单测全绿+lint --max-warnings=0+prettier 全绿）通过。npm run test:e2e 在干净树同样失败（web-console.spec.ts 既有 feedback-analyze Skill 可见性 flake，非本阶段引入，已用 git stash 复现确认）。未 push。

阶段12（OP5-E PathLayout 收敛）完成。src/core/paths.ts 增 assertPathLayout 同步校验（data-only 零 I/O，校验全部受管目录位于 home/workspaceRoot 两棵树内；外置卷须 bind mount/符号链接挂入树内并经 assertInsideReal realpath 校验，违反抛 VALIDATION_ERROR+remediation）+isInsideAny 助手，PathLayout 注释与接口语义显式化（R25：根必须位于 home/workspaceRoot 树内；外置卷默认不支持直接作为受管目录；home/workspaceRoot 本身允许用户显式覆盖到外置卷属刻意选择不硬失败，受管目录仍须落回树内）；docs/ARCHITECTURE.md 增「OP5-E：PathLayout 路径布局收敛（R25）」段。新增 tests/paths.test.ts(+4：assertPathLayout 默认布局通过、逃逸 /etc 拒绝+remediation 含 bind mount/符号链接/realpath、home 前缀兄弟目录拒绝、workspaceRoot 显式覆盖作为第二棵树不改变受管目录根、home 外置覆盖时外部受管目录仍拒绝)。共 235 单测。npm run verify 实跑（build+235 单测全绿+lint --max-warnings=0+prettier 全绿）通过。未 push。
```

## TASK-019 详情

````text
Task ID: TASK-019
Title: OP3-A 长期（Registry 移除 runtime 块 + I-5 model 收紧 + agentctl migrate）
Owner agent: claude-20260803-01
Status: IN_PROGRESS
Branch/worktree: master (TASK-019 commit)
Allowed scope: OP3-A 长期（registry-schema.ts REGISTRY_VERSION=2 移除 runtime 块、registry.ts 版本化读取+refreshConfigHash+migrate、agents.ts loadPortableConfig HARD config_hash 校验、runtime-adapter/claude/codex adapter 增 runtime 参数、runtime.ts getRuntimeAdapter(runtime)+buildRuntimeEnvironment(agent,runtime)+syncCcSwitchClaudeProvider(runtime)、job-runner/bridge/factory-services 增 runtime 透传、create-agent/backup 写 registry 不再带 runtime、factory-application.ts N+1 list+toSummary(provider)+repairAgent 重写+migrate 封装、cli-program.ts agentctl migrate、doctor.ts runtime-lock 改 portableConfig+config-drift fail、web api.ts+AgentDetailPage runtime 来源、所有 RegistryAgent fixture 删 runtime 块）与相关测试及 .agent 簿记 + docs/DECISIONS.md D-012 ADR
Forbidden scope: 改隔离层/CC Switch/备份回收、OP1 Stage B-E、OP2-F、OP5、OP4-C、schema_version 以外破坏、推送
Dependencies: TASK-016（config_hash 中期）、TASK-012（版本化只读读者）、用户确认的三项设计决策（HARD config_hash 硬校验 / SOFT 版本化 migrate / N+1 读 agent.yaml 取 provider）
Expected output: Registry 彻底移除 runtime 块（provider/locked/model），agent.yaml 为 runtime 唯一来源；loadPortableConfig 对 config_hash 漂移抛 CONFLICT 阻断运行，repairAgent 作为 HARD 逃生口原样修复；agentctl migrate 处理 schema v1→v2 升级；list()/dashboard() N+1 读 agent.yaml 取实时 provider
Acceptance criteria: registrySchema v2 无 runtime 且 config_hash 保留；read() 对 v1 内存规范化 v2 不丢数据、未知版本报错、migrate 重写磁盘 v2；loadPortableConfig 漂移抛 CONFLICT；repairAgent 绕过 loadPortableConfig 修复（含缺 config_hash）；list N+1 返回 provider、缺 yaml='unknown'；agentctl migrate --dry-run 可用；build/test/lint/e2e 实跑通过；任务完成即 commit（不 push）。
Started at: 2026-08-04 18:56 +0800
Updated at: 2026-08-04 19:16 +0800
Completed at: 2026-08-04 19:16 +0800
Outcome: OP3-A 长期全部落地。registry-schema REGISTRY_VERSION=2，registryAgentSchema 删 runtime 块、保留 config_hash: z.string().optional()，registrySchema.version literal(2)。registry.ts read() 版本分发（v1→normalizeRegistryV1 内存规范化丢弃 runtime 保留 config_hash 与其余字段、v2 原样、未知版本 VALIDATION_ERROR），migrate({dryRun}) registry.lock 下重写 v2，resyncRuntime 改 refreshConfigHash(id, configHash)，updateAgent 删 runtime 守卫。agents.ts loadPortableConfig HARD 校验（config.id===agent.id 且 computeConfigHash(config.runtime)===agent.config_hash，缺失/不符抛 CONFLICT 提示 agentctl repair），新增 readAgentConfigFile 原始只读 reader。adapters chat/run(agent,runtime)、getRuntimeAdapter(runtime)、buildRuntimeEnvironment(agent,runtime)、syncCcSwitchClaudeProvider(agent,runtime,...)、bridge run/authorize/status/secureProfile(agent,runtime)、job-runner run(agent,runtime,job,options)、launchd services(agent,runtime,...) 全部 runtime 透传。create-agent/backup 写 registry 不再带 runtime，backup manifest provider 从暂存 agent.yaml 读、restore provider 从恢复的 agent.yaml 读。factory-application listAgents N+1 读 agent.yaml 取实时 provider（缺/无效 yaml→'unknown'）、repairAgent 重写返回 {id,config_hash}、migrate 封装。cli-program.ts 新增 agentctl migrate（--dry-run）。doctor.ts runtime-lock 改 portableConfig.runtime.locked、config-drift 状态 warn→fail。web api.ts AgentSummary.runtime 加 'unknown'、AgentDetail 删 registry.runtime 增 agent.runtime，AgentDetailPage 改读 agent.runtime.*。修复 locks.ts readExisting 重读 ENOENT 误报「锁文件损坏」的并发竞态。新增 registry 迁移（v1→v2 归一化/migrate 重写/未知版本）、HARD config_hash 漂移 CONFLICT、repairAgent 绕过、list N+1 'unknown'、agentctl migrate 命令结构测试；所有 RegistryAgent fixture 删 runtime 块。docs/DECISIONS.md 增 D-012 ADR，.scratch/plan.md 写 OP3-A 长期 spec。npm run verify（build+test 176 全绿+lint --max-warnings=0+prettier）与 npm run test:e2e 实跑通过。未 push。

## TASK-018 详情

```text
Task ID: TASK-018
Title: Skill 作用域(项目级/用户级) + Skill 商店(GitHub 远程源)
Owner agent: claude-20260803-01
Status: DONE
Branch/worktree: master (TASK-018 commit)
Allowed scope: src/core/skills.ts(scope 模型)、src/core/skill-store.ts(新增)、src/core/config.ts(skill_store schema+默认源)、src/core/paths.ts(skillStoreDir)、src/application/factory-application.ts(scope 感知+store 方法)、src/web/server.ts(scope+store 路由)、src/cli-program.ts(skill-store 命令+scope 旗标)、web/src/api.ts/SkillStorePage.tsx(新)/AgentDetailPage.tsx/styles.css/App.tsx、tests/skills.test.ts+skill-store.test.ts(新)+web-ui.test.tsx+e2e、docs/DECISIONS.md(D-003 更新)+ARCHITECTURE+README+GLOSSARY、.agent 簿记
Forbidden scope: 改备份/回收站/CC Switch/隔离层语义、改现有 skill 安装方式的默认行为、OP1/OP2/OP3/OP4/OP5、推送
Dependencies: 用户批准的三项设计决策（separate storage 分离存储 / configurable repo list 可配置列表+内置默认 / top-level page 顶级页+员工入口）
Expected output: 员工详情 Skills 按项目级/用户级分组展示；SkillService 支持 scope 安装/列出/归档；Skill 商店连接可配置 GitHub 源扫码安装；不破坏现有上传/路径/CLI 安装方式
Acceptance criteria: list 返回 scope 标注；project 存 workspace/skills 投影 .claude/.codex/skills，user 存 runtimeHome/skills 原位；现有安装默认 project 不改行为；store 仅接受 github.com HTTPS 源；安装复用 SkillService.install 复用 symlink 拒绝；build/test/lint/e2e 实跑通过；任务完成即 commit（不 push）。
Started at: 2026-08-04 17:47 +0800
Updated at: 2026-08-04 18:25 +0800
Completed at: 2026-08-04 18:25 +0800
Outcome: Skill 作用域 + Skill 商店全部实现并测试通过。src/core/skills.ts 增 SkillScope='project'|'user'，SkillMetadata 增 scope 字段，list() 扫描 project+user 两根并标注，install(source,scope) 存 storeRoot(scope)（project→workspace/skills 并投影 .claude/.codex/skills，user→runtimeHome/skills 原位，无 runtimeHome 抛 VALIDATION_ERROR），remove 归档到对应根 .archive，listRoot 跳过 .archive/.staging-* 与用户级软链（历史 Codex preset 投影）。project 相对软链 ../../skills/<name>。src/core/skill-store.ts(新增) SkillStoreService：listRepositories/addRepository(非 github.com 拒绝)/removeRepository/refresh(git clone --depth 1 或 pull --ff-only，写 .refreshed 标记)/listSkills(agent-skills.yaml/json 清单或扫 SKILL.md)/resolveSkillSource(assertInside 防穿越+校验 SKILL.md)。src/core/config.ts 增 skillStoreRepositorySchema+builtinSkillStoreRepositories(superpowers/anthropic-skills)+skill_store 配置块(缺省注入内置)。src/core/paths.ts 增 skillStoreDir。src/application/factory-application.ts 增 scope 参数与 6 个 store 方法(installSkillFromStore 复用 SkillService.install)。src/web/server.ts 增 scope 参数(路径/上传/删除)+5 条 store 路由。src/cli-program.ts skill list 增 scope 列、install/remove 增 --scope、新增 skill-store 命令组(6 子命令)。web/src/api.ts 增 SkillScope/SkillMetadata.scope/Store 系列类型与 6 个 store 方法。web/src/pages/SkillStorePage.tsx(新增) 顶级商店页：仓库增删/刷新/浏览技能/安装(选员工+作用域)，?agent= 预选。web/src/pages/AgentDetailPage.tsx SkillsTab 按项目级/用户级分组+徽标+计数+「从商店安装」入口。web/src/App.tsx 增「Skill 商店」导航与 /skill-store 路由。web/src/styles.css 增 scope-picker/scope-group/status-badge project|user/store-*/modal 设计系统类。新增 tests/skill-store.test.ts(+7)、skills +5、web-server +1、web-ui +1、cli-structure +2；共 169 单测 + e2e 全过。docs/DECISIONS.md D-003 演进为作用域分离 + D-008 商店 ADR。未 push。
````

## TASK-017 详情

```text
Task ID: TASK-017
Title: OP1 Stage A 认知记忆层运行时强制（authority_order 不变量 + 派生 stance 注入 + enforced 三态）
Owner agent: claude-20260803-01
Status: DONE
Branch/worktree: master (TASK-017 commit)
Allowed scope: OP1 Stage A（agent-schema.ts memory.enforced optional、authority.ts validateMemoryConfig+renderAuthorityStance、templates.ts 派生 stance 注入 CLAUDE.md/AGENTS.md、create-agent.ts enforced:true、factory-application.ts prepareRuntime(registry,agent)+assertMemoryEnforced+7 调用点、doctor.ts memory-enforcement 4 态检查）与相关测试及 .agent 簿记 + docs/DECISIONS.md D-011 ADR
Forbidden scope: OP1 Stage B/C/D/E（knowledge 索引/transcript/ExperienceExtractor/archival 后端）、resolveConflict 热路径接线、CLAUDE.md 内容漂移检测、schema_version bump、改隔离层/CC Switch/备份回收、OP3-A 长期/OP2-F/OP5/OP4-C、推送
Dependencies: TASK-010（D-009 OP0 演进裁定就绪）、TASK-012（版本化只读读者）、TASK-016（config_hash 仅哈希 runtime 块，memory.enforced 零交互）、用户确认的 OP1 Stage A 范围（.scratch/plan.md）
Expected output: authority_order 从「声明不强制」升级为「运行时强制 + 派生 stance 注入」；enforced:true 时 prepareRuntime 硬失败误配；CLAUDE.md/AGENTS.md stance 从 authority_order 派生；doctor memory-enforcement 4 态；全部带回归测试且 verify/e2e 通过
Acceptance criteria: memory.enforced optional 向后兼容；validateMemoryConfig 空/缺 agent/agent 非首/重复 各报 issue，标准 6 层 ok；renderAuthorityStance 含全部声明层 agent 居首含约束句；新建 agent.yaml.enforced=true 且 CLAUDE.md/AGENTS.md 含派生 stance；prepareRuntime enforced:true+无效抛 VALIDATION_ERROR，false/undefined 不抛；doctor 4 态；4 预设行为不变；config_hash 不受影响；build/test/lint/e2e 实跑通过；任务完成即 commit（不 push）。
Started at: 2026-08-04 17:09 +0800
Updated at: 2026-08-04 17:25 +0800
Completed at: 2026-08-04 17:25 +0800
Outcome: OP1 Stage A 全部实现并测试通过：src/schemas/agent-schema.ts 增 AUTHORITY_LAYERS 常量+AuthorityLayer 类型，authority_order 改 z.array(z.enum(AUTHORITY_LAYERS)) 编译期穷尽，memory 块增 optional enforced（向后兼容，零 schema_version bump）；src/core/authority.ts 新增 validateMemoryConfig（空/缺 agent/agent 非首/重复 各报 issue，标准 6 层 ok）+renderAuthorityStance（从 authority_order 派生含全部声明层 agent 居首+约束句，纯函数零 I/O）；src/core/templates.ts renderRuntimeFiles 注入派生 stance 至 CLAUDE.md/AGENTS.md（caller 传 config）；src/core/create-agent.ts 新建 agent memory.enforced=true；src/application/factory-application.ts prepareRuntime(registry,agent)+assertMemoryEnforced（enforced:true+无效抛 VALIDATION_ERROR 阻断 spawn，false/undefined 跳过）+7 调用点更新（零额外 I/O，复用 getAgent 已加载 config）；src/core/doctor.ts memory-enforcement 4 态检查（undefined=warn 旧配置/false=warn 显式关闭/true+有效=pass/true+无效=fail）。documentFile 偏离裁定：现有 identity-doc 路径不变量校验（assertInside+realpath+symlink）即 agent 层写约束，叠加 memory 校验会阻止误配 agent 修复自身身份文档，故不叠加（D-011 记录）。新增 tests/authority.test.ts(+8)、memory-enforcement.test.ts(+2)、schemas +1、create-agent +1、doctor +1；共 156 单测 + e2e 全过。docs/DECISIONS.md D-011 ADR。未 push。
```

## TASK-016 详情

```text
Task ID: TASK-016
Title: OP3-A 单一可写源（中期）+ config_hash 漂移检测 + agentctl repair
Owner agent: claude-20260803-01
Status: DONE
Branch/worktree: master (TASK-016 commit)
Allowed scope: OP3-A 中期（registry-schema.ts 增 config_hash optional、agents.ts computeConfigHash+loadPortableConfig 不动 I-5、registry.ts updateAgent 拒 model 直改+register/add 存 hash、create 流程写 agent.yaml 后算 hash 入 registry、restore 流程同理、factory-application.ts repairAgent 方法、cli-program.ts agentctl repair 命令、doctor.ts config-drift 检查）与相关测试及 .agent 簿记 + docs/DECISIONS.md ADR
Forbidden scope: 从 registry-schema 移除 runtime 块（长期破坏性）、启用 I-5 model 收紧校验、agentctl migrate 命令（OP3-B 范畴）、改 adapter model 读取、哈希整文件 agent.yaml、OP1/OP2-F/OP5/OP4-C、推送
Dependencies: TASK-010（registry.lock 就绪）、TASK-012（版本化只读读者就绪）、用户确认的 OP3-A 范围（.scratch/plan.md）
Expected output: agent.yaml 为 runtime 块唯一可写真相；Registry runtime 块降级派生缓存 + config_hash（runtime 块 sha256）；updateAgent 拒 model 直改（零破坏，无调用方依赖）；agentctl repair 以 agent.yaml 重建缓存；doctor config-drift warn；全部带回归测试且 verify/e2e 通过
Acceptance criteria: registrySchema 含 optional config_hash 且向后兼容；updateAgent 改 model 抛 CONFLICT 其余字段正常；computeConfigHash 确定性；create/restore 后 Registry.config_hash === agent.yaml runtime 块 hash；repair 重建 runtime 块+刷新 hash 且 provider/locked 违例 CONFLICT；doctor config-drift 不等/缺失 warn 且 repair 后 pass；build/test/lint/e2e 实跑通过；任务完成即 commit（不 push）。
Started at: 2026-08-04 16:25 +0800
Updated at: 2026-08-04 16:38 +0800
Completed at: 2026-08-04 16:38 +0800
Outcome: OP3-A 中期全部实现并测试通过：src/schemas/registry-schema.ts 增 optional config_hash（向后兼容，缺失待 repair 补齐）；src/core/agents.ts computeConfigHash（sha256 over {provider,locked,model?} runtime 块，非整文件，避免 archive lifecycle 块等合法改写误报漂移），loadPortableConfig 不动 I-5；src/core/registry.ts updateAgent 增 model 直改 CONFLICT 守卫（grep 确认 4 调用方均只动 status/archived/bridge.authorization/updated_at，零破坏）+ 新增 resyncRuntime 受信重建路径（registry.lock 下刷新 runtime 块+config_hash，允许 model 从 agent.yaml 派生但 provider/locked 不变量仍 CONFLICT 强制）；src/core/create-agent.ts buildRegistryAgent 存 config_hash；src/core/backup.ts restore 经 registry.add 存 config_hash；src/application/factory-application.ts repairAgent（复用 getAgent 已 loadPortableConfig 校验，算 hash+比对 model/hash+resyncRuntime）；src/cli-program.ts `agentctl repair` 命令；src/core/doctor.ts 复用 loadPortableConfig+增 config-drift 检查（缺/不等 warn+remediation 指向 repair，等则 pass）。新增 tests/repair.test.ts(+3)、registry +4、agents +2、backup-restore +1、doctor +1、cli-structure +1；共 143 单测 + e2e 全过。docs/DECISIONS.md D-010 ADR 记录单一可写源+hash runtime 块而非整文件的裁定。未 push。
```

## TASK-015 详情

```text
Task ID: TASK-015
Title: OP4-B trace 关联 + ObservabilitySink 抽象
Owner agent: claude-20260803-01
Status: DONE
Branch/worktree: master (TASK-015 commit)
Allowed scope: OP4-B(observability.ts ObservabilitySink+Noop+default 填补 O-6、process-runner.ts LoggedRunOptions/Result 增 trace/operation/span 字段+metadata.json 富化、operation-store.ts OperationSummary/RecordInput 增 trace_id、operation-manager.ts dto traceId+task context+sink span+persist trace_id、server.ts run/job 透传、cli-program.ts run/job 记录 operations.jsonl) 与相关测试及 .agent 簿记
Forbidden scope: Stage C OTel GenAI span(gated on CLI 结构化输出)、TRACE_ID env 注入子进程+CLI 回显、chat/runJobService/runBridgeService trace 记录、backup/restore/doctor CLI jsonl 记录、OTel 导出器/OTLP、OP1/OP3-A/OP5、推送
Dependencies: TASK-013（OperationStore 持久化就绪）、用户确认的 OP4-B 范围（.scratch/plan.md）
Expected output: metadata.json 增 operation_id/trace_id/span_id；operations.jsonl 摘要增 trace_id；agentctl run/job 记录到 operations.jsonl；ObservabilitySink 抽象 no-op；web/CLI trace 关联闭合；全部带回归测试且 verify/e2e 通过
Acceptance criteria: metadata.json 传 traceId/operationId 时含三字段，未传省略向后兼容；LoggedRunResult 含 startedAt/finishedAt；OperationStore record/query 带 trace_id；OperationManager dto 含 traceId、task context 收到 operationId/traceId、persist 写 trace_id、sink spanStart/span.end 可注入断言默认 noop；CLI run/job 记录 operations.jsonl 含 trace_id 且与 metadata.json 一致；build/test/lint/e2e 实跑通过；任务完成即 commit（不 push）。
Started at: 2026-08-04 14:30 +0800
Updated at: 2026-08-04 15:45 +0800
Completed at: 2026-08-04 15:45 +0800
Outcome: OP4-B 全部实现并测试通过：src/core/observability.ts ObservabilitySink/Span/NoopObservabilitySink/defaultObservabilitySink 抽象（no-op 填补 O-6）；process-runner.ts LoggedRunOptions 增 operationId/traceId、LoggedRunResult 增 startedAt/finishedAt，metadata.json 传参时富化 operation_id/trace_id/span_id（未传省略向后兼容，trace 字段经 LoggedRunOptions 而非 ExecutionContext 避免触动所有 adapter）；operation-store.ts OperationSummary/OperationRecordInput 增 trace_id，record/query 透传；operation-manager.ts 构造注入 sink(默认 noop)，start 生成 traceId 入 dto，execute 以 sink.spanStart('operation',attrs)+finally span.end() 包裹、task context 携带 operationId/traceId，persist 写 trace_id；server.ts run/job handler 透传 operationId/traceId 至 application.runJob/runAgent；cli-program.ts run/job 命令生成 operationId/traceId、经 recordOperation 包装写入 operations.jsonl（CLI 路径闭环，无 web 双写）。新增 tests/observability.test.ts(+2)、process-runner.test.ts(+3)、operation-store +1、operation-manager +2(含 RecordingSink 注入断言)；共 132 单测 + e2e 全过。未 push。
```

## TASK-014 详情

```text
Task ID: TASK-014
Title: OP4-D prune 分类开关 + 保留上限 + doctor 磁盘检查
Owner agent: claude-20260803-01
Status: DONE
Branch/worktree: master (TASK-014 commit)
Allowed scope: OP4-D(src/core/prune.ts PruneService 分类 logs/registry-backups/archives/operations + 保留上限 keep-days/keep-count + assertInsideReal 安全 + operations.jsonl 原子轮转、factory-application.ts prune 薄编排、cli-program.ts agentctl prune 命令、doctor.ts disk-usage 检查) 与相关测试及 .agent 簿记
Forbidden scope: skill/job per-workspace 归档清理、config 保留字段、preAction 自动 prune、Stage B trace_id/ObservabilitySink、Stage C OTel GenAI、OP1/OP3-A/OP5、推送
Dependencies: TASK-013（OperationStore 持久化就绪，满足「先持久化再 prune」硬依赖）、用户确认的 OP4-D 范围（.scratch/plan.md）
Expected output: agentctl prune --logs/--registry-backups/--archives/--operations 分类 + dry-run + 保留上限 + assertInsideReal 安全；operations.jsonl 原子轮转保 0o600；doctor disk-usage warn；全部带回归测试且 verify/e2e 通过
Acceptance criteria: 4 scope 分类删除正确 + 保留上限（logs/archives/operations keep-days 默认 30/90/30、registry-backups keep-count 默认 20）；dry-run 零改动；越界路径 assertInsideReal 抛错；operations.jsonl 轮转后 0o600 且可 query；无 scope flag 报错；doctor disk-usage 超阈值 warn；build/test/lint/e2e 实跑通过；任务完成即 commit（不 push）。
Started at: 2026-08-04 13:40 +0800
Updated at: 2026-08-04 14:14 +0800
Completed at: 2026-08-04 14:14 +0800
Outcome: OP4-D 全部实现并测试通过：src/core/prune.ts PruneService 4 scope 分类（logs 按 slug 目录 mtime 判龄、registry-backups 按 mtime 倒序保留 keepCount、archives 按 mtime 判龄 .tar.gz/.aief.enc/.enc、operations 按 started_at 轮转原子重写保 0o600）+ keep-days/keep-count 保留上限 + safeRemove 包 assertInsideReal 二次校验（symlink 逃逸项 isDirectory()=false 在枚举阶段跳过，越界项被跳过不中止）+ 无 scope 报 VALIDATION_ERROR；factory-application.ts prune 薄编排；cli-program.ts `agentctl prune` 单命令（scope flags + --dry-run/--yes/--keep-days/--keep-count，非 dry-run 先预览 YAML 再 confirmDanger 再实跑）；doctor.ts disk-usage 检查（warn：backupsDir 字节>500MB 或 run 日志目录>500，remediation 指向 prune --dry-run）+ backupsDirSize/countRunLogs 私有助手。新增 tests/prune.test.ts(+8)、doctor +1、cli-structure +1；共 124 单测 + e2e 全过。未 push。
```

## TASK-013 详情

```text
Task ID: TASK-013
Title: OP4-A 可观测性（OperationStore + operations query + R12/R10）
Owner agent: claude-20260803-01
Status: DONE
Branch/worktree: master (TASK-013 commit)
Allowed scope: OP4-A(secrets.ts 抽 SECRET_PATTERN+redactSecrets、operation-store.ts OperationStore record/query、operation-manager.ts 注入 store+终态 record、server.ts 构造注入、config.ts R12 chmod 补全、launchd-service.ts R10 日志预创建 0o600、factory-application.ts queryOperations、cli-program.ts operations query 命令) 与相关测试及 .agent 簿记
Forbidden scope: Stage B ObservabilitySink/metadata.json trace_id、Stage C OTel、Stage D prune 分类、CLI 命令自身记录、jsonl 轮转/保留期、OP1/OP3-A/OP5、推送
Dependencies: TASK-012、用户确认的 OP4-A 范围（.scratch/plan.md）
Expected output: operations.jsonl append-only 0o600 持久化 + secret 脱敏 + agentctl operations query 审计 + R12 chmod 补全 + R10 launchd 日志 0o600，全部带回归测试且 verify/e2e 通过
Acceptance criteria: OperationStore record 写 0o600 jsonl 且 query 按 agentId/kind/since/limit 过滤；error_summary 经 redactSecrets 脱敏；OperationManager 终态 best-effort record（无 store 不回归）；config chmod 补 logsDir/servicesDir/schedulesDir/backupsDir/workspaceRoot 0o700；launchd install 预创建日志 0o600 不截断；agentctl operations query 可用；build/test/lint/e2e 实跑通过；任务完成即 commit（不 push）。
Started at: 2026-08-04 13:00 +0800
Updated at: 2026-08-04 13:20 +0800
Completed at: 2026-08-04 13:20 +0800
Outcome: OP4-A 全部实现并测试通过：src/core/secrets.ts 抽出共享 SECRET_PATTERN+redactSecrets（backup.ts R27 复用，消除重复正则）、src/core/operation-store.ts OperationStore append-only jsonl 0o600+query(agentId/kind/since/until/limit)+error_summary 经 redactSecrets 脱敏、OperationManager 构造注入 store+终态 best-effort record（succeeded/failed/cancelled 各一次，无 store 不回归）、server.ts 构造注入、config.ts R12 chmod 补 logsDir/servicesDir/schedulesDir/backupsDir/workspaceRoot 0o700、launchd-service.ts R10 预创建 stdout/stderr 日志 0o600 不截断、factory-application.ts queryOperations、cli-program.ts `agentctl operations query`。新增 tests/operation-store.test.ts(+4)、operation-manager +2、config +1；共 115 单测 + e2e 全过。未 push。
```

## TASK-012 详情

```text
Task ID: TASK-012
Title: OP3-B 前向兼容基础 + OP3-C adapter 治理（B1 最小）
Owner agent: claude-20260803-01
Status: DONE
Branch/worktree: master (TASK-012 commit)
Allowed scope: OP3-B(agent-schema 导出版本常量、agents.ts loadPortableConfig 版本分派 v1=identity、backup-schema 加 factory_version、trash-schema components min(6)、version.ts) + OP3-C(runtime-adapter 增 buildEnv、claude/codex adapter 实现、runtime.ts getRuntimeAdapter 工厂对象+DEPENDENCY_MISSING、buildRuntimeEnvironment 委托) 与相关测试及 .agent 簿记
Forbidden scope: AIEF2 备份格式变更、agentctl migrate 命令、RuntimeAdapter 扩 7 方法、CC Switch 同步入 adapter、runtimeProviderSchema 放开为 string、OP1/OP4/OP5、推送
Dependencies: TASK-011、用户确认的 OP3-B+C 范围（.scratch/plan.md）
Expected output: 版本化只读 reader（v1=identity，零行为变更）+ backup factory_version + trash min(6) 前向兼容；adapter Map+穷尽+buildEnv 委托，未知 provider 抛 DEPENDENCY_MISSING 不回退；全部带回归测试且 verify/e2e 通过
Acceptance criteria: loadPortableConfig 显式版本分派且未知版本拒绝；backup manifest 含 factory_version 且旧 manifest 可恢复；trash 7 组件通过 min(6)；getRuntimeAdapter 未知 provider 抛错不回退 Codex；buildRuntimeEnvironment 委托 adapter.buildEnv；build/test/lint/e2e 实跑通过；任务完成即 commit（不 push）。
Started at: 2026-08-04 12:50 +0800
Updated at: 2026-08-04 12:46 +0800
Completed at: 2026-08-04 12:46 +0800
Outcome: OP3-B（version.ts + CURRENT_AGENT_CONFIG_SCHEMA_VERSION + readAgentConfig 版本分派 v1=identity + backup factory_version 加性字段 + trash min(6)）与 OP3-C（RuntimeAdapter.buildEnv + adapter 实现 + buildRuntimeEnvironment 委托 + getRuntimeAdapter Record 工厂穷尽 + DEPENDENCY_MISSING 不回退）全部实现；verify=build+108 tests+lint clean；e2e 通过。新增 tests/agents.test.ts(+2)、runtime +2、backup-restore +2、trash +1。未 push。
```

## TASK-011 详情

```text
Task ID: TASK-011
Title: 备份密钥治理 OP2-E + R5 env 清洗
Owner agent: claude-20260803-01
Status: DONE
Branch/worktree: master (TASK-011 commit)
Allowed scope: OP2-E(R7/R27/R8/R20/R21) on backup.ts/trash.ts/doctor.ts/cli-program.ts、R5(config zod schema + sync.sanitize_non_whitelist) on config.ts/runtime.ts/factory-application.ts、相关测试与 .agent 簿记
Forbidden scope: R3 HOME 隔离、R13/B5、OP2-F、OP3/4/5、推送、读取或输出真实 API Key/凭据值、修改用户 CC Switch Provider 或真实 launchd/飞书状态
Dependencies: TASK-010、用户确认的 B+R5 范围与 4 项设计决策（.scratch/plan.md）
Expected output: 备份黑名单扩展+内容扫描拒绝密钥、解密产物 0o600、回收站失败态 doctor 告警+手动 --force、checksum 集合一致性、config zod schema+sanitize 选项，全部带回归测试且 verify/e2e 通过
Acceptance criteria: R7 shouldCopy 扩展(settings.json/id_rsa 等排除，id_*.pub 保留)；R27 rejectSecretsInStage 扫描 workspace+runtime(含未跟踪)命中即拒；R8 decrypt 写 0o600；R20 doctor 告警 failed/moving + trash purge --force；R21 verifyChecksums 拒未声明文件；R5 config schema + sanitize_non_whitelist(default false)；build/test/lint/e2e 实跑通过；任务完成即 commit（不 push）。
Started at: 2026-08-04 11:30 +0800
Updated at: 2026-08-04 12:35 +0800
Completed at: 2026-08-04 12:35 +0800
Outcome: R7/R27/R8/R20/R21 + R5 全部实现并测试通过；verify=build+101 tests+lint clean；e2e 通过。新增 tests/config.test.ts（4）、backup-restore +3、trash +3、doctor +1、runtime +1。未 push。
```

## TASK-010 详情

```text
Task ID: TASK-010
Title: 实施记忆系统优化 OP0 + Phase 1 (OP2)
Owner agent: claude-20260803-01
Status: DONE
Branch/worktree: master (34a98b8)
Allowed scope: OP0(ADR D-009)、OP2-A(R2/R4/R24)、OP2-B(assertInsideReal+敏感入口)、OP2-C(Registry锁/secureProfile锁/FileLock损坏拒绝)、OP2-D(R14/R19)、相关测试与文档
Forbidden scope: R3 HOME 隔离、R13/B5、R5、OP2-E/F、OP3/4/5、推送、读取或输出真实 API Key/凭据值、修改用户 CC Switch Provider 或真实 launchd/飞书状态
Dependencies: TASK-009、用户批准的研究优化方案（.scratch/research/01-memory-system/05-synthesis/optimization-proposals.md §OP2）
Expected output: 凭据隔离裂缝闭合、边界 realpath 补全、Registry/Bridge 加锁、授权态统一，全部带回归测试且 verify/e2e 通过
Acceptance criteria: R2 script Job 注入 runtime env；R4 CC Switch 源不得指向员工 Runtime Home；R24 流量路由字段保留同步+审计告警；assertInsideReal 落地于 ccSwitch/job-runner/installSkill/restoreBackupPath/scheduler；Registry update 与 secureProfile 加锁且并发不丢更新；FileLock 损坏文件拒绝；bridgeStatus exit0 调 secureProfile；restore 重置 authorization:pending；build/test/lint/e2e 实跑通过；不 commit。
Started at: 2026-08-03 20:10 +0800
Updated at: 2026-08-04 11:11 +0800
```

## TASK-009 详情

```text
Task ID: TASK-009
Title: 实现员工回收站与 7 天延迟清理
Owner agent: codex-20260803-01
Status: DONE
Branch/worktree: master (34a98b8)
Allowed scope: Agent 回收站应用服务、Registry、服务卸载、CLI/Web 接口、UI、测试和文档
Forbidden scope: 删除当前真实 Agent、清理用户系统废纸篓、修改个人 Runtime/Bridge、推送
Dependencies: TASK-008、用户确认的 Factory 自管回收站设计
Expected output: 一键把员工全部数据移入可恢复回收站，并在下次运行时清理超过 7 天的条目
Acceptance criteria: Bridge/Job 均卸载；所有受管路径移出活动区；Registry 移除；恢复不覆盖；失败回滚；Web/CLI 一致；测试覆盖。
Started at: 2026-08-03 18:56 +0800
Updated at: 2026-08-03 19:20 +0800
```

## TASK-007 详情

```text
Task ID: TASK-007
Title: 独立核实已提交基线
Owner agent: claude-20260803-01
Status: DONE
Branch/worktree: master (commit 34a98b8)
Allowed scope: 只读验证（build/test/lint/e2e），不修改源码
Forbidden scope: 修改源码、推送
Dependencies: TASK-001~006
Expected output: 独立核实首次提交基线的四项检查是否属实
Acceptance criteria: build/test/lint/e2e 实际运行并记录真实结果
Started at: 2026-08-03 18:20 +0800
Updated at: 2026-08-03 18:24 +0800
```

## TASK-008 详情

```text
Task ID: TASK-008
Title: 默认接入 CC Switch 并核查飞书 Bridge
Owner agent: codex-20260803-01
Status: DONE
Branch/worktree: master (34a98b8)
Allowed scope: Claude Runtime 接入、Bridge 兼容性、Web/CLI 引导、相关测试和研究文档
Forbidden scope: 读取或输出真实 API Key、修改用户 CC Switch Provider、真实飞书应用或 launchd 状态
Dependencies: TASK-007、用户新要求、CC Switch 与 lark-coding-agent-bridge 官方资料
Expected output: Claude 默认安全使用 CC Switch 当前 Provider，明确并修正飞书 Bridge 兼容边界
Acceptance criteria: 保留员工会话/记忆隔离；不再要求 Claude 官方登录；Provider Secret 不进入 Registry/日志/plist/Git；Bridge 命令和飞书配置与官方实现一致；测试和文档同步。
Started at: 2026-08-03 18:29 +0800
Updated at: 2026-08-03 18:47 +0800
```

## TASK-001 详情

```text
Task ID: TASK-001
Title: 实现 AI Employee Factory v1
Owner agent: codex-20260803-01
Status: DONE
Branch/worktree: current workspace (new repository; no baseline branch available)
Allowed scope: 全仓库
Forbidden scope: 用户个人 ~/.claude、~/.codex、现有 Bridge 与真实 launchd 服务
Dependencies: Node.js 20+、Git、Claude/Codex CLI、lark-channel-bridge、launchctl
Expected output: 可构建、可测试、可在临时 HOME 验收的 agentctl
Acceptance criteria: 用户批准计划中的 CLI、隔离、模板、Bridge、launchd、Job、Skill、备份恢复、Doctor 与文档均实现；build/test/lint/smoke 实际运行。
Started at: 2026-08-03 14:25 +0800
Updated at: 2026-08-03 15:10 +0800
```

## TASK-002 详情

```text
Task ID: TASK-002
Title: 实现本地 Web 管理控制台
Owner agent: codex-20260803-01
Status: DONE
Branch/worktree: current workspace (new repository; no HEAD, worktree unavailable)
Allowed scope: 全仓库，包括应用层、Web server、React UI、测试、构建和文档
Forbidden scope: 用户个人 ~/.claude、~/.codex、现有 Bridge、真实 launchd 服务、真实登录或授权
Dependencies: TASK-001、Node.js >=20.19、React、Vite、Fastify
Expected output: 可通过 agentctl web 启动的本机可视化管理控制台
Acceptance criteria: 用户批准计划中的本地认证、共享应用层、Dashboard、创建、生命周期、文档、Job、Skill、日志、备份、Doctor、异步 operation 和测试全部实现。
Started at: 2026-08-03 15:42 +0800
Updated at: 2026-08-03 16:38 +0800
```

## TASK-004 详情

```text
Task ID: TASK-004
Title: 修复创建完成页命令复制
Owner agent: codex-20260803-01
Status: DONE
Branch/worktree: current workspace (no HEAD)
Allowed scope: Web UI 与相关测试
Forbidden scope: Runtime 登录、飞书授权及其他真实外部操作
Dependencies: TASK-003、用户 UI 反馈
Expected output: 创建完成页和员工详情页具备可访问、兼容并带状态反馈的命令复制按钮
Acceptance criteria: Clipboard API 可用时直接复制；不可用或失败时自动回退；浏览器中复制精确命令并显示成功状态。
Started at: 2026-08-03 17:58 +0800
Updated at: 2026-08-03 18:03 +0800
```

## TASK-005 详情

```text
Task ID: TASK-005
Title: 补充终端命令用途说明
Owner agent: codex-20260803-01
Status: DONE
Branch/worktree: current workspace (no HEAD)
Allowed scope: Web UI 与相关测试
Forbidden scope: Runtime 登录、飞书授权及其他真实外部操作
Dependencies: TASK-004、用户 UI 反馈
Expected output: 终端操作引导逐条解释登录、飞书授权和交互聊天命令
Acceptance criteria: 每条命令具有中文操作名称、执行时机和用途说明，原有复制能力不变。
Started at: 2026-08-03 18:08 +0800
Updated at: 2026-08-03 18:10 +0800
```

## TASK-006 详情

```text
Task ID: TASK-006
Title: 修复生命周期反馈与 Skills 崩溃
Owner agent: codex-20260803-01
Status: DONE
Branch/worktree: current workspace (no HEAD)
Allowed scope: Web 生命周期 UI、Skill 元数据兼容、相关测试与簿记
Forbidden scope: 用户真实服务状态、个人凭据及非相关页面
Dependencies: TASK-005、用户 UI 反馈
Expected output: 生命周期操作有明确进度/结果反馈，预设及旧版 Skill 可稳定展示
Acceptance criteria: 启停重启期间禁用重复操作并显示结果；缺少 digest 的旧 Skill 返回可展示摘要；已有复制和隔离行为不回归。
Started at: 2026-08-03 18:15 +0800
Updated at: 2026-08-03 18:19 +0800
```

## TASK-028 详情

```text
Task ID: TASK-028
Title: CURRENT_STATE.md 自动更新（D-025）——系统侧生命周期事件自动更新 + 员工自维护引导/放行 + 单文件自动 git 提交
Owner agent: claude-20260803-01
Status: IN_PROGRESS
Branch/worktree: main
Allowed scope: src/core/current-state.ts（新）、src/core/git.ts（gitCommitFile）、src/core/templates.ts（种子标记块 + settings 放行）、templates/*-agent/ENTRY.md.tmpl（当前状态维护引导段）、src/application/factory-application.ts（runtimeAuth/bridgeAuthorize/lifecycleAction/archiveAgent/restoreTrash/restoreBackup 事件点 + prepareRuntime 幂等补放行）、tests/current-state.test.ts（新）+ tests/git.test.ts + tests/create-agent.test.ts + tests/runtime.test.ts + tests/application-management.test.ts 增测、docs/DECISIONS.md（D-025）、docs/ARCHITECTURE.md、README.md、.agent 簿记
Forbidden scope: 任务/对话完成自动写状态（D-025 覆盖面仅关键状态）、Web 人工保存自动 git 提交（badge 语义保持）、覆盖人工修改的无标记块状态文件（永不覆盖他人成果）
Dependencies: 用户批准的三项决策（AskUserQuestion：仅关键状态 / 引导约定+放行 / 自动提交该文件）
Expected output: 登录/授权/启停/归档/恢复时自动更新 CURRENT_STATE.md 标记块并单文件 git 提交；新员工种子含标记块 + settings 放行 + 运行指南引导段；存量员工 prepareRuntime 幂等补放行
Acceptance criteria:
  - 5 个事件点自动更新标记块内相关行（其余行与块外内容保留），自动 git 提交仅该文件（非 add -A）
  - 无标记块且被人工改过 → 跳过 + 警告；等于旧种子 → 升级为标记块格式
  - 新员工 .claude/settings.json 含 Edit/Write(agent/CURRENT_STATE.md) 放行；CLAUDE.md/AGENTS.md 含当前状态维护段
  - 全量单测 334 过；/code-review 双轴通过；任务完成即 commit（不 push）
Started at: 2026-08-05 17:15 +0800
Updated at: 2026-08-05 17:15 +0800
```

## 任务详情模板

```text
Task ID:
Title:
Owner agent:
Status:
Branch/worktree:
Allowed scope:
Forbidden scope:
Dependencies:
Expected output:
Acceptance criteria:
Started at:
Updated at:
```

## TASK-027 详情

```text
Task ID: TASK-027
Title: Web 编排写面 + 单轮对话（放开 D-022/D-023 只读边界：Todo 创建/加项/派发 + Chief 发起 + 对话标签）
Owner agent: claude-20260803-01
Status: IN_PROGRESS
Branch/worktree: main
Allowed scope: src/application/factory-application.ts（startPlanWithChief/runChat）、src/web/server.ts（5 个写路由）、web/src/api.ts（5 个客户端方法）、web/src/pages/AgentDetailPage.tsx（TodoTab 写面 + Chief 发起表单 + ChatTab）、web/src/styles.css（todo-add-item/chat 类）、tests/web-server.test.ts（写端点）、tests/web-ui.test.tsx（UI 写面 + 对话）、docs/DECISIONS.md(D-024)、docs/ARCHITECTURE.md、docs/TESTING.md、.agent 簿记
Forbidden scope: S3 飞书入站创建 todo（无入站基础设施，单独立项 + 安全评审）、原始 diff 持久化/展示（D-022 保持）、对话会话落盘（D-006 transcript 边界）
Dependencies: 用户批准的 S1+S2 范围（AskUserQuestion「放开只读，Web 可编排」+「Web 单轮问答」）、TASK-025/026（Todo 视图 + Chief 流水线）、TASK-023（OperationDto 底座）
Expected output: Web 可创建 Todo 计划/添加任务项/派发执行、Chief 可发起目标（后台拆解 Operation）、新增「对话」标签单轮问答（流式输出）；全部写操作后台 Operation + 202 + 前端轮询
Acceptance criteria:
  - POST /api/v1/agents/:id/task-plans 建计划（planId 由 Web 生成 plan-<8hex>）；POST .../items 加任务项；POST .../actions/run 派发（202 + OperationDto）
  - POST /api/v1/agents/:id/actions/chief-run：拆解在后台 Operation，完成停在 draft 等确认
  - POST /api/v1/agents/:id/actions/chat：runLogged 单轮（claude -p/codex exec），完成时把最终回答作为 output 事件写入
  - TodoTab 新建计划表单 + draft 展开加任务项 + active 派发执行；ChiefPipelineTab 发起目标表单；新增对话标签（Enter 发送，busy 禁用）
  - 写端点与 UI 测试全绿（web-server 2 新测 + web-ui 3 新测）；/code-review（Standards+Spec 双轴）通过；全量单测通过（仅既有 date-sensitive experience.test.ts 失败除外）；任务完成即 commit（不 push）
Started at: 2026-08-05 16:04 +0800
Updated at: 2026-08-05 16:04 +0800
```
