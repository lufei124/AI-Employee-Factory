import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { CreateAgentService } from '../src/core/create-agent.js';
import { initializeFactory } from '../src/core/config.js';
import { KnowledgeIndexImpl, chineseKeywords, tokenize } from '../src/core/knowledge-index.js';
import { KNOWLEDGE_INDEX_FILE } from '../src/core/knowledge.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-knowledge-'));
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
  const application = new FactoryApplication(paths, registry);
  return { root, paths, registry, application, agentId: 'user-operations' };
}

function knowledgeDir(application: FactoryApplication, agentId: string): string {
  return path.join(application.paths.workspaceRoot, agentId, 'knowledge');
}

describe('tokenize (OP1 Stage B)', () => {
  it('splits mixed CJK/Latin text into normalized tokens, dropping stopwords', () => {
    expect(tokenize('飞书 配置 knowledge 与 决策')).toEqual(['飞书', '配置', 'knowledge', '决策']);
  });
});

describe('KnowledgeIndexImpl ingest/recall/compact/verifyConsistency (OP1 Stage B)', () => {
  it('ingest builds a derived index; recall returns ranked hits', async () => {
    const { application, agentId } = await setup();
    const dir = knowledgeDir(application, agentId);
    await fs.writeFile(
      path.join(dir, 'lessons', 'feishu-config.md'),
      [
        '---',
        'title: 飞书配置经验',
        'summary: 飞书 PersonalAgent WebSocket 连接失败时先检查凭证有效期',
        'keywords: [飞书, WebSocket, 凭证]',
        'updated_at: 2026-08-01',
        'authority_layer: knowledge',
        '---',
        '正文内容。',
      ].join('\n'),
    );

    const index = new KnowledgeIndexImpl(dir);
    const result = await index.ingest();
    expect(result.entries).toBe(1);

    const recall = await index.recall('飞书');
    expect(recall.hits.length).toBeGreaterThan(0);
    expect(recall.hits[0]!.entry.relPath).toBe('lessons/feishu-config.md');
    expect(recall.hits[0]!.entry.authorityLayer).toBe('knowledge');
  });

  it('decisions subdirectory defaults to the decisions authority layer', async () => {
    const { application, agentId } = await setup();
    const dir = knowledgeDir(application, agentId);
    await fs.writeFile(
      path.join(dir, 'decisions', 'd-001.md'),
      ['---', 'title: D-001', 'summary: 决策记录', 'updated_at: 2026-08-01', '---', '正文。'].join(
        '\n',
      ),
    );
    const index = new KnowledgeIndexImpl(dir);
    await index.ingest();
    const recall = await index.recall('D-001');
    expect(recall.hits[0]!.entry.authorityLayer).toBe('decisions');
  });

  it('compact rebuilds and verifyConsistency reports drift after a manual edit', async () => {
    const { application, agentId } = await setup();
    const dir = knowledgeDir(application, agentId);
    const file = path.join(dir, 'metrics', 'dau.md');
    await fs.writeFile(
      file,
      [
        '---',
        'title: DAU 口径',
        'summary: 日活定义',
        'keywords: [DAU]',
        'updated_at: 2026-08-01',
        '---',
        '正文。',
      ].join('\n'),
    );
    const index = new KnowledgeIndexImpl(dir);
    await index.ingest();
    expect((await index.verifyConsistency()).ok).toBe(true);

    await fs.writeFile(
      file,
      [
        '---',
        'title: DAU 口径（已改）',
        'summary: 新定义',
        'updated_at: 2026-08-02',
        '---',
        '正文。',
      ].join('\n'),
    );
    const consistency = await index.verifyConsistency();
    expect(consistency.ok).toBe(false);
    expect(consistency.issues.some((issue) => issue.kind === 'stale-entry')).toBe(true);

    await index.compact();
    expect((await index.verifyConsistency()).ok).toBe(true);
  });

  it('verifyConsistency reports missing-index when .index.json is absent', async () => {
    const { application, agentId } = await setup();
    const dir = knowledgeDir(application, agentId);
    const index = new KnowledgeIndexImpl(dir);
    const consistency = await index.verifyConsistency();
    expect(consistency.ok).toBe(false);
    expect(consistency.issues.some((issue) => issue.kind === 'missing-index')).toBe(true);
  });

  it('recall attaches because-of evidence links for refined lessons (D-041 P3-3)', async () => {
    const { application, agentId } = await setup();
    const dir = knowledgeDir(application, agentId);
    // 一级原始记录 + 二级提炼经验（正文带 because of 证据引用）。
    await fs.outputFile(
      path.join(dir, 'lessons', 'raw', '2026-08-01-user-operations.md'),
      [
        '---',
        'title: 原始会话记录',
        'summary: 一次用户反馈闭环的完整过程',
        'keywords: [反馈, 闭环]',
        'updated_at: 2026-08-01',
        '---',
        '用户反馈了登录失败问题，最终定位是凭证过期。',
      ].join('\n'),
    );
    await fs.outputFile(
      path.join(dir, 'lessons', 'refined', '2026-08-02-feedback-loop.md'),
      [
        '---',
        'title: 反馈闭环经验',
        'summary: 用户反馈优先检查凭证有效期',
        'keywords: [反馈, 凭证]',
        'updated_at: 2026-08-02',
        '---',
        '用户反馈登录失败时优先检查凭证有效期。',
        '',
        '- `because of: knowledge/lessons/raw/2026-08-01-user-operations.md:12`',
      ].join('\n'),
    );
    const index = new KnowledgeIndexImpl(dir);
    await index.ingest();

    const recall = await index.recall('凭证');
    const refined = recall.hits.find((hit) => hit.entry.relPath.startsWith('lessons/refined/'));
    expect(refined).toBeDefined();
    expect(refined?.evidence).toBeDefined();
    expect(refined?.evidence?.[0]).toContain('lessons/raw/2026-08-01-user-operations.md');

    // 非 refined 条目不附带证据引用。
    const raw = recall.hits.find((hit) => hit.entry.relPath.startsWith('lessons/raw/'));
    expect(raw?.evidence).toBeUndefined();
  });

  it('indexes body prose — a keyword only in the body is recallable (D-042 A1)', async () => {
    const { application, agentId } = await setup();
    const dir = knowledgeDir(application, agentId);
    // title/summary/keywords 均不含「闭环」；「闭环」只出现在正文。
    await fs.writeFile(
      path.join(dir, 'lessons', 'body-only.md'),
      [
        '---',
        'title: 用户反馈处理',
        'summary: 处理用户反馈的基本流程',
        'keywords: [反馈]',
        'updated_at: 2026-08-05',
        '---',
        '收到用户反馈后应先确认问题，再走闭环跟进流程。',
      ].join('\n'),
    );
    const index = new KnowledgeIndexImpl(dir);
    await index.ingest();
    const recall = await index.recall('闭环');
    expect(recall.hits.length).toBeGreaterThan(0);
    expect(recall.hits[0]!.entry.relPath).toBe('lessons/body-only.md');
  });

  it('mixes Chinese whole-word and character-bigram tokens always-on (D-042 A4)', async () => {
    expect(chineseKeywords('用户反馈闭环跟进')).toEqual(
      expect.arrayContaining(['用户反馈闭环跟进', '用户', '反馈', '闭环', '跟进']),
    );
    const { application, agentId } = await setup();
    const dir = knowledgeDir(application, agentId);
    await fs.writeFile(
      path.join(dir, 'lessons', 'zh-mix.md'),
      [
        '---',
        'title: 飞书消息闭环',
        'summary: 飞书消息的闭环跟进',
        'keywords: [飞书]',
        'updated_at: 2026-08-05',
        '---',
        '正文。',
      ].join('\n'),
    );
    const index = new KnowledgeIndexImpl(dir);
    await index.ingest();
    // 查询整词「飞书消息闭环」虽非完整命中，但字符大词「消息」/「闭环」应命中。
    const recall = await index.recall('飞书消息闭环');
    expect(recall.hits.length).toBeGreaterThan(0);
    expect(recall.hits[0]!.entry.relPath).toBe('lessons/zh-mix.md');
  });

  it("fuzzy fallback recalls a typo'd Latin keyword (D-042 A5)", async () => {
    const { application, agentId } = await setup();
    const dir = knowledgeDir(application, agentId);
    await fs.writeFile(
      path.join(dir, 'references', 'websocket.md'),
      [
        '---',
        'title: WebSocket 连接',
        'summary: WebSocket 长连接配置',
        'keywords: [WebSocket, 连接]',
        'updated_at: 2026-08-05',
        '---',
        '正文。',
      ].join('\n'),
    );
    const index = new KnowledgeIndexImpl(dir);
    await index.ingest();
    const recall = await index.recall('websoket');
    expect(recall.hits.length).toBeGreaterThan(0);
    expect(recall.hits[0]!.entry.relPath).toBe('references/websocket.md');
    expect(recall.hits[0]!.score).toBeGreaterThan(0);
  });

  it('attaches a body snippet to recall hits (D-042 A6)', async () => {
    const { application, agentId } = await setup();
    const dir = knowledgeDir(application, agentId);
    await fs.writeFile(
      path.join(dir, 'lessons', 'snippet.md'),
      [
        '---',
        'title: 凭证过期排查',
        'summary: 登录失败优先查凭证',
        'keywords: [凭证]',
        'updated_at: 2026-08-05',
        '---',
        '用户反馈登录失败时，先检查凭证有效期，再查网络与权限配置。',
      ].join('\n'),
    );
    const index = new KnowledgeIndexImpl(dir);
    await index.ingest();
    const recall = await index.recall('凭证');
    const hit = recall.hits.find((candidate) => candidate.entry.relPath === 'lessons/snippet.md');
    expect(hit?.snippet).toBeDefined();
    expect(hit?.snippet?.toLowerCase()).toContain('凭证');
  });

  it('ignores the .retrieved.md scratchpad in ingest and verifyConsistency (D-042 B5)', async () => {
    const { application, agentId } = await setup();
    const dir = knowledgeDir(application, agentId);
    await fs.writeFile(
      path.join(dir, 'lessons', 'real.md'),
      [
        '---',
        'title: 真实条目',
        'summary: 正式知识',
        'keywords: [真实]',
        'updated_at: 2026-08-05',
        '---',
        '正文。',
      ].join('\n'),
    );
    // 无 frontmatter 的便签 + 已入 gitignore 的派生文件——scan 应跳过（点前缀 + 无 frontmatter 双保险）。
    await fs.writeFile(path.join(dir, '.retrieved.md'), '<!-- factory:retrieved -->\n# 便签\n');
    const index = new KnowledgeIndexImpl(dir);
    const result = await index.ingest();
    expect(result.entries).toBe(1); // 便签不计入。
    const consistency = await index.verifyConsistency();
    expect(consistency.ok).toBe(true); // 无孤立、无计数漂移。
    const recall = await index.recall('便签');
    expect(recall.hits.length).toBe(0); // 便签不可被召回。
  });
});

