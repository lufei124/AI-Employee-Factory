import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { CreateAgentService } from '../src/core/create-agent.js';
import { initializeFactory } from '../src/core/config.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';
import type { ReflectionSignal } from '../src/core/reflection.js';
import {
  readLastRefinedAt,
  refineExperience,
  refinedExperienceRelPath,
  renderRefineBrief,
  renderRefinedExperience,
  type RefinedExperience,
} from '../src/core/experience-refiner.js';
import type * as RefinerModule from '../src/core/experience-refiner.js';

// D-041 P1-2 二级：经验提炼器。refineExperience 依赖本地 claude CLI，测试统一 mock
// （FactoryApplication 内部引用也被替换），验证 brief/渲染/路径/证据引用与整条提炼链（不碰真实 CLI）。
vi.mock('../src/core/experience-refiner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RefinerModule>();
  return { ...actual, refineExperience: vi.fn() };
});

const roots: string[] = [];
let prevGitConfigGlobal: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
  if (prevGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = prevGitConfigGlobal;
});

function signal(overrides: Partial<ReflectionSignal> = {}): ReflectionSignal {
  return {
    date: '2026-08-06T00:00:00Z',
    importance: 3,
    topics: ['接入飞书'],
    transcriptFile: 'logs/worker/runs/1/transcript.jsonl',
    ...overrides,
  };
}

describe('renderRefineBrief（D-041 P1-2）', () => {
  it('只含脱敏后的主题/决策/经验/尾行，不含原始全文', () => {
    const brief = renderRefineBrief([
      signal({
        topics: ['接入飞书'],
        decisions: ['结论：采用 PersonalAgent'],
        lessons: ['经验：先检查凭证有效期'],
      }),
    ]);
    expect(brief).toContain('[2026-08-06T00:00:00Z] 主题=接入飞书');
    expect(brief).toContain('决策=结论：采用 PersonalAgent');
    expect(brief).toContain('经验=经验：先检查凭证有效期');
    expect(brief).toContain('transcript=logs/worker/runs/1/transcript.jsonl');
  });

  it('缺失字段以 - 占位', () => {
    const brief = renderRefineBrief([signal({ topics: [], decisions: [], lessons: [] })]);
    expect(brief).toContain('主题=-');
    expect(brief).toContain('决策=-');
    expect(brief).toContain('经验=-');
  });
});

describe('refinedExperienceRelPath / renderRefinedExperience（D-041 P1-2）', () => {
  it('路径为 lessons/refined/<date>-<slug>.md', () => {
    expect(refinedExperienceRelPath({ agentId: 'user-operations', date: '2026-08-06' })).toBe(
      'lessons/refined/2026-08-06-user-operations.md',
    );
  });

  it('渲染含 frontmatter + insight + because of 证据引用 + 正文', () => {
    const refined: RefinedExperience = {
      insight: '接入飞书前先检查凭证有效期，可避免大半环境类失败',
      evidence: ['lessons/raw/2026-08-06-user-operations.md:5'],
      writeup: '## 适用场景\n\n接入飞书。\n\n## 关键做法\n\n先检查凭证。',
    };
    const content = renderRefinedExperience(refined, {
      agentId: 'user-operations',
      date: '2026-08-06',
    });
    expect(content).toContain('title: 提炼经验');
    expect(content).toContain('# 接入飞书前先检查凭证有效期');
    expect(content).toContain('`because of: lessons/raw/2026-08-06-user-operations.md:5`');
    expect(content).toContain('## 经验正文');
    expect(content).toContain('## 关键做法');
  });
});

describe('readLastRefinedAt（D-041 P1-2）', () => {
  it('无 refined 目录返回 null（从未提炼）', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-refiner-'));
    roots.push(root);
    expect(await readLastRefinedAt(root)).toBeNull();
  });

  it('读取最新提炼文件的 updated_at', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-refiner-'));
    roots.push(root);
    const refinedDir = path.join(root, 'knowledge', 'lessons', 'refined');
    await fs.ensureDir(refinedDir);
    // 两个不同日期的提炼文件：字典序大的（日期晚的）为最新。
    await fs.writeFile(
      path.join(refinedDir, '2026-08-01-user-operations.md'),
      '---\nupdated_at: 2026-08-01\n---\n# a\n',
    );
    await fs.writeFile(
      path.join(refinedDir, '2026-08-06-user-operations.md'),
      '---\nupdated_at: 2026-08-06\n---\n# b\n',
    );
    expect(await readLastRefinedAt(root)).toBe('2026-08-06');
  });
});

