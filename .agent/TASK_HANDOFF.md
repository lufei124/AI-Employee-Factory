# 当前任务交接

## 身份

Task ID: TASK-035

Task title: 飞书主入口员工自进化（D-035）——逐消息 shim + 周期 settle 扫描，完整沉淀闭环

Outgoing/current agent: claude-20260806-01

Intended next role/agent: 用户或后续维护者（TASK-035 已实施，待 commit；后续增强：真实飞书 bridge 端到端冒烟、settle 周期间隔按使用调优、Web 观察 settle 状态等可立项）

Branch/worktree: main

Status: 飞书逐消息 shim + 周期 settle 完整闭环已实现并全量测试通过，待 commit（未 push）

更新时间：2026-08-06 13:55 +0800

## 已完成

- **`src/application/factory-application.ts`**：
  - 抽取私有 `settleActive(id, agent, registry, transcriptFile?)` 复用沉淀链：`maybeExtractExperience` → `autoAdoptSelfSkills` → `maybeAutoCreateSkill` → `commitSelfEvolution` → `reconcileEmployeeJobs`。`runJob` 后处理 `.then` 改调它（行为不变，顺序保持）。
  - 新增公开 `settleEmployee(id)`（无 transcript，仅 adopt/提交/reconcile，供周期扫描与手动触发）。
  - 新增公开 `runBridgeMessage(id, args, stdin)`（逐消息）：`resolveRealClaude`（env `AIEMPLOYEES_REAL_CLAUDE` 优先）→ 构造 `ExecutionContext`（真实 claude + workspace cwd + `buildRuntimeEnvironment` + LARK env）→ `new ProcessRunner(logsDir).runLogged(id, ctx, { transcript: transcript_persist, stdin })` → `settleActive(id, agent, registry, result.transcriptFile)` → 返回 exitCode。
  - 新增 `listBridgeEnabledIds()`。
  - `prepareRuntime` 幂等 `installClaudeShim`；`lifecycleAction` start/restart 装周期 settle 任务、stop 卸载（best-effort）；`archiveAgent` 卸载。
  - 常量 `FEISHU_SETTLE_INTERVAL_SECONDS = 300`。

- **`src/core/claude-shim.ts`（新）**：`claudeShimDir(paths, agentId)` / `claudeShimDirForRuntime(runtimeHome)` / `withClaudeShim(env, runtimeHome)`（把 shim 目录前置到 PATH）/ `resolveRealClaude(source)`（`bash -lc 'command -v claude'`）/ `renderShim`（烘焙 AI_EMPLOYEES_HOME、AI_EMPLOYEES_WORKSPACE_ROOT、AIEMPLOYEES_REAL_CLAUDE，`exec <cliFile> _service bridge-run <id> -- "$@"`）/ `installClaudeShim`（幂等：内容不变则跳过重写，mode 0o700）。

- **`src/core/process-runner.ts`**：`LoggedRunOptions` 增 `stdin?: string`；`runLogged` 提供则写子进程 stdin 后关闭（缺省不连父 stdin，保持现状）。

- **`src/services/launchd-service.ts`**：`LaunchdPlistInput` 增 `startInterval?: number`；`renderLaunchdPlist` 渲染 `<key>StartInterval</key>`，与 `StartCalendarInterval` 互斥（设了则忽略 calendar，launchd 同时指定为配置错误）。

- **`src/services/factory-services.ts`**：`ServiceAdapterFactory` 增 `settle`；`LaunchdServiceAdapterFactory.settle` 生成 `com.aiemployees.<id>.settle`（`_service settle <id>` + StartInterval）；`bridge` env 经 `withClaudeShim` 前置 shim；模块级 `settleLaunchdService` 兼容。`systemd-service.ts` 增 settle 桩（DEPENDENCY_MISSING）。

- **`src/core/bridge.ts`**：`BridgeAdapter.context` 交互 env 经 `withClaudeShim` 前置 shim PATH。

- **`src/runtimes/runtime-adapter.ts`**：`RuntimeOperation` 增 `'bridge-run'`。

- **`src/cli-program.ts`**：`_service settle <id>` → `settleEmployee`；`_service bridge-run <id> <args...>`（`allowUnknownOption`/`allowExcessArguments`，读 stdin 调 `runBridgeMessage`；commander14 的 `-- <args...>` variadic 有坑，故用 `<args...>` 透传）→ help 说明；`bridge settle [<id>]`（`--install/--uninstall/--interval` 管理周期任务）。

- **测试**：`tests/bridge-settle.test.ts`（新，7 用例）：renderShim 内容、installClaudeShim 幂等、withClaudeShim 前置 PATH、renderLaunchdPlist StartInterval 互斥、settleLaunchdService 参数烘焙、runBridgeMessage 端到端（mock runLogged 写真实 transcript + 触发 settle 链 adopt 员工 skill + 返回 exitCode）、settleEmployee adopt+evolve 提交。`tests/process-runner.test.ts` 增 stdin 转发。`tests/lifecycle-reconcile.test.ts` mock 补 `settleLaunchdService`。

- **文档**：`docs/DECISIONS.md` 新增 **D-035** ADR；`.agent/TASK_BOARD.md` / `.agent/FILE_LOCKS.md` 登记并标记 TASK-035。

## 验证

- `npm test`：全量 332 通过（串行 `--no-file-parallelism` 全绿）。
- `npm run build`：通过。
- `npm run lint`：eslint + prettier 全绿。
- CLI 冒烟：`node dist/cli.js _service --help` 显示 settle/bridge-run；`agentctl bridge settle --help` 显示 --install/--uninstall/--interval；`_service bridge-run smoke-worker -- -p --query` 用假 claude（AIEMPLOYEES_REAL_CLAUDE）验证 stdin prompt 转发 + settle 链 adopt 员工 skill（`.claude/skills/smoke-skill` 投影软链生成）；`_service settle smoke-worker` 与 `agentctl bridge settle smoke-worker` exit 0。

## 待确认 / 后续

- 未 commit（用户批准的方案 + AGENTS.md 常驻规则「任务完成即 commit」，等待授权后提交 main，不 push）。
- shim 是「不改上游 bridge」的唯一 seam：真实飞书 `lark-coding-agent-bridge` 端到端冒烟（真实 claude + 真实飞书消息）需用户在有飞书凭据的环境验证。
- 周期 settle 间隔默认 300s（`FEISHU_SETTLE_INTERVAL_SECONDS`）为初值，可按使用反馈调优。
- Web 侧暂未暴露 settle 状态/手动触发（CLI 已覆盖），可后置立项。
