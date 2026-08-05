# Web 控制台交互与 UI 重设计方案

> 状态：提案（待评审）。基于 `redesign-existing-projects` skill 审计产出，面向现有 React 19 + vanilla CSS 栈，不迁移框架、不新增依赖（除字体外）。

## 1. 现状诊断（「泛 AI 味」指纹）

对 `web/src/` 全部页面与 `styles.css`（1648 行）逐项审计，当前设计踩中了绝大多数通用 AI 模板特征：

| 类别 | 现状                                                                                              | 问题                                                 |
| ---- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 字体 | `styles.css:1` 只用 **Inter** + 系统回退                                                          | skill 头号指纹「浏览器默认字体 / 到处 Inter」        |
| 色彩 | `styles.css:17` `--accent: #6956e8`（紫）+ `body` 右上角紫色径向渐变 + 深色侧边栏 `#16182a`       | 教科书式「紫/蓝 AI 渐变」+「浅色页里突兀的深色区块」 |
| 表面 | 所有卡片 `border: 1px + white + box-shadow`（`.panel`/`.metric-card`/`.agent-card`）              | 通用「描边+阴影+白底」卡片，无层次                   |
| 布局 | `.metric-grid` **4 等分列**；左固定 238px 侧边栏                                                  | 最通用 AI 布局之一                                   |
| 按钮 | primary=紫色**渐变**+阴影，secondary=浅紫，ghost=灰                                               | 主次按钮族单一、渐变滥用                             |
| 徽标 | `.status-badge` / `.job-source-badge` 全部 **99px 胶囊**                                          | skill 明确的通用胶囊徽标                             |
| 图标 | 全部 `lucide-react`（`App.tsx` 导入十几种）                                                       | skill 明确的「Lucide 独占」AI 味                     |
| 文案 | `.eyebrow` 全大写字距标题：`CONTROL ROOM` / `LOCAL-FIRST AGENT OPERATIONS` / `EMPLOYEE BLUEPRINT` | 全大写副标题 + AI 腔                                 |
| 动效 | 仅有 `transform 0.15s` hover 上浮；无 active 反馈、无 focus ring、无骨架加载                      | 无手感、无障碍缺失                                   |

**已做对的**（保留）：`.empty-state` 空态、`.skeleton-page` 骨架、`.notice` 错误块、`min-height:100vh`、`max-width:1420px` 容器、语义化页面结构。

## 2. 设计方向（Art Direction）

**「精密仪器 / 本地控制面」**——一款本地优先、单机、技术用户使用的运维控制台，应像一台校准过的仪器，而非 AI Demo 页。

- **克制**：单 accent、中性墨色、暖纸底。一眼看不出是「AI 生成」。
- **编辑感**：大标题紧字距、数据用等宽数字、花瓣排版留白。
- **手感**：弹簧式微交互、可感知的 hover/active/focus、清晰分层的表面。

核心决策：**放弃紫色 AI 渐变 → 石墨墨 + 暖纸 + 单一低饱和青绿 accent**。青绿是「运行/健康」的操作色，低饱和后不同于通用成功绿，和紫色 AI 味彻底切割。

## 3. 设计令牌（`styles.css:1` 重写）

```css
:root {
  /* 字体：Geist 表现体 + Geist Mono 数据体（后续段落详述加载） */
  --font-sans: 'Geist', 'Inter', ui-sans-serif, 'PingFang SC', system-ui;
  --font-mono: 'Geist Mono', 'JetBrains Mono', ui-monospace, 'SF Mono', monospace;

  /* 墨与纸：暖色系，单一灰族 */
  --ink: #1b1d1f; /* 近黑暖石墨 */
  --ink-2: #3b3f43;
  --muted: #697074;
  --faint: #9aa1a5;
  --paper: #faf9f6; /* 暖纸 */
  --paper-2: #f3f1eb; /* 抬升表面 */
  --paper-3: #ece9e1; /* 悬浮/按压 */
  --line: #e5e2d8; /* 暖发丝线 */
  --line-strong: #d7d3c6;

  /* 单一 accent：低饱和青绿 */
  --accent: #0e7a6f;
  --accent-ink: #0b5f57;
  --accent-soft: #e5f3f0;
  --accent-ring: rgb(14 122 111 / 0.32);

  /* 状态 */
  --ok: #15803d;
  --warn: #b45309;
  --danger: #b3261e;
  --ok-soft: #e6f4ea;
  --warn-soft: #f9efe3;
  --danger-soft: #fbeceb;

  /* 表面：tinted 阴影（带纸色相，非纯黑），去掉纯白卡描边 */
  --shadow-sm: 0 1px 2px rgb(27 29 31 / 0.05);
  --shadow-md: 0 8px 20px -8px rgb(27 29 31 / 0.12);
  --shadow-lg: 0 22px 44px -20px rgb(27 29 31 / 0.2);

  /* 圆角：内紧外松，不再统一 */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --radius-xl: 22px;

  /* 动效 */
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1); /* 弹簧 */
  --dur: 0.22s;
  --dur-slow: 0.34s;
}
```

