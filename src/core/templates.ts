import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { digestSkillDirectory } from './skills.js';
import { renderAuthorityStance } from './authority.js';
import { renderNewSeed as renderCurrentStateSeed } from './current-state.js';
import type { AgentConfig, RuntimeProvider } from '../schemas/agent-schema.js';
import type { Preset } from '../schemas/preset-schema.js';

export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

function render(template: string, values: Record<string, string>): string {
  return template.replace(/{{(\w+)}}/g, (_, key: string) => values[key] ?? '');
}

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

async function writeExecutable(file: string, content: string): Promise<void> {
  await fs.outputFile(file, content, { mode: 0o755 });
  await fs.chmod(file, 0o755);
}

export async function renderAgentWorkspace(input: {
  workspace: string;
  config: AgentConfig;
  preset: Preset;
}): Promise<void> {
  const { workspace, config, preset } = input;
  const directories = [
    'agent',
    'skills',
    'knowledge/product',
    'knowledge/metrics',
    'knowledge/decisions',
    'knowledge/lessons',
    'knowledge/references',
    'tasks',
    'workflows',
    'scripts',
    'reports/daily',
    'reports/weekly',
    'automation/jobs',
    'automation/prompts',
    'config',
    'logs',
    'deployment',
  ];
  await Promise.all(directories.map((dir) => fs.ensureDir(path.join(workspace, dir))));
  const values = { id: config.id, name: config.name, description: config.description };
  const readmeTemplate = await fs.readFile(
    path.join(packageRoot(), 'templates/common/README.md.tmpl'),
    'utf8',
  );
  await fs.writeFile(path.join(workspace, 'README.md'), render(readmeTemplate, values));
  await fs.writeFile(path.join(workspace, 'agent.yaml'), YAML.stringify(config));
  await fs.writeFile(
    path.join(workspace, 'agent/ROLE.md'),
    `# 岗位定位\n\n${config.description}\n\n## 长期职责\n\n${bullets(preset.responsibilities)}\n`,
  );
  await fs.writeFile(
    path.join(workspace, 'agent/GOALS.md'),
    `# 核心目标\n\n${bullets(preset.goals)}\n`,
  );
  await fs.writeFile(
    path.join(workspace, 'agent/OPERATING_SYSTEM.md'),
    '# 标准工作闭环\n\n发现问题 → 收集证据 → 判断影响 → 提出方案 → 创建任务 → 跟踪执行 → 验证结果 → 沉淀经验\n',
  );
  await fs.writeFile(
    path.join(workspace, 'agent/POLICIES.md'),
    `# 权限与上报规则\n\n## 权限边界\n\n${bullets(preset.policies)}\n\n## 主动上报\n\n${bullets(preset.escalation_conditions)}\n`,
  );
  // OP6-B：CURRENT_STATE.md 采用「系统标记块 + 员工工作进展段」结构；系统侧生命周期事件
  // （登录/授权/启停/归档恢复）只更新标记块内的行，块外内容员工维护、系统不覆盖。
  await fs.writeFile(path.join(workspace, 'agent/CURRENT_STATE.md'), renderCurrentStateSeed());
  await fs.writeFile(path.join(workspace, 'tasks/BACKLOG.md'), '# Backlog\n');
  await fs.writeFile(path.join(workspace, 'tasks/ACTIVE.md'), '# Active\n');
  await fs.writeFile(path.join(workspace, 'config/env.example'), '# 不要在此文件写入真实 Secret\n');
  await fs.writeFile(
    path.join(workspace, '.gitignore'),
    // T01：基线提交不应跟踪运行时敏感配置。.claude/settings.json 由模板生成（permissions 默认），
    // 属本机运行时产物、备份按 basename 排除为敏感文件，故从 Git 跟踪中剔除。
    '.env\n.env.*\n!.env.example\n*.pem\n*.key\n*.p12\n*.token\nconfig/env.local\n.claude/settings.json\nlogs/*\n!logs/.gitkeep\nknowledge/.index.json\n.DS_Store\n',
  );
  await fs.ensureFile(path.join(workspace, 'logs/.gitkeep'));
  // OP1 Stage B：knowledge/ 目录约定。以 frontmatter（title/summary/keywords/updated_at/authority_layer）
  // 描述正式知识，agentctl knowledge 命令组据此扫描生成 knowledge/.index.json（派生、gitignored）。
  // decisions/ 下的条目默认归 'decisions' 层；其余顶层子目录默认归 'knowledge' 层。
  await fs.writeFile(
    path.join(workspace, 'knowledge/README.md'),
    [
      '# 知识库',
      '',
      'knowledge/ 存放正式知识（OP1 Stage B）。每个 markdown 文件以 YAML frontmatter 声明元数据，',
      '`agentctl knowledge` 命令组据此建立关键词索引（knowledge/.index.json，自动生成、不入 Git）。',
      '',
      '```yaml',
      '---',
      'title: 条目标题',
      'summary: 一句话摘要',
      'keywords: [关键词A, 关键词B]',
      'updated_at: 2026-08-04',
      'authority_layer: knowledge  # 可选：decisions | skills | native_memory | session | agent',
      '---',
      '```',
      '',
      '子目录约定：product（产品知识）、metrics（指标口径）、decisions（决策记录，归 decisions 层）、',
      'lessons（经验教训）、references（参考资料）。',
      '',
    ].join('\n'),
  );
  // TASK-031（D-028）：员工自我配置定时任务——automation/jobs/ 目录协议说明。
  await fs.writeFile(
    path.join(workspace, 'automation/jobs/README.md'),
    [
      '# 定时任务（automation/jobs）',
      '',
      '本目录存放定时任务定义（YAML）。每个文件一个任务，文件名＝任务 id。',
      '',
      '## 来源（managed_by）',
      '',
      '- `managed_by: admin`（缺省）：管理员配置，系统不会自动增删。',
      '- `managed_by: employee`：员工自我配置，系统在每次任务执行结束后自动 reconcile：',
      '  - `enabled: true` 的任务自动安装定时调度，并单文件 git 提交；',
      '  - 删除文件或 `enabled: false` 自动反注册；',
      '  - 修改 `schedule.time` 自动重新加载。',
      '',
      '## 最小示例（agent 任务）',
      '',
      '```yaml',
      'schema_version: 1',
      'id: daily-summary',
      'enabled: true',
      'managed_by: employee',
      'schedule:',
      '  type: daily',
      '  time: "09:00"',
      'execution:',
      '  type: agent',
      '  prompt_file: automation/prompts/daily-summary.md',
      '```',
      '',
      '脚本任务用 `type: script` + `script_file`（必须在工作区内）。',
      '提示：任务内容 prompt/脚本放在 `automation/` 下；不要改管理员任务，不可扩大权限。',
      '',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(workspace, 'deployment/MIGRATION.md'),
    `# 迁移 ${config.name}\n\n1. 克隆本 Agent Git 仓库或使用 \`agentctl restore\`。\n2. 在新电脑运行 \`${
      config.runtime.provider === 'claude'
        ? `agentctl runtime sync ${config.id}`
        : `agentctl runtime login ${config.id}`
    }\`。\n3. 运行 \`agentctl bridge authorize ${config.id}\`。\n4. 运行 \`agentctl doctor ${config.id}\`。\n\nClaude 只从 CC Switch 当前 Provider 同步必要配置；不要复制个人会话目录、~/.codex 或明文 Secret。\n`,
  );
  await writeExecutable(
    path.join(workspace, 'deployment/start.sh'),
    `#!/bin/sh\nexec agentctl start ${config.id} "$@"\n`,
  );
  await writeExecutable(
    path.join(workspace, 'deployment/run.sh'),
    `#!/bin/sh\nexec agentctl run ${config.id} "$@"\n`,
  );
  await writeExecutable(
    path.join(workspace, 'deployment/health-check.sh'),
    `#!/bin/sh\nexec agentctl doctor ${config.id}\n`,
  );

  await renderSkills(workspace, preset.skills, config.runtime.provider);
  await renderRuntimeFiles(workspace, config, values);
}

async function renderSkills(
  workspace: string,
  skills: string[],
  provider: RuntimeProvider,
): Promise<void> {
  for (const name of skills) {
    const target = path.join(workspace, 'skills', name);
    await fs.ensureDir(path.join(target, 'scripts'));
    await fs.ensureDir(path.join(target, 'references'));
    const skillContent = `---\nname: ${name}\ndescription: 待用户迁移现有 ${name} Skill 内容\n---\n\n# ${name}\n\n此目录是标准占位模板，不包含数据库、Apple API 或飞书文档配置。\n`;
    await fs.writeFile(path.join(target, 'SKILL.md'), skillContent);
    await fs.writeFile(
      path.join(target, '.agentctl.yaml'),
      YAML.stringify({
        name,
        version: '0.1.0',
        source: 'generated',
        installed_at: new Date().toISOString(),
        digest: await digestSkillDirectory(target),
      }),
    );
  }
  if (provider === 'claude') {
    const projection = path.join(workspace, '.claude/skills');
    await fs.ensureDir(projection);
    for (const name of skills)
      await fs.symlink(path.join('../../skills', name), path.join(projection, name));
  }
}

async function renderRuntimeFiles(
  workspace: string,
  config: AgentConfig,
  values: Record<string, string>,
): Promise<void> {
  const provider = config.runtime.provider;
  const entry = await fs.readFile(
    path.join(packageRoot(), `templates/${provider}-agent/ENTRY.md.tmpl`),
    'utf8',
  );
  // OP1 Stage A：权威顺序 stance 从 agent.yaml.memory.authority_order 派生，追加到 CLI 读取的系统提示文件，
  // 替代硬编码散文--改 agent.yaml 即改注入立场（W1 收敛）。
  const content = `${render(entry, values)}\n\n${renderAuthorityStance(config.memory)}\n`;
  if (provider === 'claude') {
    await fs.ensureDir(path.join(workspace, '.claude/rules'));
    await fs.ensureDir(path.join(workspace, '.claude/agents'));
    // OP6-B：放行员工编辑 CURRENT_STATE.md（默认 default 模式下该文件不在隐式白名单内，
    // 无放行每次编辑会弹权限确认）。其余文件保持默认询问。
    await fs.writeJson(
      path.join(workspace, '.claude/settings.json'),
      {
        permissions: {
          defaultMode: 'default',
          allow: ['Edit(agent/CURRENT_STATE.md)', 'Write(agent/CURRENT_STATE.md)'],
        },
      },
      { spaces: 2 },
    );
    await fs.writeFile(path.join(workspace, 'CLAUDE.md'), content);
  } else {
    await fs.ensureDir(path.join(workspace, '.codex'));
    await fs.writeFile(
      path.join(workspace, '.codex/config.toml'),
      'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n',
    );
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), content);
  }
}
