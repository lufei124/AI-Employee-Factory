# 当前任务交接

## 身份

Task ID: TASK-042

Task title: 分层自进化协议 M3（D-041）——提案账本对账（proposal-ledger）+ Web 身份文档/Skills 只读化 + 创建骨架模板

Outgoing/current agent: claude-20260806-01

Intended next role/agent: 用户或后续维护者（TASK-042 已实施并 commit；后续阶段 M4-M5：遗忘归档 + identity rollback CLI、doctor 检查项 + Web 进化历史 + 检索增强）

Branch/worktree: main

Status: 分层自进化协议 M3 已实现，全量测试/构建/lint 通过，已 commit（未 push）

更新时间：2026-08-06 21:05 +0800

## 已完成

- **`src/core/proposal-ledger.ts`（新，D-041 P1-3 提案账本对账硬门）**：轻量 JSONL 账本 `~/.ai-employees/logs/proposals/<id>.jsonl`（0600，上限 5000 行）。`parseProposalFrontmatter`（宽容解析，缺字段不抛错）、`recordProposal`/`recordDecision`（best-effort，失败仅 warn）、`readLedger`（损坏行跳过）、`truncateLedger`、`hasApprovedAnchor`（`decision=approved` + 带 `user_anchor`）。`appliedWithoutAnchor(workspace, ledger)`：ROLE/POLICIES/CONSTITUTION 相对基线超出 `allowedIdentityDiff` 可进化范围（整删/重写/锚点缺失）且无带 `user_anchor` 的 `applied` 提案依据 → 「未授权身份改动」；基线缺失返回空（交 doctor 告警）。`maybeEnforceIdentityProtocol` 按 `identity_protocol` 分级——默认 `advisory`（仅 warn 留痕，不阻断）；`enforced`（用户显式开启）→ 违规文件**不提交** + warn + CURRENT_STATE 记录「检测到未授权身份改动已拒绝提交」。**提交拒绝 ≠ 恢复文件**：保留工作区脏文件供人工 `git diff`/`git checkout` 决策，不悄悄回滚。
- **`src/application/factory-application.ts`（接线）**：`syncProposalLedger`（settle 时扫描 `agent/proposals/*.md` 登记提案；`applied`+`user_anchor` 的登记批准决策）；`enforceIdentityProtocol`（读取 `agent.memory.identity_protocol`，enforced 时对账，`recordState` 回调写 CURRENT_STATE + 若脏则 `chore: 记录未授权身份改动` 提交）；**settleActive 链序不变量**：`syncProposalLedger` → `enforceIdentityProtocol` → `ensureIdentityBaseline(excludeDocs: blockedRel)` → `commitSelfEvolution(blockedRel)`——enforced 对账跑在基线重快照前，被拦截的违规改动经 `excludeDocs` 不吸收进基线（保留既有基线条目，下次 settle 仍能发现）。`commitSelfEvolution` 增 `blockedRel` 参数跳过违规文件 + relPaths 增补 `agent/CONSTITUTION.md`。新增 `generateSkeleton`（委托 `generateEmployeeSkeleton`）。
- **`src/core/identity-baseline.ts`（P1-3）**：`IDENTITY_DOCS` 扩为五份（含 `agent/CONSTITUTION.md`，宪法区纳入基线快照供对账）；`ensureIdentityBaseline` 增 `excludeDocs`（被排除文档沿用既有基线条目，不吸收未授权改动）。
- **`src/core/identity-guard.ts`（P1-3）**：新增 `agent/CONSTITUTION.md` 锚点（`使命`/`变更流程` 标题）——宪法区员工不可静默改动，要改走聊天明确指示。
- **创建骨架化（决策②）**：
  - `templates/agent-skeleton/`（新）：`CONSTITUTION.md`（使命 + `<!-- constitution:anchors -->` 红线锚点块 + 变更流程）。
  - `src/core/employee-generator.ts`：`generateEmployeeSkeleton(brief)`——prompt 收敛产出 `{id, name, description, goals[1-3], skills[0-2]}`；保留 `generatedProfileSchema`/`generateEmployeeProfile` 兼容（CLI `--describe` 仍走完整蓝图）。
  - `src/core/create-agent.ts` `resolveProfile` 简化：responsibilities 缺省 `[description]`（岗位定位即初始职责）、policies 缺省红线模板、escalation 缺省通用上报。
  - `src/core/templates.ts`：ROLE 增 `## 协作协议` 段（四区模型 + 提案通道）、GOALS 增 `## 演进记录` 留痕行、CONSTITUTION 从模板播种、基线注释更新为五份文档。
  - `src/web/server.ts`：`GET /api/v1/agents/generate` 改走 `generateSkeleton`（Web 用骨架）。
  - `web/src/pages/CreateAgentPage.tsx`：Step 1 重写——一句话 + name/id/description/goals/skills 编辑字段；responsibilities/policies/escalation 降为「将播种的基础模板预览」只读区。
- **Web 只读化（决策①）**：`AgentDetailPage.tsx` `DocumentsTab` 移除编辑（`ReactMarkdown` 全文预览 + `（只读）` 标 + dirty 徽章 + 页脚提示走飞书聊天）、`SkillsTab` 移除安装/导入/卸载入口；`web/src/api.ts` 移除 `saveDocument`/`uploadSkill`/`removeSkill`；`src/web/server.ts` `PUT /documents/:key` 直接 403 `READONLY`（CLI 与飞书聊天是唯一改身份通道，Skill 后端路由保留为用户逃生口）。
- **文档**：`docs/DECISIONS.md` 新增 D-041 M3 ADR；README 更新（创建→骨架、Web 只读、身份守卫增提案账本、路线图 M3 已完成）；`.agent/TASK_BOARD.md` / `.agent/FILE_LOCKS.md` 登记 TASK-042 为 DONE/RELEASED。

## 验证

- `npm test`：全量 421 通过（此前 394，新增 27 用例——proposal-ledger 19 + create-agent 1 + identity-baseline 2 + web-management-api 1 + web-ui 2 + self-evolution 3，改写 web-ui 卸载用例为只读断言）。
- `npm run build`：通过（tsc + vite，仅既有 chunk-size 警告）。
- `npm run lint`：eslint + prettier 全绿（新增 `.prettierignore` 排除 gitignored `.claude/settings.local.json` 本地文件）。

## 待确认 / 后续

- 已 commit（AGENTS.md 常驻规则「任务完成即 commit」，已提交 main，不 push）。
- **M4（P2）**：`knowledge-retention.ts` 遗忘归档（raw/refined 超 retentionDays 移 `.archive/`，可恢复）+ `identity rollback` CLI（`agentctl identity rollback <id> <file>`）。
- **M5（P3）**：doctor 检查项（identity-baseline/identity-guard/proposal-ledger/memory-flags/knowledge-retention/reflection）+ Web 进化历史页（`git log --grep evolve:` + CURRENT_STATE）+ `knowledge recall` 覆盖 refined/。
- `identity_edits`（`proposal_required|direct`）仍仅声明未生效（P1 预留），后续按需启用。
