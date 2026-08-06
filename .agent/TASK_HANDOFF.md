# 当前任务交接

## 身份

Task ID: TASK-034

Task title: AI 员工自建 Skill（D-034）——完整闭环：触发 + 生成 + 校验 + 投影 + 回滚

Outgoing/current agent: claude-20260806-01

Intended next role/agent: 用户或后续维护者（TASK-034 已实施，待验证 commit；后续增强：skill-opportunity 自动检测的跨会话调优、Web「AI 生成 Skill」按钮等可立项）

Branch/worktree: main

Status: 员工自建 Skill 完整闭环已实现并全量测试通过，待 commit（未 push）

更新时间：2026-08-06 12:55 +0800

## 已完成

- **`src/core/employee-generator.ts`**：`extractJson` 从私有改为 `export`（供 skill-generator 复用）。

- **`src/core/skills.ts`**（核心）：
  - 新增导出 `parseSkillFrontmatter(text)`（重构 install/fallback 内联重复的 frontmatter 解析；name 遵 agentIdSchema，非法抛 VALIDATION_ERROR）。
  - 新增 `upsert(source, scope)`——同名版本化替换（不抛 CONFLICT）：target 不存在等同 install；digest 相同幂等 no-op；不同则旧版备份 `skills/.archive/<name>-<ver>-<ts>/` + stage 复制 + rename 覆盖 + 重投影；失败从 archive 回滚。
  - 新增 `adopt(name, scope)`——给已写盘 manual skill 补写 `.agentctl.yaml`(source:'self') + 投影软链，零 LLM；frontmatter name 与目录名不一致抛 VALIDATION_ERROR。
  - 新增 `rollback(name, scope, archiveRef?)`——从 `.archive` 恢复历史版本。
  - `project()` 幂等化（软链已存在且指向正确则跳过）；新增 `.archive` 备份/恢复/prune（保留最近 5 版）/readStoreMetadata/nextVersion 辅助。

- **`src/core/skill-generator.ts`（新）**：`generatedSkillSchema`（name/version/short_description/description/instructions/triggers）、`generateSkill(brief, opts)`（复用 employee-generator 的 `claude -p --output-format json` + `parseStructuredResult` + `extractJson` + Zod 范式，安全 prompt 锁定 workspace 沙箱）、`renderSkillFile(gen)` 渲染 SKILL.md。

- **`src/core/skill-opportunity.ts`（新）**：`pickCandidateTopic`（从含重复信号词的 lessons 相关 topic 提取候选）、`detectRepeatedSkillOpportunity`（阈值 ≥2 + 排除既有 skill）、`readSkillSignals`/`appendSkillSignal`（`knowledge/.skill-signals.jsonl`，0600，窗口过滤）。

- **`src/schemas/agent-schema.ts`**：`portableMemorySchema` 增 `skill_self_creation: z.boolean().optional()`（对齐 experience_extraction，仅当 transcript_persist=true 生效）。

- **`src/application/factory-application.ts`**：
  - `runJob` `.then` 链在 `commitSelfEvolution` **之前**插入 `autoAdoptSelfSkills` + `maybeAutoCreateSkill`（使新 `.agentctl.yaml`/SKILL.md 被 evolve: 提交）。
  - `autoAdoptSelfSkills`（纯修复、始终开启）：扫描 `skills/*/`，含 SKILL.md 但无元数据 → adopt；digest 变化 → upsert。best-effort。
  - `maybeAutoCreateSkill`（opt-in）：`skill_self_creation && transcript_persist && provider=claude` 时读 transcript → 更新信号 → 命中阈值 → `generateSkill` → 渲染 staging → `upsert` → 清理。best-effort。
  - 公开方法 `createSkillForAgent`/`adoptSkill`/`rollbackSkill`。
  - `prepareRuntime` 为 `skills/**` 幂等补 Edit/Write 放行。

- **`src/cli-program.ts`**：`skill` 组新增 `create-self <id> <brief>`（`--model/--scope/--dry-run`）、`adopt <id> <name>`、`rollback <id> <name>`（`--archive-ref/--yes`）。

- **测试**：`tests/skills.test.ts` 增 upsert 新装/版本化替换/幂等 no-op + adopt 补元数据/目录名不一致/缺 SKILL.md + rollback 恢复（7 用例）；`tests/skill-generator.test.ts`（新，8 用例）；`tests/skill-opportunity.test.ts`（新，6 用例）；`tests/self-evolution.test.ts` 增端到端 adopt（写盘→补元数据+投影+evolve 提交）+ 自动生成（skill_self_creation 命中阈值→mock generateSkill→注册+投影+提交）。

- **文档**：`docs/DECISIONS.md` 新增 **D-034** ADR；`.agent/TASK_BOARD.md` / `.agent/FILE_LOCKS.md` 登记并标记 TASK-034。

## 验证

- `npm test`：全量 324 通过（串行 `--no-file-parallelism` 全绿；并行偶发 `application.test.ts` dashboard `running` 的既有 launchd 竞争 flaky，与本次改动无关，单独跑全绿）。
- `npm run build`：通过。
- `npm run lint`：eslint + prettier 全绿。
- CLI 冒烟：`node dist/cli.js skill --help` 显示 create-self/adopt/rollback。

## 待确认 / 后续

- 未 commit（用户批准的方案 + AGENTS.md 常驻规则「任务完成即 commit」，等待授权后提交 main，不 push）。
- skill-opportunity 的跨会话重复阈值（默认 2 / 窗口 7 天）为初值，可按使用反馈调优。
- Web `POST /api/v1/agents/:id/skills/generate` + `:name/adopt` 端点首期未做（计划标为可后置），仅 CLI。