要点：

- 背景 `body` = `var(--paper)` 平涂，**删掉紫色径向渐变**；如需纹理，加一层 `pointer-events:none` 的极轻噪点 overlay（`grain` 类）。
- 阴影全部带暖色相（`rgb(27 29 31 / …)`），非纯黑低透明。
- 移除 `--accent-dark`/`--accent-soft` 的紫族，统一到青绿族。

## 4. 排版（Typography）

- **字体**：`Geist`（Sans，现代技术感、有性格）作界面字；`Geist Mono` 作数据字。都来自 Vercel 开源字体 CDN（`https://vercel.com/geist` 或 `unpkg/@vercel/geist-font`），**零构建依赖**，`@font-face` 引入。
- **数字用 tabular**：`--font-mono` + `font-variant-numeric: tabular-nums`，用于所有指标、Agent ID、时间戳、日志。
- **层级**：H1 显示级 `font-weight: 600`、`letter-spacing: -0.04em`、`line-height: 1.05`；H2 `1.1`；正文默认 14px / `1.6`。
- **副标题**：`Text on a phone` 改**句首大写 + 小字 + 松字距**，不再全大写。中文用加粗小字即可。
- **换行**：标题加 `text-wrap: balance`，正文 `text-wrap: pretty`，避免孤词。
- 引入 `--text-xs…--text-hero` 阶梯，替代散落的 `font-size: 13px/30px` 硬编码。

## 5. 色彩与表面（Color & Surfaces）

- **卡片去描边**：删 `.panel`/`.metric-card`/`.agent-card` 的 `border`，改 **`background: var(--paper-2)` + 无阴影或仅 `--shadow-sm`**。只有需要层级时才用 elevated 卡（`--shadow-md`）。skill 原则：卡片只在传达层级时才存在。
- **主 CTA**：primary = 实心 `--ink`（近黑）白字，或 `--accent` 白字；**去掉渐变**。hover 轻微 `translateY(-1px)`+变亮，active `scale(0.97)`。
- **状态**：胶囊徽标改 **方形小旗/「圆点 + 文字」**——运行中为青绿点 + 句首小写「运行中」，错误为红点，待授权为琥珀点。`border-radius: 5px`，非 99px。
- **深色侧边栏**：改浅——`background: var(--paper-2)`，只在分隔线处用 `--line`；当前 `#16182a` 深块删除（消除「浅页中的突兀深色」）。未来可选做整套 dark mode，但 v1 先统一浅色。

## 6. 布局与导航（Layout & Nav）

- **保留左侧 rail**（运维控制台 + 详情页 + Operations drawer 场景下，rail 是正确模式，同 Linear/Vercel），但**收窄瘦身**：宽 `232px`，分组导航（`总览 / 员工 / 创建` 一组，`Skill 商店 / 备份 / 诊断` 一组），当前项加**左侧 2px 实心指示条** + 浅色底。
- **指标区破对称**：`.metric-grid` 从 4 等分改成**主卡 + 辅卡**——第一个「AI 员工」为大号 hero 卡（等宽大数字），其余 3 个为小卡；或 2×2 带一卡跨列。避免四等分模板感。
- 容器 `max-width: 1420px` 保留；`main-content` 内边距统一。
- 详情页 `agent-hero` 保留卡片式，但用 `--paper-2` 底 + 左侧 3px accent 竖条，替代紫色渐变。

## 7. 组件规范（Components）

