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
- **ExecutionContext**：执行前生成的 command、argv、cwd、受控 env 和 timeout 合同。
- **FactoryApplication**：CLI 与 Web API 共用的应用用例编排层。
- **Web Console**：由 `agentctl web` 临时启动、仅监听 `127.0.0.1` 的 React 本地管理页面。
- **Operation**：Web 进程内表示 run、Doctor、Job、备份或恢复的异步状态及 SSE 事件流。
