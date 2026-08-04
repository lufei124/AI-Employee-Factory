# 项目状态

最后更新：2026-08-04 15:45 +0800
更新者：claude-20260803-01
当前版本/分支：master（TASK-015 已完成待提交；工作区含 TASK-015 未提交改动）
当前阶段：TASK-015 OP4-B trace 关联已完成（verify/e2e 全过），待 commit；记忆系统优化框架 OP0-OP5 中 OP0、OP2-A/B/C/D/E、OP3-B/C、OP4-A/B/D 已落地

## 已完成

- 完成 Node.js 20+ / TypeScript strict 的 `agentctl` 单包分层 CLI。
- 完成 Agent 创建与隔离、Claude/Codex Runtime、Bridge、launchd、Job、Skill、备份恢复、Doctor。
- 完成 `user-operations`、`monetization`、`growth`、`engineering` 预设与生成模板。
- 完成 `FactoryApplication`，CLI 与 Fastify `/api/v1` 共用同一应用用例层。
- 完成 `agentctl web`、本地会话/CSRF、Operation/SSE、React 管理页和安全上传。
- 完成总览、员工创建/生命周期、身份文档、Job、Skill、日志、备份恢复和 Doctor 界面。
- 完成 22 个 Vitest 文件、80 项测试和 1 项真实浏览器 E2E 验收。
- 完成操作中心非遮挡式布局和创建向导 Agent ID 自动生成。
- 完成创建结果页和员工详情页的命令复制、兼容回退与可见状态反馈。
- 完成员工详情页三条终端命令的用途、执行时机及飞书可选状态说明。
- 完成生命周期操作的进行中/成功/失败反馈和重复点击保护。
- 完成旧版 Skill 摘要兼容及新预设 Skill 完整元数据生成。
- 完成 README、架构、测试、假设、决策、开发规则及迁移文档。
- 完成 Claude 默认 CC Switch Provider 白名单同步；兼容的 `runtime login` 不再调用官方 OAuth。
- 完成飞书官方 PersonalAgent/WebSocket 方案兼容性核查、Bridge 多命令能力探测和 workspace 权限收紧。
- 完成 Factory 自管员工回收站：一键移入、7 天恢复、ID 重用防冲突和下次 Web/CLI 启动时过期清理。
- 完成 TASK-010 记忆系统优化 OP0+Phase1(OP2)：ADR D-009（frozen/versioned 演进流程）、R2 script Job 注入 runtime env、R4 CC Switch 源不得指向员工 Runtime Home、R24 流量路由字段保留同步+routedFieldsChanged 审计告警、OP2-B assertInsideReal 落地于 ccSwitch/job-runner/installSkill/restoreBackupPath/scheduler、OP2-C Registry 序列化锁+secureProfile per-bridge 锁+FileLock 损坏拒绝、OP2-D R14 bridgeStatus 补 secureProfile+R19 restore 重置授权态。89 单测 + e2e 全过。
- 完成 TASK-011 备份密钥治理 OP2-E + R5 env 清洗：R7 shouldCopy 黑名单扩展(settings.json/config.json/.netrc/credentials.json/gcloud.json/id_rsa/id_ed25519/id_dsa/id_ecdsa + .pfx/.keystore，id_*.pub 保留)+SECRET_PATTERN、R27 rejectSecretsInStage 扫描 workspace+runtime 含未跟踪文件命中即拒、R8 解密产物 writeFile 0o600、R20 doctor trash-health 告警 failed/moving/purging + `trash purge <id> --force`、R21 verifyChecksums 集合一致性拒未声明文件(manifest.yaml/checksums.txt 豁免)、R5 factoryConfigSchema+readConfig+sync.sanitize_non_whitelist(default false)+syncCcSwitchClaudeProvider 清洗非白名单 env。新增 tests/config.test.ts(+4)、backup-restore +3、trash +3、doctor +1、runtime +1；共 101 单测 + e2e 全过。
- 完成 TASK-012 OP3-B 前向兼容基础 + OP3-C adapter 治理（B1 最小）：OP3-B（version.ts FACTORY_VERSION、CURRENT_AGENT_CONFIG_SCHEMA_VERSION、readAgentConfig 版本化只读 reader v1=identity 不原地 mutate、backup manifest 加性 factory_version(default ''，旧备份可恢复)、trash components length(6)->min(6) 为未来第 7 类组件留前向兼容）；OP3-C（RuntimeAdapter 增 buildEnv、Claude/Codex adapter 实现、buildRuntimeEnvironment 委托 adapter.buildEnv 消除 if/else、getRuntimeAdapter 改 Record<RuntimeProvider> 工厂对象编译期穷尽+未知 provider 抛 DEPENDENCY_MISSING 不回退 Codex 修 T-2）。AIEF2 与 agentctl migrate 明确不在本批。新增 tests/agents.test.ts(+2)、runtime +2、backup-restore +2、trash +1；共 108 单测 + e2e 全过。
- 完成 TASK-013 OP4-A 可观测性：src/core/secrets.ts 抽出共享 SECRET_PATTERN+redactSecrets（backup.ts R27 复用，消除重复正则）、src/core/operation-store.ts OperationStore append-only jsonl 0o600+query(agentId/kind/since/until/limit)+error_summary 经 redactSecrets 脱敏、OperationManager 构造注入 store+终态 best-effort record（succeeded/failed/cancelled 各一次，无 store 不回归）、server.ts 构造注入、config.ts R12 chmod 补 logsDir/servicesDir/schedulesDir/backupsDir/workspaceRoot 0o700、launchd-service.ts R10 预创建 stdout/stderr 日志 0o600 不截断、factory-application.ts queryOperations、cli-program.ts `agentctl operations query` 审计。新增 tests/operation-store.test.ts(+4)、operation-manager +2、config +1；共 115 单测 + e2e 全过。
- 完成 TASK-014 OP4-D prune 分类：src/core/prune.ts PruneService 4 scope 分类（logs 按 slug 目录 mtime 判龄删整个 run 目录、registry-backups 按 mtime 倒序保留 keepCount 份、archives 按 mtime 判龄删 .tar.gz/.aief.enc/.enc、operations 按 started_at 轮转读全量+原子重写保 0o600）+ keep-days/keep-count 保留上限（默认 logs/archives/operations 30/90/30 天、registry-backups 20 份）+ safeRemove 包 assertInsideReal 二次校验（symlink 逃逸项 isDirectory()=false 枚举阶段跳过，越界项跳过不中止）+ 无 scope 报 VALIDATION_ERROR；factory-application.ts prune 薄编排；cli-program.ts `agentctl prune` 单命令（scope flags + --dry-run/--yes/--keep-days/--keep-count，非 dry-run 先 YAML 预览再 confirmDanger 再实跑+绿色汇总）；doctor.ts disk-usage 检查（warn：backupsDir>500MB 或 run 日志目录>500，remediation 指向 prune --dry-run）+ backupsDirSize/countRunLogs 助手。新增 tests/prune.test.ts(+8)、doctor +1、cli-structure +1；共 124 单测 + e2e 全过。
- 完成 TASK-015 OP4-B trace 关联：src/core/observability.ts ObservabilitySink/Span/NoopObservabilitySink/defaultObservabilitySink 抽象（no-op 填补 O-6）；process-runner.ts LoggedRunOptions 增 operationId/traceId、LoggedRunResult 增 startedAt/finishedAt、metadata.json 传参时富化 operation_id/trace_id/span_id（未传省略向后兼容，trace 字段经 LoggedRunOptions 而非 ExecutionContext 避免触动 adapter）；operation-store.ts OperationSummary/OperationRecordInput 增 trace_id；operation-manager.ts 构造注入 sink(默认 noop)、start 生成 traceId 入 dto、execute 以 spanStart('operation')+finally span.end() 包裹且 task context 携带 operationId/traceId、persist 写 trace_id；server.ts run/job 透传 operationId/traceId；cli-program.ts run/job 经 recordOperation 包装写 operations.jsonl（CLI 路径闭环无 web 双写）。新增 tests/observability.test.ts(+2)、process-runner +3、operation-store +1、operation-manager +2(含 RecordingSink 注入断言)；共 132 单测 + e2e 全过。

