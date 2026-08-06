---
name: game-feedback-collector
description: 'Use when collecting game feedback; 从正式服 game_feedback 数据库（或 App Store Connect / 纯文本 / CSV / JSON）读取手游用户反馈，规范化、去重、分类后写入飞书「反馈明细」表。本技能自包含全部规则与脚本。'
version: 1.0.0
---

# 采集游戏反馈（自包含技能）

本技能独立完成「读取 → 规范化 → 分类 → 去重 → 写入飞书」的全部采集工作。所有字段映射、分类规则、去重语义、飞书表约定与安全红线均内联于本文档；所有可执行脚本位于 `scripts/`。无需跳转其它参考文件。

## 目录

- [环境与一次性准备](#环境与一次性准备)
- [工作流程](#工作流程)
- [字段结构](#字段结构)
- [数据库读取](#数据库读取)
- [输入格式](#输入格式)
- [规范化与去重](#规范化与去重)
- [分类与负责人建议规则](#分类与负责人建议规则)
- [飞书旧结果表](#飞书旧结果表)
- [安全约定](#安全约定)
- [使用示例](#使用示例)

---

## 环境与一次性准备

本技能目录自包含依赖与配置，不依赖外部项目目录。所有命令默认从**本技能目录**（`game-feedback-collector/`）运行。

### 依赖

- **Node.js**（≥ 18，需内置 `fetch`）与 `npm`：安装 `mysql2`。
  ```bash
  cd game-feedback-collector
  npm install
  ```
- **Python 3**（≥ 3.8）：运行规范化与分类脚本（仅用标准库，无需 pip 安装）。
- **lark-cli**：飞书读写经 `lark-cli`（`write_to_feishu.mjs` / `dedup_and_preview.mjs` 通过 `spawnSync` 调用）。确认 `lark-cli` 在 PATH 中，执行前查阅各子命令的当前 `--help`，不要猜测原始 API 参数。

### 配置 `.env`

复制 `.env.example` 为 `.env`（位于本技能目录根，已被 `.gitignore` 忽略）：

```dotenv
DB_HOST=
DB_PORT=3306
DB_USER=
DB_PASSWORD=
DB_DATABASE=restart_life

# App Store Connect API（可选；采集苹果应用商店评论时需要）
ASC_ISSUER_ID=
ASC_KEY_ID=
ASC_KEY_PATH=
```

- 兼容 `MYSQL_*` 等效变量。进程环境变量覆盖 `.env`。
- **绝不提交 `.env`、凭据、连接字符串或 `.p8` 私钥。**
- **运维核查项**：`DB_USER` 应为正式库的只读账号（仅 `SELECT`，无 INSERT/UPDATE/DELETE/DDL）。脚本虽只发参数化 SELECT，但账号权限需由运维侧确认，本仓库无法代替验证。

### 脚本一览（`scripts/`）

| 脚本                             | 作用                                                    | 依赖                                  |
| -------------------------------- | ------------------------------------------------------- | ------------------------------------- |
| `fetch_game_feedback.mjs`        | 从正式服 `game_feedback` 分页只读拉取，输出规范化 JSONL | mysql2、`.env`(DB_*)                  |
| `game_feedback_db.mjs`           | 上者的库：SQL 构建、行映射、CLI/环境解析（被 import）   | -                                     |
| `fetch_appstore_reviews_api.mjs` | App Store Connect API 拉评论，输出同结构 JSONL          | Node 内置 crypto/fetch、`.env`(ASC_*) |
| `probe_asc.mjs`                  | App Store Connect 连通性与凭据自检（只读）              | Node 内置、`.env`(ASC_*)              |
| `normalize_feedback.py`          | 文本/CSV/JSON/JSONL → 规范化 JSONL                      | Python 标准库                         |
| `classify_feedback.py`           | 写入前必跑：写入 `反馈分类` 与本地预览 `_分类判定`      | Python 标准库                         |
| `write_to_feishu.mjs`            | 默认写入路径：schema 预检 → 去重 →（预览或写入+回读）   | lark-cli                              |
| `feishu_writer.mjs`              | 上者的可注入库（被 import）                             | lark-cli                              |
| `dedup_and_preview.mjs`          | 仅去重预览（不写、不做 schema 预检）                    | lark-cli                              |

> `.env` 解析路径已为本独立目录校准：脚本从 `scripts/` 向上一级（`../`）找 `.env`，即本技能目录根。

---

## 工作流程

### 第一阶段 — 读库/导入拉取本地数据

1. **正式服 MySQL `game_feedback` 为主要数据源。** 确定分页范围后运行：

   ```bash
   node scripts/fetch_game_feedback.mjs --after-id 100 --limit 50
   ```

   支持 `--after-id`、`--before-id`、`--since`/`--until`（毫秒）、`--client-version`、`--limit`（1–500，默认 100）。结果按 `id ASC`，用 stderr 摘要里的 `nextAfterId` 作下一页 `--after-id`。数据库操作始终只读。

2. 脚本输出 JSONL（每行一条规范化记录），字段含：`去重键`、`反馈时间`、`反馈内容`、`反馈内容翻译`、`情感倾向`、`反馈分类`、`来源`、`图片链接`、`客户端版本`、`系统版本`、`设备型号`、`负责人 (人员 )`。摘要（read/accepted/rejected/nextAfterId）输出到 stderr。

3. 拒绝空内容。绝不暴露或存储 `device_id`、`role_id`、`user_id`、`name` 及未知 `type`。

4. **补充路径**：App Store 评论用 `fetch_appstore_reviews_api.mjs`；文本/CSV/JSON 用 `normalize_feedback.py`（见 [输入格式](#输入格式)）。

### 第二阶段 — 本地补全与分类

5. **对两种导入路径都运行分类器。** 规范化完成、生成去重键、准备飞书 payload 前，从本技能目录运行：

   ```bash
   python3 scripts/classify_feedback.py < normalized.jsonl > classified.jsonl
   ```

   分类器在每行写入非空 `反馈分类` 与仅供预览的 `_分类判定`（含 `categories`、`owner_route`、`confidence`、`needs_review`、`reason`）。

6. **反馈时间**：脚本输出的 `反馈时间` 已是数字毫秒（如 `1783232987479`），直接传入飞书 upsert，不要再转字符串。

7. **反馈内容翻译**：留空 `null`，不由脚本或 Agent 翻译——飞书表侧自动化基于 `反馈内容` 自动生成（用户确认于 2026-08-01）。**情感倾向**基于内容判断（DB 数据无评分时由分类器推断；App Store 数据由评分映射，分类器不覆盖非空值）；情报不足时为 `中性`。

8. **负责人建议**：保留人工已提供的 `负责人 (人员 )`。仅当该字段为 `null`、`_分类判定.confidence` 为 `high`、`needs_review=false`，且运行时查询唯一验证了建议路由对应人员的 open_id 时，才可填入人员字段。其他情况保持 `null` 并在预览中列出；**不得在文档或代码中存储 open_id**。规则与边界以 [分类与负责人建议规则](#分类与负责人建议规则) 为准。

9. **来源**：DB 数据默认 `"应用内反馈"`；App Store 数据为 `"苹果应用商店"`。其他来源（Discord / 谷歌应用商店 / 社媒）需用户确认。

### 第三阶段 — 飞书写入（默认走脚本）

默认工具是 `scripts/write_to_feishu.mjs`（逻辑在 `feishu_writer.mjs`）：内建 field-get 选项预检、去重三态、`_` 字段剥离、写后回读。脚本是**默认路径而非唯一路径**——遇到线上怪癖（如新建记录默认值需二次清空）时，Agent 可偏离脚本手工用 `lark-cli`，但偏离后仍须遵守 [安全约定](#安全约定) 与 [飞书旧结果表](#飞书旧结果表) 的操作要点。

10. 向用户展示本批摘要：读取/采纳/拒绝数、分类与 `_分类判定`（置信度、需复核、建议负责人路由）、待写入预估。**数据库读取不表示已授权飞书写入。**

11. **写入前需用户明确确认**（对话层授权，不可由参数替代）。

12. 预览（不写入）：

    ```bash
    node scripts/write_to_feishu.mjs --input classified.jsonl
    ```

    脚本会：解析表 → field-get 预检（选项含尾空格，线上为权威，不一致整批阻断）→ 去重预览（new/skip/conflict/search_error）→ 输出 JSON summary 并退出。**无 `--confirm` 时绝不会调用 upsert。**

13. 用户确认后写入：

    ```bash
    node scripts/write_to_feishu.mjs --input classified.jsonl --confirm
    ```

    `--confirm` 仅是防误跑进程门，**不是授权等价物**；传参前须已完成步骤 11。查重失败（search_error）的记录不得写入，须进汇总并以非零退出码结束。

14. 解读 summary：`mode` 为 `preview` / `write` / `schema_blocked`；关注 `pendingNew`/`created`/`skipped`/`conflicts`/`searchErrors`/`failed`/`verifications`。`反馈内容翻译` 回读非空属表侧自动化，不算失败。若 `exitCode≠0` 或 `schema_blocked`，停止并报告，勿盲目重试。

15. 仅去重预览（不写、不做 schema 预检）：

    ```bash
    node scripts/dedup_and_preview.mjs --input classified.jsonl
    ```

16. Agent 手工偏离时仍须：Base token 仅存内存；用 `base +field-get` 校验选项（`field-list` 不返回 select 选项）；用 `base +record-search` 去重、`base +record-upsert` 写入；payload 只含 12 字段且删除 `_分类判定`/`_分类内容`；去重三态语义不变；写后回读；成功与否以回读为准（可能 `ok=false` 假失败）。细节见 [飞书旧结果表](#飞书旧结果表)。

17. 向用户报告是否实际写入飞书，以及创建/跳过/冲突/失败数。

---

## 字段结构

仅 `反馈内容` 为必填。

| 字段           | 类型       | 映射规则                                                                                  |
| -------------- | ---------- | ----------------------------------------------------------------------------------------- |
| 去重键         | 文本       | 上游 ID（`db:<id>` / `appstore:<territory>:<reviewId>`）或稳定内容哈希（`hp:<hash>`）     |
| 反馈时间       | 日期       | 使用提供的毫秒时间戳；不要用采集时间替代                                                  |
| 反馈内容       | 文本       | 用户原始反馈                                                                              |
| 反馈内容翻译   | 文本       | 留空 `null`，不翻译（表侧自动化生成）                                                     |
| 情感倾向       | 单选       | 正面 / 负面 / 中性，基于内容判断                                                          |
| 反馈分类       | 多选       | 分类后不得为 null；仅使用飞书实时选项值，基于内容判断                                     |
| 来源           | 单选       | 仅使用飞书实时选项值                                                                      |
| 图片链接       | 文本       | 原始 URL 或序列化的 URL 列表                                                              |
| 客户端版本     | 文本       | 游戏/应用版本                                                                             |
| 系统版本       | 文本       | 手机系统版本                                                                              |
| 设备型号       | 文本       | 手机/平板型号                                                                             |
| 负责人 (人员 ) | 用户(多选) | 可选。保留人工提供值；自动建议仅可在高置信度、无需复核且运行时唯一验证人员 open_id 后写入 |

### 缺失数据处理

除 `反馈分类` 外，可选字段缺失时保持 null。不要从相邻记录推断时间戳、版本、设备、来源或负责人。负责人路由只是历史分派导出的建议，不是承诺。

### 多值字段

`反馈分类` 即使只选一个选项也传数组。`负责人 (人员 )` 使用飞书用户单元格值格式，不使用显示名称字符串。

### 本地预览字段

`_分类判定` 是分类器生成的本地预览元数据（建议路由、置信度、复核标记、理由）。它不是飞书字段，必须在任何 `base +record-upsert` 调用前移除，绝不能存入飞书。外语/繁体内容若需分类，Agent 可将简体译文写入本地中间字段 `_分类内容`（仅供分类器读取，写入飞书前必须删除）并落盘留档；不要覆盖 `反馈内容` 原文。

---

## 数据库读取

主要反馈来源是正式服 MySQL 的 `game_feedback` 表。读取器完全在本技能内，不从其他项目引入代码或凭据。

### 分页读取

```bash
node scripts/fetch_game_feedback.mjs --after-id 100 --limit 50
```

支持的筛选参数：

- `--after-id ID`：id 大于指定值
- `--before-id ID`：id 小于指定值
- `--since MILLISECONDS`：create_time 下界（含），毫秒
- `--until MILLISECONDS`：create_time 上界（含），毫秒
- `--client-version VALUE`：精确匹配客户端版本
- `--limit N`：1–500 条，默认 100

结果按 `id ASC` 排序。使用摘要中的 `nextAfterId` 作为下一页 `--after-id` 继续翻页。CLI 不接受任意 SQL 和自定义表名，对 `game_feedback` 执行参数化 SELECT，将规范化的 UTF-8 JSONL 输出到 stdout，警告和批次摘要输出到 stderr，始终关闭连接。

### 字段映射

| `game_feedback`  | 飞书字段                 |
| ---------------- | ------------------------ |
| `id`             | `去重键`，格式 `db:<id>` |
| `create_time`    | `反馈时间`，保留毫秒     |
| `content`        | `反馈内容`               |
| `image_urls`     | `图片链接`               |
| `client_version` | `客户端版本`             |
| `os_version`     | `系统版本`               |
| `phone_type`     | `设备型号`               |
| 固定值           | `来源` = `应用内反馈`    |

读取器有意排除 `device_id`、`role_id`、`user_id` 和 `name`。`type` 枚举未确认，不得映射到 `反馈分类`。翻译、情感、分类和负责人是读取后的语义处理步骤。空内容行被拒绝。格式错误的 `image_urls` 值保留原值并发出警告，以便记录可审计。

### 读取与写入边界

数据库采集始终为只读。读取或预览数据库反馈的请求不等于授权飞书写入。照常执行 `去重键` 查找，写入前需用户明确确认。若发现连接账号具备写权限，应立即停用并联系运维降权为只读后再继续采集。

---

## 输入格式

### 正式服数据库

主采集路径，见 [数据库读取](#数据库读取)。

### 苹果应用商店

主路径：`scripts/fetch_appstore_reviews_api.mjs`（App Store Connect API，需配置 `ASC_ISSUER_ID` / `ASC_KEY_ID` / `ASC_KEY_PATH`；连通性可用 `scripts/probe_asc.mjs`）。

- 去重键格式：`appstore:<territory>:<reviewId>`（territory 为 3 字母地区码）。
- Connect API 不返回 app 版本/系统版本/设备型号，对应字段留 null。
- 标题与正文合并写入 `反馈内容`，格式：`【标题】正文`。
- 评分映射情感：1–2 → 负面，3 → 中性，4–5 → 正面。
- 支持 `--app-id`（默认 6758041290）、`--territory`（3 字母码，可重复）、`--rating`（1–5，可重复）、`--max-pages`（默认 50，每页最多 200）、`--limit`。

### 纯文本

将一条消息作为一条反馈记录，除非用户明确分隔了多条。保留原始措辞。

### CSV

支持 UTF-8 或带 BOM 的 UTF-8。规范化脚本映射常见别名：

| 输入列名          | 飞书字段     |
| ----------------- | ------------ |
| content, feedback | 反馈内容     |
| translation       | 反馈内容翻译 |
| submitted_at      | 反馈时间     |
| source            | 来源         |
| client_version    | 客户端版本   |
| os_version        | 系统版本     |
| device            | 设备型号     |
| image             | 图片链接     |
| category          | 反馈分类     |
| sentiment         | 情感倾向     |
| dedupe_key        | 去重键       |

未知列不会发送到飞书。仅在用户需要时保留在单独的本地审计对象中。

### JSON 和 JSONL

JSON 可以是单个对象或数组。JSONL 必须每行一个对象。拒绝在对应数组索引或行号处出现的非对象元素。

### CLI 调用

```bash
python3 scripts/normalize_feedback.py feedback.csv
python3 scripts/normalize_feedback.py feedback.jsonl
printf '无法下载剧情文件' | python3 scripts/normalize_feedback.py
```

输出为 UTF-8 JSONL 到 stdout。脚本不会调用飞书。

---

## 规范化与去重

### 内容处理

去掉首尾空白并折叠重复空白用于生成去重键。存储内容保留含义、标点符号和措辞。不要在存储前"美化"投诉内容。

### 去重键

1. 保留已有的 `去重键`。
2. 对于有稳定上游 ID 的记录，使用 `db:<source_id>`（DB）或 `appstore:<territory>:<reviewId>`（App Store）。
3. 否则将规范化、大小写折叠后的反馈内容用 SHA-256 哈希，取前八位十六进制字符，加 `hp:` 前缀。

项目内置脚本（`game_feedback_db.mjs`、`normalize_feedback.py`）实现了这些确定性规则。

### 去重决策

| 搜索结果               | 处理方式                               |
| ---------------------- | -------------------------------------- |
| 未匹配到去重键         | 候选写入（new）                        |
| 匹配到去重键且内容相同 | 跳过（skip）                           |
| 匹配到去重键但内容不同 | 冲突（conflict），停止该条处理         |
| 查重本身失败           | search_error，不写入，进汇总，非零退出 |

不要因为两条投诉措辞相似就合并。语义聚类属于分析阶段，不属于写入时的去重。去重内容比对一律使用 `反馈内容`（原文）。

### 翻译和标签

分类由确定性脚本 `classify_feedback.py` 执行（写入前必跑）；情感倾向可基于内容判断，情报不足时用 `中性`。`反馈内容翻译` 一律留空 `null`。分类器输出 `_分类判定` 供预览；低置信或 `needs_review=true` 的记录由 Agent 与人复核。不确定的标签使用已有的 `未分类` 选项。**采集阶段绝不创建新的下拉选项。**

---

## 分类与负责人建议规则

本节是写入前分类的唯一规范来源。分类器只可输出以下七个飞书既有多选值；代码、预览和 payload 必须保留其中的精确字符（**包括尾随空格**）：

1. `阻断性BUG `（尾随空格）
2. `玩法建议`
3. `NPC相关 `（尾随空格）
4. `功能问题`
5. `未分类`
6. `新手引导`
7. `事件&剧情`

每条有效反馈必须先有且仅有一个主分类，数组首位只能是 `阻断性BUG `、`功能问题`、`玩法建议` 或 `未分类`。命中专题后仅按固定顺序追加：`NPC相关 ` → `新手引导` → `事件&剧情`。`未分类` 不追加专题，且必须复核。

| 分类         | 简要判定与边界                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `阻断性BUG ` | 下载、登录、进入游戏、继续流程失败，或黑屏、闪退、卡死且不能绕过；已能继续使用的普通异常不属于此类。 |
| `功能问题`   | 已有功能失效、显示/称谓错误、异常或无法使用，但文本未证明完全阻断。                                  |
| `玩法建议`   | 新增、优化、改进、规则或体验建议；没有明确故障时使用。                                               |
| `未分类`     | 内容过短、对象不明或无法可靠判断；不猜测。                                                           |
| `NPC相关 `   | NPC、角色、对话、称谓、性别、关系或角色行为；仅作专题。                                              |
| `新手引导`   | 教程、首次流程、规则不明、不会操作或说明不足；仅作专题。                                             |
| `事件&剧情`  | 剧情、主线、章节、事件或情节流程；仅作专题。                                                         |

### 建议负责人路由

路由仅是从历史分派归纳出的**建议**，不是负责人承诺，也不在此文档或代码中存储 open_id。运行时路由名称与显示名：`npc` → 吴正伟；`suggestion` → 李政融；`onboarding` → 李政融；`story_flow` → 张靖；`access` → 李荣洋；`general` → 纪伟。

| 分类组合或明确证据                                   | 建议路由     | 复核边界                                |
| ---------------------------------------------------- | ------------ | --------------------------------------- |
| 下载、登录或无法进入整个游戏                         | `access`     | 优先于剧情路由；证据不明确则复核。      |
| `阻断性BUG ` + `事件&剧情` 的章节/剧情流程卡死或黑屏 | `story_flow` | 下载、登录、游戏入口失败改走 `access`。 |
| 非阻断主分类 + 仅 `NPC相关 ` 专题                    | `npc`        | 同时命中另一专题则留空复核。            |
| `玩法建议` + 仅 `新手引导` 专题                      | `onboarding` | 功能异常或多个专题则留空复核。          |
| 无专题且为明确、可执行的 `玩法建议`                  | `suggestion` | 泛泛评价或不明确请求仍复核。            |
| 无专题且为明确、可执行的 `功能问题`                  | `general`    | 对象不明确时仍复核。                    |
| `未分类` 或两个及以上专题                            | 无           | `needs_review=true`，负责人留空。       |

除上表明确路由外，任何其他合法分类组合（包括 `功能问题 + 新手引导`、`功能问题 + 事件&剧情`、`玩法建议 + 事件&剧情`）以及低置信度证据，一律不建议负责人：`负责人 (人员 )` 保持 `null`，并设 `needs_review=true`。

只有现有 `负责人 (人员 )` 为 null、分类高置信度、`needs_review=false`，并且运行时查询唯一验证该建议路由人员的 open_id 时，才可填入负责人。已有人工负责人绝不可覆盖；无法唯一验证、低置信度或存在冲突时保持 null，并在预览中显示 `_分类判定` 供人工复核。

---

## 飞书旧结果表

### 保存的入口地址

`https://uvidumfqwzk.feishu.cn/wiki/V6WEwEh1MikK0dk8Y8hcAJPZnbb?table=tblFTnIHPOHn66tY&view=vew4pnUSHd`

运行时解析此 URL。不要存储解析后的 Base token。

### 校验提示

- 主表：`反馈明细`
- 表 ID：`tblFTnIHPOHn66tY`
- 默认视图：`表格`
- 视图 ID：`vew4pnUSHd`
- 历史表：`v1.0.2&v1.0.1`

以运行时发现为准，如果任何提示发生变化，停止写入并报告 schema 差异。

### 实时字段约定（共 12 个，观察于 2026-07-30）

1. 去重键　2. 反馈分类　3. 情感倾向　4. 反馈时间　5. 负责人 (人员 )　6. 客户端版本　7. 反馈内容翻译　8. 反馈内容　9. 来源　10. 图片链接　11. 设备型号　12. 系统版本

### 已有选项

- 情感倾向：`正面`、`负面`、`中性`
- 来源：`应用内反馈`、`Discord`、`苹果应用商店`、`谷歌应用商店`、`社媒反馈`
- 反馈分类：`阻断性BUG `、`玩法建议`、`NPC相关 `、`功能问题`、`未分类`、`新手引导`、`事件&剧情`

`阻断性BUG ` 和 `NPC相关 ` 目前带尾空格。写入时使用 `field-get` 返回的精确字符串，不要 trim。

### 表侧自动化（用户确认于 2026-08-01）

`反馈内容翻译` 由飞书表内置自动化规则基于 `反馈内容` 自动生成，**不需要也不应该**由脚本或 Agent 填写：

- 写入时仍传 `反馈内容翻译: null`（保持既有契约）。
- 写入后立即回读时，该字段可能仍为 `null`，也可能已被自动化填充——两种情况都正常，不作为写入失败依据。
- 简体中文内容的"翻译"可能与原文相同，这是自动化行为，不是脚本误写。
- 去重内容比对一律使用 `反馈内容`（原文），不受该自动化影响。

### 在线操作顺序

1. 用 `sheets +workbook-info` 解析嵌入的 Base 元数据。
2. 用 `base +field-get` 校验字段和 select 选项（`field-list` 不返回 select 选项）。
3. 用 `base +record-search` 按 `去重键` 搜索。
4. 仅在用户明确确认写入后，用 `base +record-upsert` 写入。
5. 用 `base +record-get` 验证返回的记录。

执行前查阅每个命令的当前 `--help`。不要猜测原始 API 参数。

### 操作要点（来自 2026-07-30 实测）

**字段与选项校验**

- `base +field-list` **不**返回 select 选项。用 `base +field-get --field-id <字段名>`；选项在 `data.field.options[].name` 下。
- 总共 12 个字段。`反馈分类` 为多选（multiple=true），`情感倾向` 和 `来源` 为单选。
- `阻断性BUG ` 和 `NPC相关 ` 带尾空格——写入时必须使用 field-get 返回的精确字符串。
- `反馈分类` 有默认值 `["未分类"]`——新建记录会自动填充。如果确实想留空（如纯 DB 数据同步），需二次 upsert 覆盖传 `反馈分类:null`。

**record-search 用法**

- `--filter-json` 单独使用无效，必须配合 `--keyword` 或 `--json`。
- 对去重键精确等值查询：`--json '{"keyword":"db:110","search_fields":["去重键"],"select_fields":["去重键","反馈内容"],"filter":{"logic":"and","conditions":[["去重键","==","db:110"]]},"limit":10}'`。
- 返回匹配结果在 `data.data`（二维数组）、`data.record_id_list`、`data.fields`。

**record-upsert 行为**

- 创建（不带 `--record-id`）：返回新 record ID 在 `data.record.record_id_list[0]`。
- 更新（带 `--record-id`）：成功与否以回读验证为准。更新可能返回 `ok=false` 假失败（实际已写入），**不要**仅凭 `ok=true` 判定成功，也**不一定**返回 `record_id_list`。
- `--json` 是顶层字段映射——每个 key 是字段名，value 是 CellValue。
- datetime 的 CellValue = 整数毫秒（如 `1784265507324`）。**不要传字符串。**

**record-get 结构**

- 单条：`--record-id <rid>` → `data.fields`（列名）、`data.data[0]`（行值数组）、`data.record_id_list[0]`。
- 批量：`--json '{"record_id_list":["rid1","rid2",...]}'`——用此方式避免命令行参数过长。
- `data.fields` 的字段顺序与 `data.data` 行数组的列顺序一致。用 `dict(zip(fields, row))` 映射。

**datetime 处理**

- DB 的 `create_time` 在 fetch 脚本 JSONL 输出中**已是数字毫秒**（如 `1783232987479`），可直接传入 upsert，无需类型转换。
- 正确：`"反馈时间": 1783232987479` → 飞书显示 `2026-07-05 14:29:47` CST。
- 错误：`"反馈时间": "1783232987479"` → 被当成日期字符串解析，显示为 `1784-12-02...`。

**写入规则（用户偏好）**

- 反馈内容翻译：**统一 `null`**——不自动翻译。
- 情感倾向 / 反馈分类：基于内容判断填写，使用实时选项值。情报不足时用 `未分类` / `中性`。
- 反馈时间：使用 DB `create_time` 的整数毫秒值（已是 number，直接传入 upsert，不猜测、不再转换）。

---

## 安全约定

- 不要写入测试记录。连通性和结构测试为只读。
- 不执行任意 SQL，不写入 `game_feedback` 表。
- 不存储 Base token、用户 token、应用密钥或账号凭据。
- 不创建名称相近的重复下拉选项；历史尾空格有意义（`阻断性BUG `、`NPC相关 `）。
- 只写入既有的 12 个字段；不创建新字段或新选项。`_分类判定` / `_分类内容` 只用于本地预览，写入前必须删除。
- 除非用户明确要求，否则不覆盖已有记录。
- 反馈时间取自 DB `create_time`（非猜测），脚本输出为数字毫秒，直接传入飞书 upsert，无需类型转换。
- 反馈内容翻译一律传 `null`；该字段由表侧自动化生成，回读时非空不算写入错误。
- 情感倾向和反馈分类基于反馈内容判断填写（使用飞书实时选项值）；分类后 `反馈分类` 不得为空，情报不足时用 `未分类` / `中性`。
- 设备型号、客户端版本、系统版本等取自 DB 原始字段，不猜测。
- 如果在线 schema 与文档不一致，停止写入并报告差异。

---

## 使用示例

- "读取正式服 ID 100 之后的 50 条反馈，运行分类器并从 classified.jsonl 预览，不写入飞书。"
- "读取正式服 1.0.4 的新反馈，去重后写入旧结果表。"
- "导入这个 CSV，分类、去重后写入反馈明细。"
- "拉取 App Store 美区 1–2 星评论，分类预览，不写入。"
- "整理 Discord 反馈；先预览，不写入。"

---

> 本技能由 `用户反馈/skills/collect-game-feedback`（多文件版：SKILL.md + 6 篇 references）整合为单一自包含文档。脚本同步复制到 `scripts/`，并已将 `.env` 解析路径从原 3 级嵌套（`../../../`）调整为本技能目录（`../`），使技能可在根目录下独立运行。
