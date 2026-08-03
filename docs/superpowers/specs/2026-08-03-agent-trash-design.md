# 员工回收站设计

## 目标

为测试员工和不再使用的员工提供一个 Web 一键操作：将该员工的全部受管数据移出活动区，使其立即从员工列表消失并释放 Agent ID，同时保留 7 天可恢复窗口。超过期限的条目在下次启动 Web 或运行 `agentctl` 时永久清理。

## 产品语义

- “归档”继续表示停用但保留在 Registry 和员工列表筛选中。
- “移入回收站”表示停止所有服务、移走全部受管数据并从 Registry 移除。
- 回收站不是 macOS 系统废纸篓，由 Factory 管理。
- 移入回收站后可在 7 天内恢复；恢复不会自动启动 Bridge 或 Job。
- 到期清理不是常驻定时任务。只有下次运行 `agentctl` 或启动 Web 时才执行，因此条目至少保留 7 天，可能保留到下一次 Factory 运行。
- 回收站中的 Agent ID 可以立即用于创建新员工。若恢复时 ID 或原路径已被占用，恢复失败且不覆盖任何数据。

## Web 交互

员工详情的危险操作区增加“移入回收站”按钮。点击后显示确认对话框，明确列出 Workspace、Runtime、飞书配置、日志和任务都会从活动区移走，并注明 7 天内可恢复。用户只需点击一次“确认移入回收站”，不要求再次输入 Agent ID。

操作成功后跳转员工列表并刷新 Registry。失败时保持当前页面，展示统一中文错误和修复建议，不以乐观状态隐藏员工。

“备份恢复”页面增加“员工回收站”区块，显示：

- 员工名称与原 Agent ID；
- 移入时间；
- 到期时间和剩余天数；
- “恢复”按钮；
- 已到期但尚未触发清理的状态。

## CLI 与 API

新增 CLI：

```text
agentctl trash move <agent-id> [--dry-run] [--yes]
agentctl trash list
agentctl trash restore <trash-id> [--dry-run] [--yes]
agentctl trash purge --expired [--dry-run] [--yes]
```

新增 `/api/v1` 接口：

```text
GET    /trash
POST   /agents/:id/actions/trash
POST   /trash/:trashId/actions/restore
POST   /trash/actions/purge-expired
```

修改请求继续使用现有会话、Origin、CSRF 和确认对象。Web 移入回收站确认对象包含匹配的 Agent ID；浏览器界面负责生成，API 不信任客户端显示状态。

CLI 和 Fastify 只能调用 `FactoryApplication`，不得自行删除路径或拼接 shell 命令。

## 存储模型

Factory Home 新增：

```text
<AI_EMPLOYEES_HOME>/trash/
  index.yaml
  manifests/<trash-id>.yaml
```

`TrashManifest` 使用版本化 Zod Schema，至少包含：

- `schema_version`；
- 随机 `trash_id`；
- Agent ID、名称和完整 Registry 快照；
- `deleted_at` 与 `expires_at`；
- 每个受管组件的原路径、回收站路径、是否存在和 SHA-256 摘要元数据；
- 状态 `moving | ready | restoring | purging | failed`。

为避免 Workspace Root 与 Factory Home 位于不同磁盘，每个组件移动到其原父目录下的隐藏回收站：

```text
<original-parent>/.agentctl-trash/<trash-id>/<component>
```

这样正常情况下可以使用同文件系统原子 rename。中心 manifest 只保存规范化路径和状态，不保存 Secret 内容。

受管组件包括：

- Workspace；
- Runtime Home；
- Bridge Home；
- Agent 日志目录；
- canonical service plist 目录；
- Job schedule plist 目录。

安装在 `~/Library/LaunchAgents` 的 plist 在服务卸载阶段移除，不进入回收站；恢复后仍保持 stopped，后续 start/enable 时重新生成。

## 移入回收站事务

1. 获取全局 Registry 锁和 Agent 删除锁，拒绝并发 create/run/job/trash。
2. 重新读取 Registry 并解析 `agent.yaml`，验证 ID、Runtime 和路径边界一致。
3. 枚举所有 Job，卸载其 launchd 服务；卸载 Bridge launchd 服务。不存在的服务按幂等成功处理。
4. 创建状态为 `moving` 的 manifest，以 0600 原子保存。
5. 对每个存在的受管路径执行原子 rename 到同父目录隐藏回收站，并逐项记录完成状态。
6. 所有路径移动成功后，从 Registry 原子移除 Agent。
7. 将 manifest 标记为 `ready`，员工立即从活动列表消失。

如果步骤 5 或 Registry 更新失败，按相反顺序把已移动路径恢复原位。回滚失败时保留 `failed` manifest，Doctor 报告明确失败路径，禁止静默覆盖或继续清理。

服务卸载发生在文件事务之前；回滚不会自动重新启动服务，以避免在状态不确定时产生后台进程。

## 恢复事务

1. 锁定 trash entry 和 Registry。
2. 验证 manifest 为 `ready`，所有回收站路径都位于记录的隐藏根目录内且不存在软链接逃逸。
3. 验证 Agent ID 不在 Registry，所有原路径均不存在。
4. 按组件反向 rename 回原路径。
5. 原子恢复 Registry 快照，但把状态固定为 `stopped`、Bridge authorization 保留、更新时间刷新。
6. manifest 标记恢复完成并从活动回收站索引移除。

任一步失败都回滚已移动组件。恢复不 bootstrap、kickstart 或 enable 任意 launchd 服务。

## 过期清理

- Web 启动完成 Factory 路径解析后执行一次 `purgeExpired()`。
- 每个公开 CLI action 开始前执行一次 `purgeExpired()`；清理失败记录警告，但不得让无关只读命令静默丢失数据。
- 只清理 `ready` 且 `expires_at <= now` 的条目；`moving`、`restoring`、`failed` 永不自动清理。
- 清理使用现有安全路径验证，逐项永久删除回收站路径，最后删除 manifest/index entry。
- “永久删除”是普通文件系统删除，不能承诺 SSD 上的取证级安全擦除。

## 安全与错误处理

- 所有路径来自 Registry 快照和 Factory 计算，不接受浏览器提供任意文件路径。
- 移动、恢复和清理前使用 realpath/父路径校验；拒绝软链接逃逸和根目录目标。
- Registry、manifest 和 index 使用 0600 原子写入。
- 外部命令仍使用 argv 数组、`shell: false`。
- 日志和 operation 摘要只记录组件名及缩写路径，不读取或输出 Runtime/Bridge Secret。
- `--dry-run` 只列出动作，不创建 manifest、不卸载服务、不移动路径。

## 测试与验收

单元和集成测试覆盖：

- 移入后 Registry 不再包含员工，六类路径均移出活动区；
- Bridge 和所有启用/禁用 Job 服务均执行卸载；
- 任一 rename 或 Registry 写入失败时完整回滚；
- 回收站 manifest 不包含 Secret 值且权限为 0600；
- 7 天内可恢复，恢复后状态为 stopped 且不启动服务；
- ID 或路径冲突时拒绝恢复；
- 仅 `ready` 的过期条目会在下次运行时清理；
- API 确认对象、Host/Origin/CSRF 继续生效；
- Web 按钮、确认、成功跳转、回收站列表和恢复错误状态；
- Playwright 在临时 HOME 中创建测试员工、移入回收站、确认列表消失、恢复、再次移入并模拟过期清理。

验收命令保持：

```text
npm run build
npm test
npm run lint
npm run test:e2e
```
