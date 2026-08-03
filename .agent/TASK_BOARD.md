# 任务看板

Coordinator: codex-20260803-01

> 新任务 ID 分配：读取本看板取最大编号 N，先 `mkdir .agent/task-ids/TASK-(N+1)` 原子占位（已存在则编号 +1 重试），占位成功后再写入本看板任务行。占位目录永不删除，作为已用编号记录。撞号时后到者不得覆盖先到者的看板行。

| Task ID  | 标题                           | Owner agent       | Status | Branch/worktree                    | Allowed scope           | Dependencies                      | 更新时间               |
| -------- | ------------------------------ | ----------------- | ------ | ---------------------------------- | ----------------------- | --------------------------------- | ---------------------- |
| TASK-001 | 实现 AI Employee Factory v1    | codex-20260803-01 | DONE   | current workspace (new repository) | 全仓库                  | 用户批准的 v1 实施计划            | 2026-08-03 15:10 +0800 |
| TASK-002 | 实现本地 Web 管理控制台        | codex-20260803-01 | DONE   | current workspace (no HEAD)        | 全仓库                  | TASK-001、用户批准的 Web 实施计划 | 2026-08-03 16:38 +0800 |
| TASK-003 | 优化操作中心与 Agent ID 交互   | codex-20260803-01 | DONE   | current workspace (no HEAD)        | Web UI 与相关测试       | TASK-002、用户 UI 反馈            | 2026-08-03 17:54 +0800 |
| TASK-004 | 修复创建完成页命令复制         | codex-20260803-01 | DONE   | current workspace (no HEAD)        | Web UI 与相关测试       | TASK-003、用户 UI 反馈            | 2026-08-03 18:03 +0800 |
| TASK-005 | 补充终端命令用途说明           | codex-20260803-01 | DONE   | current workspace (no HEAD)        | Web UI 与相关测试       | TASK-004、用户 UI 反馈            | 2026-08-03 18:10 +0800 |
| TASK-006 | 修复生命周期反馈与 Skills 崩溃 | codex-20260803-01 | DONE   | current workspace (no HEAD)        | 生命周期、Skills 与测试 | TASK-005、用户 UI 反馈            | 2026-08-03 18:19 +0800 |

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
