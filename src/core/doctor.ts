import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import YAML from 'yaml';
import { computeConfigHash, getRegisteredAgent, readAgentConfigFile } from './agents.js';
import { validateMemoryConfig } from './authority.js';
import { BridgeAdapter } from './bridge.js';
import { KnowledgeIndexImpl } from './knowledge-index.js';
import { IDENTITY_BASELINE_FILE, baselineDrift } from './identity-baseline.js';
import { validateIdentityGuard } from './identity-guard.js';
import { appliedWithoutAnchor, readIdentityProtocol, readLedger } from './proposal-ledger.js';
import { readReflectionSignals, reflectionSignalsPath } from './reflection.js';
import {
  RETENTION_DAYS,
  RETENTION_SOURCE_DIRS,
  archiveDateFromFilename,
} from './knowledge-retention.js';
import type { FactoryPaths } from './paths.js';
import type { RegistryStore } from './registry.js';
import { buildSafeBaseEnvironment } from './runtime.js';
import { TrashService } from './trash.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  remediation?: string;
}
export interface DoctorReport {
  checks: DoctorCheck[];
  summary: Record<CheckStatus, number>;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function withDiagnosticEnvironment<T>(
  operation: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-doctor-check-'));
  try {
    return await operation({
      ...buildSafeBaseEnvironment(),
      HOME: root,
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      CODEX_HOME: path.join(root, 'codex'),
      LARK_CHANNEL_HOME: path.join(root, 'bridge'),
    });
  } finally {
    await fs.remove(root);
  }
}

async function commandAvailable(command: string): Promise<boolean> {
  return withDiagnosticEnvironment(async (env) => {
    try {
      return (
        (
          await execa(command, ['--version'], {
            shell: false,
            reject: false,
            env,
            extendEnv: false,
          })
        ).exitCode === 0
      );
    } catch {
      return false;
    }
  });
}

export class DoctorService {
  constructor(
    private readonly paths: FactoryPaths,
    private readonly registry: RegistryStore,
  ) {}

