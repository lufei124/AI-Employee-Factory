# Testing

## 标准命令

```bash
npm ci
npm run build
npm test
npm run lint
npm run test:e2e
```

## 分层

- 单元测试：ID/Schema、路径边界、环境清理、命令 argv、plist、Job/Skill 规则。
- 文件系统集成：Registry 原子更新与备份、锁、Agent 模板、备份恢复、doctor。
- CLI smoke：在临时 `HOME`、`AI_EMPLOYEES_HOME` 和 `AI_EMPLOYEES_WORKSPACE_ROOT` 中运行构建产物。
- Fastify 注入测试：会话交换、Host/Origin/CSRF、Zod 错误、确认对象、文档/Skill/备份路径边界和 Operation 状态；**Web 编排写面（D-024）**——建计划/加任务项/确认/派发（202 + OperationDto、后台派发跑完后 item 离开 pending）、payload 校验（`runAgent` 被 mock，不 spawn 真实进程）。
- React 组件测试：首次初始化、员工创建、状态展示、Markdown 编辑、空状态，以及员工详情「Todo」标签（计划/任务项状态渲染、2 秒轮询刷新、计划级确认/驳回门、审查门确认合并/驳回返工）与「Chief 编排」流水线视图（阶段条 + 聚合进度渲染、展开审查结论与闸门、2 秒轮询、`role=chief` 才显示该标签）；**D-024 写面**——Todo 新建计划/加任务项/派发执行、Chief 发起目标（后台拆解 Operation）、对话标签单轮问答（发送 → 轮询 events → 读回回答）。
- Playwright E2E：使用临时 HOME 启动真实 `agentctl web --no-open`，完成初始化、`user-operations` 创建、Doctor、备份和 `--new-id` 恢复。

自动测试不登录 Claude/Codex，不请求飞书 API，不安装真实 launchd 服务。外部进程边界使用临时脚本或参数生成断言；E2E 不触碰个人 `~/.claude`、`~/.codex` 或 Bridge home。

## 本机 smoke

```bash
SMOKE_ROOT="$(mktemp -d)"
HOME="$SMOKE_ROOT/home" \
AI_EMPLOYEES_HOME="$SMOKE_ROOT/private" \
AI_EMPLOYEES_WORKSPACE_ROOT="$SMOKE_ROOT/agents" \
node dist/cli.js init

HOME="$SMOKE_ROOT/home" \
AI_EMPLOYEES_HOME="$SMOKE_ROOT/private" \
AI_EMPLOYEES_WORKSPACE_ROOT="$SMOKE_ROOT/agents" \
node dist/cli.js create --id user-operations --name "用户运营专员" --description "负责收集用户反馈并闭环跟进" --goal "提升用户满意度" --runtime claude --feishu dedicated
```

不得通过删除断言、跳过测试或弱化安全检查来获得绿色结果。
