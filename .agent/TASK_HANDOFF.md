# 当前任务交接

## 身份

Task ID: TASK-043

Task title: 分层自进化协议 M4（D-041 P2）——knowledge 遗忘归档 + 身份 git 回滚 + 账本上限

Outgoing/current agent: claude-20260807-01

Intended next role/agent: 用户或后续维护者（TASK-043 已实施并 commit；D-041 剩余 M5：doctor 检查项 + Web 进化历史 + 检索增强）

Branch/worktree: main

Status: 分层自进化协议 M4 已实现，全量测试/构建/lint/tsc 通过，已 commit（未 push）

更新时间：2026-08-07 10:35 +0800

## 已完成

- **`src/core/knowledge-retention.ts`（新，D-041 P2-1 knowledge 遗忘归档）**：`archiveStaleKnowledge` 把 `lessons/raw/` 与 `lessons/refined/` 超 `retentionDays`（默认 90）的条目 `fs.move` 到 `knowledge/.archive/<归档日期>/<层>/`（移走非删除、可恢复），按「日期 + 层」两级分桶——raw/refined 同名文件（`<date>-<agent>.md`）不互相覆盖，恢复时无歧义回 `lessons/<层>/`。软链接条目拒移（防逃逸，记 skipped）。归档即隐退：`.archive/` 是点目录，`KnowledgeIndexImpl.scan` 递归时跳过 → 不参与 recall；工作区 `.gitignore` 排除 `knowledge/.archive/` → 不进员工 git。`restoreKnowledge` / `purgeKnowledgeArchive` 复用 TrashService 语义（restore 移回原位、目标已存在拒绝覆盖；purge 彻底删除），路径经 `assertArchiveEntry` 校验必须落在 `.archive` 树内（防 `..` 逃逸）。
- **`src/application/factory-application.ts`（接线）**：`settleActive` 末尾新增 `maybeArchiveStaleKnowledge`（归档 >0 时重建索引 + warn；best-effort 失败仅告警，不阻断自进化链）；公开入口 `knowledgeArchiveStale` / `knowledgeListArchive` / `knowledgeRestore` / `knowledgePurgeArchive`（各在归档/恢复/删除后重建索引）。新增 `identityRollback(id, relPath, {ref})`——**受限清单**（五份身份文档 + IDENTITY_BASELINE + CURRENT_STATE，知识/技能/workflows 属可进化区不提供逃生口），`assertInside` + `assertInsideReal` 双重越界校验，`gitShowFile` 读历史快照（undefined → NOT_FOUND + remediation），`atomicWriteFile` 写回 → `ensureIdentityBaseline` 刷新基线（写了则 `evolve: 更新 身份基线`）→ `evolve: 回滚 <file> 到 <ref>` 单文件提交。
- **`src/core/git.ts`（P2-2）**：新增 `gitShowFile(workspace, relPath, ref='HEAD')`——`git show <ref>:<path>`，`stripFinalNewline:false` 保留末行换行（回滚写回字节级一致），文件不存在/非仓库返回 undefined。
- **`src/core/knowledge-index.ts`（P2-1）**：`scan` 递归遍历时跳过点目录（`.archive`），归档条目不进 `.index.json`、不参与 recall。
- **`src/core/templates.ts`（P2-1）**：工作区 `.gitignore` 种子增 `knowledge/.archive/`（归档不进员工 git）。
- **`src/cli-program.ts`**：`knowledge` 子命令增 `retention`（手动归档，`--days` 透传保留期）/ `archive-list` / `restore` / `purge`；新增 `registerIdentityCommands` → `agentctl identity rollback <agent-id> <file> [--ref <commit>]`（`--yes` 跳过确认）。
- **`src/core/reflection.ts` / `src/core/proposal-ledger.ts`（P2-3 账本压缩为摘要）**：`truncateReflectionSignals` / `truncateLedger` 超上限（5000 行）时由「纯丢弃最早行」改为「压缩最早批为 1 行统计摘要 + 保留最近 maxLines-1 行原始」——摘要行记 `{event:'summary', proposals, decisions, approved, byProposalId}` / `{date, summary:true, importance, count, span, topics}`，**不带 `user_anchor`**（不会被误读为批准依据）；统计痕迹保留而非纯数据丢失，对账/触发语义不受影响。
- **文档**：`docs/DECISIONS.md` 新增 D-041 M4 ADR；README 更新（D-041 节增知识遗忘归档/身份回滚 bullet + 路线图 M4 已完成）；`.agent/TASK_BOARD.md` / `.agent/FILE_LOCKS.md` 登记 TASK-043 为 DONE/RELEASED。

## 验证

- `npm test`：全量 438 通过（此前 421，新增 17 用例——knowledge-retention 12 + git gitShowFile 2 + self-evolution 3）。
- `npm run build`：通过（tsc + vite，仅既有 chunk-size 警告）。
- `npm run lint`：eslint + prettier 全绿。
- `npx tsc --noEmit`：通过。

## 待确认 / 后续

- 已 commit（AGENTS.md 常驻规则「任务完成即 commit」，已提交 main，不 push）。
- **M5（P3）**：doctor 检查项（identity-baseline/identity-guard/proposal-ledger/memory-flags/knowledge-retention/reflection）+ Web 进化历史页（`git log --grep evolve:` + CURRENT_STATE）+ `knowledge recall` 覆盖 refined/。
- `identity_edits`（`proposal_required|direct`）仍仅声明未生效（P1 预留），后续按需启用。
