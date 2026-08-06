import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { execa } from 'execa';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { RegistryStore } from '../src/core/registry.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { ProcessRunner } from '../src/core/process-runner.js';
import {
  claudeShimDir,
  claudeShimDirForRuntime,
  installClaudeShim,
  renderShim,
  resolveRealClaude,
  withClaudeShim,
} from '../src/core/claude-shim.js';
import { renderLaunchdPlist } from '../src/services/launchd-service.js';
import { settleLaunchdService } from '../src/services/factory-services.js';

// D-035：飞书主入口员工自进化。覆盖 claude shim 生成/幂等、StartInterval 周期 settle 服务、
// runBridgeMessage 逐消息沉淀、settleEmployee 无 transcript 沉淀。
//
// 全局 mock resolveRealClaude：测试环境未必有真实 claude CLI，且 runBridgeMessage/shim 渲染都依赖它。

let prevGitConfigGlobal: string | undefined;
const tempDirs: string[] = [];

vi.mock('../src/core/claude-shim.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveRealClaude: vi.fn().mockResolvedValue('/fake/real/claude'),
  };
});

// 让 runBridgeMessage 直接用 env 里的真实可执行（跳过 resolveRealClaude），避免耦合 mock 结果。
const REAL_CLAUDE = process.execPath;

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-settle-'));
  tempDirs.push(root);
  const gitConfig = path.join(root, 'gitconfig');
  await fs.writeFile(
    gitConfig,
    '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n',
  );
  prevGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  const paths = resolveFactoryPaths({
    HOME: root,
    AI_EMPLOYEES_HOME: path.join(root, 'private'),
    AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
  });
  const app = new FactoryApplication(paths, new RegistryStore(paths.registryFile));
  await app.initialize();
  await app.createAgent({
    id: 'worker-a',
    name: '员工 A',
    runtime: 'claude',
    description: '负责用户反馈收集、分析与闭环跟进',
    goals: ['收集并分析用户反馈'],
    feishu: 'disabled',
  });
  // 预置 0600 降级凭据（OP5-B）：prepareRuntime 在无 CC Switch 源时读它，避免真实 CLI 依赖。
  const runtimeHome = path.join(paths.runtimesDir, 'worker-a', 'claude');
  await fs.outputFile(
    path.join(runtimeHome, '.cc-switch.env'),
    'ANTHROPIC_AUTH_TOKEN=test-token\n',
    {
      mode: 0o600,
    },
  );
  return { root, paths, app };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
  if (prevGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = prevGitConfigGlobal;
  delete process.env.AIEMPLOYEES_REAL_CLAUDE;
});

