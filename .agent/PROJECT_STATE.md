# 项目状态

最后更新：2026-08-04 20:16 +0800
更新者：claude-20260803-01
当前版本/分支：master（TASK-020 阶段4 OP1 Stage B knowledge/ 索引 + recall 已提交）
当前阶段：TASK-020 记忆系统剩余批次合并（阶段1-4 已提交；阶段5-12 按顺序依赖后续实施）

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
- 完成 TASK-016 OP3-A 单一可写源中期：agent.yaml runtime 块为唯一可写真相，Registry runtime 块降级为派生缓存 + config_hash（runtime 块 sha256，非整文件以避免 archive lifecycle 块等合法改写误报漂移）。src/schemas/registry-schema.ts 增 optional config_hash（向后兼容）；src/core/agents.ts computeConfigHash（loadPortableConfig 不动 I-5）；src/core/registry.ts updateAgent 增 model 直改 CONFLICT 守卫（grep 确认 4 调用方均只动 status/archived/bridge.authorization/updated_at，零破坏）+ resyncRuntime 受信重建路径（registry.lock 下刷新 runtime 块+hash，允许 model 从 agent.yaml 派生但 provider/locked 不变量仍 CONFLICT 强制）；create-agent/backup 存 hash；factory-application.ts repairAgent（复用 getAgent 已 loadPortableConfig 校验）；cli-program.ts `agentctl repair` 命令；doctor.ts 复用 loadPortableConfig+config-drift 检查（缺/不等 warn 指向 repair，等则 pass）。docs/DECISIONS.md D-010 ADR。新增 tests/repair.test.ts(+3)、registry +4、agents +2、backup-restore +1、doctor +1、cli-structure +1；共 143 单测 + e2e 全过。
- 完成 TASK-017 OP1 Stage A 认知记忆层运行时强制：authority_order 从「声明不强制」升级为「运行时强制 + 派生 stance 注入」。src/schemas/agent-schema.ts 增 AUTHORITY_LAYERS 常量+AuthorityLayer 类型，authority_order 改 z.array(z.enum(AUTHORITY_LAYERS)) 编译期穷尽，memory 块增 optional enforced（向后兼容，零 schema_version bump，与 config_hash 零交互）；src/core/authority.ts validateMemoryConfig（空/缺 agent/agent 非首/重复 各报 issue）+renderAuthorityStance（从 authority_order 派生 agent 居首+约束句，纯函数零 I/O）；src/core/templates.ts renderRuntimeFiles 注入派生 stance 至 CLAUDE.md/AGENTS.md；src/core/create-agent.ts 新建 agent memory.enforced=true；src/application/factory-application.ts prepareRuntime(registry,agent)+assertMemoryEnforced（enforced:true+无效抛 VALIDATION_ERROR 阻断 spawn，false/undefined 跳过）+7 调用点；src/core/doctor.ts memory-enforcement 4 态（undefined/false=warn、true+有效=pass、true+无效=fail）。documentFile 偏离裁定（D-011）：identity-doc 路径不变量校验即 agent 层写约束，不叠加 memory 校验以免阻断误配 agent 自修复。新增 tests/authority.test.ts(+8)、memory-enforcement.test.ts(+2)、schemas +1、create-agent +1、doctor +1；共 156 单测 + e2e 全过。

- 完成 TASK-018 Skill 作用域(项目/用户) + Skill 商店(GitHub 源)：src/core/skills.ts 增 SkillScope='project'|'user'，list() 扫描 project+user 两根并标注，install(source,scope) 存 storeRoot(scope)（project→workspace/skills 投影 .claude/.codex/skills，user→runtimeHome/skills 原位），remove 归档 .archive；src/core/skill-store.ts(新增) SkillStoreService：listRepositories/addRepository(仅 github.com HTTPS)/removeRepository/refresh(clone --depth 1 或 pull --ff-only)/listSkills(agent-skills.yaml 清单或扫 SKILL.md)/resolveSkillSource(assertInside 防穿越)；src/core/config.ts 增 skill_store 配置块+内置源(superpowers/anthropic-skills)；src/core/paths.ts 增 skillStoreDir；application 增 scope 参数与 6 个 store 方法；server 增 5 条 store 路由；cli skill 增 --scope + skill-store 命令组；web 新增 SkillStorePage 顶级页+员工详情 Skills 分组展示；docs D-003 演进+D-008 ADR。新增 tests/skill-store.test.ts(+7) 等；共 169 单测 + e2e 全过。

