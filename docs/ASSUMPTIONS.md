# v1 假设与默认值

- 正式支持 macOS，Linux systemd 仅保留适配器边界。
- `user-operations` 使用 Claude `sonnet`；Codex 未指定模型时使用 CLI 默认值。
- Registry 保存规范化绝对路径，终端显示时缩写为 `~`。
- 飞书只支持 dedicated 或 disabled；真实登录、扫码、Secret 与现有 Skill 内容由用户后续完成。
- 新 Agent 只执行 `git init --initial-branch=main`，不自动 commit 或 push。