describe('claude shim（D-035）', () => {
  it('renderShim 烘焙 home/workspace/真实 claude：仅 -p 转发，其余透传真实 claude', async () => {
    const { paths } = await setup();
    const script = await renderShim(paths, 'worker-a', '/usr/local/bin/agentctl');
    expect(script).toContain(`export AI_EMPLOYEES_HOME="${paths.home}"`);
    expect(script).toContain(`export AI_EMPLOYEES_WORKSPACE_ROOT="${paths.workspaceRoot}"`);
    // 真实 claude 路径被烘焙（非空），且不解析到 shim 自身。
    const claudeLine = script.match(/export AIEMPLOYEES_REAL_CLAUDE="([^"]+)"/);
    expect(claudeLine?.[1]?.length ?? 0).toBeGreaterThan(0);
    expect(claudeLine?.[1]).not.toContain('claude-shim');
    // 仅含 -p 时转发到 _service bridge-run（不带 --，CLI 用 <args...> 透传）。
    expect(script).toContain(`exec "/usr/local/bin/agentctl" _service bridge-run "worker-a" "$@"`);
    // 否则直接 exec 真实 claude（预检 --version 不能被拦）。
    expect(script).toContain(`exec "${claudeLine?.[1]}" "$@"`);
    // 转发被 `if [ -n "$found_p" ]` 守卫。
    expect(script).toContain('if [ -n "$found_p" ]');
    expect(script).toContain('-p|--print) found_p=1');
  });

  it('installClaudeShim 幂等：dir 在 runtimes/<id>/claude-shim，重复安装不重写', async () => {
    const { paths } = await setup();
    const resolved = resolveRealClaude as unknown as ReturnType<typeof vi.fn>;
    resolved.mockResolvedValueOnce('/real/one');
    await installClaudeShim(paths, 'worker-a', '/usr/local/bin/agentctl');
    const shimFile = path.join(claudeShimDir(paths, 'worker-a'), 'claude');
    const first = await fs.readFile(shimFile, 'utf8');
    expect(first).toContain('_service bridge-run "worker-a"');
    const mode = (await fs.stat(shimFile)).mode;

    // 幂等：内容不变则跳过重写（resolveRealClaude 不会再次被调用）。
    resolved.mockClear();
    await installClaudeShim(paths, 'worker-a', '/usr/local/bin/agentctl');
    expect(resolved).not.toHaveBeenCalled();
    expect(await fs.readFile(shimFile, 'utf8')).toBe(first);
    expect((await fs.stat(shimFile)).mode).toBe(mode);
  });

  it('withClaudeShim 把 shim 目录前置到 PATH', () => {
    const runtimeHome = '/tmp/agents/worker-a/claude';
    const env = withClaudeShim({ PATH: '/usr/bin:/bin', OTHER: '1' }, runtimeHome);
    expect(env.PATH).toBe(`${claudeShimDirForRuntime(runtimeHome)}:/usr/bin:/bin`);
    expect(env.OTHER).toBe('1');
  });

  it('resolveRealClaude 剔除 PATH 里的 claude-shim（防递归）', async () => {
    const { paths, root } = await setup();
    // 造一个假 shim 目录前置到 PATH：若 resolveRealClaude 不剔除，会解析到它自身。
    const fakeShimDir = path.join(root, 'runtimes', 'worker-a', 'claude-shim');
    await fs.outputFile(path.join(fakeShimDir, 'claude'), '#!/bin/sh\necho FAKE-SHIM\n');
    await fs.chmod(path.join(fakeShimDir, 'claude'), 0o700);
    const source = { ...process.env, PATH: `${fakeShimDir}:${process.env.PATH ?? ''}` };
    // renderShim 内部调用真实 resolveRealClaude(source)，烘焙路径应指向真实 claude 而非假 shim。
    const script = await renderShim(paths, 'worker-a', process.execPath, source);
    const realLine = script.match(/export AIEMPLOYEES_REAL_CLAUDE="([^"]+)"/)?.[1];
    expect(realLine).not.toBe(path.join(fakeShimDir, 'claude'));
    expect(realLine).not.toContain('claude-shim');
    expect(realLine?.length ?? 0).toBeGreaterThan(0);
  });

  it('功能：--version 透传真实 claude（预检不挂起），-p 才转发 bridge-run', async () => {
    const { paths } = await setup();
    // renderShim 内部调用真实 resolveRealClaude（模块 mock 不影响其内部绑定），烘焙出真实 claude 路径。
    const script = await renderShim(paths, 'worker-a', process.execPath);
    const realLine = script.match(/export AIEMPLOYEES_REAL_CLAUDE="([^"]+)"/)?.[1];
    expect(realLine?.length ?? 0).toBeGreaterThan(0);
    // 透传分支已烘焙真实 claude：模拟 `shim --version` → exec 真实 claude --version，需快速返回。
    const { stdout, exitCode } = await execa('sh', ['-c', `exec "${realLine}" --version`], {
      reject: false,
      timeout: 15000,
    });
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });
});

describe('settle 周期服务 StartInterval（D-035）', () => {
  it('renderLaunchdPlist 渲染 StartInterval（与 calendar 并存时优先）', () => {
    const plist = renderLaunchdPlist({
      label: 'com.aiemployees.worker-a.settle',
      program: '/usr/local/bin/agentctl',
      args: ['_service', 'settle', 'worker-a'],
      env: { AI_EMPLOYEES_HOME: '/tmp/home' },
      stdoutPath: '/tmp/logs/settle.stdout.log',
      stderrPath: '/tmp/logs/settle.stderr.log',
      startInterval: 300,
      calendar: { hour: 9, minute: 0 },
    });
    expect(plist).toContain('<key>StartInterval</key><integer>300</integer>');
    expect(plist).not.toContain('StartCalendarInterval');
    expect(plist).toContain(
      '<string>_service</string><string>settle</string><string>worker-a</string>',
    );
  });

  it('settleLaunchdService 生成秒级重复 settle 服务', async () => {
    const { paths, app } = await setup();
    const { registry, agent } = await app.getAgent('worker-a');
    const service = settleLaunchdService(
      registry,
      agent.runtime,
      paths,
      300,
      '/usr/local/bin/agentctl',
    );
    expect(service.installedFile).toContain('com.aiemployees.worker-a.settle.plist');
    // 不真正 install（会碰 launchctl）；直接校验烘焙进适配器的参数。
    const adapter = service as unknown as { input: { args: string[]; startInterval?: number } };
    expect(adapter.input.args).toEqual(['_service', 'settle', 'worker-a']);
    expect(adapter.input.startInterval).toBe(300);
  });
});

