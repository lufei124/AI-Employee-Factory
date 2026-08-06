# 当前任务交接

## 身份

Task ID: TASK-040

Task title: 分层自进化协议 P0（身份守卫，D-041）——identity-guard + identity-baseline + proposals 目录约定 + 系统提示文案

Outgoing/current agent: claude-20260806-01

Intended next role/agent: 用户或后续维护者（TASK-040 已实施并 commit；后续阶段 M2-M5：三开关默认开 + 经验两级化、提案账本 + Web 只读 + 创建骨架化、遗忘归档 + identity rollback CLI、doctor 检查项 + Web 进化历史 + 检索增强）

Branch/worktree: main

Status: 分层自进化协议 P0 已实现，全量测试/构建/lint 通过，已 commit（未 push）

更新时间：2026-08-06 15:55 +0800

## 已完成

- **`src/core/identity-guard.ts`（新，D-041 P0-1）**：声明式 `GUARDED_SECTION_MARKERS`（ROLE.md 岗位定位/长期职责标题 + POLICIES.md 五个红线词）、`validateIdentityGuard(relPath, content)` → `{ok, issues}`、`stripGuardSections`（提案剥离用）。纯函数零 I/O。
- **`src/application/factory-application.ts`**：`commitSelfEvolution` 对 `agent.identity.role_file`/`policies_file` 提交前过 identity-guard——锚点缺失 → `console.warn('[identity-guard] 拒绝提交 …')` 留现场 + 跳过该文件提交（保留脏文件），不阻断其他文件；relPaths 增补 `agent/proposals`。`settleActive` 加 `ensureIdentityBaseline` 回填（写盘即 `evolve: 更新 身份基线` 单文件提交）。
- **`src/core/identity-baseline.ts`（新，D-041 P0-3）**：`ensureIdentityBaseline`（幂等，忽略 generated_at，仅描述/文档内容变化才重写）、`baselineDrift`（按文件 added/removed/changed）、`allowedIdentityDiff`（改动占比<30% + 锚点仍在 → 可进化）、`parseIdentityBaseline`/`snapshotDoc`/`diffDoc`/`renderIdentityBaseline`。基线文件 `agent/IDENTITY_BASELINE.md`。
- **`src/core/templates.ts`**：`renderAgentWorkspace` 播种基线 + `agent/proposals/README.md`（frontmatter/正文/协议约定）；`ensureRuntimePrompt` 回填条件扩为「缺宿主平台 **或** 缺 `## 分层自进化协议` 标记」（D-041 P0-2，D-039 之后创建但仍是旧自我进化文案的员工也重渲）。
- **系统提示文案**：`templates/claude-agent/ENTRY.md.tmpl` + `codex-agent/ENTRY.md.tmpl`「自我进化」→「分层自进化协议」（宪法/岗位定位只提案不直改、可进化区红线词不可删/显著改动先提案、提案审批四步、永不改 agent.yaml/settings.json）；`templates/factory-skill/SKILL.md` 补「六、自进化协议」小节。
- **测试**：`tests/identity-guard.test.ts`（新 11 用例）、`tests/identity-baseline.test.ts`（新 12 用例）、`tests/self-evolution.test.ts`（增 5 用例：删红线词拒提交留现场、删岗位定位标题拒提交、合法强化仍提交、proposals 提交、基线回填幂等）、`tests/bridge-settle.test.ts`（增 D-041 回填用例）。
- **文档**：`docs/DECISIONS.md` 新增 **D-041** ADR；`README.md` 增「分层自进化协议」小节 + Roadmap 更新；`.agent/TASK_BOARD.md` / `.agent/FILE_LOCKS.md` 登记 TASK-040。

## 验证

- `npm test`：全量 372 通过（此前 332，新增 40 用例，串行 `--no-file-parallelism` 全绿）。
- `npm run build`：通过。
- `npm run lint`：eslint + prettier 全绿（唯一 warn 为 gitignored `.claude/settings.local.json`，非本次改动）。

## 待确认 / 后续

- 已 commit（用户批准的 D-041 方案 + AGENTS.md 常驻规则「任务完成即 commit」，已提交 main，不 push）。
- **M2（P1 开关 + 两级经验）**：schema 新字段 + `ensureMemoryFlags` + `reflection.ts`/`experience-refiner.ts`（三开关默认开、原始记录始终落盘 + 重要性累积触发提炼）。
- **M3（P1 对账 + Web 只读 + 创建骨架）**：`proposal-ledger.ts` 账本 + Web 文档/Skills 只读化 + 骨架模板创建。
- **M4（P2）**：`knowledge-retention.ts` 遗忘归档 + `identity rollback` CLI。
- **M5（P3）**：doctor 6 检查项 + Web 进化历史页 + recall 增强。
