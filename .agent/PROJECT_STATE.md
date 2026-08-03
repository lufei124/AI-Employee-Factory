# 项目状态

最后更新：2026-08-03 18:19 +0800
更新者：codex-20260803-01
当前版本/分支：master
当前阶段：TASK-006 已完成，等待用户复验

## 已完成

- 完成 Node.js 20+ / TypeScript strict 的 `agentctl` 单包分层 CLI。
- 完成 Agent 创建与隔离、Claude/Codex Runtime、Bridge、launchd、Job、Skill、备份恢复、Doctor。
- 完成 `user-operations`、`monetization`、`growth`、`engineering` 预设与生成模板。
- 完成 `FactoryApplication`，CLI 与 Fastify `/api/v1` 共用同一应用用例层。
- 完成 `agentctl web`、本地会话/CSRF、Operation/SSE、React 管理页和安全上传。
- 完成总览、员工创建/生命周期、身份文档、Job、Skill、日志、备份恢复和 Doctor 界面。
- 完成 21 个 Vitest 文件、66 项测试和 1 项真实浏览器 E2E 验收。
- 完成操作中心非遮挡式布局和创建向导 Agent ID 自动生成。
- 完成创建结果页和员工详情页的命令复制、兼容回退与可见状态反馈。
- 完成员工详情页三条终端命令的用途、执行时机及飞书可选状态说明。
- 完成生命周期操作的进行中/成功/失败反馈和重复点击保护。
- 完成旧版 Skill 摘要兼容及新预设 Skill 完整元数据生成。
- 完成 README、架构、测试、假设、决策、开发规则及迁移文档。

## 进行中

- 无。

## 待审查

- TASK-001 和 TASK-002 已完成，工作树保留为未提交状态供用户审阅。

## 受阻

- 无阻塞项。

## 已知问题与风险

- 未执行真实 Claude/Codex 登录、飞书授权或真实 launchd 安装；这些步骤需要用户凭据或会修改真实系统状态。
- v1 仅实现 macOS launchd；systemd 仅保留接口扩展点。
- 生成的 Bridge 启动服务须在完成 `agentctl bridge authorize <id>` 后使用。

## 近期决策

- Registry 为本机控制面真相源，`agent.yaml` 为可迁移身份真相源。
- 所有 Runtime/Bridge/Job 执行统一经过隔离的 `ExecutionContext`。
- Factory 不保存飞书 app-secret，也不在 launchd plist 或执行日志中记录 Secret。
- Web 只绑定 `127.0.0.1`，不提供远程、局域网或嵌入终端模式。

## 下一优先级

1. 用户审阅本地 Web 交互和中文文案。
2. 在需要时运行 `npm link`，通过 `agentctl web` 启动日常管理页。
3. 只在用户明确授权后创建 Git commit 或 push。
