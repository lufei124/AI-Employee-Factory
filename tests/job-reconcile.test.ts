import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reconcileEmployeeJobs } from '../src/core/job-reconcile.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import type { AgentConfig } from '../src/schemas/agent-schema.js';
import type { RegistryAgent } from '../src/schemas/registry-schema.js';

// 隔离 launchd / git 副作用：jobLaunchdService 换成 spy adapter，execa 假成功，git 单文件提交 spy 化。
const enableScheduled = vi.hoisted(() => vi.fn(async () => undefined));
const gitStatusShort = vi.hoisted(() => vi.fn(async () => [{ path: 'automation/jobs/x.yaml' }]));
const gitCommitFile = vi.hoisted(() => vi.fn(async () => true));

vi.mock('../src/services/factory-services.js', () => ({
  jobLaunchdService: () => ({ enableScheduled }),
}));
vi.mock('execa', () => ({
  execa: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
}));
vi.mock('../src/core/git.js', () => ({
  gitStatusShort,
  gitCommitFile,
}));

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

function makeRegistry(id: string, workspace: string): RegistryAgent {
  return { id, workspace: { path: workspace } } as unknown as RegistryAgent;
}
function makeAgent(runtime: string): AgentConfig {
  return { runtime: { provider: runtime } } as unknown as AgentConfig;
}

// 写一个最小 employee job 到 workspace。
async function writeEmployeeJob(workspace: string, id: string, time: string, enabled = true) {
  await fs.outputFile(
    path.join(workspace, 'automation/jobs', `${id}.yaml`),
    `schema_version: 1\nid: ${id}\nenabled: ${enabled}\nmanaged_by: employee\nschedule:\n  type: daily\n  time: "${time}"\nexecution:\n  type: agent\n  prompt_file: automation/prompts/${id}.md\n  timeout_seconds: 300\n  concurrency: forbid\n`,
  );
}

// 模拟「此前已安装」的 launchd plist（reconcile 的 uninstall 走 fs.remove，不依赖 service adapter）。
function seedPlist(paths: ReturnType<typeof resolveFactoryPaths>, agentId: string, jobId: string) {
  return fs.outputFile(path.join(paths.schedulesDir, agentId, `${jobId}.plist`), 'plist');
}

async function setup() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-recon-'));
  roots.push(home);
  const workspace = path.join(home, 'agents', 'u1');
  await fs.ensureDir(path.join(workspace, 'automation', 'jobs'));
  const paths = resolveFactoryPaths({
    HOME: home,
    AI_EMPLOYEES_HOME: path.join(home, 'private'),
    AI_EMPLOYEES_WORKSPACE_ROOT: path.join(home, 'agents'),
  });
  return {
    home,
    workspace,
    paths,
    registry: makeRegistry('u1', workspace),
    agent: makeAgent('claude'),
  };
}

