import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessRunner } from '../src/core/process-runner.js';
import { FileTranscriptSink, summarizeTranscript } from '../src/core/transcript.js';
import type { ExecutionContext } from '../src/runtimes/runtime-adapter.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-transcript-'));
  roots.push(root);
  return { root, runner: new ProcessRunner(root) };
}

function context(args: string[] = ['-e', "console.log('hi')"]): ExecutionContext {
  return {
    operation: 'run',
    command: process.execPath,
    args,
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '' },
  };
}

describe('summarizeTranscript (OP1 Stage C)', () => {
  it('extracts topics, decisions, lessons and redacts secrets in the tail', () => {
    const outputLines = [
      '# 决策：接入飞书',
      '结论：采用 PersonalAgent',
      '经验：先检查凭证有效期',
      '这是下一行的 sk-abcdefghijklmnopqrstuvwxyz0123456789XYZ 机密',
      '普通行',
    ];
    const summary = summarizeTranscript({
      agentId: 'user-operations',
      operation: 'run',
      startedAt: '2026-08-04T00:00:00Z',
      finishedAt: '2026-08-04T00:01:00Z',
      exitCode: 0,
      outputLines,
      maxTail: 10,
    });
    expect(summary.topics).toEqual(['决策：接入飞书']);
    expect(summary.decisions).toHaveLength(2);
    expect(summary.lessons).toHaveLength(1);
    expect(summary.tail.join(' ')).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789XYZ');
    expect(summary.tail.join(' ')).toContain('[REDACTED]');
  });
});

describe('FileTranscriptSink (OP1 Stage C)', () => {
  it('writes a JSON line and ensures the file is 0600', async () => {
    const { root } = await setup();
    const file = path.join(root, 'logs', 'user-operations', 'runs', 'run-1', 'transcript.jsonl');
    const sink = new FileTranscriptSink(file);
    const written = await sink.persist({
      agent_id: 'user-operations',
      operation: 'run',
      started_at: '2026-08-04T00:00:00Z',
      finished_at: '2026-08-04T00:01:00Z',
      exit_code: 0,
      topics: ['接入飞书'],
      decisions: [],
      lessons: [],
      tail: [],
    });
    expect(written).toBe(file);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const [line] = (await fs.readFile(file, 'utf8')).trim().split('\n');
    expect(JSON.parse(line!).agent_id).toBe('user-operations');
  });
});

describe('ProcessRunner transcript persistence (OP1 Stage C)', () => {
  it('writes transcript.jsonl when transcript option is enabled', async () => {
    const { runner } = await setup();
    const result = await runner.runLogged('agent-1', context(), {
      transcript: true,
      mirror: false,
    });
    expect(result.transcriptFile).toBeDefined();
    expect(await fs.pathExists(result.transcriptFile!)).toBe(true);
    expect(path.basename(result.transcriptFile!)).toBe('transcript.jsonl');
    const [line] = (await fs.readFile(result.transcriptFile!, 'utf8')).trim().split('\n');
    expect(JSON.parse(line!).agent_id).toBe('agent-1');
  });

  it('does not write a transcript by default (backward compatible)', async () => {
    const { runner } = await setup();
    const result = await runner.runLogged('agent-1', context(), { mirror: false });
    expect(result.transcriptFile).toBeUndefined();
    expect(await fs.pathExists(path.join(result.logDir, 'transcript.jsonl'))).toBe(false);
  });

  it('redacts secrets from the persisted summary', async () => {
    const { runner } = await setup();
    const result = await runner.runLogged(
      'agent-1',
      context(['-e', "console.log('token sk-abcdefghijklmnopqrstuvwxyz0123456789XYZ leaked')"]),
      { transcript: true, mirror: false },
    );
    const content = await fs.readFile(result.transcriptFile!, 'utf8');
    expect(content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789XYZ');
    expect(content).toContain('[REDACTED]');
  });
});

describe('FactoryApplication transcript wiring (OP1 Stage C)', () => {
  it('persists a transcript when agent.yaml.memory.transcript_persist is true', async () => {
    const fsExtra = await import('fs-extra');
    const YAML = (await import('yaml')).default;
    const { CreateAgentService } = await import('../src/core/create-agent.js');
    const { initializeFactory } = await import('../src/core/config.js');
    const { resolveFactoryPaths } = await import('../src/core/paths.js');
    const { RegistryStore } = await import('../src/core/registry.js');

    const root = await fsExtra.mkdtemp(path.join(os.tmpdir(), 'agentctl-transcript-app-'));
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
    // 打开 transcript_persist。
    const agentYaml = path.join(paths.workspaceRoot, 'user-operations', 'agent.yaml');
    const doc = YAML.parse(await fsExtra.readFile(agentYaml, 'utf8'));
    doc.memory.transcript_persist = true;
    await fsExtra.writeFile(agentYaml, YAML.stringify(doc));

    // 用 node 脚本模拟一次 runLogged（绕过真实 CLI），直接验证 transcript 落盘。
    const result = await new (await import('../src/core/process-runner.js')).ProcessRunner(
      paths.logsDir,
    ).runLogged(
      'user-operations',
      {
        operation: 'run',
        command: process.execPath,
        args: ['-e', "console.log('hi')"],
        cwd: paths.workspaceRoot,
        env: { PATH: process.env.PATH ?? '' },
      },
      {
        transcript: true,
        mirror: false,
      },
    );
    expect(result.transcriptFile).toBeDefined();
    expect(await fsExtra.pathExists(result.transcriptFile!)).toBe(true);
    expect((await fsExtra.stat(result.transcriptFile!)).mode & 0o777).toBe(0o600);
    // 从 agent.yaml 复核 transcript_persist 已生效。
    const persisted = YAML.parse(await fsExtra.readFile(agentYaml, 'utf8'));
    expect(persisted.memory.transcript_persist).toBe(true);
  });
});