  async run(agentId?: string): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const add = (check: DoctorCheck) => checks.push(check);
    const major = Number(process.versions.node.split('.')[0]);
    add(
      major >= 20
        ? { id: 'node', label: 'Node.js', status: 'pass', detail: process.version }
        : {
            id: 'node',
            label: 'Node.js',
            status: 'fail',
            detail: process.version,
            remediation: '请安装 Node.js 20 或更高版本。',
          },
    );
    try {
      await this.registry.read();
      add({
        id: 'registry',
        label: 'Agent Registry',
        status: 'pass',
        detail: this.paths.registryFile,
      });
      const registryMode = (await fs.stat(this.paths.registryFile)).mode & 0o777;
      add(
        registryMode === 0o600
          ? {
              id: 'registry-permissions',
              label: 'Registry 权限',
              status: 'pass',
              detail: registryMode.toString(8),
            }
          : {
              id: 'registry-permissions',
              label: 'Registry 权限',
              status: 'fail',
              detail: registryMode.toString(8),
              remediation: `运行 chmod 600 ${this.paths.registryFile}`,
            },
      );
    } catch (error) {
      add({
        id: 'registry',
        label: 'Agent Registry',
        status: 'fail',
        detail: String(error),
        remediation: '请运行 agentctl init 或恢复 registry/backups。',
      });
    }
    for (const [id, label, command] of [
      ['git', 'Git', 'git'],
      ['claude-cli', 'Claude CLI', 'claude'],
      ['codex-cli', 'Codex CLI', 'codex'],
      ['bridge-cli', 'lark-channel-bridge', 'lark-channel-bridge'],
    ] as const) {
      const available = await commandAvailable(command);
      add({
        id,
        label,
        status: available ? 'pass' : 'warn',
        detail: available ? '已安装' : '未安装（只影响使用该能力的 Agent）',
      });
    }
    // OP5-A：service-platform 按 config.yaml 的 service_provider 分发。
    let serviceProvider = 'unsupported';
    if (await fs.pathExists(this.paths.configFile)) {
      try {
        const raw = YAML.parse(await fs.readFile(this.paths.configFile, 'utf8'));
        if (typeof raw?.service_provider === 'string') serviceProvider = raw.service_provider;
      } catch {
        // 配置不可解析则维持 unsupported，由 config-permissions 检查另行告警。
      }
    }
    if (serviceProvider === 'launchd')
      add({ id: 'service-platform', label: 'launchd', status: 'pass', detail: 'macOS launchd' });
    else if (serviceProvider === 'systemd')
      add({
        id: 'service-platform',
        label: 'systemd',
        status: 'warn',
        detail: 'systemd 服务适配器为桩，install 抛 DEPENDENCY_MISSING（v1 仅正式支持 macOS）',
      });
    else
      add({
        id: 'service-platform',
        label: '服务平台',
        status: 'warn',
        detail: '未配置受支持的 service_provider（v1 仅正式支持 macOS launchd）',
      });
    if (await fs.pathExists(this.paths.configFile)) {
      const configMode = (await fs.stat(this.paths.configFile)).mode & 0o777;
      add({
        id: 'config-permissions',
        label: 'Factory 配置权限',
        status: configMode === 0o600 ? 'pass' : 'fail',
        detail: configMode.toString(8),
      });
    } else
      add({
        id: 'config-permissions',
        label: 'Factory 配置权限',
        status: 'fail',
        detail: '配置文件不存在',
      });
    add({
      id: 'environment-overrides',
      label: '根目录环境变量',
      status: 'pass',
      detail: `AI_EMPLOYEES_HOME=${this.paths.home}; AI_EMPLOYEES_WORKSPACE_ROOT=${this.paths.workspaceRoot}`,
    });
    const trashEntries = await new TrashService(this.paths, this.registry).list().catch(() => []);
    const stuckTrash = trashEntries.filter(
      (entry) => entry.state === 'failed' || entry.state === 'moving' || entry.state === 'purging',
    );
    add({
      id: 'trash-health',
      label: '员工回收站',
      status: stuckTrash.length ? 'fail' : 'pass',
      detail: stuckTrash.length
        ? `${stuckTrash.length} 个事务处于失败/卡死状态（${stuckTrash.map((entry) => entry.trashId).join(', ')}）`
        : `${trashEntries.length} 个可恢复条目`,
      ...(stuckTrash.length
        ? {
            remediation:
              '检查回收站 manifest 与原路径；确认无需保留后运行 agentctl trash purge --force <trash-id> 清理失败/卡死条目。',
          }
        : {}),
    });
    const backupsBytes = await this.backupsDirSize();
    const runLogCount = await this.countRunLogs();
    const overBytes = backupsBytes > 500 * 1024 * 1024;
    const overCount = runLogCount > 500;
    add({
      id: 'disk-usage',
      label: '磁盘占用',
      status: overBytes || overCount ? 'warn' : 'pass',
      detail: `备份归档 ${(backupsBytes / 1024 / 1024).toFixed(1)} MiB；run 日志 ${runLogCount} 个目录`,
      ...(overBytes || overCount
        ? { remediation: '运行 agentctl prune --dry-run 查看可清理项。' }
        : {}),
    });
    if (agentId) await this.agentChecks(agentId, add);
    const summary = { pass: 0, warn: 0, fail: 0 };
    for (const check of checks) summary[check.status] += 1;
    return { checks, summary };
  }

