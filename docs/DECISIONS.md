# Decisions

## D-042：.md 记忆检索增强——BM25 召回引擎升级 + 运行时 RAG 注入

- 状态：Accepted（已实施，TASK-046）
- 日期：2026-08-07
- 背景：用户问「现在对话都存在 db 是干嘛的，记忆检索应该对 .md」。查证：对话**不存 db**——`~/.ai-employees/logs/usage.db` 只是**用量/成本分析库**（每飞书消息的 duration/tokens/cost/exit_code/脱敏 prompt/`transcript_file` 指针），完整对话在 `logs/<agent>/runs/<slug>/stdout.log`（JSONL）+ `transcript.jsonl`，正式记忆在 `<workspace>/knowledge/**/*.md`。用户直觉成立：**记忆检索本就该对 .md**，usage.db 维持现状。真正的问题是 .md 侧两个短板：召回引擎弱（正文不进索引、仅精确 token 匹配、无模糊/中文混合、评分朴素、索引只在缺失时重建）+ 召回结果从不注入运行时（模型每次干活自己翻 `knowledge/`，系统不把「与当前任务相关的记忆」递到嘴边）。用户确认两个都修。
- 决定：
  - **A1 正文入索引**：`parseDocument` 不再丢弃正文——索引每条目内部形态 `IndexableEntry`（公开 `KnowledgeEntry` 不变）带 `len`（文档总 token 数）与 `fieldTokens{title/keywords/summary/body}`；正文 token 上限 ~2000/文档控 `.index.json` 体积。
  - **A2 InvertedIndex v2**：`{[token]: TermPosting[]}`（记录各字段 tf）+ 每条目写 `len`；`version` 升 2，`readIndex` 检到 v1 文件一次性重建。`buildInverted` 改为**确定性**（token 排序 + posting 按 relPath 排序），保证 `verifyConsistency` 的 `JSON.stringify` 对比稳定。
  - **A3 BM25 评分**（K1=1.5、B=0.75）：`idf_t = ln(1+(N-df_t+0.5)/(df_t+0.5))`，`score_d += w·idf_t·(tf·(k1+1))/(tf+k1·(1-b+b·dl/avgdl))`；字段权重 title=2.0 / keywords=1.8 / summary=1.3 / body=1.0；top-K=8 + 相关度下限 0.15×topScore。不加 layer 权重（与 README「正式业务知识 > 已确认决策」事实优先级一致）。
  - **A4 中文整词 + 大词恒开**：删掉「仅零命中才走中文大词」的 all-or-nothing 分支——对每个汉字串 `len≥4` 整词 + 字符大词**同时**进查询 token 集，两者都进 BM25（正文中文同样大词入索引）。`chineseKeywords` 导出供测试。
  - **A5 模糊/子串回退**：对零精确命中的查询 token 遍历词表（上限 10000），编辑距离 ≤1（≤7 字符）/ ≤2（≥8 字符）+ 长 token 前缀/子串；命中贡献 `0.6×idf`，精确命中占优。纯汉字 token 除外（噪音）。
  - **A6 片段 snippet**：`KnowledgeRecallHit` 增 `snippet?: string`；`recallDetail` 一次磁盘读合并 refined 的 `because of:` 证据行 + 首个正文命中点前后 ~200 字符窗口（剥 markdown）。
  - **A7 索引新鲜度**：`readIndex` 在 `.index.json` mtime 早于 `knowledge/**/*.md` 最新 mtime 时重建——节流到每 10s 一次 stat-tree（模块级时间戳），避免桥接热路径每消息全扫；覆盖「模型用自身工具直写 knowledge/ 后未触发 `knowledgeWrite` 重取」的陈旧窗口。
  - **B1-B3 运行时 RAG 注入**：新增 `src/core/retrieval-brief.ts` 渲染无 frontmatter 便签（`<!-- factory:retrieved -->…<!-- factory:retrieved-end -->` 包裹，列 top-K 命中 `[[title]](relPath) [score]` + summary + snippet + evidence）。`FactoryApplication.recallForTask(id, taskText)` 在 `knowledge/.retrieved.md` 原子写便签（仅 hits>0 时写，避免陈旧缓存；故意**不用** `knowledgeWrite`，那会重取 + commit；best-effort 异常 warn-and-skip）。注入点均在建 ctx 前：`runBridgeMessage`（query=飞书消息 stdin）、`runJob`（`execution.type==='agent'` 时读 prompt 文件作 query）；`chat` 跳过（交互态，模型本就读 knowledge/）。
  - **B4 模板与幂等**：gitignore 追加 `knowledge/.retrieved.md`；两个 `ENTRY.md.tmpl` 加「任务开始前先读 `knowledge/.retrieved.md`（系统按当前任务召回的相关记忆；不存在则跳过，以 `knowledge/` 正式文件为准；该文件系统自动生成、勿编辑/勿当正式知识）」；`ensureRuntimePrompt` 幂等标记检查扩展为「含 `knowledge/.retrieved.md` 阅读行」——否则每次 settle 重写 CLAUDE.md 刷 `evolve:` 提交。
  - **B5 三重隔离**：dot 前缀 + 无 frontmatter + `scan()` 文件名显式跳过 → 永不进 `.index.json`、永不被召回；gitignore 行 → `gitStatusShort`（无 `--ignored`）不列出 → `commitSelfEvolution` 永不 commit；`archiveStaleKnowledge` 只扫 `lessons/{raw,refined}` 不碰。每次运行覆盖写 = 最后一次任务的缓存，可审计。
- 边界：usage.db 维持现状（用量分析，非对话存储，Web「使用统计」+ `agentctl usage query` 依赖它）；`.retrieved.md` 不是正式知识、不参与索引/召回/提交/归档；注入仅新增读取提示（模型开场可读便签），不改提示词主体、不改正式知识文件。
- 原因：正文不进索引是召回弱的最大根因（关键词只在标题/摘要/关键词命中）；BM25 相对朴素命中数评分大幅提升排序质量且无外部依赖；中文大词恒开避免「整词不中则全不中」的全或无断层；运行时注入把「检索」与「使用」接起来，模型开场即拿到与当前任务相关的记忆，比每次自己翻 `knowledge/` 更准、更省 token。
- 影响：`knowledge.ts`（`KnowledgeRecallHit.snippet?`）、`knowledge-index.ts`（全量重写：正文索引 + InvertedIndex v2 + BM25 + 中文混合 + 模糊 + snippet + mtime 重取 + scan 跳过便签）、`retrieval-brief.ts`（新建）、`factory-application.ts`（recallForTask + 注入 runBridgeMessage/runJob）、`templates.ts`（gitignore + ensureRuntimePrompt 幂等标记）、两个 `ENTRY.md.tmpl`（RAG 阅读行）、`cli-program.ts`（recall 打印 snippet）；增测 knowledge（正文召回/中文混合/模糊错拼/snippet/便签忽略）、self-evolution（recallForTask 写便签 + git 排除 + 未入索引 + 未归档）；全量 450 测试 + build/lint/tsc/e2e 全绿。

---

## D-041：分层自进化协议 M5 增强——进化历史「点开看」（提交 → 变更文件 → 文件全文）

- 状态：Accepted（已实施，TASK-045）
- 日期：2026-08-07
- 背景：D-041 M5（TASK-044）已交付 Web「进化历史」只读 tab（evolve 提交流 + CURRENT_STATE + 使用统计），但提交只是「列表」，无法点进去看某次进化到底改了什么文件、改了哪些内容——「一切写入 git 版本化、可回溯」的承诺对人工仍是一层黑盒。本批补上钻取能力，且全程保持只读。
- 决定：
  - **`git.ts` 增 `gitShowCommitFiles(workspace, ref)`**：`git show --name-status --format= <ref>` 解析为 `{status, path}` 数组（状态 A/M/D/R，重命名行取新路径），ref 无效/非仓库 → 空数组不抛错；`gitLog` 增 `ref` 选项（`git log <ref> -n1`）以便按需定位单提交。
  - **`FactoryApplication.evolutionCommitFiles(id, ref)` / `evolutionFileContent(id, ref, relPath)`**：前者返回某提交变更文件清单；后者 `git show <ref>:<path>` 读文件全文（`stripFinalNewline:false` 保字节）。内容端点做**双向防护**：`path.resolve` 归一化 + 前缀判定的工作区内检查（禁绝对路径/`..` 逃逸），并禁止 `.git` 内部路径；文件在该提交不存在 → `NOT_FOUND` 404。
  - **`web/server.ts` 增两个只读 GET 端点**：`/api/v1/agents/:id/evolution/files?ref=` 与 `/api/v1/agents/:id/evolution/content?ref=&path=`（复用 agent-detail 认证，缺参 → VALIDATION_ERROR 400）。
  - **前端 `EvolutionTab` 钻取**：点提交 → 高亮并加载该提交变更文件清单（状态徽章 新增/修改/删除/重命名 + 路径）；点文件 → 该提交下文件全文只读展示（`pre` 等宽 + 滚动），带错误/加载态；返回 CURRENT_STATE 视图不丢失。
- 边界：仍是**只读**——两个新端点只做 git 历史读取，无任何写入/编辑/回滚入口；路径越界与 git 内部路径一律拒绝（400/404）；重命名文件只展示新路径下的内容（该提交存在）。
- 原因：人工审计自进化行为时需要知道「这次进化改了什么」而不只是「发生了什么」；git 本就是唯一事实源，直接 `git show` 零成本且天然不可变，比另建 diff 存储更简单可靠。
- 影响：`git.ts`（gitShowCommitFiles + gitLog ref）、`factory-application.ts`（evolutionCommitFiles / evolutionFileContent）、`web/server.ts`（files/content 端点）、`web/api.ts` + `web/src/pages/AgentDetailPage.tsx`（EvolutionTab 钻取）；增测 git（gitShowCommitFiles）、web-management-api（files/content 端点 + 路径穿越拒绝 + 404）；顺手修复 M3 骨架化后 e2e 三条过期断言（Skills 预置 skill / 身份文档只读预览 / feedback skill 路径）；全量 444 通过 + build/lint/tsc/e2e 全绿。

---

## D-041：分层自进化协议 M5——doctor 6 检查项 + Web 进化历史 + 检索增强

- 状态：Accepted（已实施，TASK-044，D-041 收尾）
- 日期：2026-08-07
- 背景：P0（TASK-040）建身份守卫地板、P1（TASK-041）自进化链默认开、M3（TASK-042）提案对账 + Web 只读化、M4（TASK-043）遗忘归档 + 身份回滚。本批（M5/P3）是 D-041 **最后一阶段**，把前四批建立的约束变成**可观测、可审计**：doctor 能检视全部自进化机制的健康度；Web 提供进化历史只读页（evolve 提交可回溯）；检索能沿证据链回到原始记录。
- 决定：
  - **P3-1 Web「进化历史」只读视图**：后端 `FactoryApplication.evolutionLog(id)` = `git log --grep evolve:`（最多 100 条，按时间倒序）+ `CURRENT_STATE.md` 全文 + `usageSummary`（飞书使用统计）。`git.ts` 增 `gitLog(workspace, {grep, limit, path})`（`%H%x00%s%x00%cI` 格式化，非仓库/无提交返回空数组不抛错）。前端 `AgentDetailPage` 增「进化历史」tab（纯展示：提交流 + 使用统计表 + CURRENT_STATE markdown 渲染，无任何编辑/回滚入口）；`GET /api/v1/agents/:id/evolution` 只读端点。人工修正仍走飞书聊天或 CLI（`agentctl identity rollback`）。
  - **P3-2 doctor 增 6 检查项**（对齐 D-041 前四批机制的健康监控，均随 `run(<id>)` 输出）：
    - `identity-baseline`：`IDENTITY_BASELINE.md` 缺失/不可解析 → warn（无从对账）；相对基线漂移 → warn（remediation 指向 identity rollback）。
    - `identity-guard`：ROLE 岗位定位/长期职责标题、POLICIES 红线词、CONSTITUTION 使命/变更流程标题缺失 → **fail**（硬门语义，与 `commitSelfEvolution` 提交前校验一致）。
    - `proposal-ledger`：`appliedWithoutAnchor` 检出超出可进化范围且无 `user_anchor` 依据的身份改动 → **fail**；detail 带违规文件 + 当前协议（advisory/enforced），remediation 区分两种协议处置。
    - `memory-flags`：agent.yaml 三开关（transcript_persist/experience_extraction/skill_self_creation）**缺失（undefined）** → warn（按默认开处理，引导补齐）；显式 `false` 尊重用户关闭意图（不误伤）。
    - `knowledge-retention`：lessons/raw 与 lessons/refined 中超 90 天仍未归档的条目数 > 0 → warn（引导运行 retention）。
    - `reflection`：refined/ 经验条目不附 `because of:` 证据引用（无法回溯 raw/）→ warn；无 refined 或均有证据 → pass。
  - **P3-3 检索增强**：`KnowledgeRecallHit` 增 `evidence?: string[]`；`KnowledgeIndexImpl.recall` 对 `lessons/refined/` 命中条目前置收集 `because of:` 证据行（容错，缺证据不带），非 refined 不附带。CLI `agentctl recall` 命中 refined 时以 `证据:` 标签展示证据链接；CLI 增 `agentctl identity proposals <id>` 列出提案账本状态机（proposed/approved/rejected/applied/expired，含批准依据 `user_anchor`），供审计「哪些身份改动有批准依据」。
