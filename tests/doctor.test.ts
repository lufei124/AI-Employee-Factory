import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateAgentService } from '../src/core/create-agent.js';
import { initializeFactory } from '../src/core/config.js';
import { DoctorService } from '../src/core/doctor.js';
import { ensureIdentityBaseline } from '../src/core/identity-baseline.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';
import { TrashService } from '../src/core/trash.js';
import { FactoryApplication } from '../src/application/factory-application.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

describe('DoctorService', () => {
  it('reports strict isolation passes and pending Bridge authorization as a warning', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-doctor-'));
    roots.push(root);
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    await initializeFactory(paths);
    const registry = new RegistryStore(paths.registryFile);
    await new CreateAgentService(paths, registry).create({
      id: 'user-operations',
      name: '用户运营专员',
      runtime: 'claude',
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
      feishu: 'dedicated',
    });

    const originalHome = process.env.HOME;
    const originalCodexHome = process.env.CODEX_HOME;
    const originalClaudeHome = process.env.CLAUDE_CONFIG_DIR;
    const originalBridgeHome = process.env.LARK_CHANNEL_HOME;
    process.env.HOME = root;
    delete process.env.CODEX_HOME;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.LARK_CHANNEL_HOME;
    let report;
    try {
      report = await new DoctorService(paths, registry).run('user-operations');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      if (originalClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalClaudeHome;
      if (originalBridgeHome === undefined) delete process.env.LARK_CHANNEL_HOME;
      else process.env.LARK_CHANNEL_HOME = originalBridgeHome;
    }

    expect(report.checks.find((check) => check.id === 'runtime-lock')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'default-home-isolation')?.status).toBe(
      'pass',
    );
    expect(report.checks.find((check) => check.id === 'workspace-git')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'bridge-profile')?.status).toBe('warn');
    expect(report.checks.find((check) => check.id === 'registry-permissions')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'config-permissions')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'secrets-check')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'recent-logs')?.status).toBe('pass');
    expect(report.summary.fail).toBe(0);
    expect(await fs.pathExists(path.join(root, '.claude'))).toBe(false);
    expect(await fs.pathExists(path.join(root, '.codex'))).toBe(false);
    expect(await fs.pathExists(path.join(root, '.lark-channel'))).toBe(false);
  });

  it('reports a failed/moving trash entry as fail with purge --force remediation (R20)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-doctor-trash-'));
    roots.push(root);
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    await initializeFactory(paths);
    const registry = new RegistryStore(paths.registryFile);
    await new CreateAgentService(paths, registry).create({
      id: 'user-operations',
      name: '用户运营专员',
      runtime: 'claude',
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
      feishu: 'dedicated',
    });
    const agent = (await registry.read()).agents[0];
    const entry = await new TrashService(paths, registry).move(agent);
    const manifestFile = path.join(paths.trashDir, 'manifests', `${entry.trashId}.yaml`);
    const doc = YAML.parse(await fs.readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    doc.state = 'failed';
    await fs.writeFile(manifestFile, YAML.stringify(doc));

    const report = await new DoctorService(paths, registry).run();
    const check = report.checks.find((item) => item.id === 'trash-health');
    expect(check?.status).toBe('fail');
    expect(check?.remediation).toContain('agentctl trash purge --force');
  });

  it('warns disk-usage when backups exceed the threshold (OP4-D)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-doctor-disk-'));
    roots.push(root);
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    await initializeFactory(paths);
    await fs.ensureDir(paths.backupsDir);
    const big = path.join(paths.backupsDir, 'big.tar.gz');
    await fs.writeFile(big, '');
    await fs.truncate(big, 600 * 1024 * 1024); // 稀疏 600MiB，stat 报告逻辑大小
    const registry = new RegistryStore(paths.registryFile);

    const report = await new DoctorService(paths, registry).run();
    const check = report.checks.find((item) => item.id === 'disk-usage');
    expect(check?.status).toBe('warn');
    expect(check?.remediation).toContain('agentctl prune --dry-run');
  });

  it('fails on config_hash drift and passes after repair (OP3-A HARD)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-doctor-drift-'));
    roots.push(root);
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    await initializeFactory(paths);
    const registry = new RegistryStore(paths.registryFile);
    await new CreateAgentService(paths, registry).create({
      id: 'user-operations',
      name: '用户运营专员',
      runtime: 'claude',
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
      feishu: 'dedicated',
    });
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    // 模拟漂移：手工改 agent.yaml 的 model，Registry 缓存（含 config_hash）未同步。
    const agentYaml = path.join(agent.workspace.path, 'agent.yaml');
    const doc = YAML.parse(await fs.readFile(agentYaml, 'utf8')) as { runtime: { model?: string } };
    doc.runtime.model = 'opus';
    await fs.writeFile(agentYaml, YAML.stringify(doc));

    const originalHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const report = await new DoctorService(paths, registry).run('user-operations');
      const drift = report.checks.find((c) => c.id === 'config-drift');
      expect(drift?.status).toBe('fail');
      expect(drift?.remediation).toContain('agentctl repair');
      // repair 后漂移消除
      await new FactoryApplication(paths, registry).repairAgent('user-operations');
      const report2 = await new DoctorService(paths, registry).run('user-operations');
      expect(report2.checks.find((c) => c.id === 'config-drift')?.status).toBe('pass');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it('warns on a bound CC Switch Provider and passes when unbound (OP5-D)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-doctor-credential-provider-'));
    roots.push(root);
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    await initializeFactory(paths);
    const registry = new RegistryStore(paths.registryFile);
    await new CreateAgentService(paths, registry).create({
      id: 'user-operations',
      name: '用户运营专员',
      runtime: 'claude',
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
      feishu: 'dedicated',
    });
    await registry.updateAgent('user-operations', (current) => ({
      ...current,
      credential_provider: 'Kimi',
    }));

    const originalHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const report = await new DoctorService(paths, registry).run('user-operations');
      const check = report.checks.find((item) => item.id === 'credential-provider');
      expect(check?.status).toBe('warn');
      expect(check?.detail).toContain('Kimi');
      expect(check?.remediation).toContain('--provider live');

      // 清除绑定后 pass（跟随当前 live Provider）
      await registry.updateAgent('user-operations', (current) => ({
        ...current,
        credential_provider: undefined,
      }));
      const report2 = await new DoctorService(paths, registry).run('user-operations');
      expect(report2.checks.find((item) => item.id === 'credential-provider')?.status).toBe('pass');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it('reports memory-enforcement states (OP1 Stage A)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-doctor-mem-'));
    roots.push(root);
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    await initializeFactory(paths);
    const registry = new RegistryStore(paths.registryFile);
    await new CreateAgentService(paths, registry).create({
      id: 'user-operations',
      name: '用户运营专员',
      runtime: 'claude',
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
      feishu: 'dedicated',
    });
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    const agentYaml = path.join(agent.workspace.path, 'agent.yaml');
    const originalHome = process.env.HOME;
    process.env.HOME = root;
    try {
      // 新建 agent：enforced:true + 合法 6 层 -> pass。
      let report = await new DoctorService(paths, registry).run('user-operations');
      expect(report.checks.find((c) => c.id === 'memory-enforcement')?.status).toBe('pass');

      // 旧 agent.yaml（移除 enforced）-> warn（未声明）。
      const docOld = YAML.parse(await fs.readFile(agentYaml, 'utf8')) as {
        memory: { enforced?: boolean; authority_order: string[] };
      };
      delete docOld.memory.enforced;
      await fs.writeFile(agentYaml, YAML.stringify(docOld));
      report = await new DoctorService(paths, registry).run('user-operations');
      const warnCheck = report.checks.find((c) => c.id === 'memory-enforcement');
      expect(warnCheck?.status).toBe('warn');
      expect(warnCheck?.detail).toContain('未声明');

      // enforced:true + 非法序（缺 agent）-> fail。
      const docBad = YAML.parse(await fs.readFile(agentYaml, 'utf8')) as {
        memory: { enforced?: boolean; authority_order: string[] };
      };
      docBad.memory.enforced = true;
      docBad.memory.authority_order = ['knowledge'];
      await fs.writeFile(agentYaml, YAML.stringify(docBad));
      report = await new DoctorService(paths, registry).run('user-operations');
      const failCheck = report.checks.find((c) => c.id === 'memory-enforcement');
      expect(failCheck?.status).toBe('fail');
      expect(failCheck?.detail).toContain('authority_order');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it('reports .cc-switch.env permission violations (OP5-B)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-doctor-env-'));
    roots.push(root);
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    await initializeFactory(paths);
    const registry = new RegistryStore(paths.registryFile);
    await new CreateAgentService(paths, registry).create({
      id: 'user-operations',
      name: '用户运营专员',
      runtime: 'claude',
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
      feishu: 'dedicated',
    });
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');

    // 无 .cc-switch.env：无该检查项（仅显式预置时检查）。
    let report = await new DoctorService(paths, registry).run('user-operations');
    expect(report.checks.find((c) => c.id === 'cc-switch-env-mode')).toBeUndefined();

    // 0644 -> fail，remediation 指向 chmod 600。
    await fs.outputFile(
      path.join(agent.runtime_home.path, '.cc-switch.env'),
      'ANTHROPIC_AUTH_TOKEN=secret',
      { mode: 0o644 },
    );
    report = await new DoctorService(paths, registry).run('user-operations');
    let check = report.checks.find((c) => c.id === 'cc-switch-env-mode');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toBe('644');
    expect(check?.remediation).toContain('chmod 600');

    // chmod 600 -> pass。
    await fs.chmod(path.join(agent.runtime_home.path, '.cc-switch.env'), 0o600);
    report = await new DoctorService(paths, registry).run('user-operations');
    check = report.checks.find((c) => c.id === 'cc-switch-env-mode');
    expect(check?.status).toBe('pass');
    expect(check?.detail).toBe('0600');
  });

  it('reports the six D-041 P3-2 self-evolution checks (baseline/guard/ledger/flags/retention/reflection)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-doctor-evolution-'));
    roots.push(root);
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    await initializeFactory(paths);
    const registry = new RegistryStore(paths.registryFile);
    await new CreateAgentService(paths, registry).create({
      id: 'user-operations',
      name: '用户运营专员',
      runtime: 'claude',
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
      feishu: 'dedicated',
    });
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    const workspace = agent.workspace.path;
    const roleFile = path.join(workspace, 'agent', 'ROLE.md');
    const baselineFile = path.join(workspace, 'agent', 'IDENTITY_BASELINE.md');
    const originalRole = await fs.readFile(roleFile, 'utf8');
    const originalHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const runDoctor = async () => {
        const report = await new DoctorService(paths, registry).run('user-operations');
        return (id: string) => report.checks.find((c) => c.id === id)?.status;
      };
      // 复位：ROLE 恢复原文 + 重快照基线（供后续单项篡改后的对账基准）。
      const rebaseline = async (description: string) => {
        await fs.writeFile(roleFile, originalRole);
        await fs.remove(baselineFile);
        await ensureIdentityBaseline({ workspace, description });
      };

      // 新建员工：基线已播种、锚点完整、无未授权改动、三开关已启用、无陈旧经验、无缺证据 refined → 全 pass。
      let status = await runDoctor();
      expect(status('identity-baseline')).toBe('pass');
      expect(status('identity-guard')).toBe('pass');
      expect(status('proposal-ledger')).toBe('pass');
      expect(status('memory-flags')).toBe('pass');
      expect(status('knowledge-retention')).toBe('pass');
      expect(status('reflection')).toBe('pass');

      // identity-baseline：删基线 → warn（无从对账）。
      await fs.remove(baselineFile);
      status = await runDoctor();
      expect(status('identity-baseline')).toBe('warn');

      // identity-guard：删 ROLE 岗位定位标题 → fail（硬门）。
      await rebaseline('负责用户反馈收集、分析与闭环跟进');
      await fs.writeFile(roleFile, originalRole.replace(/^# 岗位定位\n/, ''));
      status = await runDoctor();
      expect(status('identity-guard')).toBe('fail');

      // proposal-ledger：整段改写 ROLE（保留标题锚点，改动 >30%）且账本无 user_anchor → fail。
      await rebaseline('负责用户反馈收集、分析与闭环跟进');
      await fs.writeFile(
        roleFile,
        `# 岗位定位\n\n这是被篡改的岗位描述，与原始描述完全不同，内容非常长以便超过 30% 的改动比例，从而触发提案对账。\n\n## 长期职责\n\n- 完全不同的职责 A\n- 完全不同的职责 B\n- 完全不同的职责 C\n- 完全不同的职责 D\n\n## 协作协议\n\n- 完全不同的协作约定。\n`,
      );
      status = await runDoctor();
      expect(status('identity-guard')).toBe('pass'); // 标题锚点仍在
      expect(status('proposal-ledger')).toBe('fail');

      // D-043（identity_edits 生效）：direct=聊天直改模式 → proposal-ledger pass（对账跳过，
      // detail 标注 direct；identity-guard 锚点硬门在任何模式下单独生效）。
      await rebaseline('负责用户反馈收集、分析与闭环跟进');
      const agentYaml = path.join(workspace, 'agent.yaml');
      const docDirect = YAML.parse(await fs.readFile(agentYaml, 'utf8')) as {
        memory: { identity_edits?: 'proposal_required' | 'direct' };
      };
      docDirect.memory.identity_edits = 'direct';
      await fs.writeFile(agentYaml, YAML.stringify(docDirect));
      const reportDirect = await new DoctorService(paths, registry).run('user-operations');
      const ledgerCheck = reportDirect.checks.find((c) => c.id === 'proposal-ledger');
      expect(ledgerCheck?.status).toBe('pass');
      expect(ledgerCheck?.detail).toContain('direct 模式');
      // direct 只豁免提案门，不豁免锚点硬门。
      expect(status('identity-guard')).toBe('pass'); // ROLE 已复位，锚点完整
      // 复位 identity_edits。
      delete docDirect.memory.identity_edits;
      await fs.writeFile(agentYaml, YAML.stringify(docDirect));

      // memory-flags：移除 agent.yaml 三开关（undefined）→ warn。
      await rebaseline('负责用户反馈收集、分析与闭环跟进');
      const doc = YAML.parse(await fs.readFile(agentYaml, 'utf8')) as {
        memory: {
          transcript_persist?: boolean;
          experience_extraction?: boolean;
          skill_self_creation?: boolean;
        };
      };
      delete doc.memory.transcript_persist;
      delete doc.memory.experience_extraction;
      delete doc.memory.skill_self_creation;
      await fs.writeFile(agentYaml, YAML.stringify(doc));
      status = await runDoctor();
      expect(status('memory-flags')).toBe('warn');

      // knowledge-retention：lessons/raw 出现超 90 天的陈旧条目 → warn。
      await fs.outputFile(
        path.join(workspace, 'knowledge', 'lessons', 'raw', '2024-01-15-stale.md'),
        '# 陈旧经验\n',
      );
      status = await runDoctor();
      expect(status('knowledge-retention')).toBe('warn');

      // reflection：lessons/refined 有条目不附 because of: 证据 → warn。
      await fs.outputFile(
        path.join(workspace, 'knowledge', 'lessons', 'refined', '2026-08-01-insight.md'),
        '---\ntitle: 某洞察\n---\n\n# 某洞察\n\n无证据引用。\n',
      );
      status = await runDoctor();
      expect(status('reflection')).toBe('warn');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});
