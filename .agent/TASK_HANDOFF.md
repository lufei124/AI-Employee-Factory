# 当前任务交接

## 身份

Task ID: TASK-045

Task title: 分层自进化协议 M5 增强——进化历史「点开看」（提交 → 变更文件 → 文件全文）

Outgoing/current agent: claude-20260807-01

Intended next role/agent: 用户或后续维护者（TASK-045 已实施并 commit；D-041 五阶段 M1-M5 全部完成，本次为其「点开看」增强）

Branch/worktree: main

Status: 进化历史点开看已实现，全量测试/构建/lint/tsc/e2e 通过，已 commit（未 push）

更新时间：2026-08-07 11:15 +0800

## 已完成

- **`src/core/git.ts`**：新增 `gitShowCommitFiles(workspace, ref)`——`git show --name-status --format= <ref>` 解析为 `{status, path}` 数组（状态 A/M/D/R，重命名行 `R100 old new` 取新路径），ref 无效/非仓库 → 空数组不抛错；`gitLog` 增 `ref` 选项（`git log <ref> -n1`）。
- **`src/application/factory-application.ts`**：新增 `evolutionCommitFiles(id, ref)`（某提交变更文件清单）与 `evolutionFileContent(id, ref, relPath)`（`git show <ref>:<path>` 读文件全文，`stripFinalNewline:false` 保字节）。内容端点**双向路径防护**：`path.resolve` 归一化 + 前缀判定（禁绝对路径/`..` 逃逸）+ 禁 `.git` 内部路径；文件在该提交不存在 → `NOT_FOUND`。
- **`src/web/server.ts`**：新增两个只读 GET 端点 `GET /api/v1/agents/:id/evolution/files?ref=` 与 `GET /api/v1/agents/:id/evolution/content?ref=&path=`（缺参 → VALIDATION_ERROR 400，复用 agent-detail 认证）。
- **`web/src/api.ts` + `web/src/pages/AgentDetailPage.tsx`**：api 增 `evolutionCommitFiles`/`evolutionFileContent`；`EvolutionTab` 增钻取——点提交 → 高亮并加载该提交变更文件清单（新增/修改/删除/重命名徽章 + 路径）；点文件 → 该提交下文件全文只读展示（`pre` 等宽 + 滚动），带错误/加载态；无选中提交时仍显示 CURRENT_STATE。
- **测试**：git（gitShowCommitFiles 列变更文件 + 无效 ref 空数组）、web-management-api（files/content 端点 + 缺 ref 400 + `..` 与 `.git` 穿越拒绝 + 无文件 404）。
- **e2e 修复（M3 骨架化后过期断言，此前未跑所以未暴露）**：Skills 预置 skill 改 `ai-employee-factory`、身份文档只读预览断言（`getByRole('heading', {name:'岗位定位'})`）、feedback skill 路径改 `ai-employee-factory/SKILL.md`；新增进化历史点开看全链路（`bridge settle` 造 evolve 提交 → 点提交 → 点文件 → 看 `pre` 全文）。
- **文档**：`docs/DECISIONS.md` 新增 M5 增强 ADR；README 进化历史 bullet 补「点开看」；`.agent/TASK_BOARD.md` / `.agent/FILE_LOCKS.md` 登记 TASK-045 为 DONE/RELEASED；`.agent/task-ids/TASK-045/` 占位。

## 验证

- `npm test`：全量 444 通过（此前 442，新增 2 用例——git gitShowCommitFiles 1 + web files/content 端点 1）。
- `npm run build`：通过（tsc + vite，仅既有 chunk-size 警告）。
- `npm run lint`：eslint + prettier 全绿。
- `npx tsc --noEmit`：通过。
- `npx playwright test`：e2e 通过（含新增点开看断言 + 三条过期断言修复）。

## 待确认 / 后续

- 已 commit（AGENTS.md 常驻规则「任务完成即 commit」，已提交 main，不 push）。
- **D-041 五阶段 M1-M5 全部完成**：P0 身份守卫 → P1 三开关+两级经验 → M3 提案对账 + Web 只读化 + 创建骨架 → M4 遗忘归档 + 身份回滚 + 账本上限 → M5 doctor 监控 + Web 进化历史 + 检索增强；本次 M5 增强补上「点提交看内容」的钻取闭环。
- 老员工兼容：所有回填（宿主平台 skill / 系统提示 / 身份基线 / 三开关 / 自进化协议文案）均经 `settleActive` 幂等链在每条飞书消息 / runJob / 周期 settle 自动补齐，无需人工操作。
- `identity_edits`（`proposal_required|direct`）仍仅声明未生效（P1 预留），后续按需启用。
