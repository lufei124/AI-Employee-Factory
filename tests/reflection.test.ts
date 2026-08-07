import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  REFLECTION_SIGNALS_FILE,
  REFLECTION_THRESHOLD,
  accumulatedImportance,
  appendReflectionSignal,
  estimateImportance,
  readReflectionSignals,
  reflectionSignalsPath,
  shouldReflect,
  truncateReflectionSignals,
  type ReflectionSignal,
} from '../src/core/reflection.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

function signal(overrides: Partial<ReflectionSignal> = {}): ReflectionSignal {
  return {
    date: new Date().toISOString(),
    importance: 1,
    topics: ['接入飞书'],
    transcriptFile: '/tmp/runs/transcript.jsonl',
    ...overrides,
  };
}

describe('estimateImportance（D-041 P1-2）', () => {
  it('base 1，主题/决策/经验越丰富越重要，封顶 5', () => {
    expect(estimateImportance({ topics: [], decisions: [], lessons: [] })).toBe(1);
    expect(estimateImportance({ topics: ['a'], decisions: ['d1'], lessons: ['l1'] })).toBe(
      1 + 1 + 1,
    );
    expect(
      estimateImportance({ topics: ['a', 'b'], decisions: ['d1', 'd2'], lessons: ['l1', 'l2'] }),
    ).toBe(5);
    // 决策/经验超过 2 条只计 2 条；多主题 +1 封顶 5。
    expect(
      estimateImportance({
        topics: ['a', 'b'],
        decisions: ['d1', 'd2', 'd3'],
        lessons: ['l1', 'l2', 'l3', 'l4'],
      }),
    ).toBe(5);
  });
});

describe('appendReflectionSignal / readReflectionSignals（D-041 P1-2）', () => {
  it('追加 JSONL 并可回读；损坏行跳过不阻断', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-reflection-'));
    roots.push(root);
    const file = path.join(root, REFLECTION_SIGNALS_FILE);
    await appendReflectionSignal(file, signal({ importance: 2 }));
    await appendReflectionSignal(file, signal({ importance: 3 }));
    await fs.appendFile(file, '{broken json}\n');
    const signals = await readReflectionSignals(file);
    expect(signals).toHaveLength(2);
    expect(signals[0].importance).toBe(2);
    expect(accumulatedImportance(signals)).toBe(5);
  });

  it('truncateReflectionSignals 压缩最早批为摘要 + 保留最近原始行（P2-3 压缩为摘要）', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-reflection-'));
    roots.push(root);
    const file = path.join(root, REFLECTION_SIGNALS_FILE);
    for (let i = 0; i < 12; i += 1) {
      await appendReflectionSignal(
        file,
        signal({ importance: 1, date: `2026-08-0${(i % 9) + 1}T00:00:00Z` }),
      );
    }
    await truncateReflectionSignals(file, 5);
    const signals = await readReflectionSignals(file);
    // 上限 5 行 = 1 行摘要 + 最近 4 行原始。
    expect(signals).toHaveLength(5);
    const [first, ...rest] = signals;
    expect((first as { summary?: boolean }).summary).toBe(true);
    expect((first as { count?: number }).count).toBe(8);
    expect(rest).toHaveLength(4);
    for (const s of rest) expect((s as { summary?: boolean }).summary).toBeUndefined();
  });
});

describe('shouldReflect（D-041 P1-2 重要性累积触发）', () => {
  it('累积 importance 达阈值触发', () => {
    const signals = [signal({ importance: 2 }), signal({ importance: 2 })];
    expect(shouldReflect(signals, { threshold: REFLECTION_THRESHOLD })).toBe(true);
  });

  it('未达阈值且距上次提炼不久不触发', () => {
    const signals = [signal({ importance: 1 }), signal({ importance: 1 })];
    const lastRefinedAt = new Date().toISOString();
    expect(shouldReflect(signals, { lastRefinedAt, maxIdleHours: 24 })).toBe(false);
  });

  it('距上次提炼超过保底窗口触发', () => {
    const signals = [signal({ importance: 1 })];
    const lastRefinedAt = new Date(Date.now() - 48 * 3_600_000).toISOString();
    expect(shouldReflect(signals, { lastRefinedAt, maxIdleHours: 24 })).toBe(true);
  });

  it('从未提炼且无信号时不触发（避免首条消息即提炼）', () => {
    expect(shouldReflect([], { lastRefinedAt: null })).toBe(false);
  });

  it('从未提炼但信号已积累很久触发保底（以最早信号为参照）', () => {
    const stale = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const signals = [signal({ date: stale, importance: 1 })];
    expect(shouldReflect(signals, { lastRefinedAt: null, maxIdleHours: 24 })).toBe(true);
  });

  it('从未提炼且信号很新时不触发', () => {
    const fresh = new Date().toISOString();
    const signals = [signal({ date: fresh, importance: 1 })];
    expect(shouldReflect(signals, { lastRefinedAt: null, maxIdleHours: 24 })).toBe(false);
  });
});

describe('reflectionSignalsPath（D-041 P1-2）', () => {
  it('返回工作区内信号文件路径', () => {
    expect(reflectionSignalsPath('/tmp/ws')).toBe(path.join('/tmp/ws', REFLECTION_SIGNALS_FILE));
  });
});