describe('reconcileEmployeeJobs (D-028)', () => {
  it('installs an enabled employee job and records it in the manifest', async () => {
    const { workspace, paths, registry, agent } = await setup();
    await writeEmployeeJob(workspace, 'daily', '09:00');

    await reconcileEmployeeJobs(registry, agent, paths);

    expect(enableScheduled).toHaveBeenCalledTimes(1);
    const manifest = JSON.parse(
      await fs.readFile(path.join(paths.schedulesDir, 'u1', '.employee-jobs.json'), 'utf8'),
    );
    expect(manifest).toEqual({ daily: '09:00' });
    // git 单文件提交命中 employee job yaml。
    expect(gitCommitFile).toHaveBeenCalledWith(
      workspace,
      'automation/jobs/daily.yaml',
      'job: 更新 daily',
      expect.anything(),
    );
  });

  it('reinstalls when schedule.time changes and unregisters removed/disabled jobs', async () => {
    const { workspace, paths, registry, agent } = await setup();
    await writeEmployeeJob(workspace, 'daily', '09:00');
    await writeEmployeeJob(workspace, 'weekly', '18:00');
    await seedPlist(paths, 'u1', 'daily');
    await seedPlist(paths, 'u1', 'weekly');
    await reconcileEmployeeJobs(registry, agent, paths);
    expect(enableScheduled).toHaveBeenCalledTimes(2);

    // 改 time → 重装；weekly 停用 → 反注册；再新增一个。
    await writeEmployeeJob(workspace, 'daily', '10:30');
    await writeEmployeeJob(workspace, 'weekly', '18:00', false);
    await writeEmployeeJob(workspace, 'monthly', '08:00');
    await reconcileEmployeeJobs(registry, agent, paths);

    // daily 因 time 变更被反注册（plist 移除）后重装，monthly 新装，weekly 停用被反注册。
    expect(enableScheduled).toHaveBeenCalledTimes(4);
    expect(await fs.pathExists(path.join(paths.schedulesDir, 'u1', 'daily.plist'))).toBe(false);
    expect(await fs.pathExists(path.join(paths.schedulesDir, 'u1', 'weekly.plist'))).toBe(false);
    const manifest = JSON.parse(
      await fs.readFile(path.join(paths.schedulesDir, 'u1', '.employee-jobs.json'), 'utf8'),
    );
    expect(manifest).toEqual({ daily: '10:30', monthly: '08:00' });
  });

  it('unregisters a previously installed employee job when the file is deleted', async () => {
    const { workspace, paths, registry, agent } = await setup();
    await writeEmployeeJob(workspace, 'daily', '09:00');
    await seedPlist(paths, 'u1', 'daily');
    await reconcileEmployeeJobs(registry, agent, paths);
    expect(enableScheduled).toHaveBeenCalledTimes(1);

    await fs.remove(path.join(workspace, 'automation/jobs', 'daily.yaml'));
    await reconcileEmployeeJobs(registry, agent, paths);

    // 不再新装，plist 被反注册移除。
    expect(enableScheduled).toHaveBeenCalledTimes(1);
    expect(await fs.pathExists(path.join(paths.schedulesDir, 'u1', 'daily.plist'))).toBe(false);
    const manifest = JSON.parse(
      await fs.readFile(path.join(paths.schedulesDir, 'u1', '.employee-jobs.json'), 'utf8'),
    );
    expect(manifest).toEqual({});
  });

  it('never touches admin-managed jobs', async () => {
    const { workspace, paths, registry, agent } = await setup();
    await fs.outputFile(
      path.join(workspace, 'automation/jobs', 'adminjob.yaml'),
      `schema_version: 1\nid: adminjob\nenabled: true\nschedule:\n  type: daily\n  time: "07:00"\nexecution:\n  type: script\n  script_file: scripts/adm.sh\n  interpreter: bash\n  args: []\n  timeout_seconds: 60\n  concurrency: forbid\n`,
    );

    await reconcileEmployeeJobs(registry, agent, paths);

    expect(enableScheduled).not.toHaveBeenCalled();
    expect(gitCommitFile).not.toHaveBeenCalled();
  });

  it('skips a single malformed employee job without blocking the rest', async () => {
    const { workspace, paths, registry, agent } = await setup();
    await writeEmployeeJob(workspace, 'good', '09:00');
    // 恶意 job：引用工作区外脚本，listTolerant 应跳过而不断言。
    await fs.outputFile(
      path.join(workspace, 'automation/jobs', 'escape.yaml'),
      `schema_version: 1\nid: escape\nenabled: true\nmanaged_by: employee\nschedule: { type: daily, time: "09:00" }\nexecution: { type: script, script_file: ../../escape.sh, interpreter: bash, args: [], timeout_seconds: 30, concurrency: forbid }\n`,
    );

    await expect(reconcileEmployeeJobs(registry, agent, paths)).resolves.toBeUndefined();
    expect(enableScheduled).toHaveBeenCalledTimes(1); // 只调度合法 job
    const manifest = JSON.parse(
      await fs.readFile(path.join(paths.schedulesDir, 'u1', '.employee-jobs.json'), 'utf8'),
    );
    expect(manifest).toEqual({ good: '09:00' });
  });

  it('commits a .yml employee job at its real path (D-028 review fix)', async () => {
    const { workspace, paths, registry, agent } = await setup();
    await fs.outputFile(
      path.join(workspace, 'automation/jobs', 'daily.yml'),
      `schema_version: 1\nid: daily\nenabled: true\nmanaged_by: employee\nschedule:\n  type: daily\n  time: "09:00"\nexecution:\n  type: agent\n  prompt_file: automation/prompts/daily.md\n  timeout_seconds: 300\n  concurrency: forbid\n`,
    );

    await reconcileEmployeeJobs(registry, agent, paths);

    expect(enableScheduled).toHaveBeenCalledTimes(1);
    expect(gitCommitFile).toHaveBeenCalledWith(
      workspace,
      'automation/jobs/daily.yml',
      'job: 更新 daily',
      expect.anything(),
    );
  });
});