describe('runBridgeMessage 逐消息沉淀（D-035）', () => {
  it('用真实 claude 跑 runLogged（含 stdin）+ 触发 settle 链，返回 exitCode', async () => {
    const { app } = await setup();
    process.env.AIEMPLOYEES_REAL_CLAUDE = REAL_CLAUDE;

    // 预置一个员工写盘的 skill：settle 链的 autoAdoptSelfSkills 应将其 adopt 注册。
    const { registry } = await app.getAgent('worker-a');
    const skillRoot = path.join(registry.workspace.path, 'skills', 'feedback-loop');
    await fs.ensureDir(skillRoot);
    await fs.writeFile(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: feedback-loop\ndescription: 收集用户反馈并闭环跟进\nversion: 0.1.0\n---\n# feedback-loop\n\n收集用户反馈并闭环跟进。\n',
    );

    // mock runLogged：写一个真实 transcript 文件并返回 exitCode=7，验证 settle 链确实拿到它。
    const runLoggedSpy = vi
      .spyOn(ProcessRunner.prototype, 'runLogged')
      .mockImplementation(async function (this: ProcessRunner, id) {
        await fs.ensureDir(this.logsRoot);
        const transcriptFile = path.join(this.logsRoot, id, 'transcript.jsonl');
        await fs.outputFile(
          transcriptFile,
          JSON.stringify({ role: 'user', content: '帮我做反馈分析' }) + '\n',
        );
        return {
          exitCode: 7,
          stdoutFile: path.join(this.logsRoot, id, 'stdout.log'),
          stderrFile: path.join(this.logsRoot, id, 'stderr.log'),
          metadataFile: path.join(this.logsRoot, id, 'metadata.json'),
          transcriptFile,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
      });

    const exitCode = await app.runBridgeMessage('worker-a', ['-p', '--', 'do work'], 'do x');

    expect(exitCode).toBe(7);
    expect(runLoggedSpy).toHaveBeenCalledTimes(1);
    const [id, ctx, options] = runLoggedSpy.mock.calls[0] as unknown as [
      string,
      { command: string; args: string[]; cwd: string },
      { stdin: string },
    ];
    expect(id).toBe('worker-a');
    expect(ctx.command).toBe(REAL_CLAUDE);
    expect(ctx.args).toEqual(['-p', '--', 'do work']);
    expect(ctx.cwd).toBe(registry.workspace.path);
    expect(options.stdin).toBe('do x');

    // settle 链已跑：autoAdoptSelfSkills 把员工写盘的 skill adopt 注册到 claude 运行时。
    const list = await app.listSkills('worker-a');
    expect(list.some((skill) => skill.name === 'feedback-loop')).toBe(true);
  });
});

describe('settleEmployee 无 transcript 沉淀（D-035）', () => {
  it('adopt 员工写盘的 skill 并提交自进化（不依赖 transcript）', async () => {
    const { app } = await setup();
    // 直接改 agent.yaml（模拟员工自维护文档），verify commitSelfEvolution 提交。
    const { registry } = await app.getAgent('worker-a');
    const agentYaml = path.join(registry.workspace.path, 'agent.yaml');
    await fs.appendFile(agentYaml, '\n# 员工自维护：补充一条备注\n');
    const skillRoot = path.join(registry.workspace.path, 'skills', 'triage');
    await fs.ensureDir(skillRoot);
    await fs.writeFile(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: triage\ndescription: 分类处理\nversion: 0.1.0\n---\n# triage\n\n分类处理。\n',
    );

    await app.settleEmployee('worker-a');

    const list = await app.listSkills('worker-a');
    expect(list.some((skill) => skill.name === 'triage')).toBe(true);
    // commitSelfEvolution 已跑：workspace git 有 evolve: 提交。
    const { exitCode, stdout } = await execa(
      'git',
      ['-C', registry.workspace.path, 'log', '--oneline'],
      { reject: false },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/evolve/);
  });
});
