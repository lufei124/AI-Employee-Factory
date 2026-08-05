# 当前任务交接

## 身份

Task ID: TASK-028

Task title: CURRENT_STATE.md 自动更新（D-025）——系统侧生命周期事件自动更新 + 员工自维护引导/放行 + 单文件自动 git 提交

Outgoing/current agent: claude-20260803-01

Intended next role/agent: 用户或后续维护者（D-025 已实施并提交；后续增强：任务完成自动写状态、飞书入站等单独立项）

Branch/worktree: main

Status: 已完成（实现 + 双轴 /code-review + 修复后全量验证通过，已提交 main）

更新时间：2026-08-05 17:25 +0800

## 已完成

- **新模块 `src/core/current-state.ts`**：`updateCurrentState`（有标记块只重写目标 key 行、块外保留；无标记块且等于旧种子 → 升级为标记块格式并合并事件行；无标记块且被人工改过 → skip + warn 永不覆盖）、`renderStateBlock`/`renderNewSeed`/`INITIAL_STATE`、`ensureStateEditAllowed`（存量员工幂等补放行）。
- **`src/core/git.ts`** 新增 `gitCommitFile`（`git add -- <relPath>` + commit --allow-empty，绝不用 add -A，防误收员工未提交成果；`requireIdentity:false` 缺身份不阻断）。
- **事件接入（5 处）**：`runtimeAuth`（claude 分支改造 + codex 返回 0；`status` 查询只同步登录状态不写登录事件）、`bridgeAuthorize`（code===0 旁）、`lifecycleAction`（start/stop/restart 成功后，restart 记「重启服务」）、`archiveAgent`、`restoreTrash`/`restoreBackup`/`restoreBackupPath`（恢复后状态行）。全部经私有 `syncCurrentState`（统一入口：内容更新 + 单文件 git 提交，best-effort——更新失败、提交抛错、缺 git 身份返回 false 均 console.warn 不阻断主流程）。
- **模板**：种子 CURRENT_STATE.md 升级为标记块 + 工作进展段；claude 分支 `.claude/settings.json` 加 `allow: ['Edit(agent/CURRENT_STATE.md)', 'Write(agent/CURRENT_STATE.md)']`；两个 ENTRY.md.tmpl 追加「当前状态维护」引导段；`prepareRuntime` 对存量员工幂等补放行（合并保留既有 permissions/theme）。
- **测试**：`tests/current-state.test.ts`（新，9 用例）、`tests/git.test.ts`（+2）、`tests/create-agent.test.ts`（+2）、`tests/runtime.test.ts`（+1）、`tests/application-management.test.ts`（+5 事件集成含 status 区分，GIT_CONFIG_GLOBAL 身份基建）。全量 **335 过**（原 318 + 17）。
- **文档**：`docs/DECISIONS.md` D-025、`docs/ARCHITECTURE.md`（事务与安全段）、`README.md`、`.agent/TASK_BOARD.md`（TASK-028 登记）、`.agent/FILE_LOCKS.md`（锁）。
- **/code-review 双轴（已完结）**：Standards 0 硬违规、4 判断性气味（helper 重复/重名、身份检查重复、StateRow 字符串）→ 已修复（helper 合并为 `syncCurrentState`、git.ts 提取 `checkIdentity`、`StateRow.state` 字面量联合 `STATE_VALUES`）；Spec 2 轻微缺陷（gitCommitFile 缺身份静默、runtimeAuth status 误写登录事件）+ 2 建议（restart 文案）→ 全部修复并补 status 区分测试。

## 验证

| 命令/检查                      | 结果   | 相关输出                        |
| ------------------------------ | ------ | ------------------------------- |
| `npx tsc --noEmit`             | 通过   | 全绿                            |
| `npm test`                     | 335 过 | 43 文件全绿（新增 17 用例）     |
| `tests/current-state.test.ts`  | 9 过   | 标记块行更新/升级/skip/人工保留 |
| `tests/application-management` | 9 过   | 事件后状态文件 + 自动提交 + status 区分断言 |
| `/code-review`                 | 完成   | Standards 0 硬违规 / Spec 缺陷已修复 |

## 安全边界与限制

- **永不覆盖他人成果**：无标记块且被人工改过 → skip + console.warn；有标记块只改目标 key 行；块外全保留。
- **系统写不触发 Web saveDocument 通道**：事件路径走同构直接调用 + git 提交；Web 人工保存仍不自动提交（「Git 未提交」badge 语义保持）。
- **覆盖面仅关键状态**：任务/对话完成不自动写状态（D-025）。
- **codex 侧零配置改动**：workspace-write 已允许编辑状态文件，仅引导段注入。
- 已提交 main（`gitCommitFile` 只 add 状态文件，绝不 add -A）；未 push，按用户常驻规则等待明确要求。
