import { beforeEach, describe, expect, it, vi } from 'vitest';

const execa = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({ execa }));

import { generateEmployeeProfile } from '../src/core/employee-generator.js';

beforeEach(() => vi.clearAllMocks());

describe('generateEmployeeProfile (D-029)', () => {
  it('parses a valid structured profile from `claude -p --output-format json`', async () => {
    const profile = {
      name: '内容运营',
      description: '负责内容选题与撰写',
      goals: ['每周输出报告'],
      responsibilities: ['选题策划'],
      policies: ['对外发布须审批'],
      escalation_conditions: ['需要管理决策'],
      skills: ['content-writing'],
    };
    execa.mockResolvedValue({ stdout: JSON.stringify({ result: JSON.stringify(profile) }) });

    await expect(generateEmployeeProfile('帮我建一个内容运营')).resolves.toEqual(profile);

    // 用用户默认 Claude 环境：不设 CLAUDE_CONFIG_DIR。
    const env = execa.mock.calls[0]?.[2]?.env as Record<string, string> | undefined;
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    // 结构化 flag 已追加。
    expect(execa.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--output-format', 'json']));
  });

  it('strips markdown code fences around the JSON result', async () => {
    execa.mockResolvedValue({
      stdout: JSON.stringify({
        result: '```json\n{"name":"内容运营","description":"负责内容","goals":["每周输出"]}\n```',
      }),
    });
    await expect(generateEmployeeProfile('描述')).resolves.toMatchObject({
      name: '内容运营',
      goals: ['每周输出'],
    });
  });

  it('rejects (OPERATION_FAILED) when the model returns non-JSON result', async () => {
    execa.mockResolvedValue({ stdout: JSON.stringify({ result: '不是 JSON' }) });
    await expect(generateEmployeeProfile('描述')).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
    });
  });

  it('rejects (OPERATION_FAILED) when claude CLI call fails', async () => {
    execa.mockRejectedValue(new Error('claude not found'));
    await expect(generateEmployeeProfile('描述')).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
    });
  });

  it('passes --model when provided', async () => {
    execa.mockResolvedValue({
      stdout: JSON.stringify({
        result: JSON.stringify({
          name: 'x',
          description: 'y',
          goals: ['g'],
        }),
      }),
    });
    await generateEmployeeProfile('描述', { model: 'opus' });
    expect(execa.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--model', 'opus']));
  });
});
