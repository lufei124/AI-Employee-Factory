# Project Context

## 项目解决的问题

AI Employee Factory 为 macOS 个人用户提供统一的本地 AI 员工创建与管理工具，解决多个 Claude Code/Codex 员工的配置、记忆、飞书身份、日志和生命周期相互污染问题。

## 目标用户

需要在单台 Mac 上长期运行多个、岗位不同、可通过飞书沟通的 AI 员工的个人开发者与运营者。

## 主要业务流程

1. 通过 `agentctl init` 或 Web 首次向导初始化控制面。2. 用一句话描述员工用法，AI 生成可编辑的员工蓝图（Web 或 `agentctl create --describe`）后创建员工。3. Claude 同步 CC Switch 当前 Provider，Codex 在专属 runtime home 登录，并在终端授权飞书。4. 通过 CLI 或 Web 执行任务、启停 Bridge 和定时任务。5. 使用 doctor、日志和备份恢复进行运维。

## 当前阶段

v1 主功能开发，优先 macOS 和 `user-operations` Claude 员工。

## 核心产品目标

- 强制 Claude/Codex/Bridge 配置与记忆隔离。
- 提供可脚本化的统一 CLI 和中文诊断。
- 提供只监听本机回环地址的可视化管理控制面。
- 使每个员工的岗位、知识、Skill、任务与备份可迁移。
- 在不存储明文 Secret 的前提下集成飞书和 launchd。

## 技术栈与外部依赖

- 技术栈：Node.js 20.19+、TypeScript strict、Commander、Zod、YAML、Execa、Fastify 5、React 19、Vite、Vitest、Playwright。
- 外部依赖：Git、Claude Code 或 Codex CLI、lark-channel-bridge、macOS launchd。

## 已知约束

禁止读取个人 `~/.claude`/`~/.codex`；禁止 shell 字符串拼接；不将 Secret 写入 Git、plist 或日志；所有工作区和 runtime home 必须位于配置根目录内。

## 重要业务术语

统一定义见 [GLOSSARY.md](GLOSSARY.md)。

## 当前明确不做

远程/局域网 Web 部署、账号系统、浏览器内 Runtime 登录/飞书授权/交互聊天、多 Agent 共用一个飞书机器人、Agent 自由互聊、云端多租户、Skill 市场、生产数据写入和完整 systemd 部署。

## 开放问题

无阻塞 v1 的开放问题；非关键默认值记录于 `docs/ASSUMPTIONS.md`。
