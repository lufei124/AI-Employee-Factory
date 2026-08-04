# 任务看板

Coordinator: codex-20260803-01

> 新任务 ID 分配：读取本看板取最大编号 N，先 `mkdir .agent/task-ids/TASK-(N+1)` 原子占位（已存在则编号 +1 重试），占位成功后再写入本看板任务行。占位目录永不删除，作为已用编号记录。撞号时后到者不得覆盖先到者的看板行。

| Task ID  | 标题                                            | Owner agent        | Status | Branch/worktree                    | Allowed scope                                                                                     | Dependencies                          | 更新时间               |
| -------- | ----------------------------------------------- | ------------------ | ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------- |
| TASK-001 | 实现 AI Employee Factory v1                     | codex-20260803-01  | DONE   | current workspace (new repository) | 全仓库                                                                                            | 用户批准的 v1 实施计划                | 2026-08-03 15:10 +0800 |
| TASK-002 | 实现本地 Web 管理控制台                         | codex-20260803-01  | DONE   | current workspace (no HEAD)        | 全仓库                                                                                            | TASK-001、用户批准的 Web 实施计划     | 2026-08-03 16:38 +0800 |
| TASK-003 | 优化操作中心与 Agent ID 交互                    | codex-20260803-01  | DONE   | current workspace (no HEAD)        | Web UI 与相关测试                                                                                 | TASK-002、用户 UI 反馈                | 2026-08-03 17:54 +0800 |
| TASK-004 | 修复创建完成页命令复制                          | codex-20260803-01  | DONE   | current workspace (no HEAD)        | Web UI 与相关测试                                                                                 | TASK-003、用户 UI 反馈                | 2026-08-03 18:03 +0800 |
| TASK-005 | 补充终端命令用途说明                            | codex-20260803-01  | DONE   | current workspace (no HEAD)        | Web UI 与相关测试                                                                                 | TASK-004、用户 UI 反馈                | 2026-08-03 18:10 +0800 |
| TASK-006 | 修复生命周期反馈与 Skills 崩溃                  | codex-20260803-01  | DONE   | current workspace (no HEAD)        | 生命周期、Skills 与测试                                                                           | TASK-005、用户 UI 反馈                | 2026-08-03 18:19 +0800 |
| TASK-007 | 独立核实已提交基线                              | claude-20260803-01 | DONE   | master (34a98b8)                   | 只读验证                                                                                          | TASK-001~006                          | 2026-08-03 18:24 +0800 |
| TASK-008 | 默认接入 CC Switch 并核查飞书 Bridge            | codex-20260803-01  | DONE   | master (34a98b8)                   | Runtime、Bridge、Web、文档与测试                                                                  | TASK-007、用户新要求                  | 2026-08-03 18:47 +0800 |
| TASK-009 | 实现员工回收站与 7 天延迟清理                   | codex-20260803-01  | DONE   | master (34a98b8)                   | 应用层、存储、CLI、Web、测试                                                                      | TASK-008、用户确认的回收站设计        | 2026-08-03 19:20 +0800 |
| TASK-010 | 实施记忆系统优化 OP0+Phase1(OP2)                | claude-20260803-01 | DONE   | master (cb9723b)                   | 隔离与同步强化核心模块、锁、文档与测试                                                            | TASK-009、用户批准的研究优化方案      | 2026-08-04 11:11 +0800 |
| TASK-011 | 备份密钥治理 OP2-E + R5 env 清洗                | claude-20260803-01 | DONE   | master (7ef0f16)                   | backup/trash/runtime/config/doctor/CLI 与测试                                                     | TASK-010、用户批准的 B+R5 范围        | 2026-08-04 12:35 +0800 |
| TASK-012 | OP3-B 前向兼容基础 + OP3-C adapter 治理         | claude-20260803-01 | DONE   | master (c2a2b71)                   | schemas/agents/backup/runtime/adapters 与测试                                                     | TASK-011、用户批准的 OP3-B+C 范围     | 2026-08-04 12:46 +0800 |
| TASK-013 | OP4-A 可观测性 OperationStore + query + R12/R10 | claude-20260803-01 | DONE   | master (8b17712)                   | operation-store/operation-manager/server/config/launchd/CLI 与测试                                | TASK-012、用户批准的 OP4-A 范围       | 2026-08-04 13:20 +0800 |
| TASK-014 | OP4-D prune 分类 + 保留上限 + doctor 磁盘检查   | claude-20260803-01 | DONE   | master (76ab134)                   | prune/factory-application/cli-program/doctor 与测试                                               | TASK-013、用户批准的 OP4-D 范围       | 2026-08-04 14:14 +0800 |
| TASK-015 | OP4-B trace 关联 + ObservabilitySink 抽象       | claude-20260803-01 | DONE   | master (e690cd0)                   | observability/process-runner/operation-store/operation-manager/server/cli-program 与测试          | TASK-013、用户批准的 OP4-B 范围       | 2026-08-04 15:45 +0800 |
| TASK-016 | OP3-A 单一可写源（中期）+ config_hash + repair  | claude-20260803-01 | DONE   | master (4f15147)                   | registry-schema/agents/registry/create-agent/backup/factory-application/cli-program/doctor 与测试 | TASK-010、用户批准的 OP3-A 范围       | 2026-08-04 16:38 +0800 |
| TASK-017 | OP1 Stage A 认知记忆层运行时强制                | claude-20260803-01 | DONE   | master (TASK-017 commit)           | agent-schema/authority/templates/create-agent/factory-application/doctor 与测试 + DECISIONS ADR   | TASK-010、用户批准的 OP1 Stage A 范围 | 2026-08-04 17:25 +0800 |

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
