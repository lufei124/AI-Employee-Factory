# 当前任务交接

## 身份

Task ID: TASK-044

Task title: 分层自进化协议 M5（D-041 P3）——Web 进化历史只读视图 + doctor 6 检查项 + 检索增强

Outgoing/current agent: claude-20260807-01

Intended next role/agent: 用户或后续维护者（TASK-044 已实施并 commit；D-041 五阶段 M1-M5 全部完成）

Branch/worktree: main

Status: 分层自进化协议 M5 已实现，全量测试/构建/lint/tsc 通过，已 commit（未 push）

更新时间：2026-08-07 10:52 +0800

## 已完成

- **`src/core/git.ts`（P3-1）**：新增 `gitLog(workspace, {grep, limit, path})`——`git log --format=%H%x00%s%x00%cI` 解析为 `{hash, subject, date}` 数组，按时间倒序；非仓库/无提交返回空数组不抛错。
- **`src/application/factory-application.ts`（P3-1）**：新增 `evolutionLog(id)` = `gitLog(workspace, {grep:'evolve:', limit:100})` + `agent/CURRENT_STATE.md` 全文 + `usageDb.summary()` 使用统计，供 Web「进化历史」只读视图与审计。
- **`src/web/server.ts`（P3-1）**：新增只读端点 `GET /api/v1/agents/:id/evolution`（复用 agent-detail 认证模式，无写端点）。
- **`web/src/api.ts` + `web/src/pages/AgentDetailPage.tsx`（P3-1）**：前端增 `EvolutionLog` 类型 + `api.evolutionLog(id)`；AgentDetailPage 增「进化历史」tab——evolve 提交流（hash 短码 + subject + 本地时间）、使用统计表（消息/平均耗时/费用）、CURRENT_STATE markdown 渲染，**纯展示无任何编辑/回滚入口**。
- **`src/core/doctor.ts`（P3-2，6 检查项）**：
  - `identity-baseline`：基线缺失/不可解析 → warn（无从对账）；相对基线漂移 → warn（remediation 指向 identity rollback）。
  - `identity-guard`：ROLE 岗位定位/长期职责标题、POLICIES 红线词、CONSTITUTION 使命/变更流程标题缺失 → **fail**（与 commitSelfEvolution 提交前硬门一致）。
  - `proposal-ledger`：`appliedWithoutAnchor` 检出超出可进化范围且无 `user_anchor` 依据的身份改动 → **fail**（detail 带违规文件 + 当前协议，remediation 区分 advisory/enforced）。
  - `memory-flags`：agent.yaml 三开关（transcript_persist/experience_extraction/skill_self_creation）**缺失（undefined）** → warn（按默认开处理，引导补齐）；显式 false 尊重关闭意图。
  - `knowledge-retention`：lessons/raw 与 refined 中超 90 天未归档条目 >0 → warn（引导运行 retention）。
  - `reflection`：refined/ 条目不附 `because of:` 证据引用（无法回溯 raw/）→ warn；无 refined 或均有证据 → pass。
- **`src/core/knowledge.ts` + `src/core/knowledge-index.ts`（P3-3）**：`KnowledgeRecallHit` 增 `evidence?: string[]`；`recall` 对 `lessons/refined/` 命中条目前置收集 `because of:` 证据行（容错缺证据不带），非 refined 不附带。
- **`src/cli-program.ts`（P3-3）**：`registerIdentityCommands` 增 `agentctl identity proposals <agent-id>`——列出提案账本状态机（proposed/approved/rejected/applied/expired，含批准依据 `user_anchor`）；`knowledge recall` 命中 refined 时以 `证据:` 标签展示证据链接。
- **测试**：git（gitLog 过滤/limit/倒序/非仓库空数组）、doctor（6 检查项全 pass + 逐项破坏断言）、knowledge（recall refined 带证据 / raw 不带）、web-management-api（evolution 端点 + settleEmployee 后 evolve 提交可见）、cli-structure（identity 含 rollback + proposals）、e2e/web-console（进化历史 tab 可见）。
- **文档**：`docs/DECISIONS.md` 新增 D-041 M5 ADR（D-041 收尾）；README 更新（D-041 节增进化历史/检索证据链/doctor 检查项 bullet + 路线图 D-041 全部完成）；`.agent/TASK_BOARD.md` / `.agent/FILE_LOCKS.md` 登记 TASK-044 为 DONE/RELEASED。

## 验证

- `npm test`：全量 442 通过（此前 438，新增 4 用例——git gitLog 1 + doctor 6 检查项 1 + knowledge recall 证据 1 + web evolution 1，另 cli-structure 断言扩为 arrayContaining）。
- `npm run build`：通过（tsc + vite，仅既有 chunk-size 警告）。
- `npm run lint`：eslint + prettier 全绿。
- `npx tsc --noEmit`：通过。

## 待确认 / 后续

- 已 commit（AGENTS.md 常驻规则「任务完成即 commit」，已提交 main，不 push）。
- **D-041 五阶段 M1-M5 全部完成**：P0 身份守卫 → P1 三开关+两级经验 → M3 提案对账 + Web 只读化 + 创建骨架 → M4 遗忘归档 + 身份回滚 + 账本上限 → M5 doctor 监控 + Web 进化历史 + 检索增强。
- `identity_edits`（`proposal_required|direct`）仍仅声明未生效（P1 预留），后续按需启用。
