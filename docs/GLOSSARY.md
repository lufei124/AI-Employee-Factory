# Glossary

统一术语表。命名领域概念时使用此处定义的词汇，不要漂移到同义词。新概念入表前确认它是项目真实使用的语言。

| 术语                   | 定义                                             | 状态   |
| ---------------------- | ------------------------------------------------ | ------ |
| Current implementation | 当前代码的实际行为（可能与产品规则不同，需标注） | 元约定 |
| Confirmed rule         | 已确认的产品/业务规则                            | 元约定 |
| Pending confirmation   | 尚未确认、待业务或数据证实的实现或规则           | 元约定 |

- **Factory Home**：`AI_EMPLOYEES_HOME`，保存本机私有运行数据。
- **Workspace Root**：`AI_EMPLOYEES_WORKSPACE_ROOT`，保存各个独立 Agent Git 仓库。
- **Runtime Home**：某 Agent 专属的 Claude/Codex 原生配置、会话和记忆目录。
- **Bridge Home**：某 Agent 专属的 lark-channel-bridge profile 与加密凭据目录。
- **Portable memory**：Agent 仓库中可经 Git/备份迁移的岗位、知识、决策、Skill 和任务。
- **Skill 作用域**：Skill 的归属级别。**项目级（project）** 存于 `workspace/skills/` 并投影到 `workspace/.claude/skills` / `workspace/.codex/skills`，随工作区版本管理和默认备份；**用户级（user）** 原位存于 `runtimeHome/skills/`（运行器原生用户级发现目录），属于员工运行时身份，仅随包含 Runtime 的备份打包。
- **Skill 商店**：把可配置的远端 GitHub 仓库源（`config.yaml` 的 `skill_store.repositories`）浅克隆到 `~/.ai-employees/skill-store/cache/<name>/`，用 `agent-skills.yaml/json` 清单或扫描 `SKILL.md` 发现技能，安装复用 `SkillService.install`。仅接受 `https://github.com/` 公开仓库。
- **ExecutionContext**：执行前生成的 command、argv、cwd、受控 env 和 timeout 合同。
- **FactoryApplication**：CLI 与 Web API 共用的应用用例编排层。
- **Web Console**：由 `agentctl web` 临时启动、仅监听 `127.0.0.1` 的 React 本地管理页面。
- **Operation**：Web 进程内表示 run、Doctor、Job、备份或恢复的异步状态及 SSE 事件流。
- **Job（定时任务）**：定义在员工 workspace `automation/jobs/*.yaml`、由 launchd plist 定时触发 `agentctl _service job run` 的脚本/Agent 任务。
- **managed_by**：Job 的来源标记（`admin`/`employee`，缺省 admin）。`employee` 任务由 `reconcileEmployeeJobs` 自动调度与反注册；`admin` 任务仅管理员经 `agentctl job`/Web「任务」页管理。
- **员工 Job**：`managed_by: employee` 的定时任务——员工在任务中写 YAML 自我配置，系统自动安装调度、单文件 git 提交（D-028）。
