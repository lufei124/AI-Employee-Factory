# 当前任务交接

## 身份

Task ID: TASK-029

Task title: 派发进度反馈（A+C）+ 员工自我进化（岗位/目标/工作系统/规则 + knowledge 自动提交）

Outgoing/current agent: claude-20260803-01

Intended next role/agent: 用户或后续维护者（TASK-029 已实施并提交；后续增强：任务完成自动写状态、飞书入站等单独立项）

Branch/worktree: main

Status: 已完成 Phase 1 + Phase 2 + /code-review 双轴（修复后全量验证通过，已提交 main）

更新时间：2026-08-05 18:00 +0800

## 已完成

- **Phase 1（commit df9a7a6）派发进度反馈 A+C**：
  - `OperationDto`/`OperationEvent` 加 `summary?: string`；execute 的 emit 包装同步 `dto.summary`。
  - `dispatchItem` 加第 8 参 `emit?: DispatchEmit`，6 阶段 progress 事件（`[t1]「任务一」规划中…/规划完成/规划失败/执行中…/执行完成/执行失败（exit=N）`）；抽 `progressOf`/`summaryOf` 纯函数（`N/M 完成 · 执行中 ids · 等待中 n`）。
  - `dispatchPlan` 波形两处 emit 带 summary，wave.map 传 emit。
  - `orchestrate()` 加 `onProgress?: (summary) => void`（订阅 Operation 事件）；CLI `plan run`/`chief run` 打印 `\r` 进度行。
  - Web：api.ts OperationDto + OperationsDrawer 列表/详情展示 summary + styles.css。
  - tests/orchestration.test.ts +3（progress 事件序列 / 终态 summary / 多 item 中间态 summary）。

- **Phase 2（未提交）员工自我进化**：
  - 两个 ENTRY.md.tmpl 追加「自我进化」节（只在 developing 更新、规划阶段绝不动文件、保持结构、记录工作进展、不手动 git 提交；claude 侧附「不可改 settings.json 扩大权限」）。
  - `current-state.ts`：`ensureStateEditAllowed` 重构为 `ensureAgentDocsAllowed(workspace, relPaths)` 的薄封装（参数化 Edit/Write 幂等合并，非法 JSON 返回不覆盖）。
  - `factory-application.ts`：`prepareRuntime` 调用 `ensureAgentDocsAllowed(workspace, [四文档路径])`；新增 `commitAgentFile`（best-effort 单文件提交）+ `commitSelfEvolution`（遍历四文档 gitStatusShort 有变更则 `evolve: 更新 <basename>`）；挂载 runAgent/runChat/runJob 三处 `.then()`；`knowledgeWrite` 内原子写+ingest 后提交 `evolve: 更新知识`。
  - tests/self-evolution.test.ts（新，4 用例）：runAgent 后 ROLE.md 单文件提交（mock ProcessRunner.runLogged 走真实后处理链）/ 规划门不豁免 agent/*.md / ensureAgentDocsAllowed 幂等 / knowledgeWrite 提交。GIT_CONFIG_GLOBAL + .cc-switch.env 0600 预置凭据基建。

- **文档**：docs/DECISIONS.md D-026、docs/ARCHITECTURE.md（D-026 段）、README.md（自我进化 + 进度行）、.agent/TASK_BOARD.md（TASK-029 登记）、.agent/FILE_LOCKS.md（TASK-028 释放 + TASK-029 锁）。

- **/code-review 双轴（已完结）**：Standards 0 硬违规、3 判断性气味（progressOf/summaryOf 重复终态判定、四文档数组重复、CLI 直取 operationManager 而非 orchestrate seam）→ 已修复重复判定（抽 `isDone`）；CLI seam 系计划明确指定、保留。Spec 2 轻微缺陷 → 已修复：① 只读探针（planning/review/decompose）加 `skipSelfEvolution:true`，规划门违规改动不再被 commitSelfEvolution 当作合法 `evolve:` 提交（+回归测试）；② knowledgeWrite 加 gitStatusShort 变更守卫，内容相同不再产生空 `evolve:` 提交。

## 验证

| 命令/检查                                     | 结果   | 相关输出                                                       |
| --------------------------------------------- | ------ | -------------------------------------------------------------- |
| `npx tsc --noEmit`                            | 通过   | 全绿                                                           |
| `npm run lint`（eslint+prettier）             | 通过   | 全绿                                                           |
| `npm test`                                    | 343 过 | 44 文件全绿（+5 self-evolution +3 orchestration）              |
| `npx vitest run tests/self-evolution.test.ts` | 5 过   | 提交/skipSelfEvolution 不提交/规划门不豁免/幂等/knowledge 提交 |
| `/code-review`                                | 完成   | Standards 0 硬违规 / Spec 缺陷已修复                           |

## 安全边界与限制

- **单文件 git 提交**：`commitAgentFile`/`commitSelfEvolution`/`knowledgeWrite` 均只 `git add -- <relPath>`，绝不用 `add -A`。
- **best-effort**：缺 git 身份或提交抛错仅 console.warn，不阻断 runAgent/runChat/runJob 主流程。
- **规划门不豁免 agent/\*.md**：规划阶段改 `agent/*.md` 与改任意文件一样判违规→任务失败（用户拍板）。
- **员工不可扩大自身权限**：claude 侧引导明确「不可改 `.claude/settings.json`」。
- **config_hash 只含 runtime 块**：员工改 `agent/*.md` 不触发漂移。
- **只读探针不提交自我进化**：仅 real runAgent/runChat/runJob 触发 commitSelfEvolution；planning/review/decompose 探针（skipSelfEvolution:true）不提交，规划门违规改动保持 dirty 暴露。
- 已提交 Phase 1（df9a7a6）、Phase 2（57c1fe4）、review 修复（待提交）；未 push，按用户常驻规则等待明确要求。
