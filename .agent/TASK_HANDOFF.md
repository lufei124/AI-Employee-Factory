# 当前任务交接

## 身份

Task ID: TASK-009

Task title: 实现员工回收站与 7 天延迟清理

Outgoing/current agent: codex-20260803-01

Intended next role/agent: 用户或后续维护者

Branch/worktree: master（基线 commit 34a98b8）

Status: DONE

更新时间：2026-08-03 19:20 +0800

## 已完成

- 新增 Factory 自管回收站，同卷原子移走 Workspace、Runtime、Bridge、日志、服务和定时任务数据。
- 移入前卸载 Bridge 和全部 Job 服务，然后从 Registry 移除 Agent，原 ID 可重新创建。
- Web 员工详情提供一次确认的“移入回收站”；备份/恢复页可查看和恢复。
- CLI 新增 `trash move|list|restore|purge`，支持 `--dry-run` 和 `--yes`。
- 保留期固定 7 天；下次启动 Web 或运行公开 CLI 命令时懒清理过期条目。
- 恢复后固定为 `stopped`，不自动重新安装或启动服务；ID 或目标路径已占用时拒绝覆盖。
- 同一本地提交中保留 TASK-008 的 CC Switch Provider 隔离同步和飞书 Bridge 兼容性修正。

## 验证

| 命令/检查          | 结果 | 相关输出                     |
| ------------------ | ---- | ---------------------------- |
| `npm run verify`   | 通过 | build + 22 文件/80 项 + lint |
| `npm run test:e2e` | 通过 | 1/1，4.2s                    |
| `git diff --check` | 通过 | 无空白或补丁格式错误         |

## 安全边界与限制

- 未对用户当前真实 Agent 执行移入回收站，未修改个人 Runtime/Bridge 或真实 launchd 服务。
- 回收站是 Factory 管理的可恢复存储，不是 macOS 系统废纸篓。
- 过期清理是下次 Web/CLI 调用触发，不启动常驻守护进程。
- 恢复只恢复数据并登记 stopped 状态，需由用户审核后再手动启动。

## 接管说明

1. 先读 `AGENTS.md`、`.agent/PROJECT_STATE.md` 和本文件。
2. 日常管理用 `agentctl web`；CLI 可用 `agentctl trash list` 查看回收站。
3. 不要手动删除 `.agentctl-trash` 组件目录；应走 restore/purge 以保持 manifest/index 一致。
4. 本任务只授权本地 commit，未授权 push。