## 进行中

- 无进行中任务。TASK-015 已完成待 commit；记忆系统优化框架剩余 OP1（CLI 结构化输出）、OP3-A（迁移）、OP5（Web 痕迹展示）未启动，均需用户授权范围。

## 待审查

- TASK-001~006 已完成并首次提交（34a98b8），由 claude-20260803-01 独立核实 build/test/lint/e2e 四项全过。
- 未做逐文件深度静态审查（隔离/安全/边界），可作为后续任务。

## 受阻

- 无阻塞项。

## 已知问题与风险

- 未执行真实 Claude/Codex 登录、飞书授权或真实 launchd 安装；这些步骤需要用户凭据或会修改真实系统状态。
- v1 仅实现 macOS launchd；systemd 仅保留接口扩展点。
- 生成的 Bridge 启动服务须在完成 `agentctl bridge authorize <id>` 后使用。
- `bridge status` 的 profile export 只能证明本地 Profile 存在，不能证明 WebSocket 与机器人实际收发成功；真实连通性需启动后结合日志确认。

## 近期决策

- Registry 为本机控制面真相源，`agent.yaml` 为可迁移身份真相源。
- 所有 Runtime/Bridge/Job 执行统一经过隔离的 `ExecutionContext`。
- Factory 不保存飞书 app-secret，也不在 launchd plist 或执行日志中记录 Secret。
- Web 只绑定 `127.0.0.1`，不提供远程、局域网或嵌入终端模式。
- Claude Provider 只从 CC Switch live settings 同步白名单字段到员工专属 Runtime Home。
- 飞书采用官方 PersonalAgent 扫码和 WebSocket；Bridge profile 固定 workspace/workspace 权限。

## 下一优先级

1. 用户审阅本地 Web 交互和中文文案。
2. 在需要时运行 `npm link`，通过 `agentctl web` 启动日常管理页。
3. 记忆系统优化剩余批次（OP1 CLI 结构化输出 / OP3-A 迁移 / OP5 Web 痕迹展示）需用户逐批授权范围后再实施。
4. 当前用户已明确授权创建本地 Git commit（任务完成即 commit）；未授权 push。
