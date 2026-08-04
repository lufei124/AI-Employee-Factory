import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { computeConfigHash, getRegisteredAgent, loadPortableConfig } from './agents.js';
import { BridgeAdapter } from './bridge.js';
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
    if (process.platform === 'darwin')
      add({ id: 'service-platform', label: 'launchd', status: 'pass', detail: 'macOS launchd' });
    else
      add({
        id: 'service-platform',
        label: '服务平台',
        status: 'warn',
        detail: 'v1 仅正式支持 macOS',
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
    const portableConfig = await loadPortableConfig(agent).catch(() => null);
    const portableValid = portableConfig !== null;
    add({
      id: 'agent-config',
      label: 'agent.yaml',
      status: portableValid ? 'pass' : 'fail',
      detail: portableValid ? '与 Registry 一致' : '无效或不一致',
    });
    // OP3-A：config_hash 漂移检测--agent.yaml runtime 块为唯一真相，Registry 派生缓存须一致。
    if (portableConfig) {
      const actualHash = computeConfigHash(portableConfig.runtime);
      const drift = !agent.config_hash || actualHash !== agent.config_hash;
      add(
        drift
          ? {
              id: 'config-drift',
              label: '配置漂移',
              status: 'warn',
              detail: !agent.config_hash
                ? 'Registry 缺 config_hash（旧条目，待补齐）'
                : 'agent.yaml 与 Registry 缓存不一致',
              remediation: `运行 agentctl repair ${agent.id} 以 agent.yaml 重建 Registry 缓存。`,
            }
          : { id: 'config-drift', label: '配置漂移', status: 'pass', detail: '一致' },
      );
    }
    add({
      id: 'runtime-lock',
      label: '运行器锁定',
      status: agent.runtime.locked ? 'pass' : 'fail',
      detail: agent.runtime.locked ? '是' : '否',
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
      if (!(await fs.pathExists(file)) || (await fs.stat(file)).size > 1024 * 1024) continue;
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