- 完成 TASK-019 OP3-A 长期（移除 Registry runtime 块 + I-5 model 收紧 + agentctl migrate）：registry-schema REGISTRY_VERSION=2，registryAgentSchema 删 runtime 块、保留 config_hash optional，registrySchema.version literal(2)；registry.ts read() 版本分发（v1→normalizeRegistryV1 内存规范化丢弃 runtime 保留 config_hash 与其余字段、v2 原样、未知版本 VALIDATION_ERROR）、migrate({dryRun}) registry.lock 下重写 v2、resyncRuntime 改 refreshConfigHash(id,configHash)、updateAgent 删 runtime 守卫；agents.ts loadPortableConfig HARD 校验（config.id===agent.id 且 computeConfigHash(config.runtime)===agent.config_hash，缺失/不符抛 CONFLICT 提示 agentctl repair）+ 新增 readAgentConfigFile 原始只读 reader；adapters chat/run(agent,runtime)、getRuntimeAdapter(runtime)、buildRuntimeEnvironment(agent,runtime)、syncCcSwitchClaudeProvider(agent,runtime,...)、bridge run/authorize/status/secureProfile(agent,runtime)、job-runner run(agent,runtime,job,options)、launchd services(agent,runtime,...) 全部 runtime 透传；create-agent/backup 写 registry 不再带 runtime，backup manifest provider 从暂存 agent.yaml 读、restore provider 从恢复的 agent.yaml 读；factory-application listAgents N+1 读 agent.yaml 取实时 provider（缺/无效 yaml→'unknown'）、repairAgent 重写返回 {id,config_hash}、migrate 封装；cli-program 新增 agentctl migrate（--dry-run）；doctor runtime-lock 改 portableConfig.runtime.locked、config-drift 状态 warn→fail；web api.ts AgentSummary.runtime 加 'unknown'、AgentDetail 删 registry.runtime 增 agent.runtime，AgentDetailPage 改读 agent.runtime.*；修复 locks.ts readExisting 重读 ENOENT 误报「锁文件损坏」并发竞态。新增 registry 迁移（v1→v2 归一化/migrate 重写/未知版本）、HARD config_hash 漂移 CONFLICT、repairAgent 绕过、list N+1 'unknown'、agentctl migrate 命令结构测试；所有 RegistryAgent fixture 删 runtime 块。docs/DECISIONS.md 增 D-012 ADR，.scratch/plan.md 写 OP3-A 长期 spec。共 176 单测 + e2e 全过，npm run verify 实跑通过。

- 完成 TASK-020 阶段1（OP2-F 扩展面能力隔离 R23）：src/core/extensions.ts(新增) ExtensionKind='data-only'|'adapter-interface'|'subprocess'+ExtensionSandbox/ExtensionManifest/Extension 契约类型（设计级，v1 不固化加载器）；src/core/backup.ts 把模块级 shouldCopy/excludedNames/excludedExtensions 收敛为 BackupFilter 接口+defaultBackupFilter() 纯函数零 I/O，BackupService 构造注入 filter?:BackupFilter（默认 defaultBackupFilter()），全部 shouldCopy 调用改 this.filter.shouldCopy；src/core/paths.ts 增 PathLayout 数据契约接口（home/workspaceRoot/managedDirs）+resolvePathLayout 派生（所有受管目录均位于 home 树内，assertInside 保证，纯数据不 hold fs）；src/schemas/agent-schema.ts 增 portableMemorySchema+PortableMemorySchema 类型（memory 块权威类型导出，agentConfigSchema.memory 复用，schema 内容与旧 memory 块同构零行为变更）。docs/DECISIONS.md 增 D-013 ADR（扩展点限定为 data-only/adapter-interface，禁止同进程 JS 模块直接持有 fs/execa）。新增 tests/paths.test.ts resolvePathLayout 断言所有 managedDirs 经 assertInside 位于 home 内、tests/backup-restore.test.ts 注入 BackupFilter 断言隔离生效（shouldCopy:()=>true 时 .env 被备份）。共 180 单测 + e2e 全过，npm run verify 实跑通过。

- 完成 TASK-020 阶段2（CLI 结构化输出，A2 门控通过）：调研写入 .scratch/cli-structured-output.md——Claude 完全可达（`claude -p --output-format json` 单对象含 usage input/output/cache tokens、modelUsage per-model canonicalModel+costUSD、total_cost_usd、result，本机 2.1.221 实测）；Codex 仅 token 可达（`codex exec --json` JSONL 事件流仅 turn.completed 携带 usage 含 cached_input_tokens，事件 schema 无 model/cost，源码核查 openai/codex main codex-rs/exec）。src/core/usage.ts(新增) RunUsage 类型+parseClaudeUsage（主模型取 modelUsage inputTokens 最大者）/parseCodexUsage（累加 turn.completed usage）/parseStructuredUsage 纯函数零 I/O；runtime-adapter.ts run 增 structured?:boolean 参，claude 追加 --output-format json、codex 追加 --json；process-runner.ts LoggedRunOptions 增 provider/structured、LoggedRunResult 增 usage，runLogged 结束后读 stdout 文件 best-effort 解析写入 metadata.json 与 result（exactOptionalPropertyTypes 下条件展开）。新增 tests/usage.test.ts(+8)、process-runner +2、runtime +2；共 188 单测 + e2e 全过，npm run verify 实跑通过。