- 边界：本批为**只读 + 监控**——不新增任何写入端点，不改变前四批的提交/对账/归档行为；doctor 检查项只报告状态不自动修复（remediation 指向 CLI/聊天）；Web 进化历史只读（后端无写端点、前端无编辑控件）。`identity proposals` 命令只读账本，不提供回写。
- 原因：D-041 前四批建立了约束但缺少「漂移被及时发现」的闭环——doctor 6 检查项把身份守卫/提案对账/开关/遗忘/反思证据全部纳入可观测；Web 进化历史把「一切写入 git 版本化、可回溯」的承诺变成人工可见；recall 证据链让二级提炼经验可回溯到一级原始记录，数据血缘完整。
- 影响：`git.ts`（gitLog）、`factory-application.ts`（evolutionLog + settleEmployee 复用）、`doctor.ts`（6 检查项）、`knowledge.ts`/`knowledge-index.ts`（evidence 字段 + recallEvidence）、`cli-program.ts`（identity proposals + recall 证据展示）、`web/server.ts`（evolution 端点）、`web/api.ts` + `web/src/pages/AgentDetailPage.tsx`（进化历史 tab）；增测 git（gitLog）、doctor（6 检查项）、knowledge（recall 证据）、web-management-api（evolution 端点）、cli-structure（identity 含 proposals）；全量测试 442 通过（此前 438），build/lint/tsc 全绿。D-041 M1-M5 全部完成。

---

## D-041：分层自进化协议 M4——knowledge 遗忘归档 + 身份 git 回滚 + 账本压缩为摘要

- 状态：Accepted（已实施，TASK-043）
- 日期：2026-08-07
- 背景：P0（TASK-040）建了「身份不可静默削弱」地板，P1（TASK-041）让自进化链「默认开 + 有沉淀」，M3（TASK-042）把「人工只能通过飞书聊天改身份」变成系统级硬约束。本批（M4/P2）补齐「记忆有界有淘汰」与「回滚逃生口」：**knowledge 遗忘归档**（raw/refined 无限累积会索引膨胀、检索信噪比下降）与 **身份 git 回滚**（身份改错后的人肉可回退通道）+ **账本压缩为摘要**（两条 JSONL 账本超限不再纯丢弃最早行，而是压成统计摘要保留痕迹）。
- 决定：
  - **P2-1 knowledge 遗忘归档**（新增 `src/core/knowledge-retention.ts`）：
    - `archiveStaleKnowledge`：`lessons/raw/` 与 `lessons/refined/` 超 `retentionDays`（默认 90）的条目 **`fs.move` 到 `knowledge/.archive/<归档日期>/<层>/`**（移走非删除、可恢复），按「日期 + 层」两级分桶——raw/refined 同名文件（`<date>-<agent>.md`）不互相覆盖，恢复时无歧义回 `lessons/<层>/`。软链接条目拒移（防逃逸，记 skipped）。
    - **归档即隐退**：`.archive/` 是点目录，`KnowledgeIndexImpl.scan` 递归时跳过 → 归档条目不进 `.index.json`、不参与 recall；工作区 `.gitignore` 排除 `knowledge/.archive/` → 归档不进员工 git（避免 git 无限膨胀）。恢复时移回 lessons/ 后重新入索引、重新进 evolve 提交。
    - `restoreKnowledge` / `purgeKnowledgeArchive`：复用 TrashService 语义——restore 移回 lessons/ 原位（目标已存在则拒绝，不覆盖），purge 彻底删除；路径经 `assertArchiveEntry` 校验必须落在 `.archive` 树内（防 `..` 逃逸）。
    - **接入**：`settleActive` 末尾低频调用（不依赖 transcript，周期 settle 也触发；best-effort，归档/重建索引失败仅告警不阻断链）；CLI `agentctl knowledge retention` 手动触发，另有 `knowledge archive-list` / `restore` / `purge` 子命令。
  - **P2-2 身份 git 回滚**：`git.ts` 新增 `gitShowFile(workspace, relPath, ref)`（`git show <ref>:<path>`，`stripFinalNewline:false` 保留末行换行、字节级一致）。CLI `agentctl identity rollback <id> <file> [--ref <commit>]`：git show 写回工作区 → 走 `evolve: 回滚 <file> 到 <ref>` 单文件提交（可回溯）→ 刷新身份基线（`evolve: 更新 身份基线`，使对账反映回滚后状态、不误判漂移）。**受限清单**：只允许回滚五份身份文档 + IDENTITY_BASELINE + CURRENT_STATE；知识/技能/workflows 属可进化区由员工 git 自主管理，不提供 rollback 逃生口（与「人工只走聊天改身份」对齐）。技能回滚沿用已有 `SkillService.rollback`。
  - **P2-3 账本压缩为摘要**：`truncateLedger` 与 `truncateReflectionSignals` 超上限（5000 行）时，由「纯丢弃最早行」改为「压缩最早批为 1 行统计摘要 + 保留最近 `maxLines-1` 行原始」——摘要行记 `{event:'summary', proposals, decisions, approved, byProposalId}` / `{date, summary:true, importance, count, span, topics}`，**不带 `user_anchor`**（不会被误读为批准依据）；统计痕迹保留而非纯数据丢失，对账/触发语义不受影响。
- 边界：本批 **不引入 doctor 检查项 / Web 进化历史页 / recall 覆盖 refined**（M5）。归档是「移走非删除」——数据仍在本机 `.archive/`（gitignored）可恢复，不涉及云端删除；身份回滚只限身份文档，不提供知识/技能回滚逃生口。`.archive` 不进入正式记忆与正式检索，恢复后重新入列。
- 原因：经验两级会无限累积（raw 始终落盘、refined 持续提炼），无淘汰则索引膨胀、检索信噪比下降——「记忆有界有淘汰」是四区模型可进化区的闭环（对齐调研的有界记忆）；身份回滚提供「改错 → 人工可回退」的最后逃生口，与「一切写入 git 版本化」的承诺一致；账本压缩为摘要避免纯丢弃（对账统计仍有据可查）。
- 影响：新增 `knowledge-retention.ts` + `tests/knowledge-retention.test.ts`；`knowledge-index.ts` scan 跳过点目录；`templates.ts` `.gitignore` 增 `knowledge/.archive/`；`git.ts`（gitShowFile + stripFinalNewline）；`factory-application.ts`（maybeArchiveStaleKnowledge + settleActive 链序增补 + knowledgeArchiveStale/ListArchive/Restore/PurgeArchive + identityRollback）；`cli-program.ts`（knowledge retention 子命令 + registerIdentityCommands）；`reflection.ts`/`proposal-ledger.ts`（truncate 压缩为摘要）；增测 git（gitShowFile）、self-evolution（identityRollback 恢复+拒绝清单+NOT_FOUND + settleActive 归档钩子）；全量测试 438 通过（此前 421）。

---

## D-041：分层自进化协议 M3——提案账本对账 + Web 只读化 + 创建骨架模板

- 状态：Accepted（已实施，TASK-042）
- 日期：2026-08-06
- 背景：P0（TASK-040）建了「身份不可静默削弱」地板，P1（TASK-041）让自进化链「默认开 + 有沉淀」。本批（M3/P1-3）把「人工只能通过飞书聊天改身份」变成系统级硬约束：**提案账本对账**（员工未经用户批准就大改核心身份 → 系统可拦截）+ **Web 只读化**（决策①落地）+ **创建骨架化**（决策②落地）。三者共同闭环「创建只给基础岗位模板，之后边用边进化，Web 纯看，修改只走聊天」。
- 决定：
  - **P1-3 身份修订对账账本（硬门）**（新增 `src/core/proposal-ledger.ts`）：
    - 轻量 JSONL 账本 `~/.ai-employees/logs/proposals/<agent-id>.jsonl`（0600）：`recordProposal`（扫描 `agent/proposals/*.md` frontmatter 登记）/ `recordDecision`（`applied` + `user_anchor` 的提案登记为批准决策，作批准依据）/ `readLedger` / `truncateLedger`（上限 5000 行防无限累积，P2-3）。账本写入 best-effort，失败仅 warn 不阻断。
    - `appliedWithoutAnchor(workspace, ledger)`：ROLE/POLICIES/CONSTITUTION 相对基线的改动若**超出 `allowedIdentityDiff` 可进化范围**（整删/重写/锚点缺失）且无带 `user_anchor` 的 `applied` 提案 → 判定「未授权身份改动」。基线缺失返回空（交 doctor 告警，不硬判避免存量首次 settle 误伤）。
    - `maybeEnforceIdentityProtocol` 按 `identity_protocol` 分级：默认 `advisory`（仅 warn 留痕，不阻断）；`enforced`（用户显式开启）→ 违规文件**不提交** + warn + CURRENT_STATE 记录「检测到未授权身份改动已拒绝提交」。**提交拒绝 ≠ 恢复文件**——保留工作区脏文件供人工 `git diff`/`git checkout` 决策，不悄悄回滚。
    - **接线（settleActive 顺序不变量）**：`syncProposalLedger` → `enforceIdentityProtocol` → `ensureIdentityBaseline(excludeDocs: blockedRel)` → `commitSelfEvolution(blockedRel)`。**enforced 对账必须跑在基线重快照之前**——被拦截的违规改动经 `excludeDocs` 不吸收进基线（保留既有基线条目），否则违规会被基线快照认可、下次 settle 放行提交。
    - **CONSTITUTION 纳入受保护区**：`IDENTITY_DOCS` 扩为五份（含 `agent/CONSTITUTION.md`）；`identity-guard` 新增 CONSTITUTION 锚点（`使命`/`变更流程` 标题）；`commitSelfEvolution` relPaths 增补 CONSTITUTION。宪法区员工不可静默改动，要改走聊天明确指示。
  - **① Web 只读化**：`DocumentsTab` 移除 `save`/`Textarea` 编辑 → `ReactMarkdown` 全文预览 + `（只读）` 标 + 「工作区有未提交改动」dirty 徽章 + 页脚「身份文档只能通过飞书聊天修改」。后端 `PUT /api/v1/agents/:id/documents/:key` 直接 403 `READONLY`（CLI 与飞书聊天是唯一改身份通道）。`SkillsTab` 移除「从商店安装 / 导入目录 / 卸载」入口（后端路由与 CLI `agentctl skill` 保留为用户逃生口）；`api.ts` 移除 `saveDocument`/`uploadSkill`/`removeSkill` 前端调用。
  - **② 创建骨架化**：新 `templates/agent-skeleton/`（CONSTITUTION.md 播种红线锚点块 + 变更流程；ROLE/GOALS/OPERATING_SYSTEM/POLICIES 与渲染基准对齐）。`employee-generator.ts` 新 `generateEmployeeSkeleton(brief)`——prompt 收敛产出 `{id, name, description, goals[1-3], skills[0-2]}`，保留 `generatedProfileSchema`/`generateEmployeeProfile` 兼容（CLI 仍用完整蓝图）。`create-agent.ts resolveProfile` 简化：responsibilities 缺省 `[description]`（岗位定位即初始职责）、policies 缺省红线模板、escalation 缺省通用上报。Web `CreateAgentPage` Step 1 重写：一句话 + name/id/description/goals/skills 编辑字段，responsibilities/policies/escalation 降为「将播种的基础模板预览」只读区（不再可编辑——细节由员工在使用中自进化沉淀）。`templates.ts`：ROLE 增 `## 协作协议` 段、GOALS 增 `## 演进记录` 留痕行、基线注释更新为五份文档。后端 `GET /api/v1/agents/generate` 改走 `generateSkeleton`（Web 用骨架，CLI `--describe` 仍走完整 `generateProfile`）。
- 边界：本批 **不引入 knowledge 遗忘归档 / identity rollback CLI**（M4）、**不做 doctor 检查项 / Web 进化历史页 / recall 增强**（M5）。`identity_protocol` 默认 `advisory`，`enforced` 需用户显式开启；P1 声明而未生效的 `identity_edits`（`proposal_required|direct`）本批仍仅声明。
- 原因：提案账本让「人工只能通过聊天改身份」有系统层兜底——显著合法改动必有一份 `applied`+`user_anchor` 提案作依据，没有依据的显著改动即未经批准，enforced 下拒绝提交（但不回滚，留人工决策现场）；Web 纯看避免人工在浏览器直接改身份与飞书聊天通道冲突；骨架创建把「人工一次性确认」收敛到最小字段，身份细节全部交由自进化沉淀。
- 影响：新增 `proposal-ledger.ts` + `tests/proposal-ledger.test.ts`；`identity-baseline.ts`（IDENTITY_DOCS 五份 + excludeDocs）；`identity-guard.ts`（CONSTITUTION 锚点）；`factory-application.ts`（syncProposalLedger/enforceIdentityProtocol + settleActive 链序 + commitSelfEvolution blockedRel + generateSkeleton）；`templates.ts` + `templates/agent-skeleton/`；`employee-generator.ts`（generateEmployeeSkeleton）；`create-agent.ts`（resolveProfile 简化）；`web/server.ts`（PUT documents 403 + generate 改骨架）；`web/api.ts` + `CreateAgentPage.tsx` + `AgentDetailPage.tsx`（只读化 + 骨架表单）；增测 create-agent（CONSTITUTION/演进记录/协作协议/基线五份）、identity-baseline（CONSTITUTION 纳入 + excludeDocs）、web-management-api（PUT 403）、web-ui（骨架表单 + 只读断言）、self-evolution（账本同步 + enforced 拦截 + user_anchor 放行）；全量测试 421 通过（此前 394）。

---

## D-041：分层自进化协议 P1——三开关默认开 + 经验两级化（raw 始终落盘 + 重要性触发提炼）

