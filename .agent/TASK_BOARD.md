# 任务看板

Coordinator: codex-20260803-01

> 新任务 ID 分配：读取本看板取最大编号 N，先 `mkdir .agent/task-ids/TASK-(N+1)` 原子占位（已存在则编号 +1 重试），占位成功后再写入本看板任务行。占位目录永不删除，作为已用编号记录。撞号时后到者不得覆盖先到者的看板行。

| Task ID  | 标题                                    | Owner agent        | Status | Branch/worktree                    | Allowed scope                                 | Dependencies                      | 更新时间               |
| -------- | --------------------------------------- | ------------------ | ------ | ---------------------------------- | --------------------------------------------- | --------------------------------- | ---------------------- |
| TASK-001 | 实现 AI Employee Factory v1             | codex-20260803-01  | DONE   | current workspace (new repository) | 全仓库                                        | 用户批准的 v1 实施计划            | 2026-08-03 15:10 +0800 |
| TASK-002 | 实现本地 Web 管理控制台                 | codex-20260803-01  | DONE   | current workspace (no HEAD)        | 全仓库                                        | TASK-001、用户批准的 Web 实施计划 | 2026-08-03 16:38 +0800 |
| TASK-003 | 优化操作中心与 Agent ID 交互            | codex-20260803-01  | DONE   | current workspace (no HEAD)        | Web UI 与相关测试                             | TASK-002、用户 UI 反馈            | 2026-08-03 17:54 +0800 |
| TASK-004 | 修复创建完成页命令复制                  | codex-20260803-01  | DONE   | current workspace (no HEAD)        | Web UI 与相关测试                             | TASK-003、用户 UI 反馈            | 2026-08-03 18:03 +0800 |
| TASK-005 | 补充终端命令用途说明                    | codex-20260803-01  | DONE   | current workspace (no HEAD)        | Web UI 与相关测试                             | TASK-004、用户 UI 反馈            | 2026-08-03 18:10 +0800 |
| TASK-006 | 修复生命周期反馈与 Skills 崩溃          | codex-20260803-01  | DONE   | current workspace (no HEAD)        | 生命周期、Skills 与测试                       | TASK-005、用户 UI 反馈            | 2026-08-03 18:19 +0800 |
| TASK-007 | 独立核实已提交基线                      | claude-20260803-01 | DONE   | master (34a98b8)                   | 只读验证                                      | TASK-001~006                      | 2026-08-03 18:24 +0800 |
| TASK-008 | 默认接入 CC Switch 并核查飞书 Bridge    | codex-20260803-01  | DONE   | master (34a98b8)                   | Runtime、Bridge、Web、文档与测试              | TASK-007、用户新要求              | 2026-08-03 18:47 +0800 |
| TASK-009 | 实现员工回收站与 7 天延迟清理           | codex-20260803-01  | DONE   | master (34a98b8)                   | 应用层、存储、CLI、Web、测试                  | TASK-008、用户确认的回收站设计    | 2026-08-03 19:20 +0800 |
| TASK-010 | 实施记忆系统优化 OP0+Phase1(OP2)        | claude-20260803-01 | DONE   | master (cb9723b)                   | 隔离与同步强化核心模块、锁、文档与测试        | TASK-009、用户批准的研究优化方案  | 2026-08-04 11:11 +0800 |
| TASK-011 | 备份密钥治理 OP2-E + R5 env 清洗        | claude-20260803-01 | DONE   | master (7ef0f16)                   | backup/trash/runtime/config/doctor/CLI 与测试 | TASK-010、用户批准的 B+R5 范围    | 2026-08-04 12:35 +0800 |
| TASK-012 | OP3-B 前向兼容基础 + OP3-C adapter 治理 | claude-20260803-01 | DONE   | master (TASK-012 commit)           | schemas/agents/backup/runtime/adapters 与测试 | TASK-011、用户批准的 OP3-B+C 范围 | 2026-08-04 12:46 +0800 |

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