describe('FactoryApplication knowledge API (OP1 Stage B)', () => {
  it('ingest/recall/verify work end-to-end', async () => {
    const { application, agentId } = await setup();
    await fs.writeFile(
      path.join(knowledgeDir(application, agentId), 'product', 'onboarding.md'),
      [
        '---',
        'title: 新手引导',
        'summary: 新员工初始化流程',
        'keywords: [onboarding]',
        'updated_at: 2026-08-03',
        '---',
        '正文。',
      ].join('\n'),
    );
    const ingest = await application.knowledgeIngest(agentId);
    expect(ingest.entries).toBe(1);

    const recall = await application.knowledgeRecall(agentId, 'onboarding');
    expect(recall.hits[0]!.entry.title).toBe('新手引导');

    const consistency = await application.knowledgeVerify(agentId);
    expect(consistency.ok).toBe(true);
  });

  it('knowledgeWrite rejects paths escaping knowledge/ (assertInside)', async () => {
    const { application, agentId } = await setup();
    await expect(application.knowledgeWrite(agentId, '../escape.md', '# x')).rejects.toThrow(
      '必须位于',
    );
    await expect(application.knowledgeRead(agentId, '../../agent.yaml')).rejects.toThrow(
      '必须位于',
    );
  });

  it('knowledgeWrite writes and re-ingests, then recall finds the new entry', async () => {
    const { application, agentId } = await setup();
    await application.knowledgeWrite(
      agentId,
      'references/rest-api.md',
      [
        '---',
        'title: REST API 规范',
        'summary: 统一错误码约定',
        'keywords: [REST, API]',
        'updated_at: 2026-08-04',
        '---',
        '正文。',
      ].join('\n'),
    );
    const recall = await application.knowledgeRecall(agentId, 'REST');
    expect(recall.hits.length).toBeGreaterThan(0);
    expect(recall.hits[0]!.entry.relPath).toBe('references/rest-api.md');
    expect(
      await fs.pathExists(path.join(knowledgeDir(application, agentId), KNOWLEDGE_INDEX_FILE)),
    ).toBe(true);
  });
});
