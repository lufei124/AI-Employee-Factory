# 文件锁

锁是建议性的协调记录。并行 Agent 仍应使用独立的 Git 分支或 worktree。

| Path or glob                                                                                                                                                                                                                                                                                                                | Task ID  | Owner agent        | Branch/worktree   | 原因                                     | 获取时间               | 最后更新               | State    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------ | ----------------- | ---------------------------------------- | ---------------------- | ---------------------- | -------- |
| `**/*`                                                                                                                                                                                                                                                                                                                      | TASK-001 | codex-20260803-01  | current workspace | v1 端到端实施，用户指定单 Agent 顺序开发 | 2026-08-03 14:25 +0800 | 2026-08-03 15:10 +0800 | RELEASED |
| `**/*`                                                                                                                                                                                                                                                                                                                      | TASK-002 | codex-20260803-01  | current workspace | Web 控制台端到端实施，单 Agent 顺序开发  | 2026-08-03 15:42 +0800 | 2026-08-03 16:38 +0800 | RELEASED |
| `web/src/**`, `tests/web-ui.test.tsx`, `e2e/web-console.spec.ts`                                                                                                                                                                                                                                                            | TASK-003 | codex-20260803-01  | current workspace | 修复操作中心遮挡与 Agent ID 自动生成     | 2026-08-03 17:33 +0800 | 2026-08-03 17:38 +0800 | RELEASED |
| `web/src/**`, `tests/web-ui.test.tsx`, `e2e/web-console.spec.ts`                                                                                                                                                                                                                                                            | TASK-003 | codex-20260803-01  | current workspace | 用户复验仍遮挡，改为真实停靠第三列       | 2026-08-03 17:39 +0800 | 2026-08-03 17:54 +0800 | RELEASED |
| `web/src/**`, `tests/web-ui.test.tsx`, `e2e/web-console.spec.ts`                                                                                                                                                                                                                                                            | TASK-004 | codex-20260803-01  | current workspace | 实现可用的命令复制与状态反馈             | 2026-08-03 17:58 +0800 | 2026-08-03 18:03 +0800 | RELEASED |
| `web/src/pages/AgentDetailPage.tsx`, `web/src/styles.css`, `tests/web-ui.test.tsx`                                                                                                                                                                                                                                          | TASK-005 | codex-20260803-01  | current workspace | 为三条终端命令增加清晰用途说明           | 2026-08-03 18:08 +0800 | 2026-08-03 18:10 +0800 | RELEASED |
| `web/src/pages/AgentDetailPage.tsx`, `web/src/styles.css`, `src/core/skills.ts`, `src/core/templates.ts`, `tests/web-ui.test.tsx`, `tests/skills.test.ts`, `tests/create-agent.test.ts`, `e2e/web-console.spec.ts`                                                                                                          | TASK-006 | codex-20260803-01  | current workspace | 修复生命周期无反馈与旧 Skill 摘要缺失    | 2026-08-03 18:15 +0800 | 2026-08-03 18:19 +0800 | RELEASED |
| `src/core/runtime.ts`, `src/runtimes/**`, `src/core/bridge.ts`, `src/services/**`, `src/application/**`, `src/cli-program.ts`, `web/src/**`, `tests/**`, `README.md`, `docs/**`                                                                                                                                             | TASK-008 | codex-20260803-01  | master            | 默认接入 CC Switch 并核查飞书 Bridge     | 2026-08-03 18:29 +0800 | 2026-08-03 18:47 +0800 | RELEASED |
| `src/application/**`, `src/core/**`, `src/services/**`, `src/web/**`, `src/cli-program.ts`, `web/src/**`, `tests/**`, `e2e/**`, `README.md`, `docs/**`                                                                                                                                                                      | TASK-009 | codex-20260803-01  | master            | 员工回收站、恢复与 7 天延迟清理          | 2026-08-03 18:56 +0800 | 2026-08-03 19:20 +0800 | RELEASED |
| `src/core/runtime.ts`, `src/core/paths.ts`, `src/core/registry.ts`, `src/core/bridge.ts`, `src/core/job-runner.ts`, `src/core/skills.ts`, `src/core/scheduler.ts`, `src/core/locks.ts`, `src/services/factory-services.ts`, `src/application/factory-application.ts`, `src/cli-program.ts`, `docs/DECISIONS.md`, `tests/**` | TASK-010 | claude-20260803-01 | master            | 隔离与同步强化 OP0+Phase1(OP2)           | 2026-08-03 20:10 +0800 | 2026-08-04 11:11 +0800 | RELEASED |

合法状态：`ACTIVE`、`RELEASED`、`STALE`、`TAKEOVER_PENDING`。

## 心跳与陈旧判定

ACTIVE 锁须随每次检查点刷新 `最后更新`；连续工作超过 60 分钟未写检查点也应刷新。

`最后更新` 距今超过 4 小时的锁可被任何 Agent提请检视，但标记 `STALE` 仍须满足以下三者之一：

- 原分支无进行中迹象（无提交、无检查点更新）；
- 原 Agent 在 `.agent/AGENTS_REGISTRY.md` 标记为不可达；
- 协调者或用户授权接管。

TTL 不自动释放锁--自动释放会破坏「永不擦除他人成果」原则。

## 接管历史模板

```text
Previous owner:
New owner:
Takeover reason:
State observed at takeover:
Uncommitted changes preserved:
Verification performed:
```
