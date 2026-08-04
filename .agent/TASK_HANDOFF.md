# 当前任务交接

## 身份

Task ID: TASK-018

Task title: Skill 作用域(项目级/用户级) + Skill 商店(GitHub 远程源)

Outgoing/current agent: claude-20260803-01

Intended next role/agent: 用户或后续维护者

Branch/worktree: master（TASK-018 commit）

Status: DONE

更新时间：2026-08-04 18:25 +0800

## 已完成

- Skill 引入显式作用域两级：**项目级（project）** 存 `workspace/skills/` 并投影 `workspace/.claude/skills` / `workspace/.codex/skills`，随工作区 git 与默认备份；**用户级（user）** 原位存 `runtimeHome/skills/`（运行器原生用户级发现目录），仅随包含 Runtime 的备份打包。`SkillService.install/list/remove` 均支持 scope，默认 project 不改既有行为。
- 新增 Skill 商店：`SkillStoreService` 把 `config.yaml` 声明的 GitHub 仓库源浅克隆到 `~/.ai-employees/skill-store/cache/<name>/`，用 `agent-skills.yaml/json` 清单或扫描 `SKILL.md` 发现技能，安装复用 `SkillService.install`（传递源路径）。仅接受 `https://github.com/` 公开仓库；内置默认源 superpowers、anthropic-skills。
- Web 新增「Skill 商店」顶级页（仓库增删/刷新/浏览技能/安装，`?agent=` 预选员工）+ 员工详情 SkillsTab 按项目级/用户级分组展示并带「从商店安装」入口；CLI 新增 `skill-store` 命令组 + `skill list/install/remove` 的 `--scope` 旗标。
- 文档：docs/DECISIONS.md D-003 演进为作用域分离 + D-008 商店 ADR；ARCHITECTURE/README/GLOSSARY 同步。

## 验证

| 命令/检查          | 结果 | 相关输出                 |
| ------------------ | ---- | ------------------------ |
| `npm run build`    | 通过 | tsc + vite 均通过        |
| `npm test`         | 通过 | 32 文件 / 169 项         |
| `npm run lint`     | 通过 | eslint + prettier 均通过 |
| `npm run test:e2e` | 通过 | 1/1，3.8s                |

## 安全边界与限制

- 未改动备份/回收站/CC Switch/隔离层语义；未改既有 Skill 安装方式的默认行为（默认 project）。
- 商店仅接受 `https://github.com/` 公开仓库；安装复用 `SkillService.install` 的软链接拒绝规则（R6）。
- 未 push；按用户常驻规则「任务完成即 commit」只提交不推送。
