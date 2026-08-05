# 当前任务交接

## 身份

Task ID: TASK-032

Task title: 描述生成员工 + 自进化拓宽（D-029）

Outgoing/current agent: claude-20260803-01

Intended next role/agent: 用户或后续维护者（TASK-032 已实施，待验证 commit；后续增强：任务完成自动写状态、飞书入站等其他立项）

Branch/worktree: main

Status: 描述→AI 生成蓝图 + 移除预设 + commitSelfEvolution 拓宽到 skills/workflows/knowledge，已提交 main（未 push）

更新时间：2026-08-05 22:00 +0800

## 已完成

- **Schema**（`src/schemas/job-schema.ts`）：`jobConfigSchema` 加 `managed_by: 'admin' | 'employee'`（缺省 admin，向后兼容）。

- **`src/core/scheduler.ts`**：`JobStore` 新增 `listTolerant()`——逐文件独立 parse，单个无效 job（schema 校验失败/路径逃逸）仅 console.warn 跳过，供 reconcile 容错列举。

- **新增 `src/core/job-reconcile.ts`**：`reconcileEmployeeJobs(registry, agent, paths)`（best-effort，绝不抛错阻断主流程）——
  - 过滤 `managed_by === 'employee'` 的 job；`enabled:true` 为 desired。
  - 清单 `schedules/<agent>/.employee-jobs.json`（记录上次已调度的 employee job id → schedule.time）用于变化检测。
  - 对 desired 中每个 job：`jobLaunchdService(...).enableScheduled()`；`schedule.time` 变更先反注册再重装（让 launchd 重载日历）。
  - 对「之前调度过但现在不在 desired」（删除或 `enabled:false`）：`uninstallEmployeeJob` 按确定性 label bootout + 删 plist（不依赖 job 配置是否存在）。
  - 写回清单（0600）；新增/变更的 employee job YAML 单文件 git 提交（`job: 更新 <id>`，只 `add -- <relPath>`）。

- **`src/application/factory-application.ts`**：`runAgent`/`runChat`/`runJob` 结束后（`commitSelfEvolution` 之后）追加 `reconcileEmployeeJobs`；`prepareRuntime` 幂等放行 `automation/jobs/**` 与 `automation/prompts/**`（`ensureAgentDocsAllowed`）。

- **引导与种子**：`templates/claude-agent/ENTRY.md.tmpl` + `templates/codex-agent/ENTRY.md.tmpl` 加「定时任务自我配置」节（managed_by + enabled:true + 最小示例 + 安全约束）；`src/core/templates.ts` 种子 `automation/jobs/README.md`（managed_by 协议 + 示例）。

- **Web**：`web/src/api.ts` `JobConfig` 加 `managed_by`；`AgentDetailPage.tsx`「任务」tab 每条 job 显示 `[员工]/[管理员]` 徽标（新建任务默认 `managed_by: admin`）；`styles.css` 加 `.job-source-badge`/`.job-source-employee`。

- **测试**：新增 `tests/job-reconcile.test.ts`（5 用例：安装+清单、改时间重装+停用反注册、删除反注册、admin 不触碰、单 job 校验失败跳过）；`tests/schemas.test.ts` 加 managed_by 缺省 admin / 显式 employee；`tests/self-evolution.test.ts` 加 automation/jobs+prompts 幂等放行。

- **文档**：`docs/DECISIONS.md` 新增 **D-028** ADR；`docs/ARCHITECTURE.md` 加「员工自我配置定时任务」段；`README.md` 加用法段；`docs/GLOSSARY.md` 加 Job / managed_by / 员工 Job 词条；`.agent/TASK_BOARD.md` / `.agent/FILE_LOCKS.md` 登记 TASK-031。

## 验证

| 命令/检查                                         | 结果   | 相关输出                       |
| ------------------------------------------------- | ------ | ------------------------------ |
| `npx tsc --noEmit`（tsconfig.json + web）         | 通过   | 全绿                           |
| `npm run lint`（eslint+prettier）                 | 通过   | 全绿                           |
| `npm test`                                        | 279 过 | 41 文件全绿（272 + 7 新）      |
| 孤儿引用 grep（managed_by/reconcileEmployeeJobs） | 无残留 | job-reconcile 被应用层接线消费 |

## 安全边界与限制

- **只对 `managed_by: employee` reconcile**：管理员 job（缺省 admin）不受自动 reconcile 影响。
- **best-effort**：单 job 校验失败（含 `assertInsideReal` 路径逃逸）仅 console.warn 跳过，绝不阻断员工主流程。
- **权限不扩大**：脚本/job 仍以员工 runtime 的 workspace 权限运行，路径限制 workspace 内；员工不可改 `.claude/settings.json` 扩大权限。
- **单文件 git 提交**：reconcile 只 `git add -- <relPath>`，绝不用 `add -A`。
- 未 push，按用户常驻规则等待明确要求。
