import { describe, expect, it } from 'vitest';
import {
  agentConfigSchema,
  agentIdSchema,
  DEFAULT_MEMORY_FLAGS,
  resolveMemoryFlags,
} from '../src/schemas/agent-schema.js';
import { jobConfigSchema } from '../src/schemas/job-schema.js';
import { presetSchema } from '../src/schemas/preset-schema.js';
import { generatedProfileSchema } from '../src/core/employee-generator.js';

const validAgent = {
  schema_version: 1,
  id: 'user-operations',
  name: '用户运营专员',
  description: '负责用户运营',
  runtime: { provider: 'claude', locked: true, model: 'sonnet' },
  identity: {
    role_file: 'agent/ROLE.md',
    goals_file: 'agent/GOALS.md',
    operating_system_file: 'agent/OPERATING_SYSTEM.md',
    policies_file: 'agent/POLICIES.md',
    current_state_file: 'agent/CURRENT_STATE.md',
  },
  memory: {
    isolation: 'strict',
    native_memory: true,
    portable_memory: true,
    authority_order: ['agent', 'knowledge', 'decisions', 'skills', 'native_memory', 'session'],
  },
  feishu: { enabled: true, mode: 'dedicated_bot', bridge_profile: 'user-operations' },
  permissions: {
    level: 'workspace',
    production_write: 'approval_required',
    external_publish: 'approval_required',
  },
  lifecycle: { status: 'active', created_at: '2026-08-03T00:00:00.000Z', archived_at: null },
};

describe('agent schemas', () => {
  it.each(['user-operations', 'agent2', 'growth-2026'])('accepts valid id %s', (id) => {
    expect(agentIdSchema.parse(id)).toBe(id);
  });

  it.each(['User-Operations', '../escape', 'has space', '-leading', 'trailing-'])(
    'rejects id %s',
    (id) => {
      expect(() => agentIdSchema.parse(id)).toThrow();
    },
  );

  it('requires a locked runtime', () => {
    expect(() =>
      agentConfigSchema.parse({ ...validAgent, runtime: { provider: 'claude', locked: false } }),
    ).toThrow();
    expect(agentConfigSchema.parse(validAgent).runtime.provider).toBe('claude');
  });

  it('treats memory.enforced as optional for backward compat (OP1 Stage A)', () => {
    // 旧 agent.yaml（无 enforced）解析为 undefined。
    expect(agentConfigSchema.parse(validAgent).memory.enforced).toBeUndefined();
    // 新 agent.yaml 显式 enforced: true 解析为 true。
    expect(
      agentConfigSchema.parse({
        ...validAgent,
        memory: { ...validAgent.memory, enforced: true },
      }).memory.enforced,
    ).toBe(true);
    // enforced: false 亦合法（显式降级逃生口）。
    expect(
      agentConfigSchema.parse({
        ...validAgent,
        memory: { ...validAgent.memory, enforced: false },
      }).memory.enforced,
    ).toBe(false);
  });

  it('accepts D-041 P1-4 optional memory fields and treats them as optional for compat', () => {
    // 旧 agent.yaml（无这些字段）解析为 undefined，不报错。
    const legacy = agentConfigSchema.parse(validAgent).memory;
    expect(legacy.reflection_enabled).toBeUndefined();
    expect(legacy.identity_protocol).toBeUndefined();
    expect(legacy.identity_edits).toBeUndefined();
    // 新 agent.yaml 显式声明可解析。
    const explicit = agentConfigSchema.parse({
      ...validAgent,
      memory: {
        ...validAgent.memory,
        reflection_enabled: false,
        identity_protocol: 'enforced',
        identity_edits: 'proposal_required',
      },
    }).memory;
    expect(explicit.reflection_enabled).toBe(false);
    expect(explicit.identity_protocol).toBe('enforced');
    expect(explicit.identity_edits).toBe('proposal_required');
  });

  it('resolveMemoryFlags maps undefined flags to defaults and preserves explicit false (D-041 P1-1)', () => {
    // 旧 agent.yaml（缺失三开关）归一为默认 true。
    const resolved = resolveMemoryFlags(agentConfigSchema.parse(validAgent).memory);
    expect(resolved).toEqual({
      transcript_persist: true,
      experience_extraction: true,
      skill_self_creation: true,
    });
    expect(resolved).toEqual(DEFAULT_MEMORY_FLAGS);
    // 显式 false 保留（用户关闭意图）。
    const withFalse = resolveMemoryFlags(
      agentConfigSchema.parse({
        ...validAgent,
        memory: {
          ...validAgent.memory,
          transcript_persist: false,
          experience_extraction: false,
          skill_self_creation: false,
        },
      }).memory,
    );
    expect(withFalse).toEqual({
      transcript_persist: false,
      experience_extraction: false,
      skill_self_creation: false,
    });
    // 不修改原对象。
    const original = agentConfigSchema.parse(validAgent).memory;
    resolveMemoryFlags(original);
    expect(original.transcript_persist).toBeUndefined();
  });
});

describe('profile and job schemas', () => {
  it('accepts a profile container (Preset shape)', () => {
    expect(
      presetSchema.parse({
        schema_version: 1,
        id: 'user-operations',
        name: '用户运营专员',
        description: '负责用户运营',
        goals: ['提高留存'],
        responsibilities: ['用户反馈分析'],
        policies: ['生产写入需要人工确认'],
        escalation_conditions: ['数据丢失'],
      }).id,
    ).toBe('user-operations');
  });

  it('accepts a generated employee profile and defaults optional arrays (D-029)', () => {
    const parsed = generatedProfileSchema.parse({
      name: '内容运营',
      description: '负责内容选题与撰写',
      goals: ['每周输出'],
    });
    expect(parsed.name).toBe('内容运营');
    expect(parsed.responsibilities).toEqual([]);
    expect(parsed.policies).toEqual([]);
    expect(parsed.skills).toEqual([]);
    // 缺 goals 或 name → 拒绝。
    expect(() =>
      generatedProfileSchema.parse({ name: 'x', description: 'y', goals: [] }),
    ).toThrow();
  });

  it('validates daily agent jobs and rejects shell strings', () => {
    const parsed = jobConfigSchema.parse({
      schema_version: 1,
      id: 'daily-feedback-review',
      enabled: false,
      schedule: { type: 'daily', time: '09:00' },
      execution: {
        type: 'agent',
        prompt_file: 'automation/prompts/daily-feedback-review.md',
        timeout_seconds: 900,
        concurrency: 'forbid',
      },
    });
    expect(parsed.schedule.time).toBe('09:00');
    expect(() =>
      jobConfigSchema.parse({
        ...parsed,
        execution: { type: 'script', command: 'node script.js && rm -rf /' },
      }),
    ).toThrow();
  });

  it('defaults managed_by to admin and accepts explicit employee (D-028)', () => {
    const admin = jobConfigSchema.parse({
      schema_version: 1,
      id: 'daily-feedback-review',
      enabled: false,
      schedule: { type: 'daily', time: '09:00' },
      execution: {
        type: 'agent',
        prompt_file: 'automation/prompts/daily-feedback-review.md',
        timeout_seconds: 900,
        concurrency: 'forbid',
      },
    });
    expect(admin.managed_by).toBe('admin');

    const employee = jobConfigSchema.parse({
      ...admin,
      managed_by: 'employee',
    });
    expect(employee.managed_by).toBe('employee');
  });
});
