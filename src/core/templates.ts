import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { digestSkillDirectory } from './skills.js';
import { renderAuthorityStance } from './authority.js';
import { renderNewSeed as renderCurrentStateSeed } from './current-state.js';
import { ensureIdentityBaseline } from './identity-baseline.js';
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
    'agent/proposals',
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
  // D-041 P0-1/P1-3：身份文档播种。岗位骨架（ROLE 岗位定位）由 description 渲染（唯一权威），
  // 长期职责初始即岗位定位；宪法区（CONSTITUTION）播种红线锚点块，员工不可静默改动。
  await fs.writeFile(
    path.join(workspace, 'agent/ROLE.md'),
    `# 岗位定位\n\n${config.description}\n\n## 长期职责\n\n${bullets(preset.responsibilities)}\n\n## 协作协议\n\n- 你的身份文档分四层：宪法（不可静默改）→ 岗位骨架（岗位定位由系统从 \`agent.yaml.description\` 渲染，是唯一权威）→ 可进化区（GOALS/OPERATING_SYSTEM/POLICIES/skills/knowledge，自主改进）→ 会话/运行区（logs/automation，不入正式记忆）。\n- 想改岗位定位或权限红线 → 写提案（\`agent/proposals/\`）→ 用户在飞书聊天批准 → 再改。\n- 一切改动都会进 \`evolve:\` 单文件提交历史，可回溯。\n`,
  );
  await fs.writeFile(
    path.join(workspace, 'agent/CONSTITUTION.md'),
    await fs.readFile(path.join(packageRoot(), 'templates/agent-skeleton/CONSTITUTION.md'), 'utf8'),
  );
  await fs.writeFile(
    path.join(workspace, 'agent/GOALS.md'),
    `# 核心目标\n\n${bullets(preset.goals)}\n\n## 演进记录\n\n- ${new Date().toISOString()}：初始目标（创建员工）。\n`,
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
  // D-041 P0-3：身份基线播种。agent.yaml.description 为岗位定位唯一权威，ROLE.md 的
  // `# 岗位定位` 段由系统渲染；基线快照五份身份文档（含 CONSTITUTION，D-041 P1-3）标题+
  // 内容，供漂移检测/进化历史/提案对账。
  await ensureIdentityBaseline({ workspace, description: config.description });
  // D-041 P0-4：「记录→提案→批准」通道目录约定。员工对身份（ROLE/POLICIES/CONSTITUTION）
  // 的显著改动走提案，由用户在飞书聊天中批准后落盘；提案本身随自进化链提交，可回溯。
  await fs.writeFile(
    path.join(workspace, 'agent/proposals/README.md'),
    [
      '# 身份修订提案（agent/proposals）',
      '',
      '本目录存放你对**核心身份**（岗位定位 / 权限红线）的修订提案。**批准通道是飞书聊天**：',
      '把提案内容发给用户，用户明确说「同意 / 批准 / 就按这个改」后，你才改对应文件并标记',
      '`status: applied`；用户说「不同意」则标 `status: rejected` 归档。',
      '',
      '## 提案文件约定（frontmatter）',
      '',
      '```yaml',
      '---',
      'proposal_id: p-YYYYMMDD-序号',
      'kind: identity | policy | goal',
      'status: proposed | approved | rejected | applied | expired',
      'target_file: agent/ROLE.md',
      'proposed_at: 2026-08-06T00:00:00+08:00',
      'user_anchor: 用户在飞书中的原话/截图（批准依据，批准后必填）',
      '---',
      '```',
      '',
      '## 正文结构',
      '',
      '- **现状**：当前文件里相关段落原文。',
      '- **拟改**：你打算改成什么样。',
      '- **理由**：为什么要改（依据经验/数据/用户反馈）。',
      '- **证据引用**：`because of knowledge/lessons/xxx.md:行号`。',
      '',
      '## 协议',
      '',
      '- **只提案，不直改**：`agent/ROLE.md` 的岗位定位/长期职责、`agent/POLICIES.md` 的红线词',
      '  由系统硬门保护，删除或削弱会触发 identity-guard 拒绝提交；要改就写提案。',
      '- **员工不得自行 proposed→applied**：必须等到用户在飞书明确批准。',
      '- 目标（GOALS）、工作系统（OPERATING_SYSTEM）等「可进化区」不必走提案，但显著改动',
      '  仍建议先说明再改，改动都会进 `evolve:` 提交历史可回溯。',
      '',
      '> 这些文件由系统随自进化链单文件提交，不要手动 git 提交。',
      '',
    ].join('\n'),
  );
  await fs.writeFile(path.join(workspace, 'tasks/BACKLOG.md'), '# Backlog\n');
  await fs.writeFile(path.join(workspace, 'tasks/ACTIVE.md'), '# Active\n');
  await fs.writeFile(path.join(workspace, 'config/env.example'), '# 不要在此文件写入真实 Secret\n');
  await fs.writeFile(
    path.join(workspace, '.gitignore'),
    // T01：基线提交不应跟踪运行时敏感配置。.claude/settings.json 由模板生成（permissions 默认），
    // 属本机运行时产物、备份按 basename 排除为敏感文件，故从 Git 跟踪中剔除。
    // D-041 P2-1：knowledge/.archive/ 遗忘归档目录不进 git（归档条目不膨胀 git 历史，可恢复）。
    '.env\n.env.*\n!.env.example\n*.pem\n*.key\n*.p12\n*.token\nconfig/env.local\n.claude/settings.json\nlogs/*\n!logs/.gitkeep\nknowledge/.index.json\nknowledge/.archive/\n.DS_Store\n',
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
  // TASK-037：把宿主平台（AI Employee Factory）预置为员工 skill，新建即有。
  await ensureFactorySkill({
    workspace,
    provider: config.runtime.provider,
    values: { id: config.id, name: config.name, runtime: config.runtime.provider, workspace },
  });
  await renderRuntimeFiles(workspace, config, values);
}

// TASK-037（D-037）：把宿主平台预置为员工 skill（ai-employee-factory）。内容来自
// templates/factory-skill/SKILL.md，说明员工身份/环境/宿主项目/agentctl CLI/局限。
// 幂等：SKILL.md 内容与模板一致则跳过写盘（避免 settle 链反复 git 提交）；投影到运行时
// 发现目录（.claude 用相对链接、.codex 用绝对目标，与 renderSkills/projectCodexSkills 一致）。
export async function ensureFactorySkill(input: {
  workspace: string;
  provider: RuntimeProvider;
  values: Record<string, string>;
}): Promise<void> {
  const { workspace, provider, values } = input;
  const template = await fs.readFile(
    path.join(packageRoot(), 'templates/factory-skill/SKILL.md'),
    'utf8',
  );
  const content = render(template, values);
  const dir = path.join(workspace, 'skills', 'ai-employee-factory');
  const skillFile = path.join(dir, 'SKILL.md');
  const existing = await fs.readFile(skillFile, 'utf8').catch(() => '');
  if (existing !== content) {
    await fs.ensureDir(path.join(dir, 'scripts'));
    await fs.ensureDir(path.join(dir, 'references'));
    await fs.writeFile(skillFile, content);
    await fs.writeFile(
      path.join(dir, '.agentctl.yaml'),
      YAML.stringify({
        name: 'ai-employee-factory',
        version: '1.0.0',
        source: 'factory',
        installed_at: new Date().toISOString(),
        digest: await digestSkillDirectory(dir),
      }),
    );
  }
  // 投影到运行时 skill 发现目录（幂等，已存在则跳过）。相对目标 `../../skills/<name>` 在
  // 创建流程的工作区 rename 后仍有效（.claude 与 .codex 均与 workspace 同级），故两 provider 共用。
  const projectionDir = path.join(
    workspace,
    provider === 'claude' ? '.claude' : '.codex',
    'skills',
  );
  await fs.ensureDir(projectionDir);
  const link = path.join(projectionDir, 'ai-employee-factory');
  const target = path.join('../../skills', 'ai-employee-factory');
  if (!(await fs.pathExists(link))) {
    await fs.symlink(target, link);
  }
}

// D-039：存量员工系统提示词回填。仅当 CLAUDE.md/AGENTS.md 缺「宿主平台」小节（D-037 之前创建的
// 旧员工）时，按当前模板重渲一次，使存量员工与新建员工完全一致；已含该小节则不动（尊重员工
// 对系统提示的既有编辑，不反复覆盖）。返回是否发生写入（供调用方决定是否走自进化提交）。
//
// D-041 P0-2/P1-5：回填条件扩为「缺宿主平台 **或** 缺分层自进化协议标记」。D-039 之后创建的
// 员工（已含宿主平台但仍是旧「自我进化」文案）也重渲为新协议文案；已含「分层自进化协议」
// 小节则不动（尊重员工对系统提示的既有编辑，幂等不反复覆盖）。
const RUNTIME_PROMPT_PROTOCOL_MARKER = '## 分层自进化协议';
export async function ensureRuntimePrompt(input: {
  workspace: string;
  provider: RuntimeProvider;
  values: Record<string, string>;
  memory: AgentConfig['memory'];
}): Promise<boolean> {
  const { workspace, provider, values, memory } = input;
  const file = path.join(workspace, provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.md');
  const existing = await fs.readFile(file, 'utf8').catch(() => '');
  if (
    existing.includes('## 宿主平台（AI Employee Factory）') &&
    existing.includes(RUNTIME_PROMPT_PROTOCOL_MARKER)
  ) {
    return false;
  }
  const entry = await fs.readFile(
    path.join(packageRoot(), `templates/${provider}-agent/ENTRY.md.tmpl`),
    'utf8',
  );
  // 与 renderRuntimeFiles 同构：ENTRY 渲染 + 从 agent.yaml.memory.authority_order 派生的权威顺序。
  const content = `${render(entry, values)}\n\n${renderAuthorityStance(memory)}\n`;
  await fs.writeFile(file, content);
  return true;
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
