# Skill: Feature Development

## 使用场景

新增可见能力、API、配置、报表或完整交互。

## 不适用场景

根因明确的回归缺陷使用 bug-fix；无行为变化的结构调整使用 refactor（大型任务按 docs/DEVELOPMENT_RULES.md 的规模分级处理）。

## 输入

验收条件、影响清单、现有相似实现、API/数据契约。

## 执行步骤

1. 完成 requirement-review，确认状态和数据所有权。
2. 设计最小纵向切片：领域逻辑、接口、数据访问、UI（按项目架构）。
3. 先为校验、转换和边界补测试。
4. 按 docs/ARCHITECTURE.md 放置代码，复用既有数据访问通道与公共组件。
5. 验证 loading/empty/error、导出、比较和兼容场景。
6. 更新 README、docs（按 AGENTS.md 代码-文档映射）与 `.agent/` 状态。

## 检查清单

- [ ] 代码放置符合 docs/ARCHITECTURE.md 的边界约定。
- [ ] 数据访问走项目既定通道，未散写绕过层。
- [ ] 密钥、ID、错误信息无泄露。
- [ ] 自动和人工验收覆盖核心路径。
- [ ] 文档与 `.agent/` 状态已同步。

## 输出

完整纵向功能、测试、文档和 handoff 更新。

## 完成标准

验收条件全部满足，相关检查通过，无双实现或未解释风险。

## 常见风险

只完成一半；复制相似实现导致口径漂移；重依赖进入首屏；范围悄悄扩大。

## 与其他 Skill 的关系

前置 requirement-review，结束使用 test-and-verify、task-handoff。
