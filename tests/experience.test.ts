import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { CreateAgentService } from '../src/core/create-agent.js';
import { initializeFactory } from '../src/core/config.js';
import { DefaultExperienceExtractor, sanitizeSlug } from '../src/core/experience.js';
import type { TranscriptSummary } from '../src/core/transcript.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

function summary(overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
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

describe('sanitizeSlug (OP1 Stage D)', () => {
  it('normalizes ids to safe file slug fragments', () => {
    expect(sanitizeSlug('user-operations')).toBe('user-operations');
    expect(sanitizeSlug('User Operations!')).toBe('user-operations');
    expect(sanitizeSlug('!!!')).toBe('agent');
  });
});

describe('DefaultExperienceExtractor (OP1 Stage D)', () => {
  it('returns no assets when the summary has no decisions/lessons', () => {
    const extractor = new DefaultExperienceExtractor({ agentId: 'user-operations' });
    expect(extractor.extract(summary({ decisions: [], lessons: [], topics: [] }))).toEqual([]);
  });

  it('produces one knowledge asset with frontmatter and redacted-free body', () => {
    const extractor = new DefaultExperienceExtractor({ agentId: 'user-operations' });
    const assets = extractor.extract(summary());
    expect(assets).toHaveLength(1);
    const asset = assets[0]!;
    expect(asset.targetScope).toBe('knowledge');
    expect(asset.authorityLayer).toBe('knowledge');
    expect(asset.relPath).toMatch(/^lessons\/\d{4}-\d{2}-\d{2}-user-operations\.md$/);
    expect(asset.content).toContain('title: 会话经验摘要');
    expect(asset.content).toContain('## 决策');
    expect(asset.content).toContain('- 结论：采用 PersonalAgent');
    expect(asset.content).toContain('## 经验');
    expect(asset.content).toContain('- 经验：先检查凭证有效期');
  });
});

describe('FactoryApplication experience extraction (OP1 Stage D)', () => {
  async function setup(enableExtraction = true) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-experience-'));
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
    // 打开 transcript_persist（Stage C 前置）与 experience_extraction。
    const agentYaml = path.join(paths.workspaceRoot, 'user-operations', 'agent.yaml');
    const YAML = (await import('yaml')).default;
    const parsed = YAML.parse(await fs.readFile(agentYaml, 'utf8'));
    parsed.memory.transcript_persist = true;
    parsed.memory.experience_extraction = enableExtraction;
    await fs.writeFile(agentYaml, YAML.stringify(parsed));
    // 预置 0600 降级凭据（OP5-B）：无 CC Switch 源时 prepareRuntime 读它，避免真实 CLI 依赖。
    const runtimeHome = path.join(paths.runtimesDir, 'user-operations', 'claude');
    await fs.outputFile(
      path.join(runtimeHome, '.cc-switch.env'),
      'ANTHROPIC_AUTH_TOKEN=test-token\n',
      { mode: 0o600 },
    );
    const application = new FactoryApplication(paths, registry);
    return { root, paths, registry, application, agentId: 'user-operations' };
  }

  function lessonsDir(application: FactoryApplication, agentId: string): string {
    return path.join(application.paths.workspaceRoot, agentId, 'knowledge', 'lessons');
  }

  it('extracts a lesson file into knowledge/lessons/ after a transcripted run', async () => {
    const { application, agentId } = await setup(true);
    // 用 runLogged 触发 transcript 落盘（绕过真实 CLI），再经公开入口提取经验。
    const runner = new (await import('../src/core/process-runner.js')).ProcessRunner(
      application.paths.logsDir,
    );
    const result = await runner.runLogged(
      agentId,
      {
        operation: 'run',
        command: process.execPath,
        args: ['-e', "console.log('结论：采用 PersonalAgent')"],
        cwd: application.paths.workspaceRoot,
        env: { PATH: process.env.PATH ?? '' },
      },
      { transcript: true, mirror: false },
    );
    expect(result.transcriptFile).toBeDefined();
    await application.extractExperience(agentId, result.transcriptFile!);
    // D-041 P1-2：公开入口走两级——一级原始记录始终落盘到 lessons/raw/（文件名带运行日期）。
    const today = new Date().toISOString().slice(0, 10);
    const rawFile = path.join(
      lessonsDir(application, agentId),
      'raw',
      `${today}-user-operations.md`,
    );
    expect(await fs.pathExists(rawFile)).toBe(true);
    const content = await fs.readFile(rawFile, 'utf8');
    expect(content).toContain('结论：采用 PersonalAgent');
    expect(content).toContain('title: 原始会话经验');
    // 写回后索引应能 recall 到该经验条目。
    const recall = await application.knowledgeRecall(agentId, '经验');
    expect(recall.hits.some((hit) => hit.entry.relPath.includes('lessons/'))).toBe(true);
  });

  it('records raw experience even when experience_extraction is off（一级始终落盘）', async () => {
    const { application, agentId } = await setup(false);
    // D-041 P1-2：experience_extraction=false 仅关闭二级提炼；一级原始记录始终写 raw/（防丢现场）。
    const runner = new (await import('../src/core/process-runner.js')).ProcessRunner(
      application.paths.logsDir,
    );
    const result = await runner.runLogged(
      agentId,
      {
        operation: 'run',
        command: process.execPath,
        args: ['-e', "console.log('结论：采用 PersonalAgent')"],
        cwd: application.paths.workspaceRoot,
        env: { PATH: process.env.PATH ?? '' },
      },
      { transcript: true, mirror: false },
    );
    expect(result.transcriptFile).toBeDefined();
    await application.extractExperience(agentId, result.transcriptFile!);
    // 一级原始记录仍写（与开关无关）。
    const today = new Date().toISOString().slice(0, 10);
    const rawFile = path.join(
      lessonsDir(application, agentId),
      'raw',
      `${today}-user-operations.md`,
    );
    expect(await fs.pathExists(rawFile)).toBe(true);
    // 二级提炼目录保持为空（experience_extraction=false 不提炼）。
    const refinedDir = path.join(lessonsDir(application, agentId), 'refined');
    const refinedFiles = (await fs.readdir(refinedDir).catch(() => [])).filter((name) =>
      name.endsWith('.md'),
    );
    expect(refinedFiles).toEqual([]);
  });
});