describe('FactoryApplication 经验提炼链（D-041 P1-2，refineExperience 已 mock）', () => {
  async function setupAgent() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-refiner-'));
    roots.push(root);
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
    // 预置 0600 降级凭据（OP5-B）：prepareRuntime 在无 CC Switch 源时读它，避免真实 CLI 依赖。
    const runtimeHome = path.join(paths.runtimesDir, 'user-operations', 'claude');
    await fs.outputFile(
      path.join(runtimeHome, '.cc-switch.env'),
      'ANTHROPIC_AUTH_TOKEN=test-token\n',
      { mode: 0o600 },
    );
    return { root, paths, registry, application: new FactoryApplication(paths, registry) };
  }

  function transcriptSummary(overrides: Partial<Record<string, unknown>> = {}) {
    const today = new Date().toISOString().slice(0, 10);
    return {
      agent_id: 'user-operations',
      operation: 'run',
      started_at: `${today}T00:00:00Z`,
      finished_at: `${today}T00:01:00Z`,
      exit_code: 0,
      topics: ['接入飞书'],
      decisions: ['结论：采用 PersonalAgent'],
      lessons: ['经验：先检查凭证有效期'],
      tail: [],
      ...overrides,
    };
  }

  it('信号累积达阈值 → 调用提炼并写回 lessons/refined/（证据带 because of）', async () => {
    const { application, paths } = await setupAgent();
    const refineMock = refineExperience as unknown as ReturnType<typeof vi.fn>;
    refineMock.mockClear();
    refineMock.mockResolvedValue({
      insight: '接入飞书前先检查凭证有效期',
      evidence: ['lessons/raw/2026-08-06-user-operations.md:5'],
      writeup: '## 适用场景\n\n接入飞书。',
    });

    // 预置累计信号达到阈值（importance 总和 >= 3），使 shouldReflect 触发。
    const workspace = path.join(paths.workspaceRoot, 'user-operations');
    const signalsFile = path.join(workspace, 'knowledge', '.reflection-signals.jsonl');
    const { appendReflectionSignal } = await import('../src/core/reflection.js');
    await appendReflectionSignal(signalsFile, signal({ importance: 2 }));
    await appendReflectionSignal(signalsFile, signal({ importance: 2 }));

    // 写一个真实 transcript 文件，经公开入口触发提炼。
    const transcriptFile = path.join(workspace, 'logs', 'transcript.jsonl');
    await fs.outputFile(transcriptFile, `${JSON.stringify(transcriptSummary())}\n`);
    await application.extractExperience('user-operations', transcriptFile);

    // refineExperience 被调用；提炼产物写回 lessons/refined/。
    expect(refineMock).toHaveBeenCalledTimes(1);
    const today = new Date().toISOString().slice(0, 10);
    const refinedFile = path.join(
      workspace,
      'knowledge',
      refinedExperienceRelPath({ agentId: 'user-operations', date: today }),
    );
    expect(await fs.pathExists(refinedFile)).toBe(true);
    const content = await fs.readFile(refinedFile, 'utf8');
    expect(content).toContain('because of: lessons/raw/');
    // 信号已收敛为提炼产物：信号文件被重置。
    expect(await fs.pathExists(signalsFile)).toBe(false);
    // 提炼文件被 evolve 单文件提交。
    const { execa } = await import('execa');
    const { stdout } = await execa('git', ['-C', workspace, 'log', '--oneline'], {
      reject: false,
      extendEnv: false,
    });
    expect(stdout).toMatch(/evolve: 提炼经验/);
  });

  it('信号未达阈值时不提炼（refineExperience 不被调用），信号继续累积', async () => {
    const { application, paths } = await setupAgent();
    const refineMock = refineExperience as unknown as ReturnType<typeof vi.fn>;
    refineMock.mockClear();
    refineMock.mockResolvedValue({
      insight: 'x',
      evidence: [],
      writeup: 'y',
    });

    const workspace = path.join(paths.workspaceRoot, 'user-operations');
    const signalsFile = path.join(workspace, 'knowledge', '.reflection-signals.jsonl');
    const { appendReflectionSignal } = await import('../src/core/reflection.js');
    // 预置一条 importance=1 且时间很新的信号（避免 idle 保底触发）；本次 transcript 空
    // 决策/经验（importance=1）。累积 1+1=2 < 3，且从未提炼（以最新信号为参照 idle≈0），不触发。
    await appendReflectionSignal(
      signalsFile,
      signal({ importance: 1, date: new Date().toISOString() }),
    );

    const transcriptFile = path.join(workspace, 'logs', 'transcript.jsonl');
    await fs.outputFile(
      transcriptFile,
      `${JSON.stringify(
        transcriptSummary({ topics: ['会话'], decisions: [], lessons: [], tail: [] }),
      )}\n`,
    );
    await application.extractExperience('user-operations', transcriptFile);

    // 未达阈值：不调提炼，信号文件仍保留（累积），无 refined 产物。
    expect(refineMock).not.toHaveBeenCalled();
    expect(await fs.pathExists(signalsFile)).toBe(true);
    const refinedDir = path.join(workspace, 'knowledge', 'lessons', 'refined');
    expect((await fs.readdir(refinedDir).catch(() => [])).filter((n) => n.endsWith('.md'))).toEqual(
      [],
    );
  });
});
