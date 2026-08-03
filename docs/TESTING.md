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
- Fastify 注入测试：会话交换、Host/Origin/CSRF、Zod 错误、确认对象、文档/Skill/备份路径边界和 Operation 状态。
- React 组件测试：首次初始化、员工创建、状态展示、Markdown 编辑和空状态。
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
node dist/cli.js create --id user-operations --name "用户运营专员" --runtime claude --preset user-operations --feishu dedicated
```

不得通过删除断言、跳过测试或弱化安全检查来获得绿色结果。