  private async agentChecks(agentId: string, add: (check: DoctorCheck) => void): Promise<void> {
    const agent = await getRegisteredAgent(this.registry, agentId);
    add({
      id: 'workspace',
      label: 'Workspace',
      status:
        (await fs.pathExists(agent.workspace.path)) &&
        inside(this.paths.workspaceRoot, agent.workspace.path)
          ? 'pass'
          : 'fail',
      detail: agent.workspace.path,
    });
    add({
      id: 'workspace-git',
      label: 'Git',
      status: (await fs.pathExists(path.join(agent.workspace.path, '.git'))) ? 'pass' : 'fail',
      detail: path.join(agent.workspace.path, '.git'),
    });
    // OP3-A 长期：doctor 诊断必须能检视漂移 agent，故原样读 agent.yaml（不做 config_hash 校验），
    // 由下方 config-drift 检查独立报告漂移。
    const portableConfig = await readAgentConfigFile(
      path.join(agent.workspace.path, 'agent.yaml'),
    ).catch(() => null);
    const portValid = portableConfig !== null;
    add({
      id: 'agent-config',
      label: 'agent.yaml',
      status: portValid ? 'pass' : 'fail',
      detail: portValid ? '可解析' : '无效或缺失',
    });
    // OP3-A：config_hash 漂移检测--agent.yaml runtime 块为唯一真相，Registry 派生缓存须一致。
    // HARD 模式下漂移 agent 不可用，故状态升为 fail（remediation 指向 repair）。
    if (portableConfig) {
      const actualHash = computeConfigHash(portableConfig.runtime);
      const drift = !agent.config_hash || actualHash !== agent.config_hash;
      add(
        drift
          ? {
              id: 'config-drift',
              label: '配置漂移',
              status: 'fail',
              detail: !agent.config_hash
                ? 'Registry 缺 config_hash（旧条目，待补齐）'
                : 'agent.yaml 与 Registry 缓存不一致',
              remediation: `运行 agentctl repair ${agent.id} 以 agent.yaml 重建 Registry 缓存。`,
            }
          : { id: 'config-drift', label: '配置漂移', status: 'pass', detail: '一致' },
      );
    }
    // OP5-D：Registry 本机绑定的 CC Switch Provider 检查。绑定即非 live 语义（短期 warn，长期将按
    // provider 不匹配 fail）。仅 claude runtime 有意义；codex runtime 的绑定为无效状态（warn）。
    if (portableConfig && portableConfig.runtime.provider === 'claude') {
      const bound = agent.credential_provider;
      add(
        bound
          ? {
              id: 'credential-provider',
              label: 'CC Switch Provider 绑定',
              status: 'warn',
              detail: `绑定 ${bound}（非当前 live，短期语义）`,
              remediation: `如不再需要该绑定，运行 agentctl runtime sync ${agent.id} --provider live 清除。`,
            }
          : {
              id: 'credential-provider',
              label: 'CC Switch Provider 绑定',
              status: 'pass',
              detail: '未绑定（跟随当前 live Provider）',
            },
      );
    }
    // OP1 Stage A：memory.enforced 运行时强制一致性（W1 收敛）。4 态：undefined(旧)/false warn、true+无效 fail、true+有效 pass。
    if (portableConfig) {
      const enforced = portableConfig.memory.enforced;
      if (enforced === undefined) {
        add({
          id: 'memory-enforcement',
          label: '记忆强制',
          status: 'warn',
          detail: '未声明 memory.enforced（旧 agent.yaml）',
          remediation: '在 agent.yaml 的 memory 块设 enforced: true 启用运行时强制。',
        });
      } else if (enforced === false) {
        add({
          id: 'memory-enforcement',
          label: '记忆强制',
          status: 'warn',
          detail: 'memory.enforced 已显式关闭',
          remediation: 'authority_order 不在运行时强制；如需启用请设 enforced: true。',
        });
      } else {
        const { ok, issues } = validateMemoryConfig(portableConfig.memory);
        add(
          ok
            ? {
                id: 'memory-enforcement',
                label: '记忆强制',
                status: 'pass',
                detail: '已启用运行时强制',
              }
            : {
                id: 'memory-enforcement',
                label: '记忆强制',
                status: 'fail',
                detail: `authority_order 无效：${issues.join('；')}`,
                remediation:
                  '修正 agent.yaml 的 memory.authority_order，或设 enforced: false 降级。',
              },
        );
      }
    }
    // OP1 Stage B：知识库索引漂移检测。index 是派生文件（.gitignore 排除），
    // 与 knowledge/**/*.md 内容不一致时 warn，remediation 指向 knowledge rebuild 重建。
    const knowledgeRoot = path.join(agent.workspace.path, 'knowledge');
    if (await fs.pathExists(knowledgeRoot)) {
      const knowledgeDirReal = await fs.realpath(knowledgeRoot);
      if (inside(this.paths.workspaceRoot, knowledgeDirReal)) {
        const consistency = await new KnowledgeIndexImpl(knowledgeRoot).verifyConsistency();
        add(
          consistency.ok
            ? { id: 'knowledge-index', label: '知识库索引', status: 'pass', detail: '索引一致' }
            : {
                id: 'knowledge-index',
                label: '知识库索引',
                status: 'warn',
                detail: consistency.issues
                  .slice(0, 3)
                  .map((issue) => issue.detail)
                  .join('；'),
                remediation: `运行 agentctl knowledge rebuild ${agent.id} 重建索引。`,
              },
        );
      }
    }
    // D-041 P3-2：身份基线漂移监控。IDENTITY_BASELINE.md 缺失/不可解析 → 无法对账（warn）；
    // 存在但相对基线有漂移 → warn（remediation 指向 identity rollback 恢复单文件）。
    const identityDrift = await baselineDrift(agent.workspace.path);
    add(
      identityDrift === null
        ? {
            id: 'identity-baseline',
            label: '身份基线',
            status: 'warn',
            detail: `基线缺失或不可解析（${IDENTITY_BASELINE_FILE}）。新建员工 settleActive 幂等回填；存量员工首次 settle 自动生成。`,
            remediation: `运行 agentctl identity rollback ${agent.id} agent/IDENTITY_BASELINE.md 重新生成基线。`,
          }
        : identityDrift.drift
          ? {
              id: 'identity-baseline',
              label: '身份基线',
              status: 'warn',
              detail: `身份文档相对基线漂移：${Object.entries(identityDrift.docs)
                .map(
                  ([relPath, drift]) =>
                    `${relPath}（+${drift?.added.length ?? 0}/-${drift?.removed.length ?? 0} 行）`,
                )
                .join('、')}。`,
              remediation: `运行 agentctl identity rollback ${agent.id} <file> 回滚单文件，或走飞书聊天提案。`,
            }
          : { id: 'identity-baseline', label: '身份基线', status: 'pass', detail: '与基线一致' },
    );
    // D-041 P3-2：身份文档锚点硬门。ROLE 岗位定位/长期职责标题、POLICIES 红线词、CONSTITUTION
    // 使命/变更流程标题缺失 → 疑似被删除/重写（fail，硬门语义，与 commitSelfEvolution 一致）。
    const guardIssues: Array<{ relPath: string; message: string }> = [];
    for (const relPath of ['agent/ROLE.md', 'agent/POLICIES.md', 'agent/CONSTITUTION.md']) {
      const content = await fs
        .readFile(path.join(agent.workspace.path, relPath), 'utf8')
        .catch(() => '');
      const result = validateIdentityGuard(relPath, content);
      if (!result.ok) {
        for (const issue of result.issues) guardIssues.push({ relPath, message: issue.message });
      }
    }
    add(
      guardIssues.length > 0
        ? {
            id: 'identity-guard',
            label: '身份锚点硬门',
            status: 'fail',
            detail: guardIssues
              .slice(0, 3)
              .map((issue) => issue.message)
              .join('；'),
            remediation: '受保护锚点不可被删除/重写，恢复缺失锚点后走聊天提案修改。',
          }
        : { id: 'identity-guard', label: '身份锚点硬门', status: 'pass', detail: '锚点完整' },
    );
    // D-041 P3-2：提案账本对账。身份文档相对基线改动超出可进化范围且无 user_anchor 批准依据
    // → 未授权身份改动（fail）。基线缺失时 baselineDrift 返回 null → 无基线无从对账（交由
    // identity-baseline 检查项告警，此处不误伤）。
    // D-043（identity_edits 生效）：direct=聊天直改模式 → 对账跳过（不判未授权，detail 标注）；
    // proposal_required（默认）维持提案门。identity-guard 锚点硬门在任何模式下都单独 fail。
    const ledger = await readLedger(this.paths.logsDir, agentId);
    const edits = portableConfig?.memory.identity_edits ?? 'proposal_required';
    const unauthorized = await appliedWithoutAnchor(agent.workspace.path, ledger, edits);
    const protocol = await readIdentityProtocol(agent.workspace.path);
    add(
      edits === 'direct'
        ? {
            id: 'proposal-ledger',
            label: '提案账本',
            status: 'pass',
            detail: `direct 模式（聊天直改，跳过提案门；锚点硬门仍生效）`,
          }
        : unauthorized.length === 0
          ? {
              id: 'proposal-ledger',
              label: '提案账本',
              status: 'pass',
              detail: `无未授权身份改动（协议 ${protocol}）`,
            }
          : {
              id: 'proposal-ledger',
              label: '提案账本',
              status: 'fail',
              detail: `未授权身份改动：${unauthorized
                .slice(0, 3)
                .map((item) => `${item.relPath}（${item.reason}）`)
                .join('、')}（协议 ${protocol}）。`,
              remediation:
                protocol === 'enforced'
                  ? 'enforced 模式已拒提交违规文件，保留工作区脏文件供 git diff/checkout 决策。'
                  : '身份改动须先在飞书聊天中经用户批准（user_anchor 落账本），或回滚单文件。',
            },
    );
    // D-041 P3-2：三个自进化开关（transcript_persist/experience_extraction/skill_self_creation）
    // 缺失（undefined）→ 按默认开处理（warn 引导补齐）；显式 false 尊重用户关闭意图（不误伤）。
    const memory = portableConfig?.memory;
    const missingFlags =
      memory === undefined
        ? ['transcript_persist', 'experience_extraction', 'skill_self_creation']
        : [
            ['transcript_persist', memory.transcript_persist],
            ['experience_extraction', memory.experience_extraction],
            ['skill_self_creation', memory.skill_self_creation],
          ]
            .filter(([, value]) => value === undefined)
            .map(([name]) => name as string);
    add(
      missingFlags.length === 0
        ? { id: 'memory-flags', label: '自进化开关', status: 'pass', detail: '三开关均已启用' }
        : {
            id: 'memory-flags',
            label: '自进化开关',
            status: 'warn',
            detail: `缺失开关：${missingFlags.join('、')}（缺失按默认开处理，显式 false 尊重关闭意图）。`,
            remediation: '在飞书聊天中请用户开启对应开关，或 agentctl 编辑 agent.yaml 补齐。',
          },
    );
    // D-041 P3-2：knowledge 遗忘监控。lessons/raw 与 lessons/refined 中有超过保留期（默认 90 天）
    // 仍未被归档的陈旧条目 → warn（引导运行 retention）；无陈旧 → pass。
    let staleCount = 0;
    for (const dir of RETENTION_SOURCE_DIRS) {
      const sourceDir = path.join(agent.workspace.path, 'knowledge', 'lessons', dir);
      const entries = await fs.readdir(sourceDir).catch(() => []);
      const now = new Date();
      for (const filename of entries) {
        if (!filename.endsWith('.md')) continue;
        const date = archiveDateFromFilename(filename);
        if (!date) continue;
        const ageDays = (now.getTime() - new Date(`${date}T00:00:00Z`).getTime()) / 86_400_000;
        if (!Number.isNaN(ageDays) && ageDays >= RETENTION_DAYS) staleCount += 1;
      }
    }
    add(
      staleCount === 0
        ? {
            id: 'knowledge-retention',
            label: '知识遗忘',
            status: 'pass',
            detail: '无超期未归档的经验条目',
          }
        : {
            id: 'knowledge-retention',
            label: '知识遗忘',
            status: 'warn',
            detail: `${staleCount} 条经验超过保留期（${RETENTION_DAYS} 天）尚未归档。`,
            remediation: '运行 agentctl knowledge retention <agent-id> 归档超期经验。',
          },
    );
    // D-041 P3-2：二级反思证据监控。refined/ 经验条目不附 `because of:` 证据引用
    // → 无法回溯到 raw/ 原始记录（数据血缘受损，warn）。无 refined 或均有证据 → pass。
    const signalsFile = reflectionSignalsPath(agent.workspace.path);
    const signals = await readReflectionSignals(signalsFile);
    const refinedDir = path.join(agent.workspace.path, 'knowledge', 'lessons', 'refined');
    const refinedFiles = (await fs.readdir(refinedDir).catch(() => [])).filter((file) =>
      file.endsWith('.md'),
    );
    let missingEvidenceCount = 0;
    for (const file of refinedFiles) {
      const content = await fs.readFile(path.join(refinedDir, file), 'utf8').catch(() => '');
      if (!content.includes('because of:')) missingEvidenceCount += 1;
    }
    add(
      missingEvidenceCount === 0
        ? {
            id: 'reflection',
            label: '二级反思',
            status: 'pass',
            detail:
              signals.length > 0
                ? `已积累 ${signals.length} 条反思信号，refined 经验均带证据引用`
                : 'refined 经验均带证据引用（尚无反思信号属正常）',
          }
        : {
            id: 'reflection',
            label: '二级反思',
            status: 'warn',
            detail: `${missingEvidenceCount} 条 refined 经验缺 evidence 证据引用（无 'because of:' 行，无法回溯到 raw/ 原始记录）。`,
            remediation: '重新提炼该条经验，或在聊天中修正证据引用。',
          },
    );
    add({
      id: 'runtime-lock',
      label: '运行器锁定',
      status: portableConfig?.runtime.locked ? 'pass' : 'fail',
      detail: portableConfig?.runtime.locked ? '是' : '否',
    });
    const personalClaude = path.join(process.env.HOME ?? '', '.claude');
    const personalCodex = path.join(process.env.HOME ?? '', '.codex');
    const isolated =
      agent.runtime_home.path !== personalClaude &&
      agent.runtime_home.path !== personalCodex &&
      inside(this.paths.runtimesDir, agent.runtime_home.path);
    add(
      isolated
        ? {
            id: 'default-home-isolation',
            label: '默认 Runtime 目录隔离',
            status: 'pass',
            detail: agent.runtime_home.path,
          }
        : {
            id: 'default-home-isolation',
            label: '默认 Runtime 目录隔离',
            status: 'fail',
            detail: agent.runtime_home.path,
            remediation: '请归档该 Agent 并用正确根目录重新创建。',
          },
    );
    add({
      id: 'runtime-home',
      label: 'Agent Runtime Home',
      status: (await fs.pathExists(agent.runtime_home.path)) ? 'pass' : 'fail',
      detail: agent.runtime_home.path,
    });
    // OP5-B：.cc-switch.env 降级预置文件权限必须为 0600（含 secret，守 D-006）。存在但权限不符告警。
    const ccSwitchEnv = path.join(agent.runtime_home.path, '.cc-switch.env');
    if (await fs.pathExists(ccSwitchEnv)) {
      const mode = (await fs.stat(ccSwitchEnv)).mode & 0o777;
      add(
        mode === 0o600
          ? {
              id: 'cc-switch-env-mode',
              label: '.cc-switch.env 权限',
              status: 'pass',
              detail: '0600',
            }
          : {
              id: 'cc-switch-env-mode',
              label: '.cc-switch.env 权限',
              status: 'fail',
              detail: mode.toString(8),
              remediation: `运行 chmod 600 ${ccSwitchEnv} 后重试。`,
            },
      );
    }
    add({
      id: 'bridge-home',
      label: 'Bridge Home',
      status:
        (await fs.pathExists(agent.bridge.home)) && inside(this.paths.bridgesDir, agent.bridge.home)
          ? 'pass'
          : 'fail',
      detail: agent.bridge.home,
    });
    add(
      agent.bridge.enabled && agent.bridge.authorization !== 'ready'
        ? {
            id: 'bridge-profile',
            label: 'Bridge Profile',
            status: 'warn',
            detail: '待授权',
            remediation: `运行 agentctl bridge authorize ${agent.id}`,
          }
        : {
            id: 'bridge-profile',
            label: 'Bridge Profile',
            status: 'pass',
            detail: agent.bridge.enabled ? '已授权' : '未启用',
          },
    );
    const ignore = path.join(agent.workspace.path, '.gitignore');
    const ignoreText = (await fs.pathExists(ignore)) ? await fs.readFile(ignore, 'utf8') : '';
    add({
      id: 'gitignore',
      label: 'Secrets .gitignore',
      status: ignoreText.includes('.env') && ignoreText.includes('*.pem') ? 'pass' : 'fail',
      detail: ignore,
    });
    const secretFiles = await this.trackedSecretFiles(agent.workspace.path);
    add(
      secretFiles.length === 0
        ? {
            id: 'secrets-check',
            label: 'Secrets 检查',
            status: 'pass',
            detail: '未发现 Git 跟踪的敏感文件或常见凭据',
          }
        : {
            id: 'secrets-check',
            label: 'Secrets 检查',
            status: 'fail',
            detail: secretFiles.join(', '),
            remediation: '从 Git 跟踪中移除这些文件并立即更换相关凭据。',
          },
    );
    if (agent.bridge.enabled) {
      const capabilities = await withDiagnosticEnvironment((env) =>
        new BridgeAdapter().inspectCapabilities(env),
      );
      add({
        id: 'bridge-capabilities',
        label: 'Bridge 参数兼容',
        status: capabilities.compatible ? 'pass' : 'fail',
        detail: capabilities.compatible
          ? `${capabilities.version}: run/profile create/profile export`
          : `${capabilities.version}: ${capabilities.missing.join(', ')}`,
        ...(!capabilities.compatible
          ? { remediation: '请升级 lark-coding-agent-bridge 后重新运行 doctor。' }
          : {}),
      });
    }
    const plist = path.join(this.paths.servicesDir, agent.id, 'bridge.plist');
    add({
      id: 'launchd-service',
      label: 'launchd 服务',
      status: (await fs.pathExists(plist)) ? 'pass' : 'warn',
      detail: (await fs.pathExists(plist)) ? plist : '未安装（在 start 时生成）',
    });
    const recentErrors = await this.recentLogErrors(path.join(this.paths.logsDir, agent.id));
    add(
      recentErrors.length === 0
        ? { id: 'recent-logs', label: '最近日志', status: 'pass', detail: '未发现明确错误' }
        : {
            id: 'recent-logs',
            label: '最近日志',
            status: 'warn',
            detail: recentErrors.slice(0, 3).join('; '),
          },
    );
  }