- **按钮族**：primary（实心墨/青绿）、secondary（`--paper-3` 底）、ghost（透明）、**text link**（纯文字 + hover 下划线）。不再「一个实心 + 一个幽灵」到底。
- **图标**：保留 lucide（零迁移），但**统一 stroke 到 1.75**、`size` 规格化 16/18/20；替换陈词滥调隐喻（火箭→`Activity`/`Sparkle`、盾牌→`Fingerprint`/`Vault`）。品牌 logo 用 `Factory` 或自绘 mark。
- **表格/列表**：`.agent-directory`、`.log-viewer` 用等宽数字栏 + tabular；行 hover 浅底反馈。
- **Tab**：`.tabs` 保留下划线，但 active 由纯紫改 `--accent`，加 `transition`。
- **表单**（创建向导）：stepper 保留，但**加内联校验**（错误 `<small>` 红字于字段下方，不用 `alert`）；`Agent ID` 输入即时校验 kebab-case 并显示有效/无效态。
- **Loading**：`.skeleton-page` 升级为**布局形骨架**（按 metric/agent 卡形状占位，带 shimmer），替代文字「正在读取…」。
- **空态**：保留 `.empty-state`，文案改具体直白（见 §9）。

## 8. 交互与动效（Interactions & Motion）

- **通用**：所有可交互元素 `transition: var(--dur) ease`；hover `translateY(-1px)`，active `scale(0.97)`，focus `outline: 2px solid var(--accent-ring)`（无障碍必需）。
- **弹簧**：`--ease-spring` 用于面板滑入、drawer、微交互。
- **入场**：页面内容**交错入场**（staggered），子项 40ms 间隔 `translateY(8px)→0 + opacity`，`prefers-reduced-motion` 时关闭。
- **动效属性**：一律 `transform`/`opacity`，禁 `top/left/width/height`。
- **滚动**：`scroll-behavior: smooth`；`height:100vh` → `min-height:100dvh`（已在 body，页面容器同步）。

## 9. 内容与文案（Content & Copy）

- **删全大写 eyebrow**：`CONTROL ROOM`→「运行总览」小注、`LOCAL-FIRST AGENT OPERATIONS`→句首小写短句、`EMPLOYEE BLUEPRINT`→「员工蓝图」。
- **禁 AI 腔**：全文无「无缝/赋能/一键/智能/NEXT-GEN」；用具体语言（如「在员工专属目录中完成 Codex 登录」而非「智能登录」）。
- **成功/错误**：去掉感叹号；错误直接「连接失败，请重试」，不用「Oops」。
- **中文主界 + 英文技术词**（Agent ID / Skill / Runtime / Job）保留，符合产品语言（见 `docs/GLOSSARY.md`）。

## 10. 战略补缺（Strategic Omissions）

- **skip-to-content 链接**（键盘用户）。
- **404 页**：更新 `App.tsx` 的 `*` 兜底为品牌化「页面未找到 + 返回」，而非回 Dashboard。
- **favicon**：补品牌 favicon（`web/` 内 `favicon.svg`，青绿 mark）。
- **meta**：`index.html` 补 `<title>`/`description`/`og:`。
- **表单校验**：向导逐步字段校验（§7）。
- **返回导航**：详情页顶部 breadcrumb 回员工列表。

## 11. 分阶段实施（Phased Rollout，低风险优先）

按 skill 的 Fix Priority 排序，每阶段可独立验证、可回退：

| 阶段               | 改动                                                              | 风险 |
| ------------------ | ----------------------------------------------------------------- | ---- |
| **P1 字体 + 令牌** | 引入 Geist/Geist Mono；重写 `:root` 令牌；`body` 去紫渐变         | 低   |
| **P2 色彩/表面**   | 卡片去描边、改 `--paper-2`；深色侧边栏改浅；按钮去渐变            | 低   |
| **P3 交互态**      | 统一 hover/active/focus/transition；弹簧；`min-height:100dvh`     | 低   |
| **P4 布局**        | 指标区破对称；导航分组 + 指示条                                   | 中   |
| **P5 组件**        | 徽标改方旗、图标 stroke 统一、骨架加载、inline 校验、tabular 数字 | 中   |
| **P6 文案 + 补缺** | 删全大写、AI 腔；404/favicon/meta/skip-link                       | 低   |

每阶段跑 `npx tsc --noEmit -p tsconfig.web.json` + `npm run lint` + `tests/web-ui.test.tsx`（UI 测试对文案/类名敏感，需同步更新）。

## 12. 验证（Verification）

- 逐阶段 `tsc` + `lint` + `web-ui`/`web-server` 测试全绿。
- 手动 `agentctl web` 走查：总览、员工列表、创建向导（生成→编辑→确认）、详情五 tab、Skill 商店、备份、诊断、操作中心。
- 用 `cc-vision` 截图核对：无紫色渐变、无 Inter 味、无 4 等分卡、无胶囊徽标、无全大写。
- 全量 `npm test` 收尾。

---

_配套：本文档为 UI 换代提案，不涉及业务逻辑/路由/API 变更。评审通过后按 P1→P6 分阶段在 `web/` 实施。_