- 状态：Accepted（已实施，TASK-041）
- 日期：2026-08-06
- 背景：P0（TASK-040）已建「身份不可静默削弱」地板（identity-guard / identity-baseline / proposals 通道）。本批（M2/P1）让自进化链真正「默认开 + 有沉淀」：三个自进化开关默认启用并存量回填；经验提取两级化——一级原始记录始终落盘（不依赖任何开关，防丢现场），二级提炼按「重要性累积」触发（对齐 Generative Agents poignancy / Reflexion 滑动窗口，而非每轮提炼=噪音+成本）。schema 新增字段全 optional，零迁移。
- 决定：
  - **P1-1 三开关默认开 + 存量回填**：`agent-schema.ts` 新增 `DEFAULT_MEMORY_FLAGS = { transcript_persist: true, experience_extraction: true, skill_self_creation: true }` + `resolveMemoryFlags(memory)`（undefined→true，显式 false 尊重不回填；返回具体对象类型以兼容 `exactOptionalPropertyTypes`）。新建员工 `create-agent.ts buildAgentConfig` memory 块显式写三个 `true`（agent.yaml 自文档化）。存量员工 `settleActive` 新增 `ensureMemoryFlags(agent)` 幂等回填（写 agent.yaml，由 `commitSelfEvolution` 新增的 `agent.yaml` relPath 单文件提交，`evolve: 更新 agent.yaml` 可回溯）。`computeConfigHash` 只 hash runtime 块 → memory 变更不触发 config_hash 漂移，registry 无需动。`runBridgeMessage`/`runJob`/`maybeAutoCreateSkill` 的 transcript/开关判定统一改经 `resolveMemoryFlags`。
  - **P1-2 经验两级化**：
    - **一级（始终写）**：`maybeRecordRawExperience` 在 transcript 摘要一到即同步写 `knowledge/lessons/raw/<date>-<agent>.md`（`flag:'wx'` 防重，best-effort 失败仅 warn）——**不依赖任何开关**，是二级提炼的证据源（`source_agent`/`source_transcript` frontmatter 记录出处）。
    - **二级（重要性触发）**：新增 `src/core/reflection.ts`——`estimateImportance`（轻量启发式：基准 1 + 决策 ≤2 + 经验 ≤2 + 多主题 +1，封顶 5）、`appendReflectionSignal`（`knowledge/.reflection-signals.jsonl`，0600 纯追加）、`shouldReflect`（累积 importance ≥ 阈值 3，**或**距上次提炼 > 24h 保底；从未提炼时以最早信号为参照，**避免首条消息即提炼**，符合「按重要性累积而非每轮」）、`truncateReflectionSignals`（上限 5000 行防无限累积）。新增 `src/core/experience-refiner.ts`——`refineExperience` 复用 employee-generator/skill-generator 的「本地 claude CLI → 结构化 JSON → Zod」范式，产出 `{insight, evidence[], writeup}`，`evidence` 必须引用 `raw/` 具体文件/行 → 写回 `knowledge/lessons/refined/<date>-<slug>.md`，正文带 `because of: knowledge/lessons/raw/<file>:<line>` 证据引用；`readLastRefinedAt` 供保底触发参照。
    - **门控**：`maybeRefineExperience` 仅当 `resolveMemoryFlags(agent.memory).experience_extraction !== false` 且 `reflection_enabled !== false` 且运行时为 claude（依赖本地 CLI）；提炼成功后信号文件 `rm` 重置累积（保底仍由 idle 触发），产物 `evolve: 提炼经验` 单文件提交。`experience_extraction` 语义变更为「是否二级提炼」——一级原始记录始终写。
  - **P1-4 schema 新字段**（全 optional 向后兼容）：`memory.reflection_enabled`（bool）、`memory.identity_protocol`（`'advisory'|'enforced'`，默认 advisory）、`memory.identity_edits`（`'proposal_required'|'direct'`，本批仅声明，M3 提案对账时生效）。`agentConfigSchema.parse` 天然兼容旧文件。
- 边界：P1 **不引入 proposal-ledger 账本 / Web 只读 / 骨架创建**（M3）、**不做遗忘归档 / identity rollback**（M4）、**不引入向量库 / 新 DB / 对外网络外发**。提炼依赖本地 claude CLI（provider=codex 不触发），失败降级不阻断运行（原始记录仍在 raw/，不丢现场）。二级提炼是 best-effort 非硬门——未达阈值/CLI 失败仅 warn。
- 原因：三开关默认开让存量员工无需人工操作即获得与新建员工一致的自进化能力（同 D-039 的 settleActive 回填点语义）；经验两级化对齐「记录→验证→提炼→写回」门控——原始记录始终留底、提炼有据可查（`because of` 证据引用），避免无限累积与无依据的自我改写。
- 影响：新增 `reflection.ts`/`experience-refiner.ts` + `tests/reflection.test.ts`/`tests/experience-refiner.test.ts`；`agent-schema.ts`（DEFAULT_MEMORY_FLAGS + resolveMemoryFlags + P1-4 字段）；`create-agent.ts`（显式三 true）；`factory-application.ts`（maybeRecordRawExperience/maybeRefineExperience/ensureMemoryFlags + settleActive 链序 raw→refine→…→reconcile + runBridgeMessage/runJob/autoCreateSkill 经 resolveMemoryFlags + commitSelfEvolution relPaths 增补 agent.yaml）；`experience.ts`（renderRawExperience/rawExperienceRelPath）；增测 memory-enforcement（存量回填）/schemas（P1-4 + resolveMemoryFlags）/create-agent（三开关显式 true）/experience（raw 始终写、extraction=false 时 refined 不写）；全量测试 394 通过（此前 372）。

---

## D-041：分层自进化协议 P0——身份守卫（identity-guard + identity-baseline + proposals 通道）

- 状态：Accepted（已实施，TASK-040）
- 日期：2026-08-06
- 背景：用户要求「AI 员工的记忆/职业/行业/目标等所有进化，都在与飞书聊天/干活过程中由 AI 自己持续优化；人工不直接编辑（修正也通过聊天）；Web 只看信息；初始创建只给基础岗位模板」。规划确认三项决策：① Web 移除身份文档编辑入口（保留只读预览）；② 更轻的骨架模板；③ 提案审批制（员工改核心身份需用户在飞书聊天批准）。调研前沿方法论（Letta/Mem0/Generative Agents/Voyager/ExpeL/Reflexion/四层人格）得出核心约束：记忆分层+每层不同写入者、「记录→验证→提炼→写回」门控、一切写入 Git 版本化、身份受保护慢节奏修订、反模式=对话内内联自主改身份/记忆、自评改目标、只看表层。本批（M1/P0）先建「防漂移底线」——零 schema 变更、零迁移，让员工无法静默削弱身份、全部改动可 diff。
- 决定：
  - **P0-1 身份文档只读锚点硬门**（新增 `src/core/identity-guard.ts`）：声明式 `GUARDED_SECTION_MARKERS`——`ROLE.md` 的 `# 岗位定位`/`## 长期职责` 一级/二级标题不可删，`POLICIES.md` 红线词（`人工审批`/`生产写入`/`对外发布`/`删除数据`/`Git push`）不可被移除。`validateIdentityGuard(file, content)` → `{ok, issues}`；`stripGuardSections` 供提案工具剥离受保护行。**接入 `commitSelfEvolution`**：提交 ROLE/POLICIES 前校验，失败 → `console.warn` 留现场 + **跳过该文件提交**（保留工作区脏文件供 `git diff`/`git checkout` 人工决策，不悄悄回滚，不阻断其他文件提交）。
  - **P0-3 身份基线 + 双真相消解**（新增 `src/core/identity-baseline.ts`）：`agent.yaml.description` 定为**岗位定位唯一权威**，ROLE.md 的 `# 岗位定位` 段由系统渲染（创建/回填时写），员工不直改。`ensureIdentityBaseline(workspace, description)` 幂等快照四份身份文档标题结构+内容到 `agent/IDENTITY_BASELINE.md`（含 sha256 标记），幂等判定忽略 `generated_at`（仅描述或文档内容变化才重写，避免 settle 反复提交）。`baselineDrift(workspace)` 按文件返回 `{added, removed, changed}` 差异摘要；`allowedIdentityDiff`：改动行占比 <30% + 未删受保护标题 + 红线词仍在 → 判「可进化」，整删/重写 → 疑似漂移。**接入**：新建 `renderAgentWorkspace` 播种 + `settleActive` 幂等回填（写盘即 `evolve: 更新 身份基线` 单文件提交）。
  - **P0-4 「记录→提案→批准」通道**（目录约定）：`agent/proposals/*.md`（frontmatter `proposal_id/kind/status(proposed|approved|rejected|applied|expired)/target_file/proposed_at/user_anchor`，正文含「现状→拟改→理由→证据引用 `because of knowledge/lessons/xxx.md:行号`」）。应用协议写进 ENTRY 模板：用户明确「同意/批准/就按这个改」→ 员工改文件并标 `applied`；「不同意」→ `rejected` 归档；**员工不得自行 proposed→applied**。`commitSelfEvolution` relPaths 增补 `agent/proposals`。`renderAgentWorkspace` 播种 `agent/proposals/README.md`。
  - **P0-2 系统提示升级**：`ENTRY.md.tmpl`（claude/codex）「自我进化」小节重写为「分层自进化协议」——宪法/岗位定位只提案不直改、可进化区自主但红线词不可删/显著改动先提案、永不修改 `agent.yaml`/`.claude/settings.json` 扩大权限。`templates/factory-skill/SKILL.md` 补「六、自进化协议」小节。**回填条件扩展**：`ensureRuntimePrompt` 从「缺宿主平台」扩为「缺宿主平台 **或** 缺 `## 分层自进化协议` 标记」——D-039 之后创建、已含宿主平台但仍是旧「自我进化」文案的存量员工也重渲为协议文案；已含新协议则不动（幂等、尊重员工编辑）。
- 边界：**P0 零 schema 变更、零迁移**（`agent-schema.ts` 不动，`identity_protocol` 等新字段留到 M2/P1）。硬门是内容级校验**不是权限门**——不阻止员工在聊天中提案修改身份，只防静默削弱后不可追溯。硬门默认 `advisory` 语义（拒绝提交 + 留现场），不自动回滚脏文件。Web 编辑入口移除（决策①）与骨架模板（决策②）在 M3。
- 原因：员工全自主进化必须先有「身份不可静默削弱」的地板，否则任何后续机制（记忆/技能/反思）都建立在可被一句话抹掉的身份上。选 `settleActive` 作存量回填点是它是飞书逐消息/runJob/周期 settle 的统一沉淀入口（同 D-039）。
- 影响：新增 `identity-guard.ts`/`identity-baseline.ts` + 两测试文件；`factory-application.ts` `commitSelfEvolution` 加硬门 + 增补 proposals relPath、`settleActive` 加基线回填；`templates.ts` 播种基线 + proposals README + `ensureRuntimePrompt` 回填条件扩展；两个 ENTRY 模板 + factory-skill 升级文案；`self-evolution.test.ts`/`bridge-settle.test.ts` 增补；全量测试 372 通过（此前 332）。

---

## D-039：存量员工系统提示词回填（与新建员工完全一致）

- 状态：Accepted（已实施，TASK-039）
- 日期：2026-08-06
- 背景：D-037 给所有员工预置了宿主平台 skill（`ai-employee-factory`），并在 `settleActive` 回填存量员工，但**只回填 skill，没有重渲系统提示词**——刻意避免覆盖员工对 `CLAUDE.md`/`AGENTS.md` 的既有编辑。结果是 D-037 之前创建的旧员工（如 `user-operations`）的 `CLAUDE.md` 只有 4 行旧版内容，**缺「宿主平台（AI Employee Factory）」小节**，与新建员工功能不一致。用户要求：让存量员工与新建员工完全一致。
- 决定：
  - **新增 `ensureRuntimePrompt(workspace, provider, values, memory)`**（templates.ts）：仅当 `CLAUDE.md`/`AGENTS.md` **缺「宿主平台」小节**（D-037 之前的旧员工标志）时，按当前 ENTRY 模板重渲一次；内容与 `renderRuntimeFiles` 同构（`{{name}}` 等占位符渲染 + 从 `agent.yaml.memory.authority_order` 派生的「记忆权威顺序」）。**已含该小节则跳过**，尊重员工对系统提示的既有编辑、不反复覆盖。
  - **回填点**：`settleActive`（飞书逐消息/runJob/周期 settle 统一入口）在 `ensureFactorySkill` 之后调用 `ensureRuntimePrompt`，覆盖 claude 与 codex（`CLAUDE.md`/`AGENTS.md`）。
  - **提交**：`commitSelfEvolution` 的 relPaths 增补 `CLAUDE.md`/`AGENTS.md`——回填写入由自进化链**单文件 git 提交**（`evolve: 更新 CLAUDE.md`，进员工 git 历史、可回溯）；已提交无变更则不产生提交。
- 边界：**只增不改**——仅补缺的「宿主平台」小节所在的完整模板内容，员工已有内容（如 `settings.json` 的真实权限）一律不动；已升级的员工后续自维护系统提示不受影响（不覆盖）。回填是一次性、幂等的。
- 原因：用户要求"让存量员工和新建员工功能完全一致，如果不行提醒重新建"。回填 `CLAUDE.md`/`AGENTS.md` 即补齐系统提示词缺口，使旧员工获得与新建员工相同的「宿主平台」指引，无需重建。
- 影响：`templates.ts` 新增 `ensureRuntimePrompt`；`factory-application.ts` `settleActive` 调用 + `commitSelfEvolution` 增补系统提示文件；测试 `bridge-settle.test.ts` 新增「旧员工缺宿主平台→回填为当前模板→已含则不动」用例。