  private async trackedSecretFiles(workspace: string): Promise<string[]> {
    const result = await execa('git', ['ls-files'], {
      cwd: workspace,
      shell: false,
      reject: false,
    });
    if (result.exitCode !== 0) return [];
    const suspicious: string[] = [];
    for (const relative of result.stdout.split('\n').filter(Boolean)) {
      if (/(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:pem|key|p12|token))$/i.test(relative)) {
        suspicious.push(relative);
        continue;
      }
      const file = path.join(workspace, relative);
      // 跳过不存在的、符号链接（skill/运行时投影目录）与超大文件，避免读取目录抛 EISDIR。
      let st: fs.Stats;
      try {
        st = await fs.lstat(file);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > 1024 * 1024) continue;
      const content = await fs.readFile(file, 'utf8');
      if (
        /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|(?:api[_-]?key|app[_-]?secret)\s*[:=]\s*[^\s]+)/i.test(
          content,
        )
      )
        suspicious.push(relative);
    }
    return suspicious;
  }

  private async recentLogErrors(root: string): Promise<string[]> {
    if (!(await fs.pathExists(root))) return [];
    const errors: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (/\.(?:log|json)$/i.test(entry.name) && (await fs.stat(file)).size < 1024 * 1024) {
          const matches = (await fs.readFile(file, 'utf8'))
            .split('\n')
            .filter((line) => /\b(?:error|fatal)\b|失败/i.test(line));
          errors.push(...matches.slice(-3));
        }
      }
    };
    await visit(root);
    return errors;
  }

  private async backupsDirSize(): Promise<number> {
    if (!(await fs.pathExists(this.paths.backupsDir))) return 0;
    let total = 0;
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else total += (await fs.stat(file)).size;
      }
    };
    await visit(this.paths.backupsDir);
    return total;
  }

  private async countRunLogs(): Promise<number> {
    const logsDir = this.paths.logsDir;
    if (!(await fs.pathExists(logsDir))) return 0;
    let count = 0;
    for (const agentEntry of await fs.readdir(logsDir, { withFileTypes: true })) {
      if (!agentEntry.isDirectory()) continue;
      const runsDir = path.join(logsDir, agentEntry.name, 'runs');
      if (!(await fs.pathExists(runsDir))) continue;
      for (const runEntry of await fs.readdir(runsDir, { withFileTypes: true })) {
        if (runEntry.isDirectory()) count += 1;
      }
    }
    return count;
  }
}
