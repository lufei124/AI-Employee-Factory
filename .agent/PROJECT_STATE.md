# 项目状态

最后更新：2026-08-04 11:11 +0800
更新者：claude-20260803-01
当前版本/分支：master（commit 34a98b8，工作区含 TASK-010 未提交改动）
当前阶段：TASK-010 记忆系统优化 OP0+Phase1(OP2) 实施完成，待用户审阅与提交决策

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

## 进行中

- 无（TASK-010 改动未提交，待用户授权 commit）。

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
3. 当前用户已明确授权创建本地 Git commit；未授权 push。