---

## D-038：Skill 商店新增内置本地源 first-party（game-feedback-collector 进商店）

- 状态：Accepted（已实施，TASK-038）
- 日期：2026-08-06
- 背景：用户要求"把用户反馈的那个收集 skill（`game-feedback-collector`）放到 skill 商店"。该技能是 `user-operations` 员工工作区里的自包含技能（SKILL.md + 11 个 scripts + package.json + `.env`/node_modules/jsonl/DB 等运行数据），而 skill 商店此前**仅接受 `https://github.com/` 公开仓库**（`config.ts` `skillStoreRepositorySchema`），无法直接纳入一个本地技能。
- 决定：
  - **内置本地源**：仓库 schema 增 `source: 'github' | 'local'`（默认 github，`superRefine` 校验 github 必须带 url）。新增恒常合并的 `FIRST_PARTY_SOURCE`（name=`first-party`，source=`local`）——**不写入 config.yaml、不可被移除、随项目分发、离线可用**。`SkillStoreService` 对 local 源跳过 clone/refresh（`cached=true`、`lastRefreshedAt='bundled'`），`sourceDir` 指向 `{packageRoot}/templates/skill-store/`，复用现有 `scanSkills` 发现技能、`resolveSkillSource` 校验 SKILL.md 且防目录穿越。
  - **技能打包**：`game-feedback-collector` 的**分享形态**打包到 `templates/skill-store/game-feedback-collector/`（SKILL.md + scripts/ + package.json + package-lock.json + .env.example + .gitignore），并给 frontmatter 补 `version: 1.0.0`。**绝不打包 `.env`/node_modules/各 jsonl/DB/err 运行数据**（守 D-006，凭据不入库）；`.gitignore` 忽略运行期产物。
  - **安装命令**：`agentctl skill-store install <agent-id> first-party game-feedback-collector`（无需 refresh）；`list-repos`/`list-skills first-party` 可直接查看。
- 边界：内置源是**随仓库分发、恒常只读**的安装来源，不改动目标技能的业务逻辑；技能安装后仍需在员工工作区 `npm install` 并配 `.env`（`.env.example` 提供占位模板），凭据由员工侧提供。远端源行为不变（仍需 add-repo + refresh）。
- 原因：用户明确选择"打包进仓库作为内置源"（vs 推到 GitHub 公开仓库）。本地源让内置技能**离线可用、随项目版本分发、不依赖外部仓库与网络**，且避免把内部业务规则（飞书表/负责人路由）推到公开 GitHub。
- 影响：`config.ts`（schema 增 source + `FIRST_PARTY_SOURCE`）；`skill-store.ts`（local 源 list/refresh/resolve/remove 分支 + `sourceDir`）；`cli-program.ts`（list-repos 显示 `(bundled)`、描述更新）；新增 `templates/skill-store/game-feedback-collector/`（11 个脚本 + SKILL.md + package.json/lock + .env.example + .gitignore）；测试 `skill-store.test.ts` 更新断言 + 新增 first-party 用例。

---

## D-037：宿主平台预置为员工 skill（ai-employee-factory）

- 状态：Accepted（已实施，TASK-037）
- 日期：2026-08-06
- 背景：用户要求"把当前这个项目（AI Employee Factory）当成 CLI 和对应的 skill **预置给所有的 AI 员工**，新建的时候也要有，这样他才会用；并告诉它局限、它是什么、身处什么环境、项目是干嘛的"。此前员工工作区只有岗位/知识/业务 skill，**不知道自己是跑在什么平台上、宿主 CLI 怎么用、能力边界在哪**——容易误判能做什么、或不善用 `agentctl` 管理工厂。
- 决定：
  - **预置 skill**：新增 `templates/factory-skill/SKILL.md`（frontmatter `name: ai-employee-factory`，合法 kebab-case），内容讲清四件事：① 你是什么（AI 员工、隔离子进程）；② 所处环境（员工 id/名称/运行时/工作区结构）；③ 宿主项目（AI Employee Factory 是干嘛的、核心能力）；④ `agentctl` CLI 速查；⑤ **能力边界与局限**（工作区沙箱、审批边界、不可改 `.claude/settings.json`、不可越权、本地运行）。用 `{{id}}/{{name}}/{{runtime}}/{{workspace}}` 占位符按员工注入。
  - **播种**：新增 `ensureFactorySkill(workspace, provider, values)`（幂等：SKILL.md 与模板一致则跳过写盘，避免 settle 反复提交；投影用相对 target `../../skills/<name>`，`.claude` 与 `.codex` 共用，创建流程 workspace rename 后仍有效）。**新建员工**在 `renderAgentWorkspace` 播种；**存量员工**在 `settleActive` 回填（飞书逐消息/runJob/周期 settle 都会走到，覆盖 claude 与 codex）。
  - **ENTRY 提示词**：`claude-agent`/`codex-agent` ENTRY 模板各加「宿主平台」小节，让新员工系统提示词始终指向该 Skill。
  - **顺带修复**：① `doctor.trackedSecretFiles` 用 `lstat` 跳过符号链接/非文件，避免读投影软链抛 EISDIR（预置 skill 使 `.claude/skills/` 必有跟踪软链后暴露的存量 bug）；② `commitSelfEvolution` 增补 `.claude/skills`/`.codex/skills` 投影目录——adopt/自建技能新增软链一并跟踪，保持 git 干净（预置 skill 使 `.claude/` 成跟踪目录后，原「投影软链未提交」的隐性不一致显性化）。
- 边界：预置 skill 是**平台说明**，不改员工业务 skill 与权限；不扩大员工权限（仍是 workspace 沙箱 + 审批）；存量员工在下一次飞书消息/runJob/settle 时自动获得，无需手动操作。
- 原因：员工「知道自己运行在什么平台、宿主 CLI 怎么用、边界在哪」才能被真正用起来且不越权。选 `settleActive` 作存量回填点是因为它是飞书逐消息/runJob/周期 settle 的统一沉淀入口。
- 影响：新增 `templates/factory-skill/SKILL.md`；`templates.ts` 增 `ensureFactorySkill` 并在 `renderAgentWorkspace` 调用；`factory-application.ts` `settleActive` 回填 + `commitSelfEvolution` 补投影目录；`doctor.ts` 修投影软链 EISDIR；两个 ENTRY 模板加宿主平台小节；测试 `create-agent.test.ts`/`application-management.test.ts`/`web-management-api.test.ts` 断言更新 + 新增 codex/.claude 投影断言。

---

## D-036：飞书实际使用日志（本地 SQLite usage.db）

- 状态：Accepted（已实施）
- 日期：2026-08-06
- 背景：用户以飞书对话为员工主入口，但**没有任何"飞书实际使用"的结构化日志**——无法回答"飞书都在干些什么活、每条消息花多久/多少钱、哪些功能被用到、哪些是冗余"。现状只有 append-only `operations.jsonl`（操作审计摘要，非 DB、无消息维度/token/耗时），且飞书 `bridge-run` 路径**不写 operations.jsonl**、也**不采集 token/成本**（`runBridgeMessage` 未传 provider/structured）。`observability.ts` 是 no-op 默认。
- 决定：
  - **存储**：新增 `better-sqlite3@^13`（本地 Node≥22；`engines.node` 从 `>=20.19.0` 提到 `>=22`）。DB 文件 `~/.ai-employees/logs/usage.db`（WAL）。
  - **新模块** `src/core/usage-log.ts`：`UsageDb` 单表 `messages`（agent_id/provider/started_at/finished_at/duration_ms/exit_code/prompt/prompt_chars/args_json/model/四个 token 列/total_cost_usd/topics_json/transcript_file，索引 `(agent_id, started_at)`）。`record` **best-effort**（写失败仅 `console.warn`，绝不阻断消息/settle 链）；`query`/`summary`（按天+员工聚合：消息数/平均耗时/总成本/错误数）。
  - **埋点**：`runBridgeMessage`（唯一逐消息入口）在 `runLogged` 补 `provider`+`structured`（best-effort 解析 token/成本，bridge 非 JSON 输出则空），运行后 record 一条（prompt 经 `redactSecrets` 脱敏，守 D-006）；transcript 启用时从 transcript.jsonl 提取 topics 一并记录。
  - **CLI**：`agentctl usage query`（按 agent/时间/limit 列消息）+ `agentctl usage summary`（聚合）。`FactoryApplication` 暴露 `queryUsage`/`usageSummary`。
- 边界：**不加 Web 分析页**（本批范围=埋点+CLI+分析报告）；`usage.db` 是本地分析数据，不纳入备份/迁移（重建即重新累积）；prompt 只存脱敏文本，不存全量原文（D-006 transcript 边界不变）；不记录飞书用户/群/消息 id（该元数据在外部 `lark-channel-bridge` 内，本层不可达，留作 bridge 暴露后增强）。
- 原因：用户要求"记录飞书实际使用到本地 DB，用于后续产品优化"。true DB（SQLite）支持聚合查询，比 JSONL 更适合分析。注入点选 `runBridgeMessage` 是因为它是唯一能拿到 agent_id/时间/exit_code/prompt/usage 的逐消息入口。
- 影响：新增 `core/usage-log.ts`；`factory-application.ts` `runBridgeMessage` 埋点 + `queryUsage`/`usageSummary`；`cli-program.ts` 增 `agentctl usage` 命令组；`package.json` 增依赖 + engine 提升；测试 `tests/usage-log.test.ts`。配套分析报告 `docs/USAGE_ANALYSIS.md`（功能面冗余观察 + 待测指标）。

---

## D-035：飞书主入口员工自进化（逐消息 shim + 周期 settle 扫描）