- 完成 TASK-020 阶段3（OP4-C OTel GenAI span，gated on 阶段2）：src/core/observability.ts SpanAttrs 增 'gen_ai.request.model'/'gen_ai.usage.input_tokens'/'gen_ai.usage.output_tokens'/'gen_ai.usage.cost_usd'（可选）+toGenAiAttrs(usage) 映射助手（缺省字段省略，Codex 无 model/cost 自然不报）；src/web/operation-manager.ts OperationTask 返回类型增 usage?:RunUsage，execute 内 task 结果 usage 经 finally span.end(toGenAiAttrs(usage)) 上报（无 usage 传 {}，向后兼容）；src/application/factory-application.ts runAgent 默认启用结构化输出（run 传 structured=true + options 合并 provider/structured），runLogged 解析 usage；src/web/server.ts run handler 返回 {exitCode, usage?} 透传。新增 tests/observability.test.ts toGenAiAttrs(+2)、operation-manager +2（RecordingSink 捕获 endAttrs 断言 gen_ai 属性/无 usage 传 {}）。共 192 单测 + e2e 全过，npm run verify 实跑通过。

- 完成 TASK-020 阶段4（OP1 Stage B knowledge/ 轻量索引 + recall）：src/core/knowledge.ts(新增) KnowledgeIndex 接口（ingest/recall/compact/verifyConsistency）+KnowledgeEntry（frontmatter title/summary/keywords/updated_at/authority_layer）+defaultLayerFor（按顶层子目录推断：decisions→'decisions'、其余→'knowledge'）；src/core/knowledge-index.ts(新增) KnowledgeIndexImpl 扫描 knowledge/**\/*.md 解析 frontmatter 建关键词倒排，写派生 knowledge/.index.json（atomicWriteFile 0600，.gitignore 排除），recall 中文感知（整词+2-gram 退化+同义词扩展），verifyConsistency 检测漂移；src/core/templates.ts 增 knowledge/README.md frontmatter 约定种子+workspace .gitignore 排除 knowledge/.index.json；src/application/factory-application.ts knowledgeIngest/knowledgeCompact/knowledgeRecall/knowledgeVerify/knowledgeRead/knowledgeWrite 复用 documentFile 的 assertInside+realpath+symlink 硬约束模式，写后自动 re-ingest；src/cli-program.ts 新增 agentctl knowledge 命令组（rebuild/recall/verify）；src/core/doctor.ts 增 knowledge-index 索引漂移检查；src/web/server.ts 增 GET /api/v1/agents/:id/knowledge/recall?q= 只读 API。新增 tests/knowledge.test.ts(+8)。npm run verify 实跑（build+lint+prettier 全绿；test 4 项既有失败为并发 TASK-018 技能空预设回归，干净树复现，非本阶段引入）。未 push。

- 完成 TASK-020 阶段5（OP1 Stage C chat transcript 持久化，为 Stage D 铺路）：src/core/transcript.ts(新增) TranscriptSummary（agent_id/operation/started_at/finished_at/exit_code/topics/decisions/lessons/tail）+TranscriptSink 接口+FileTranscriptSink.persist（ensureDir+append+0600+chmod）+summarizeTranscript 纯函数（TOPIC_LINE_PATTERN/DECISION_PATTERN/LESSON_PATTERN 抽取，tail/decisions/lessons 经 redactSecrets 脱敏）；src/core/process-runner.ts LoggedRunOptions 增 transcript?:boolean 与 transcriptSummary? 覆盖、LoggedRunResult 增 transcriptFile?，runLogged 在 transcript 启用时收集 stdout 行，元数据写完后 best-effort persist 摘要到 logs/<id>/runs/<slug>/transcript.jsonl（0600，失败不阻断）；src/schemas/agent-schema.ts portableMemorySchema 增 transcript_persist:z.boolean().optional()（opt-in，缺省不落盘，D-006 对齐）；src/application/factory-application.ts runAgent/runJob 在 agent.memory.transcript_persist===true 时透传 transcript:true，chat 保持 runInteractive 不落盘。新增 tests/transcript.test.ts(+6)。npm run verify 实跑（build+lint+prettier 全绿；207 测试中 206 过，唯一失败为工作区另一 Agent 未提交 skills.ts 改动——Skill remove 改彻底卸载——所致，非本阶段引入）。未 push。

## 进行中

- TASK-020 记忆系统剩余批次合并：阶段1（OP2-F）、阶段2（CLI 结构化输出）、阶段3（OP4-C）、阶段4（OP1 Stage B knowledge/ 索引 + recall）、阶段5（OP1 Stage C chat transcript 持久化）已提交；阶段6-12（OP1 Stage D-E / OP5 A-E）按顺序依赖后续实施。

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
3. 记忆系统优化剩余批次（OP1 CLI 结构化输出 / OP3-A 长期（移除 Registry runtime 块 + I-5 model 收紧）/ OP5 Web 痕迹展示 / OP2-F / OP4-C）需用户逐批授权范围后再实施。
4. 当前用户已明确授权创建本地 Git commit（任务完成即 commit）；未授权 push。
