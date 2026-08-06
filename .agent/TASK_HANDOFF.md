# 当前任务交接

## 身份

Task ID: TASK-041

Task title: 分层自进化协议 P1（D-041 M2）——三开关默认开 + 两级经验（原始始终落盘 + 重要性触发提炼）+ schema 新字段

Outgoing/current agent: claude-20260806-01

Intended next role/agent: 用户或后续维护者（TASK-041 已实施并 commit；后续阶段 M3-M5：提案账本 + Web 只读 + 创建骨架化、遗忘归档 + identity rollback CLI、doctor 检查项 + Web 进化历史 + 检索增强）

Branch/worktree: main

Status: 分层自进化协议 P1 已实现，全量测试/构建/lint 通过，已 commit（未 push）

更新时间：2026-08-06 20:26 +0800

## 已完成

- **`src/schemas/agent-schema.ts`（D-041 P1-1/P1-4）**：`DEFAULT_MEMORY_FLAGS`（三开关默认 true）+ `resolveMemoryFlags(memory)`（undefined→默认，显式 false 保留；返回具体对象类型以兼容 `exactOptionalPropertyTypes`）；`portableMemorySchema` 新增 `reflection_enabled`（bool）/`identity_protocol`（advisory|enforced）/`identity_edits`（proposal_required|direct），全 optional 向后兼容。
- **`src/core/create-agent.ts`（P1-1）**：`buildAgentConfig` memory 块显式写三开关 `true`（新建即默认开，agent.yaml 自文档化）。
- **`src/core/experience.ts`（P1-2 一级）**：`renderRawExperience`（frontmatter + 主题/决策/经验/尾行 + `source_agent`/`source_transcript` 出处）+ `rawExperienceRelPath` → `lessons/raw/<date>-<slug>.md`。
- **`src/core/reflection.ts`（新，P1-2 二级触发层）**：`estimateImportance`（轻量启发式，基准 1 + 决策≤2 + 经验≤2 + 多主题 +1，封顶 5）、`appendReflectionSignal`（`knowledge/.reflection-signals.jsonl` 0600 追加）、`readReflectionSignals`、`accumulatedImportance`、`shouldReflect`（累积 ≥ 阈值 3 或 idle > 24h 保底；**从未提炼以最早信号为参照，避免首条消息即提炼**）、`truncateReflectionSignals`（上限 5000 行防无限累积）。
- **`src/core/experience-refiner.ts`（新，P1-2 二级提炼器）**：`refineExperience`（本地 claude CLI → 结构化 JSON → Zod，产出 `{insight, evidence[], writeup}`，evidence 引用 raw/ 具体文件/行）、`renderRefineBrief`/`renderRefinedExperience`（`because of:` 证据引用）/`refinedExperienceRelPath`/`readLastRefinedAt`。
- **`src/application/factory-application.ts`（接入）**：`maybeRecordRawExperience`（一级始终写，`flag:'wx'` 防重）；`maybeRefineExperience`（门控 experience_extraction/reflection_enabled + claude 运行时，信号累积达标提炼 → refined 写盘 + evolve 提交 + 信号重置）；`ensureMemoryFlags`（存量幂等回填 undefined→true，显式 false 尊重）；`settleActive` 链序升级为 12 步（raw→refine→factorySkill→runtimePrompt→identityBaseline→memoryFlags→adopt→autoCreateSkill→commit→reconcile）；`runBridgeMessage`/`runJob`/`maybeAutoCreateSkill` 的开关判定统一经 `resolveMemoryFlags`；`commitSelfEvolution` relPaths 增补 `agent.yaml`。
- **测试**：`tests/reflection.test.ts`（新 8 用例）、`tests/experience-refiner.test.ts`（新 8 用例，含 FactoryApplication 提炼链集成）、`tests/memory-enforcement.test.ts`（增 2 用例：存量回填 true + evolve 提交、显式 false 尊重 + 幂等）、`tests/schemas.test.ts`（增 2 用例：P1-4 optional + resolveMemoryFlags）、`tests/create-agent.test.ts`（增三开关显式 true 断言）、`tests/experience.test.ts`（改写两级化语义：raw 始终写、extraction=false 时 refined 不写）。
- **文档**：`docs/DECISIONS.md` 新增 D-041 P1 ADR；`.agent/TASK_BOARD.md` / `.agent/FILE_LOCKS.md` 登记 TASK-041 为 DONE（TASK-040 一并补 RELEASED）。

## 验证

- `npm test`：全量 394 通过（此前 372，新增 22 用例）。
- `npm run build`：通过（tsc + vite，仅既有 chunk-size 警告）。
- `npm run lint`：eslint + prettier 全绿（唯一 warn 为 gitignored `.claude/settings.local.json`，非本次改动）。

## 待确认 / 后续

- 已 commit（AGENTS.md 常驻规则「任务完成即 commit」，已提交 main，不 push）。
- **M3（P1 对账 + Web 只读 + 创建骨架）**：`proposal-ledger.ts` 账本（appliedWithoutAnchor 校验 + maybeEnforceIdentityProtocol）+ Web 文档/Skills 只读化 + 骨架模板创建（`generateEmployeeSkeleton`）。
- **M4（P2）**：`knowledge-retention.ts` 遗忘归档 + `identity rollback` CLI。
- **M5（P3）**：doctor 检查项（identity-baseline/identity-guard/proposal-ledger/memory-flags/knowledge-retention/reflection）+ Web 进化历史页 + `knowledge recall` 覆盖 refined/。
