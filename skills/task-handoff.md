# Skill: Task Handoff

## 使用场景

任务结束、暂停、换 Agent、接近上下文边界或存在未完成工作时。

## 不适用场景

永久架构、产品规则和通用方法应进入 docs/ 或 skills/，不应只留在 handoff。

## 输入

当前目标、git status/diff、验证结果、决策、pending 和失败尝试。

## 执行步骤

1. 使用 `.agent/TASK_HANDOFF.md` 的固定章节作为当前任务的可恢复检查点。
2. 用事实描述 Current Status，不依赖「刚才」「上面」等聊天上下文。
3. Changed Files 说明原因，并区分既有改动与本任务改动。
4. Documentation Updated / Documentation Not Updated 按代码-文档映射逐项记录（见 AGENTS.md）。
5. Verification 写实际命令、结果和 warning。
6. Pending、Known Issues 和 Next Action 必须可执行。
7. 将永久信息迁往 docs/DECISIONS.md 或 skills/，再精简 handoff。
8. 暂停或完成时归档一份副本到 `.agent/handoffs/`。

## 检查清单

- [ ] 当前 commit/工作树状态清楚。
- [ ] 已完成与未完成没有混写。
- [ ] 不含密钥、用户数据或冗长聊天过程。
- [ ] 文档更新与无需更新都已逐项说明。
- [ ] 下一位 AI 能从文件独立继续。

## 输出

更新后的 `.agent/TASK_HANDOFF.md`、归档副本与面向用户的简短状态报告。

## 完成标准

陌生 Agent 不询问历史聊天即可确认目标、进度、验证、风险和下一动作。

## 常见风险

把 handoff 写成日志；遗漏未提交状态；宣称未运行的测试通过；长期规则只留在 Pending；文档更新一笔带过。

## 与其他 Skill 的关系

所有任务的最终步骤；test-and-verify 为其提供验证输入；长期信息由 docs/ 承接。
