import { beforeEach, describe, expect, it, vi } from 'vitest';

const execa = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({ execa }));

import {
  generateSkill,
  renderSkillFile,
  generatedSkillSchema,
} from '../src/core/skill-generator.js';
import { extractJson } from '../src/core/employee-generator.js';

beforeEach(() => vi.clearAllMocks());

describe('generateSkill (D-034)', () => {
  it('parses a valid skill blueprint from `claude -p --output-format json`', async () => {
    const blueprint = {
      name: 'periodic-report',
      version: '1.0.0',
      short_description: '周期性生成报告',
      description: '按固定模板生成周期报告',
      instructions: '# 步骤\n1. 读取数据\n2. 生成报告',
      triggers: ['每周生成销售报表'],
    };
    execa.mockResolvedValue({ stdout: JSON.stringify({ result: JSON.stringify(blueprint) }) });

    await expect(generateSkill('每周生成销售报表')).resolves.toEqual(blueprint);

    expect(execa.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--output-format', 'json']));
  });

  it('strips markdown code fences around the JSON result', async () => {
    execa.mockResolvedValue({
      stdout: JSON.stringify({
        result:
          '```json\n{"name":"rep","version":"1.0.0","short_description":"d","description":"d","instructions":"i"}\n```',
      }),
    });
    await expect(generateSkill('描述')).resolves.toMatchObject({ name: 'rep' });
  });

  it('rejects (OPERATION_FAILED) when the model returns non-JSON result', async () => {
    execa.mockResolvedValue({ stdout: JSON.stringify({ result: '不是 JSON' }) });
    await expect(generateSkill('描述')).rejects.toMatchObject({ code: 'OPERATION_FAILED' });
  });

  it('rejects (OPERATION_FAILED) when claude CLI call fails', async () => {
    execa.mockRejectedValue(new Error('claude not found'));
    await expect(generateSkill('描述')).rejects.toMatchObject({ code: 'OPERATION_FAILED' });
  });

  it('passes --model when provided', async () => {
    execa.mockResolvedValue({
      stdout: JSON.stringify({
        result: JSON.stringify({
          name: 'x',
          version: '1.0.0',
          short_description: 'd',
          description: 'd',
          instructions: 'i',
        }),
      }),
    });
    await generateSkill('描述', { model: 'opus' });
    expect(execa.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--model', 'opus']));
  });
});

describe('generatedSkillSchema', () => {
  it('rejects an invalid name (not kebab-case)', () => {
    expect(generatedSkillSchema.safeParse({ name: 'Bad Name' }).success).toBe(false);
  });

  it('defaults version and triggers', () => {
    const parsed = generatedSkillSchema.parse({
      name: 'ok',
      short_description: 'd',
      description: 'd',
      instructions: 'i',
    });
    expect(parsed.version).toBe('0.0.1');
    expect(parsed.triggers).toEqual([]);
  });

  it('rejects missing instructions', () => {
    expect(
      generatedSkillSchema.safeParse({ name: 'ok', short_description: 'd', description: 'd' })
        .success,
    ).toBe(false);
  });
});

describe('renderSkillFile', () => {
  it('renders frontmatter + instructions', () => {
    const text = renderSkillFile({
      name: 'periodic-report',
      version: '1.0.0',
      short_description: '周期性生成报告',
      description: 'd',
      instructions: '# 步骤\n1. 读取数据',
      triggers: [],
    });
    expect(text).toContain('---\nname: periodic-report\nversion: 1.0.0\n');
    expect(text).toContain('description: 周期性生成报告');
    expect(text).toContain('# 步骤\n1. 读取数据');
  });
});

describe('extractJson (exported from employee-generator)', () => {
  it('parses bare JSON and fenced JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
});