- 状态：Accepted（已实施，TASK-035）
- 日期：2026-08-06
- 背景：用户以**飞书对话为员工主入口**（"我会通过飞书对话让他干活"）。但调研确认整套"员工自进化"沉淀链（skill adopt/生成、经验提取、自进化 git 提交、任务 reconcile）**只挂在 `runJob` 后处理 `.then` 上**；飞书 bridge 走 `runBridgeService` → `runInteractive`（裸 `execa`，`stdio: inherit`）→ 外部 `lark-coding-agent-bridge` 长驻进程，**一个收口钩子都不跑**。`prepareRuntime` 对飞书会跑，所以放行规则/skills/** 员工在飞书里写得动，但写完没人收口。
- 关键可行性事实（已核实上游源码）：外部 `lark-coding-agent-bridge` 的 Claude adapter 对每条飞书消息 `spawn('claude', …)` 从 PATH 解析、prompt 走 stdin、完全继承父进程 PATH（binary 仅代码层可覆盖）。→ Factory 给 bridge 的 env 把 PATH 前置一个 `claude` shim 目录，每条 `claude -p` 即被 shim 接住，逐消息送回 `runLogged`（真实 transcript）→ 跑完整沉淀链。
- 决定：
  - **方案 A（安全网，覆盖 adopt/提交/reconcile）**：抽取 `settleActive(id, agent, registry, transcriptFile?)` 复用沉淀链（`maybeExtractExperience` → `autoAdoptSelfSkills` → `maybeAutoCreateSkill` → `commitSelfEvolution` → `reconcileEmployeeJobs`），`runJob` 改调它；新增公开 `settleEmployee(id)`（无 transcript，仅 adopt/提交/reconcile）。launchd 支持 `StartInterval`（秒级重复，与 `StartCalendarInterval` 互斥，设了则优先）；`settleLaunchdService` 生成 `com.aiemployees.<id>.settle` 周期任务，默认 300s（`FEISHU_SETTLE_INTERVAL_SECONDS`），随 bridge `start/restart` 安装、`stop` 卸载（best-effort）。CLI 增 `_service settle` + `agentctl bridge settle [<id>]`（`--install/--uninstall/--interval`）。
  - **方案 B（主路径，完整覆盖①②③④⑤）**：`runLogged` 支持 `stdin`；新 `_service bridge-run <id> <args...>` 读 stdin 调公开 `runBridgeMessage(id, args, stdin)`（`resolveRealClaude` → 构造 `ExecutionContext`（真实 claude + workspace cwd + `buildRuntimeEnvironment` + LARK env）→ `new ProcessRunner(logsDir).runLogged(id, ctx, { transcript, stdin })` → `settleActive(id, agent, registry, transcriptFile)` → 返回 exitCode）。新 `src/core/claude-shim.ts`：`installClaudeShim` 在 `runtimes/<id>/claude-shim/claude` 幂等写可执行 shim，烘焙 home/workspace/真实 claude 路径，`exec <cliFile> _service bridge-run <id> -- "$@"`（stdin 经 exec 继承转发）；`withClaudeShim` 把 shim 目录前置到 PATH，注入 `LaunchdServiceAdapterFactory.bridge` env（launchd 路径）与 `BridgeAdapter.context`（交互路径）。`prepareRuntime` 幂等安装 shim。
- 边界：不改外部 `lark-coding-agent-bridge`（shim 是唯一 seam）；shim 只影响 bridge 进程（runJob/chat env 不含 shim 目录）；A 兜底"绕开 shim 或非消息的 workspace 编辑"，B 逐消息已覆盖全部；④⑤ 仅 B（依赖 transcript），A 无 transcript 只跑①②③；飞书链路权限仍受 `secureProfile`（workspace/workspace）约束，shim 不扩大权限。
- 原因：飞书是主入口，员工沉淀（skill/记忆/提交）必须在此闭环；shim 是唯一不改上游即可逐消息拿到真实 transcript 的 seam。
- 影响：`factory-application.ts` 增 `settleActive`/`settleEmployee`/`runBridgeMessage`/`listBridgeEnabledIds`；新增 `core/claude-shim.ts`；`process-runner.ts` `runLogged` 支持 stdin；`bridge.ts`/`factory-services.ts` 注入 shim PATH；`launchd-service.ts` 支持 `StartInterval`；`factory-services.ts` 增 `settle`；`runtime-adapter.ts` 增 `'bridge-run'` 操作；CLI 增 `_service settle`/`_service bridge-run`/`bridge settle`；测试 `tests/bridge-settle.test.ts`（新，7 用例）+ `process-runner` stdin。

---

## D-001：单包分层架构

v1 使用单 npm 包，通过 core/runtime/service/schema 边界保留扩展性，不引入 workspaces 发布成本。

## D-002：Factory 管理 launchd

Factory 启动 Bridge 的前台 `run` 命令，不委托 Bridge 自有 daemon，以强制注入隔离环境、统一日志和状态。

## D-003：Skill 按 Agent 复制与作用域分离

- 状态：Evolved（原 v1 为单一项目级源；现按作用域分离，见下）
- 决定：Skill 按 Agent 独立复制，并按作用域分为两级，两处存储互不共享：
  - **project（项目级）**：存于 `workspace/skills/<name>/`，投影到项目发现目录 `workspace/.claude/skills/<name>`（Claude）/ `workspace/.codex/skills/<name>`（Codex）。随 Agent 工作区 git 进入版本管理，进入默认备份。
  - **user（用户级）**：原位存于 `runtimeHome/skills/<name>/`（= CLAUDE_CONFIG_DIR/CODEX_HOME 的 skills，即运行器原生用户级发现目录）。属于员工运行时身份，默认不进备份（仅 `includeRuntime` 时打包）。
- 边界：不同 Agent 不得连接同一实时共享 Skill 目录；用户级 store 仅统计真实目录（跳过历史 Codex preset 投影软链）。安装复用 `SkillService.install`，拒绝源内软链接（R6）。
- 原因：原单一 `workspace/skills/` 造成 Claude（项目级）与 Codex（用户级）的 Provider 不对称；显式作用域让 UI 按项目级/用户级分类展示，并让备份语义清晰（项目级随工作区、用户级仅随 Runtime）。

## D-008：Skill 商店（远端 GitHub 仓库源）

- 状态：Accepted
- 日期：2026-08-04
- 决定：新增 `agentctl skill-store` 命令组与「Skill 商店」顶级页，把可配置的远端 GitHub 仓库源（`config.yaml` 的 `skill_store.repositories`）浅克隆到 `~/.ai-employees/skill-store/cache/<name>/`，用 `agent-skills.yaml/json` 清单或扫描 `SKILL.md` 发现技能，安装复用 `SkillService.install`（传递源路径）。
- 边界：仅接受 `https://github.com/` 公开仓库；仓库源上限 20 个；安装沿用既有作用域（project/user）与软链接拒绝规则。不改变任何既有安装方式（上传目录 / 本地路径 / CLI）。
- 原因：满足「连接远端 GitHub 仓库共享技能」的需求，同时不破坏既有安装方式；内置默认仓库源（superpowers、anthropic-skills）作为可配置列表的起点。

## D-004：非破坏归档和可验证备份

archive/remove 优先移入归档区。默认备份排除凭据和 runtime；包含 runtime 时强制 scrypt + AES-256-GCM 加密。
例外：Skill remove（D-003 演进）是用户决策的彻底卸载——直接删除技能目录（项目级含投影软链，用户级含 runtimeHome 原位目录），不可恢复、不再进归档区；Agent/Job 归档仍走归档区。

## D-005：本地临时 Web 控制面

- 状态：Accepted
- 日期：2026-08-03
- 决定：`agentctl web` 只绑定 `127.0.0.1`，使用一次性 fragment token 交换 HttpOnly 会话并对修改请求验证 Origin/CSRF。CLI 和 Web 共用 `FactoryApplication`。
- 边界：不提供 `--host`、常驻服务、账号系统或嵌入终端。Runtime 登录、飞书授权和交互聊天仍由隔离的 CLI 入口完成。
- 原因：保留本地单用户的低配置体验，同时避免将本机 Agent 管理面暴露到网络或在浏览器重做终端安全边界。

## D-006：Claude 默认同步 CC Switch Provider

- 状态：Accepted
- 日期：2026-08-03
- 决定：Claude 不执行官方 OAuth 登录。Factory 在运行前从 CC Switch 当前 live `settings.json` 读取 Provider 白名单字段，原子同步到员工专属 `CLAUDE_CONFIG_DIR`。
- 边界：只同步 API endpoint/token、模型别名和相关 Claude Provider 开关；不复制 OAuth、会话、历史、MCP、权限、主题或其他个人设置。摘要和日志只记录字段名，不记录值。
- 原因：满足 CC Switch 为默认 Provider 控制面的产品要求，同时保留不同员工的原生会话、Skills 和配置目录隔离。

## D-007：Bridge 使用官方 PersonalAgent 并固定 workspace 权限

- 状态：Accepted
- 日期：2026-08-03
- 决定：沿用 `lark-coding-agent-bridge profile create` 的扫码/已有 App ID 流程及 WebSocket 长连接；授权后把 profile `permissions.defaultAccess/maxAccess` 固定为 `workspace`。
- 边界：首次授权只在终端进行，App Secret 不进 agentctl argv；Factory 管理前台 `run` 的 launchd，不同时使用 Bridge daemon。
- 原因：官方新 profile 默认 `full/full`，会映射为 Claude `bypassPermissions` 或 Codex `danger-full-access`，与 Factory 的 workspace 安全默认冲突。

## D-008：Factory 自管七天员工回收站

- 状态：Accepted
- 日期：2026-08-03
- 决定：一键移除员工时不立即永久删除，而是停止全部服务、移出六类受管路径并从 Registry 移除；7 天内允许恢复。
- 清理：不安装后台 daemon。条目到期后，在下次启动 Web 或运行公开 CLI 时永久清理。
- 存储：组件移动到原父目录下隐藏的 `.agentctl-trash`，中心 manifest 以 0600 保存且不包含文件内容或 Secret。
- 原因：测试员工需要立即从活动列表和路径中消失，同时必须避免误操作导致 Workspace、飞书凭据或正式记忆不可恢复。

## D-009：封存不变量与版本化契约的演进流程

- 状态：Accepted
- 日期：2026-08-03
- 决定：把对外契约分两类管理。**封存不变量（frozen）**：语义对外固定，实现可经安全评审升级--典型为 `assertInside` 的「路径包含由核心执行」语义、Bridge profile `workspace/workspace` 权限不放宽、D-006「SyncSummary 只返回字段名不返回值」。frozen 实现升级须同时满足：(a) 记 ADR；(b) 对外语义不变；(c) 补回归测试；(d) 不放宽安全默认。**版本化契约（versioned）**：可经 schema 版本号 bump + 显式分派调整--典型为 env 白名单（`runtime.ts` `safeInheritedVariables`，及 OP5-B 起外置到 `presets/cc-switch-allowlist.json` 的 CC Switch 白名单）与配置 schema；调整须版本号 bump、显式分派与迁移说明，禁止静默全局改写（与红队 B2 一致）。
- 边界：本决策不改变任何既有不变量的语义，只确立其演进流程。`assertInside`（`paths.ts:77`）保持 frozen 语义，实现允许升级为 realpath 补全（OP2-B）；env 白名单从隐含 frozen 降为 versioned，为后续白名单调整铺路。
- 原因：原 `extension-surface.md` 把上述项笼统标为「封存不变量 frozen」，但安全实现需迭代（realpath 抵抗符号链接、白名单收紧），缺乏「语义不变、实现可演进」的流程会导致要么不敢改、要么静默改坏对外契约。frozen/versioned 二分让安全实现可迭代而不破坏对外承诺。

## D-010：agent.yaml 为 runtime 块单一可写源 + config_hash 漂移检测

- 状态：Accepted
- 日期：2026-08-04
- 决定：`agent.yaml` 的 `runtime` 块（provider/locked/model）为唯一可写真相；Registry 的 `runtime` 块降级为派生缓存，新增 `config_hash`（runtime 块的 sha256）做漂移指纹。`RegistryStore.updateAgent` 拒绝 `model` 直改（`CONFLICT`，提示经 `agentctl repair`）；新增 `RegistryStore.resyncRuntime` 作为 repair 的受信重建路径--允许 model 从 agent.yaml 同步，但 provider/locked 不变量仍强制（违则 `CONFLICT`，不覆盖）。`agentctl repair <id>` 以 agent.yaml 重建 Registry runtime 块 + 刷新 config_hash；doctor 增 `config-drift` 检查（hash 不等或缺失 -> warn，remediation 指向 repair）。create/restore 流程在写 agent.yaml 后即记 config_hash。
- 边界（本批非破坏性增量）：Registry `runtime` 块**不移除**（长期项，需破坏性 schema-bump + migrate，deferred）；`loadPortableConfig` **不启用** I-5 model 收紧校验（框架「待 OP3-A 长期完成 + repair 就绪」，repair 虽就绪但长期未完成）；`agentctl migrate` 命令不实现（属 OP3-B 范畴）；adapter 仍读 `RegistryAgent.runtime.model` 缓存，单源化不改读路径。
- config_hash 取 runtime 块 sha256（非整文件）的裁定理由：精确覆盖 OP3-A 的 runtime 单源范围，避免 archive（写 lifecycle 块）/ identity 文档变更等合法 agent.yaml 改写误报漂移；框架原文「agent.yaml 的 sha256」在此细化为 runtime 块 sha256。
- 原因：红队 B3/W5 指出 Registry 与 agent.yaml 各持 runtime 块（双真相源），`updateAgent` 允许改 model 不同步 agent.yaml -> 静默漂移；收紧校验（I-5）只会把「静默漂移」变「硬砖」而无修复路径。本决策以 agent.yaml 为唯一可写真相 + config_hash 漂移检测 + repair 重建路径，从根因消解双写，而非加校验。经核实四处 `updateAgent` 调用均不动 model、restore 用 `registry.add` 非 `updateAgent`，故 model 守卫零破坏。

## D-011：OP1 Stage A authority_order 运行时强制 + 派生 stance 注入

- 状态：Accepted
- 日期：2026-08-04
- 决定：`agent.yaml.memory` 增 `enforced: boolean`（optional，向后兼容旧 agent.yaml 视为未声明）。`enforced:true` 时 `FactoryApplication.prepareRuntime` 在 spawn 前经 `validateMemoryConfig` 强制校验 `authority_order` 不变量--非空、`'agent'` 必须在场且居首（R26「新层不得排在 agent 之前」）、无重复层；违则 `VALIDATION_ERROR` 硬失败，不让误配 agent 跑起来。`enforced` 缺失（旧）或 `false` 不硬失败（doctor warn），保留降级逃生口。权威顺序 stance 从 `authority_order` 派生为 markdown 段，写入 CLAUDE.md / AGENTS.md（CLI 读取的系统提示文件），替代 ENTRY.md.tmpl 的硬编码散文--改 agent.yaml 即改注入立场。doctor 增 `memory-enforcement` 检查（4 态：undefined warn / false warn / true+无效 fail / true+有效 pass）。新建员工默认 `enforced:true`。
- 边界（本批仅 OP1 Stage A）：不实现 Stage B（knowledge 索引 + recall）/ Stage C（transcript 持久化）/ Stage D（ExperienceExtractor）/ Stage E（archival 后端）--数据可达性门控，逐 Stage 立项；不接 `resolveConflict` 热路径（无 KnowledgeIndex 调用方）；不做 CLAUDE.md/AGENTS.md 内容漂移检测（脆弱，仅 config 级一致性，stance 重建留待未来 repair 扩展）；`schema_version` 不 bump（additive optional 字段）；不动隔离层 / CC Switch / 备份回收。
- documentFile 偏离裁定：框架提及「documentFile 路径强制校验」，经核实 documentFile 已强制身份文档路径不变量（assertInside + realpath + 拒符号链接），即身份文档层（authority 'agent'）的写入约束已就位；在 documentFile 再叠 memory 校验会令误配 agent 无法修复自身身份文档（损害可恢复性）。故 Stage A 的 memory 强制只在 prepareRuntime（pre-run 硬门），documentFile 维持既有路径校验。
- 原因：红队 W1 指出 `authority_order` 硬编码（create-agent.ts）但无任何代码运行时强制，`knowledge/` 5 子目录为空骨架--认知记忆层「声明型、不强制、随 schema 演进被误删」（maintainability-review §2.5）。设计原则「先让既有声明型字段成为运行时强制项，再谈新增检索层」（A1）：本决策先把 authority_order 从声明升级为运行时强制 + 派生注入，避免新增检索层（Stage B）重蹈「声明不强制」覆辙。enforced 三态保证向后兼容（旧 agent.yaml 不硬砖）+ 可降级（false 逃生口）。

## D-012：OP3-A 长期——Registry 移除 runtime 块 + config_hash 硬校验 + SOFT 版本化迁移

- 状态：Accepted
- 日期：2026-08-04
- 决定：把 D-010 的中期收敛推进到长期目标——**从 Registry 彻底移除 `runtime` 块**（provider/locked/model），使 `agent.yaml` 成为 runtime 的**唯一**来源；同时启用 D-010 推迟的 **I-5 model 收紧**（model 一致性纳入强制校验）；并新增破坏性 `agentctl migrate` 命令处理 schema v1→v2 升级。删除 registry runtime 块是安全的：其中所有数据（provider/locked/model）都存在于 agent.yaml，它纯粹是派生缓存。
  - **I-5 = HARD 硬校验**：`loadPortableConfig` 校验 `config.id === agent.id` 且 `computeConfigHash(config.runtime) === agent.config_hash`；任一不符（含 config_hash 缺失）抛 `CONFLICT` 阻断运行，remediation 指向 `agentctl repair`。`repairAgent` 是逃生口——绕过 `loadPortableConfig` 直接 `readAgentConfigFile` 读 agent.yaml 原样，重算 config_hash 并 `registry.refreshConfigHash` 修复。
  - **Registry migrate = SOFT 版本化读取**：`read()` 对 v1 文件在内存中规范化为 v2（丢弃 runtime 块、保留 config_hash 与其余字段，零数据丢失），命令照常可用；`agentctl migrate --dry-run` 预览、`agentctl migrate` 重写磁盘为 v2 清理残留。未知版本抛 `VALIDATION_ERROR`。
  - **list()/dashboard() provider = N+1 读 agent.yaml**：逐个读每个 agent.yaml 取实时 provider（单一真相源，派生缓存永不漂移）；缺失/无效 yaml 容错显示 `unknown`。
- 边界：`migrate` 为破坏性命令（改磁盘格式），但 SOFT 语义保证 v1 文件不迁移也能继续运行（内存规范化），故不强制用户立即迁移；旧 v1 备份的 `registry-agent.yaml` 在 restore 时用 `registryAgentSchema`（v2）解析，provider 从恢复的 agent.yaml 读取。
- 原因：D-010 是中期收敛（registry runtime 块仍为派生缓存、`loadPortableConfig` 未启用 I-5、`migrate` 未实现、adapter 仍读缓存）；长期目标要求单一真相源不再有派生缓存副本，消除双真相源残余与「缓存永漂移」问题。HARD 校验把「静默漂移」变「硬砖」，但 D-010 已就绪的 repair 逃生口保证可恢复；SOFT 迁移避免破坏性升级强行打断 v1 用户。

状态使用 Accepted、Superseded、Proposed。日期来自已验证的实现或提交；无法证明的动机不写成事实。

## D-013：OP2-F 扩展面能力隔离——扩展点限定为 data-only / adapter-interface

- 状态：Accepted
- 日期：2026-08-04
- 决定：把可扩展点（`BackupFilter`、`PathLayout`、`PortableMemorySchema`、未来的 `CredentialProvider`）收敛为**纯数据（data-only）或 adapter 接口**契约，禁止同进程 JS 模块直接持有 `fs`/`execa`。代码型扩展（若未来需要）必须运行在子进程/Worker 并经 IPC 限制能力。具体落地：
  - `src/core/extensions.ts`：定义 `ExtensionKind = 'data-only' | 'adapter-interface' | 'subprocess'` 与评审用 `ExtensionSandbox` 契约类型（v1 不固化加载器）。
  - `src/core/backup.ts`：`shouldCopy`/排除名单从模块级硬编码收敛为 `BackupFilter` 接口 + `defaultBackupFilter()`（纯函数、零 I/O），`BackupService` 构造注入。
  - `src/core/paths.ts`：`PathLayout` 接口（根必须位于 home/workspaceRoot 树内）+ `resolvePathLayout` 派生助手。
  - `src/schemas/agent-schema.ts`：导出 `PortableMemorySchema` 类型（memory 块权威类型，供扩展点引用）。
- 边界：本批只确立契约与默认实现，不实现加载器、不新增任何可执行扩展；`assertInside`/`assertInsideReal` 不变量语义不变；`RuntimeAdapter`/`ServiceAdapter` 等已固化扩展点保持接口形态（`buildExecEnv` 委托 adapter 属 OP3-C 已落地）。
- 原因：红队 R23 指出扩展点若以同进程 JS 模块加载并直接持有 `fs`/`execa`，会在扩展机制建立的瞬间引入「插件可触碰宿主文件系统/进程」的权限面。把扩展点约化为纯数据或受限 adapter 接口，从根因消除该面，而非事后加校验。与 D-009（frozen/versioned 二分）一致：data-only 契约不放松安全默认。

## D-014：OP1 Stage E archival 后端写入前置约束（frozen 不变量，先于任何后端实现）

- 状态：Accepted
- 日期：2026-08-04
- 决定：把 archival 后端的写入约束写成 **frozen 不变量**，在任何后端实现之前先确立契约。`src/core/archival.ts`（新增）仅定义 `ArchivalBackend` 接口（`kind: 'local-sqlite' | 'external' | 'none'`，默认 `none`），不实现任何后端。未来新增后端的 **写入硬约束**（frozen，实现不得放宽）：
  1. **Secret 过滤**：写入前必须经核心 secret 正则（`SECRET_PATTERN`）过滤，禁止原始 Secret 落盘。
  2. **per-entry 显式授权**：必须经用户显式 per-entry 授权，不得隐式归档用户未确认的内容。
  3. **范围隔离**：不得传输 `runtime_home` / `bridge` 内容；仅工作区可迁移身份知识（`knowledge/`、identity 文档）可归档。
  4. **威胁模型评审**：网络面 / 多租户威胁模型须经安全评审（external 后端尤其如此）。
- 边界：本批只确立契约与文档，不实现 `local-sqlite` / `external` 后端，不接入任何调用方，不改变既有 `PruneService` 归档区清理语义（`archives` 清理范围照旧）。archival 后端与既有本地归档区（archive/trash）是不同概念：前者是外部/持久化归档目标，后者是本地可恢复目录。
- 原因：OP1 Stage E 的目标是把「归档到外部后端」这个未来能力的安全边界先钉死，避免实现时引入 secret 泄露（写原始 transcript/内存）或越权传输（把 runtime_home/bridge 内容带出）。与 D-006（不落盘 Secret）、D-009（frozen/versioned 二分）、D-013（扩展点限定 data-only/adapter-interface）一致——先约束后实现。

## D-015：换机重授权成本（OP5-C 调研裁定）

- 状态：Accepted
- 日期：2026-08-04
- 决定：换机重授权可显著降低但不为零，保留「交互授权」为硬边界。调研结论（详见 `.scratch/op5-c-migration.md`）：
  1. **Codex OAuth token 可迁移**：`~/.codex/auth.json`（0600，含 `id_token`/`access_token`/`refresh_token`/`account_id`）官方文档确认**不绑定主机**，可在换机时复制；但 token 会轮换（文件随时间变化），且若用户配置 Keychain 存储（`cli_auth_credentials_store = "keyring"`）则复制法不适用，须重新登录。
  2. **飞书非扫码路径存在**：`lark-channel-bridge profile create --app-id --app-secret --tenant` 用既有 Feishu/Lark 应用凭据建 profile（App Secret 进加密 keystore `profiles/<name>/secrets.enc`，0600），无需扫码；但 `--app-secret` 建议交互输入，扫码路径仍须人在场（D-005）。
  3. **Claude 已非交互**：CC Switch 同步（OP5-B 起带 mtime 缓存 + `.cc-switch.env` 降级）换机 0 次交互，仅需新机配置 CC Switch。
  4. **不实现 `agentctl migrate` 向导**（`MigrationWizard` 接口保持设计级草图）：OP5-C 原始为「立项评估，非承诺」，当前交付以文档明确换机清单与可降低路径，而非强推自动化。推荐配置下每员工 0 次交互，最坏情形每员工 2 次（Codex 重登 + 飞书扫码）。
- 边界：本裁定不引入任何代码改动；Factory 不自动复制/注入凭据（守 D-006——复制 `auth.json`/App 凭据属用户在换机时的主动运维行为，不在 Factory 自动传输面）。`agentctl migrate` 仍指 Registry schema v1→v2 迁移（OP3-A 长期，TASK-019），不扩展为换机向导。
- 原因：C4 评估「10 员工 × 3 次交互授权」过高——实际调研显示 Codex token 可迁移、飞书有 App 凭据路径、Claude 已非交互，推荐配置下可降至 0 次/员工。文档交付比强推向导更符合「非承诺」立项边界，避免为实现而实现。

## D-016：OP5-D per-agent Provider 绑定（Registry 本机侧，不进便携文件）

- 状态：Accepted
- 日期：2026-08-04
- 决定：为 Claude 员工新增「绑定 CC Switch 中具体 Provider（而非当前 live）」的能力。`registryAgentSchema` 增 `credential_provider?: string`（Registry 本机绑定侧）；`syncCcSwitchClaudeProvider` 增 `providerName` 参数，指定时从 `~/.cc-switch/cc-switch.db`（SQLite）读取该 Provider 的 `settings_config`（白名单过滤，复用 OP5-B），否则沿用 live `settings.json`。`agentctl runtime sync <id> --provider <name>` 写绑定并同步，`--provider live` 清除绑定回退 live；spawn 前 `prepareRuntime` 把 `registry.credential_provider` 透传给同步。doctor 增 `credential-provider` 检查：有绑定 → warn（短期语义，长期将按 provider 不匹配 fail），无绑定 → pass。
- 读库机制：CI/运行时基线 Node 20.19 无 `node:sqlite`（Node 22.5+），不引入原生依赖；改用 `sqlite3` CLI 只读查询（`-readonly -json`，macOS/ubuntu CI 均自带）。sqlite3 打开不存在的文件失败（退出码 1）→ 报 NOT_FOUND 并列出可用 Provider；不存在的 Provider → NOT_FOUND。名称经单引号转义（`''`）嵌入 SQL，避免注入。sqlite3 缺失/读取失败时回退为 NOT_FOUND（比静默绑定错误 Provider 更安全）。
- 边界（本批短期语义）：`credential_provider` **不进便携文件** `agent.yaml`——属 Registry 本机绑定侧（守 D-006 与 OP3-A「agent.yaml 为 runtime 唯一真相」的便携面），换机不迁移该绑定；`--provider live` 显式清除。不实现「自动读取 live」外的任何多 Provider 指纹校验（研究提案 C5 明确不采用 `pinned_provider` 指纹方案）。doctor 短期为 warn（非 fail），长期语义（provider 不匹配 fail）留待后续批次。
- 原因：让不同员工可绑定不同 CC Switch Provider（如 A 员工用 DeepSeek、B 员工用 Kimi），独立于当前 live Provider 切换，且不复制凭据到便携文件、不改任何既有 live 同步语义（缺省 providerName 时零行为变更）。CI 无 sqlite3 时的 NOT_FOUND 回退符合「显式绑定不可达则失败」的最小惊讶原则，避免静默同步到错误 Provider。

## D-017：Chief 交叉审查用编排器单向搬运，不放开 D-003

> **⚠️ 已废弃（D-027）**：Chief 编排与 Todo 状态机已整体移除，本决策不再适用。

- 状态：Accepted（grilling 待实施）
- 日期：2026-08-05
- 决定：Todo/Chief 的「等待审查」态由 Chief 交叉审查，但 Chief **不直接读写任一 worker 的 workspace**。Node 编排器读 worker 的 `diff.patch`（受控工件）+ `logs/<workerId>/runs/<slug>/stdout.log`，经 `redactSecrets` 脱敏后拼进 Chief 的 REVIEW_PROMPT，Chief 返回评审结论。编排器单向搬运文本，Chief 自始至终零 worker 文件系统访问。
- 边界：D-003（「Agent 永不共享实时目录」）保持不动，无需放开。拒绝「显式授权只读挂载」方案（需新只读 runtime 模式，claude 无只读 flag / codex sandbox 写死 workspace-write，工程量大且直接放宽隔离）。
- 原因：Chief 交叉审查（用户选择）与 D-003 隔离模型冲突；编排器单向搬运是唯一两全路径——Chief 的「看到」是编排器喂文本，不是开文件系统。工人产物写自己 workspace（git 版本化），编排器只读受控工件 + 日志，脱敏后喂给 Chief。

## D-018：MCP 认证——MVP 用静态 bearer，OAuth AS 自建降级为后续阶段

> **⚠️ 已废弃（D-027）**：MCP 接入已整体移除，本决策不再适用。

- 状态：Accepted（已实施，T11）
- 日期：2026-08-05
- 决定：MCP 接入挂到现有 Fastify `POST/GET /mcp`，MVP 认证用**静态 bearer token**（随 `startWebConsole` 生成并打印，客户端用 `Authorization: Bearer <token>` 连接）。实现采用 `@modelcontextprotocol/sdk@^1.30.0` 的 `StreamableHTTPServerTransport`，经 `request.raw`/`reply.raw` 直接接到既有 Fastify 实例（共享进程生命周期）；认证为手写 `mcpAuthorized`（`Bearer` 正则 + `crypto.timingSafeEqual` 恒定时间比较）；loopback 边界复用既有全局 `onRequest` 的 127.0.0.1 校验。自建 OAuth Authorization Server（token 签发 + DCR + 授权码/设备流程）降级为后续阶段。
- 边界：MCP 是同一 loopback 边界上的第二个认证面——D-005「不提供账号系统」针对 Web 的语义不变，MCP 加 bearer 不改其语义（仍无账号、仍 loopback-only）。`/mcp` 不在 `/api/v1/*` 的 CSRF 钩子范围内（server.ts onRequest L136 对非 /api/v1/ 直接 return），互不干扰。
- 原因：用户最初倾向「OAuth 2.1 为主」，但经逐包核实，`@modelcontextprotocol/server@2.0.0` 只提供 **Resource Server（token 校验）侧**（`OAuthTokenVerifier` 接口、`verifyBearerToken`、RFC 9728 metadata），**不含 Authorization Server**——无 token 签发、无 DCR、无授权码流程，且 `@modelcontextprotocol/oauth` 包不存在（404）。「OAuth 为主」意味着从零自建 AS，远超 MCP 最小切片。Static bearer 是 MCP 三端（Claude Code/Cursor/VS Code）共同支持的最低公分母，先把能力接通。实现时另核实 `@modelcontextprotocol/fastify@2.0.0` 的 `createMcpFastifyApp` 会自建独立 Fastify 实例（无法挂进既有 /api/v1 控制台），且 `@modelcontextprotocol/server` 的 bearer 校验叠加非必要 OAuth 依赖链，故以 `@modelcontextprotocol/sdk` 的 StreamableHTTP transport + 手写恒定时间 bearer 落地（D-018 决定行据此于实施期修订）。OAuth AS 留作独立后续阶段。

## D-021：MCP 工具集——读 + 编排写，单一应用 seam，JSON 主路径响应

> **⚠️ 已废弃（D-027）**：MCP 接入已整体移除，本决策不再适用。

- 状态：Accepted（已实施，T12/T13）
- 日期：2026-08-05
- 决定：在 D-018 的 MCP 端点注册 **13 个工具**——读 8：`list_agents`/`get_agent`/`list_operations`/`get_operation`/`list_jobs`/`list_skills`/`read_latest_log`/`knowledge_recall`；编排写 5：`create_task_plan`/`run_task_plan`/`approve_plan`/`review_task_plan`/`cancel_operation`。工具是 `FactoryApplication` 的**薄适配器**（`McpBackend` 接口注入 `options.application`），穿过应用编排层单一入口，与 Web/CLI 共享同一行为（spec 阶段 3 的测试 seam 原则）。`run_task_plan` 返回排队态 `OperationDto`，客户端轮询 `get_operation`（主路径轮询）；`cancel_operation` 复用 `operationManager.cancel(id)`。
- **JSON 主路径响应（偏离 spec 措辞的 SSE→MCP）**：transport 以 `enableJsonResponse: true` 运行，POST JSON-RPC 请求返回 JSON 响应体（而非 SSE 帧），简化轮询客户端集成；GET `/mcp` 的 SSE 流保留。spec 阶段 3 的「SSE→MCP / 主路径轮询 = 工具返回 OperationDto + 轮询 get_operation」语义不变，仅传输槽位从 SSE 帧改为 JSON 响应。客户端仍须在 initialize 后携带 `mcp-session-id`。
- 边界：脱敏约束由应用 seam 保证——`AgentConfig`/`RegistryAgent` 均不含原始 Secret（token/app_secret 不进入便携配置），MCP 层不新增任何 secret 读取面；测试固定「读工具不泄露注入工作区的 secret 形态 token」作为回归守卫。`list_operations`/`run_task_plan`/`read_latest_log` 的过滤/并发/行长参数为 spec 之外的合理性 affordance，不改变 spec 工具语义。
- 原因：spec 阶段 3 的 grilling Q9 明确读+编排写工具集；thin-adapter 保证三面（CLI/Web/MCP）共用同一行为与脱敏约束，避免 MCP 形成第二套逻辑。JSON 主路径响应降低 MCP 客户端（Claude Code/Cursor/VS Code）轮询成本，SSE 增强路径（请求内 progress）与推送路径（subscriptions/listen）均留作后续。

## D-022：Web Todo 视图渲染审查结论，不持久化原始 diff

> **⚠️ 已废弃（D-027）**：Web Todo 视图随 Chief 编排/Todo 移除，本决策不再适用。

- 状态：Accepted（已实施，issue 07）
- 日期：2026-08-05
- 决定：Web 员工详情页「Todo」标签渲染**已存储的审查结论** `item.review { verdict, note }`（verdict 本地化为已通过/已驳回），**不展示原始 diff**。原因：按 D-017，`reviewTaskPlan` 由编排器从 worker workspace **实时读取** `diff.patch` 与运行日志、脱敏后喂 Chief，原始 diff **不写回计划文件**——计划文件只持久化 Chief 返回的结构化 verdict+note。因此 Web 无从读取 diff（它只读计划文件），展示 verdict+note 是唯一不新增网面的选择。
- 边界：issue 07 的「走完 Todo 流程」原只含看状态、确认/驳回计划、确认合并/驳回审查——**创建/派发/Chief 发起由 D-024 于 TASK-027 放开**（Web 可编排）；本决策的「Web 不实现派发与任务项创建」措辞被 D-024 取代，但「不展示原始 diff」边界保持。若需 Web 展示原始 diff，属后续增强（读 worker 产物路径，见 ARCHITECTURE「Chief 编排与 Todo 状态机」）。
- 原因：避免 scope creep（派发是 CLI 范畴）与避免为展示 diff 而放开隔离语义/新增读面；保持 Web 只读 + 两种闸门（计划级确认/驳回、审查级合并/驳回）的最小网面。

## D-024：Web 编排写面开放——创建/派发/Chief 发起/单轮对话，全部后台 Operation

> **⚠️ 已废弃（D-027）**：Web 编排写面（建计划/加任务项/派发/Chief 发起）随 Chief 编排/Todo 移除；「单轮对话」部分保留（`/actions/chat`，D-024 的对话语义不变）。

- 状态：Accepted（已实施，TASK-027）
- 日期：2026-08-05
- 决定：放开 D-022/D-023 的「Web 只读」边界，Web 控制台新增编排写面与单轮对话：
  - **Todo 写面**：`POST /api/v1/agents/:id/task-plans`（建计划，planId 由 Web 生成 `plan-<8hex>`）、`POST .../task-plans/:planId/items`（加任务项）、`POST .../task-plans/:planId/actions/run`（派发）。
  - **Chief 发起**：`POST /api/v1/agents/:id/actions/chief-run` —— `startPlanWithChief` 把阻塞的 `planWithChief` 放进后台 Operation（拆解耗时几十秒不阻塞 HTTP），完成后停在 draft 等人工确认；确认/驳回是独立显式步骤（等价 CLI inquirer 门）。
  - **单轮对话**：`POST /api/v1/agents/:id/actions/chat` —— 走 `runLogged`（复用 transcript/experience 管线，`transcript_persist` opt-in），`claude -p`/`codex exec` 非交互单轮，无需新 adapter；Operation 完成时把最终回答作为 output 事件写入，前端轮询读回。
  - **统一模式**：全部写操作返回 202 + `OperationDto`（后台 Operation），前端轮询 `/api/v1/operations/:id/events`；不引入同步长请求。Web 与 CLI/MCP 共享 `FactoryApplication` 同一编排层（D-021 单一应用 seam 原则）。
- 边界：**原始 diff 仍不持久化**（D-022 保持——Web 仍不展示 diff，审查结论 verdict+note 是唯一持久化形态）；对话会话记录不落盘（D-006 的 transcript 边界——`runChat` 无锁、`mirror: false`，与 CLI chat 一致）；`concurrency` 仅作派发参数，Chief 发起时不自动派发。S3（飞书入站创建 todo）无入站基础设施，单独立项。
- 原因：用户要求「相关功能可以在 Web 使用、以及与 agent 对话生效」。后端编排方法全齐（MCP 写工具已直连，D-021），Web 只缺写端点与按钮；运行时本就支持非交互单轮（`claude -p`/`codex exec`），无新 adapter 面。飞书入站是全新网络面 + 安全评审，超本任务范围。

## D-023：Chief Web 编排流水线视图——派生状态，不新增写面

> **⚠️ 已废弃（D-027）**：Chief 编排视图随 Chief 编排/Todo 移除，本决策不再适用。

- 状态：Accepted（已实施，issue 10）
- 日期：2026-08-05
- 决定：Web 新增「Chief 编排」视图（仅 `role=chief` 员工显示该标签），把 Chief 拥有的每个目标（plan）渲染成一条流水线卡片：**阶段条**（拆解 → 计划确认 → 执行 → 审查 → 结果）与**聚合整体进度**（如 `2/3 完成 · 1 待审查`）。阶段点亮与整体状态均为**纯派生**（`derivePipeline`/`summarizePlan`，从 plan.status + item 状态分布计算，无副作用、可单测）——不落盘、不改后端 schema、不新增端点，计划文件仍是唯一事实源。
- 阶段条语义（**累计到达门**）：每个阶段一旦达成即常亮、不随执行结束熄灭——完成计划的五段全亮，中途终止（cancelled 且曾派发）亮到已执行阶段，驳回未派发（cancelled 且全项 pending）仅亮「拆解」。**「曾派发」= 任一任务实际运行过（离开 pending 且非 cancelled）**——计划内被单独取消的项不算派发。进度聚合排除 cancelled 项（不进分母，不可能完成）。
- 边界：**本视图本身仍纯派生**（阶段点亮/聚合进度不落盘、不改 schema）；Web 编排写面由 D-024 放开（创建/派发/Chief 发起走 Web，均后台 Operation）——本决策的「不含发起编排入口」措辞被 D-024 取代，但派生语义不变；Chief 视角不替代 Todo 标签（Todo 是逐项操作视图，Chief 编排是目标级流水线仪表）。
- 原因：issue 07 已覆盖任务项级渲染，issue 10 的真正增量是目标为中心的流水线呈现与进度聚合；派生态避免为「是否来自 Chief 拆解」新增持久化字段（plan 有 items 即视为拆解完成），保持切片最小。

## D-025：CURRENT_STATE.md 自动更新——系统侧生命周期事件 + 员工自维护，自动 git 提交

- 状态：Accepted（已实施，TASK-028）
- 日期：2026-08-05
- 决定：`agent/CURRENT_STATE.md` 从「创建时写一次、之后全靠 Web 人工编辑」升级为**系统自动维护 + 员工自维护**双通道：
  - **文件结构**：`<!-- factory-auto:begin -->`/`<!-- factory-auto:end -->` 标记块内为行级 KV（状态/运行器/飞书/最近事件），由系统管理；块外「工作进展」段由员工维护，系统不覆盖。
  - **系统侧覆盖面 = 仅关键状态**：运行器登录成功（`runtimeAuth`）、飞书授权成功（`bridgeAuthorize`）、服务启停（`lifecycleAction`）、归档与恢复（`archiveAgent`/`restoreTrash`/`restoreBackup`）时自动更新标记块内相关行；**任务/对话完成不自动写**（避免频繁刷屏，任务进展属「工作进展」段员工自维护）。
  - **更新语义**：有标记块只重写目标 key 的行、块外内容原样保留；无标记块且内容等于旧种子模板 → 自动升级为标记块格式；无标记块且被人工改过 → **跳过并警告**（永不覆盖他人成果）。
  - **自动 git 提交**：系统更新后 `git add -- agent/CURRENT_STATE.md` + commit（**绝不用 `add -A`**，防误收员工未提交的工作成果；缺 git 身份不阻断，best-effort）。Web 人工保存**不触发**自动提交（保持「Git 未提交」badge 语义——badge 是单文件 `git status`，自动提交后不再因系统写入常亮）。
  - **员工侧通道 = 引导约定 + 权限放行**：CLAUDE.md/AGENTS.md 模板追加「工作开始/结束时更新工作进展段」指令（标记块为系统管理勿改、无需手动 git 提交）；claude 侧工作区 `.claude/settings.json` 放行 `Edit/Write(agent/CURRENT_STATE.md)`（`defaultMode` 保持，避免员工每次编辑弹权限确认）；存量员工由 `prepareRuntime`（chat/run/runJob/start 前都会调用）幂等补放行。
- 边界：状态更新不落 `saveDocument` Web 通道（事件路径走同构的直接调用 + git 提交）；不加锁（与 Web 人类保存独立，atomic 替换防损坏）；员工运行中系统并发写入靠标记块边界隔离。任务完成/对话不自动写状态。
- 原因：员工详情状态文档与实际情况脱节（登录/授权/启停/归档后仍显示「已创建」）；系统侧生命周期事件产生结构化信号但无写入通道；员工（AI）子进程跑在工作区、天然能编辑文件，缺的只是引导指令与权限。

## D-026：员工自我进化——岗位/目标/工作系统/规则 + knowledge 自动提交

- 状态：Accepted（已实施，TASK-029）
- 日期：2026-08-05
- 背景：员工是 Claude/Codex 子进程，可编辑工作区文件，但只有 `CURRENT_STATE.md` 被放行且自动提交，岗位/目标/工作系统/规则文档既无修改引导、也无权限放行、改动了也不自动提交；员工的学习成果没有持久化通道，每次执行都从默认文档重新开始，无法积累。
- 决定：
  - **员工自我进化**：员工可在任务执行（developing）阶段更新 `agent/ROLE.md`（岗位）、`GOALS.md`（目标）、`OPERATING_SYSTEM.md`（工作系统）、`POLICIES.md`（规则）与 `knowledge/` 知识，让下次执行更准确。两个 ENTRY.md.tmpl 追加「自我进化」引导节（只在 developing 更新，保持文件结构；变更记录到 CURRENT_STATE.md「工作进展」；不手动 git 提交）。
  - **权限放行**：`ensureAgentDocsAllowed(workspace, relPaths)` 参数化复用 CURRENT_STATE 放行模式，为四份自维护文档生成 `Edit/Write` 规则幂等合并；`prepareRuntime` 调用放行（存量员工自动升级）。员工不可修改 `.claude/settings.json` 扩大自身权限。
  - **自动 git 提交**：`commitSelfEvolution` 在 `runAgent`/`runChat`/`runJob` 成功后检测四份文档变更并单文件提交（`evolve: 更新 <basename>`）；`knowledgeWrite`（含经验提取写回 `knowledge/lessons/`）提交 `evolve: 更新知识`。均 best-effort（缺 git 身份/抛错仅 console.warn 不阻断主流程），单文件提交绝不用 `add -A`。
- 边界：`config_hash` 只含 runtime 块，员工改 `agent/*.md` 不触发漂移告警；Web 人工保存 `agent/*.md` 仍不自动提交（保持「Git 未提交」badge 语义）。
- 原因：员工的学习成果没有持久化通道，每次执行都从默认文档重新开始，无法积累。
- 注：本决策原含「派发进度可观测」半（`OperationDto.summary` + CLI 进度行），该半随 Chief 编排/Todo 移除而一并移除，见 D-027。

- 状态：Accepted
- 日期：2026-08-03
- 背景：本项目需要被多个 AI Agent 并行编辑或在任意时刻交接，必须有持久化的事实来源替代易失的聊天上下文。
- 候选方案：仅依赖聊天记录；仅用 Git 分支无簿记；铺设 `.agent/` 协作簿记 + 文档体系骨架。
- 最终选择：通过 `multi-agent-project-skill` 的 `init_workspace.py` 生成完整骨架（入口层 + docs + skills + `.agent/` + 技术栈基线）。
- 选择原因：仓库是持久事实来源；簿记层让无聊天记录的 Agent 也能接手；文档体系让规则与代码不漂移。
- 影响范围：项目根、`docs/`、`skills/`、`.agent/`、`.github/workflows/ci.yml`、`.gitignore`。
- 后续注意：`.agent/` 必须提交到仓库；平台适配文件只指向 AGENTS.md，不复制规则。

## D-027：移除 Chief 编排 / Todo 状态机 / MCP 接入

- 状态：Accepted（已实施，TASK-030）
- 日期：2026-08-05
- 背景：用户经使用后明确判断「Chief 编排 + Todo 状态机 + MCP 接入都去掉，没啥用，不是我想要的东西」。这三块是此前按 spec-chief-orchestration / spec-chief-todo-mcp 逐步加进来的协作编排层，复杂且非目标。
- 决定：
  - **移除 Todo 状态机 + Chief 编排（合并）**：删除 `task-schema.ts`/`task-store.ts` 与全部 plan/编排方法（`createTaskPlan`/`runTaskPlan`/`orchestrate`/`reviewTaskPlan`/`planWithChief`/`waitOperation` 等）及私有辅助（派发/审查/拆解提示词、`parseReview`/`parseDecompose`、`isDone`/`progressOf`/`summaryOf`、`withPlanLock`）。`runAgent` 的 `commitSelfEvolution` 改无条件调用（去掉 `skipSelfEvolution` 守卫）。
  - **移除 MCP 接入（整块）**：删除 `mcp-server.ts`、`POST/GET /mcp` 路由、`enableMcp`/`mcpToken` 选项、`web --mcp` 与 `@modelcontextprotocol/sdk` 依赖。
  - **移除派发进度反馈（D-026 半，用户拍板一并移除）**：`OperationDto`/`OperationEvent` 去掉 `summary` 字段，CLI 进度行一并删除。
  - **保留**：`OperationManager`/`OperationStore`/`OperationDto` 共享基础设施（run/chat/job/backup/doctor/restore 与 Web 操作中心依赖）；`runAgent`/`runChat`/`runJob`、`commitSelfEvolution`、knowledge/skills/backup/trash/prune/doctor、Web「任务」标签（= 定时 Job）。`AgentRole`/`role` 字段（worker/chief）保留 schema 位（前向兼容），不再有 Chief 编排/UI/CLI 特殊化。
- 边界：只删上述三块及其直接依赖；共享基础设施原样保留。删除后 `OperationDto.summary` 无消费方。
- 原因：用户明确判断这三块复杂且非目标；回退到「单一 AI 员工 + 定时 Job + 对话」的核心模型，聚焦用户真正想要的东西。
- 影响：废弃 D-017、D-018、D-021、D-022、D-023、D-024（已标注）；D-026 改写为仅保留「员工自我进化」半。

---

## D-028：员工自我配置定时任务（按需）

- 状态：Accepted（已实施，TASK-031）
- 日期：2026-08-05
- 背景：用户需求「允许员工给自己配置定时任务 按需」。现状是 Job 定义存员工 workspace `automation/jobs/*.yaml`，由 launchd plist 定时触发，但只有管理员能创建/调度（`setJobEnabled` → `enableScheduled`）——员工即使写了 YAML 也不会产生任何调度。
- 决定：
  - **managed_by 标记**：`jobConfigSchema` 加 `managed_by: 'admin' | 'employee'`（缺省 admin，向后兼容）。同一目录，Web 显示 `[管理员]/[员工]` 徽标。
  - **自动生效**：员工 `enabled: true` 的 job 在每次 run/chat/job 结束后自动 reconcile（`src/core/job-reconcile.ts` 的 `reconcileEmployeeJobs`，best-effort），安装 launchd 调度，无需人工审批。
  - **文件 YAML 自我进化**（D-026 模式延伸）：员工在任务中写/改 `automation/jobs/*.yaml`，系统自动检测→调度→单文件 git 提交（`git add -- <relPath>`，绝不用 `add -A`）。
  - **清单**：`schedules/<agent>/.employee-jobs.json` 记录上次已调度的 employee job 及其 `schedule.time`，用于检测删除/停用/改时间：删除或 `enabled:false` → 反注册（bootout + 删 plist）；`schedule.time` 变更 → 先反注册再重装（让 launchd 重新加载日历）。
  - **权限放行**：`prepareRuntime` 幂等放行 `automation/jobs/**` 与 `automation/prompts/**`（仅 UX 平滑，非硬权限门——员工本就在 workspace 权限内）。
  - **引导**：ENTRY 模板加「定时任务自我配置」节；种子 `automation/jobs/README.md` 说明 managed_by 协议。
- 边界：
  - 只对 `managed_by: employee` reconcile；管理员 job 不受自动 reconcile 影响。
  - 单 job 校验失败（schema/路径逃逸 `assertInsideReal`）仅跳过该 job，不阻断其余。
  - 脚本/job 仍以员工 runtime 的 workspace 权限运行，路径限制在 workspace 内，不扩大权限；员工不可改 `.claude/settings.json` 扩大权限。
- 原因：把「员工自我进化」从「改文档」扩展到「配置自己的定时任务」，让例行工作自动化而无需每次人工；同时用 managed_by 明确边界，防止员工意外改动管理员任务。
- 影响：新增 `JobStore.listTolerant()`（容错列举）；`factory-application.ts` 的 runAgent/runChat/runJob 后接 reconcile。

---

## D-029：描述生成员工 + 拓宽自进化（移除预设）

- 状态：Accepted（已实施，TASK-032）
- 日期：2026-08-05
- 背景：用户提出方向转变——创建员工不应靠预设（用户运营/商业化等），而应由用户按需描述、AI 自动生成可编辑的员工蓝图；且员工应能在使用中自我进化、减少人工修改的模块。调研确认现创建是纯预设驱动、且无任何「模型生成」能力。
- 决定：
  - **描述 → 生成员工蓝图**：用户在 Web（或 CLI `--describe`）一句话描述员工用法 → 调用本地 Claude CLI（`claude -p --output-format json`，用户默认环境，**不设 CLAUDE_CONFIG_DIR**，与员工隔离 runtime 无关）→ 生成结构化蓝图（`id`/`name`/`description`/`goals`/`responsibilities`/`policies`/`escalation_conditions`/`skills`）→ 表单可编辑 → 确认创建。新模块 `src/core/employee-generator.ts`，复用 `parseStructuredResult` 抽正文、剥离 markdown 代码围栏后按 `generatedProfileSchema` 校验；失败抛 `OPERATION_FAILED`，remediation 提示重试或手动 `--description/--goal`。
  - **完全移除预设**：删除 `presets/*.yaml` 与 `loadPreset`；`CreateAgentInput` 去 `preset` 字段，新增 `responsibilities/policies/escalation_conditions/skills`；`resolvePreset` → `synthesizeProfile`（始终从 `description`+`goals` 合成，缺省 responsibilities/policies/skills 有安全默认）。`presets/cc-switch-allowlist.json`（CC Switch 白名单）与员工预设无关，保留。
  - **拓宽自进化**：`commitSelfEvolution` 从四份身份文档扩展到内容目录 `skills/**`、`workflows/**`、`knowledge/**`——员工在一次 run/chat/job 中新建/修改的任何内容（含未跟踪新文件）自动单文件提交，沿用 `git add -- <relPath>`，绝不用 `add -A`。不扫 `tasks/`、`reports/`、`scripts/`、`config/`、`logs/`（gitignore 已排除敏感/派生文件）。
- 边界：
  - 生成 prompt 仅含用户本人输入的描述，不读秘密；模型被要求只输出 JSON；蓝图权限边界（policies）由系统提示锁定为 workspace 沙箱内 + 高危操作人工审批。
  - 自进化只扫内容目录，单文件提交，不收未提交流程产物；员工权限不变（workspace 沙箱，生产写入/对外发布/推 Git/删数据须审批），员工仍不可改 `.claude/settings.json` 扩大权限。
- 原因：预设是「固定岗位模板」，无法覆盖用户的长尾自定义需求；让员工按需一次性描述、AI 生成蓝图，并把「员工自我进化」从文档扩展到员工写的所有内容，是最小人工的路径。
- 影响：新增 `generateEmployeeProfile`/`generateProfile`；Web 创建页步骤 0 改为「描述 + AI 生成 + 可编辑表单」；CLI `create` 加 `--describe`、去 `--preset`；自进化钩子覆盖内容目录。

---

## D-034：AI 员工自建 Skill（完整闭环：触发 + 生成 + 校验 + 投影 + 回滚）

- 状态：Accepted（已实施，TASK-034）
- 日期：2026-08-06
- 背景：员工在任务中无法让自己真正用上新 skill。已有 skill 存储/投影/版本化基础设施（`SkillService.install`、D-029 `commitSelfEvolution`、`experience_extraction`），但缺「员工自主生成 + 注册 + 校验 + 回滚」的编排层。调研确认 Claude 里「注册 skill」的本质 = 把合法 `SKILL.md` 放进发现目录（无编程式 API，下次会话自动发现）；参考 Voyager（技能库版本化）、Claude Agent SDK skills（注册=落盘契约）、PraisonAI（Shadow Git Checkpoints 回滚）。
- 关键缺口：员工手写 `workspace/skills/<name>/SKILL.md` 只被 D-033 fallback 识别为「可见」，不会被软链投影到 `.claude/skills/<name>`（投影只在 `install()` 时做）→ Claude 实际发现不到、用不了。
- 决定：
  - **生成器** `src/core/skill-generator.ts`：复用 employee-generator（D-029）的 `claude -p --output-format json` + `parseStructuredResult` + `extractJson` + Zod 范式；`generateSkill(brief)` 产出 `GeneratedSkill`（name/version/instructions/triggers），`renderSkillFile` 渲染 SKILL.md。安全 prompt 锁定 workspace 沙箱。
  - **SkillService 扩展**（`src/core/skills.ts`）：`upsert`（同名版本化替换，不抛 CONFLICT；digest 相同幂等 no-op）；`adopt`（给已写盘 manual skill 补写 `.agentctl.yaml` + 投影，零 LLM）；`rollback`（从 `.archive` 恢复历史版本）；`project()` 幂等化。替换前旧版备份到 `skills/.archive/<name>-<version>-<ts>/`（保留最近 5 版）。
  - **触发层**（`runJob` 后，`commitSelfEvolution` 之前）：`autoAdoptSelfSkills`（纯修复、始终开启，扫描 `skills/*/` adopt/upsert 并投影）+ `maybeAutoCreateSkill`（opt-in `memory.skill_self_creation`，复用 `readTranscriptSummary` 检测重复模式，`knowledge/.skill-signals.jsonl` 累计，阈值命中后 `generateSkill` + `upsert`）。两者 best-effort，失败仅 `console.warn` 不阻断 runJob。
  - **按需/任务驱动**：CLI 新增 `agentctl skill create-self/adopt/rollback` 子命令；`prepareRuntime` 为 `skills/**` 幂等补 Edit/Write 放行（员工任务中可直接写 `skills/`）。
- 边界：`install` 保持外部导入的 CONFLICT 语义不变；生成/校验失败绝不写 store，回滚只发生在版本化替换瞬间；自动生成仅当 `skill_self_creation=true` 且 `transcript_persist=true` 且 provider=claude。
- 原因：员工自建 skill 是「把重复劳动沉淀为可复用能力」的最小人工路径；投影是让 Claude 真正用上的关键一环。
- 影响：新增 `skill-generator.ts`/`skill-opportunity.ts`；`skills.ts` 增 `parseSkillFrontmatter`/`upsert`/`adopt`/`rollback`；`factory-application.ts` 挂双 hook + 公开方法 `createSkillForAgent`/`adoptSkill`/`rollbackSkill`；schema 增 `skill_self_creation`；CLI 增三子命令。

---

> 后续决策按 `D-XXX - 标题` 格式追加。模板见 [.agent/decisions/ADR-0000-template.md](../.agent/decisions/ADR-0000-template.md)。重要技术取舍（架构、API、数据、依赖、跨模块规则）须记录于此。
