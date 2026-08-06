import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptSummary } from '../src/core/transcript.js';
import {
  appendSkillSignal,
  detectRepeatedSkillOpportunity,
  pickCandidateTopic,
  readSkillSignals,
} from '../src/core/skill-opportunity.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

function summary(overrides: Partial<TranscriptSummary>): TranscriptSummary {
  return {
    agent_id: 'a',
    operation: 'run',
    started_at: '2026-08-06T00:00:00.000Z',
    finished_at: '2026-08-06T00:00:00.000Z',
    exit_code: 0,
    topics: ['report'],
    decisions: [],
    lessons: [],
    tail: [],
    ...overrides,
  };
}

describe('pickCandidateTopic', () => {
  it('returns a topic related to a repeat-signal lesson', () => {
    const topic = pickCandidateTopic(
      summary({ topics: ['report'], lessons: ['下次记得用统一模板生成 report'] }),
    );
    expect(topic).toBe('report');
  });

  it('returns null when no lesson carries a repeat signal', () => {
    expect(pickCandidateTopic(summary({ lessons: ['已完成任务'] }))).toBeNull();
  });

  it('falls back to the first topic when lessons have signal but no text match', () => {
    const topic = pickCandidateTopic(
      summary({ topics: ['alpha', 'beta'], lessons: ['总是需要重复做'] }),
    );
    expect(topic).toBe('alpha');
  });
});

describe('detectRepeatedSkillOpportunity', () => {
  it('returns null below threshold', () => {
    const result = detectRepeatedSkillOpportunity(
      summary({ topics: ['report'], lessons: ['下次用模板'] }),
      { topics: {} },
      [],
      2,
    );
    expect(result).toBeNull();
  });

  it('returns a brief once a topic repeats at the threshold', () => {
    const result = detectRepeatedSkillOpportunity(
      summary({ topics: ['report'], lessons: ['下次用模板'] }),
      { topics: { report: 1 } },
      [],
      2,
    );
    expect(result?.topic).toBe('report');
    expect(result?.count).toBe(2);
    expect(result?.brief).toContain('report');
  });

  it('excludes topics already covered by an existing skill', () => {
    const result = detectRepeatedSkillOpportunity(
      summary({ topics: ['report'], lessons: ['下次用模板'] }),
      { topics: { report: 5 } },
      ['report'],
      2,
    );
    expect(result).toBeNull();
  });
});

describe('skill signal persistence', () => {
  it('reads counts within the window and appends new signals', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-signal-'));
    roots.push(root);
    const file = path.join(root, '.skill-signals.jsonl');

    await appendSkillSignal(file, 'report');
    await appendSkillSignal(file, 'report');
    await appendSkillSignal(file, 'other');

    const history = await readSkillSignals(file);
    expect(history.topics.report).toBe(2);
    expect(history.topics.other).toBe(1);
  });

  it('returns empty history for a missing file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-signal-'));
    roots.push(root);
    expect(await readSkillSignals(path.join(root, 'nope.jsonl'))).toEqual({ topics: {} });
  });
});
