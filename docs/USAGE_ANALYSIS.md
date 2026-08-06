# 产品功能使用分析报告

> 目的：回答「飞书产品哪些功能被使用、哪些冗余、哪些未被充分利用」。
> **数据现状**：本报告撰写时**尚无真实使用数据**（新增的 `usage.db` 埋点从 2026-08-06 起才开始累积）。因此本报告给出的是**功能面基线 + 待测指标**——真实的使用频次/成本/空转判断，需等 `agentctl usage summary` 累积一段时间后再跑。下方「冗余观察」为基于代码结构的功能面判断，非数据结论。

## 一、功能总览（飞书为员工唯一工作入口）

| 功能                        | 入口                                    | 沉淀/收口                                                 | 代码                                                        |
| --------------------------- | --------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| 执行任务（自由文本）        | 每条飞书消息 → `claude -p`/`codex exec` | claude-shim 拦截（D-035）→ `runBridgeMessage` → settle 链 | `core/claude-shim.ts`、`application/factory-application.ts` |
| 记忆读写                    | 员工写 `knowledge/**/*.md`              | `commitSelfEvolution` 单文件 git 提交                     | `core/knowledge.ts`、`current-state.ts`                     |
| 经验沉淀                    | transcript → `knowledge/lessons/`       | `maybeExtractExperience`（opt-in）                        | `core/experience.ts`                                        |
| 自建 Skill（D-034）         | 员工写 `skills/<name>/SKILL.md`         | `autoAdoptSelfSkills` + `maybeAutoCreateSkill`（opt-in）  | `core/skill-opportunity.ts`、`skill-generator.ts`           |
| 自配置定时任务（D-028）     | 员工写 `automation/jobs/*.yaml`         | `reconcileEmployeeJobs`（managed_by: employee）           | `core/job-reconcile.ts`                                     |
| 自进化身份文档（D-026/029） | 员工改 ROLE/GOALS/OS/POLICIES           | `commitSelfEvolution`                                     | `factory-application.ts`                                    |
| skill-store（远端源）       | `agentctl skill-store` / Web            | 安装复用 `SkillService`                                   | `core/skill-store.ts`                                       |
| 描述生成员工（D-029）       | Web/CLI 一句话 → 生成蓝图               | 本地 Claude 生成                                          | `core/employee-generator.ts`                                |
| 回收站/备份/doctor/prune    | CLI + Web 管理台                        | —                                                         | `core/trash.ts`、`backup.ts`、`doctor.ts`、`prune.ts`       |

## 二、初始冗余观察（功能面判断，待数据验证）

### 1. 仓库级 `skills/` 与员工运行时脱节 —— 疑似冗余

仓库根 `skills/`（bug-fix、feature-development、requirement-review、task-handoff、test-and-verify）是**本项目自身开发用技能**，**未接入员工运行时**（员工运行时发现目录是 workspace 的 `.claude/skills/` / `.codex/skills/`，与此无关）。对最终用户（用飞书让员工干活）**零价值**——它们只服务本仓库的 AI 开发。建议：移入 `.agent/` 或独立 dev 目录，避免与员工技能混淆。

### 2. Web 与 CLI 功能面高度重叠 —— 重复实现

Web 控制台与 `agentctl` CLI **共享同一个 `FactoryApplication`**，几乎每个管理功能（创建/备份/恢复/回收站/doctor/skill 管理）都有 CLI 与 Web 两个入口。D-033 已收敛（删 Web 对话/一次性任务、定时任务只读），但管理面仍是「双入口」。若用户实际只用 CLI（或只用 Web），另一套就是维护负担。**待数据判断**：`usage.db` 无法直接测 Web/CLI 用量（它只埋飞书消息），需 Web 访问日志或人工确认。

### 3. 自进化链每次消息后全量跑 —— 空转风险

`settleActive`（经验提取 → skill adopt/生成 → 自进化提交 → job reconcile）在**每条飞书消息后**都会执行，且 `_service settle` 每 300s 又跑一次。其中 `maybeAutoCreateSkill`（自动生成 skill）和 `maybeExtractExperience` 是 **opt-in**（默认关），但 `autoAdoptSelfSkills`、`commitSelfEvolution`、`reconcileEmployeeJobs` **默认每次跑**。若员工很少改文档/写 skill/配任务，这些扫描是**纯空转**（每次 spawn 校验 + git 单文件查询）。**待数据判断**：检查 usage.db 里有多少消息实际产生了 skill/经验/文档变更（未来可给 settle 事件建表）。

### 4. Skill 三套并存 —— 可能重复

① 仓库 dev skills（见观察 1）② skill-store 默认源（superpowers、anthropic-skills）③ 员工自建 skill。②③ 有各自用途，但默认两个远端源 + 自建，若员工不用，skill-store 与其缓存目录就是闲置资产。

## 三、新 DB（`usage.db`）如何驱动后续优化

`agentctl usage query/summary` 累积后，可回答的产品问题：

- **活跃度**：每条消息按天/员工分布 → 哪些员工在真用、哪些闲置（可归档/回收）。
- **成本**：`total_cost_usd` 按天/员工聚合 → 哪些员工花钱最多、单消息成本是否异常（模型是否该降档）。
- **数量**：`prompt_chars`、`duration_ms` → 用户消息是否过短/过长（产品要不要引导）。
- **失败率**：`exit_code` 非 0 占比 → 飞书链路稳定性。
- **技能/经验利用**（待扩展）：目前只存 transcript 的 `topics`。要判断「自建 skill 是否被用上」，需给 settle 事件建表（记录 skill 创建/adopt/经验提取是否发生），属后续增强。

## 四、建议的下一步（数据驱动精简候选）

1. 等 `usage.db` 累积 1–2 周，跑 `agentctl usage summary` + `usage query`，据此判断：闲置员工回收、高成本模型降档、失败高峰时段。
2. 评估是否移除/归档仓库级 `skills/`（观察 1）——纯功能面判断，无需等数据。
3. 评估 settle 空转（观察 3）：若 `autoAdoptSelfSkills`/`reconcile` 长期零变更，可改为「仅在有变更信号时触发」。
