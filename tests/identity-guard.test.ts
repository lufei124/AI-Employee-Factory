import { describe, expect, it } from 'vitest';
import { stripGuardSections, validateIdentityGuard } from '../src/core/identity-guard.js';

// D-041 P0-1：身份文档只读锚点硬门。验证 ROLE.md 岗位定位/长期职责标题、POLICIES.md
// 红线词不可被删除；stripGuardSections 供提案工具剥离受保护行。

const VALID_ROLE = `# 岗位定位

负责用户反馈收集、分析与闭环跟进。

## 长期职责

- 收集用户反馈并分类。
- 跟进问题闭环。

## 协作协议

- 与主账号协作，按时交付。
`;

const VALID_POLICIES = `# 权限与上报规则

## 权限边界

- 生产写入、对外发布、Git push 和删除数据必须经人工审批。
- 不要覆盖其他员工的工作区。

## 主动上报

- 需要生产权限或管理决策时上报。
`;

describe('validateIdentityGuard（D-041 P0-1）', () => {
  it('完整身份文档通过校验', () => {
    expect(validateIdentityGuard('agent/ROLE.md', VALID_ROLE).ok).toBe(true);
    expect(validateIdentityGuard('agent/POLICIES.md', VALID_POLICIES).ok).toBe(true);
  });

  it('未知文件不做硬门（不阻断）', () => {
    expect(validateIdentityGuard('agent/GOALS.md', '').ok).toBe(true);
    expect(validateIdentityGuard('knowledge/x.md', '').ok).toBe(true);
  });

  it('删除「岗位定位」标题被拒', () => {
    const stripped = VALID_ROLE.replace(/# 岗位定位\n\n/, '');
    const result = validateIdentityGuard('agent/ROLE.md', stripped);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.marker.label === '岗位定位')).toBe(true);
  });

  it('删除「长期职责」标题被拒', () => {
    const stripped = VALID_ROLE.replace(/## 长期职责\n\n/, '');
    const result = validateIdentityGuard('agent/ROLE.md', stripped);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.marker.label === '长期职责')).toBe(true);
  });

  it('标题改名（不以前缀匹配）被拒', () => {
    const renamed = VALID_ROLE.replace(/# 岗位定位/, '# 我的新定位');
    expect(validateIdentityGuard('agent/ROLE.md', renamed).ok).toBe(false);
  });

  it('标题文字完整保留但格式变化（一级变二级）仍通过', () => {
    const demoted = VALID_ROLE.replace('# 岗位定位', '## 岗位定位');
    // 一级/二级标题都算「标题存在」，锚点未删除 → 通过（防误伤合法格式调整）。
    expect(validateIdentityGuard('agent/ROLE.md', demoted).ok).toBe(true);
  });

  it('删除 POLICIES 红线词被拒', () => {
    const stripped = VALID_POLICIES.replace(
      '生产写入、对外发布、Git push 和删除数据必须经人工审批。',
      '所有操作须谨慎。',
    );
    const result = validateIdentityGuard('agent/POLICIES.md', stripped);
    expect(result.ok).toBe(false);
    // 五个红线词全部缺失。
    for (const label of ['人工审批', '生产写入', '对外发布', '删除数据', 'Git push']) {
      expect(result.issues.some((issue) => issue.marker.label === label)).toBe(true);
    }
  });

  it('保留红线词但扩展说明文字仍通过（允许合法强化）', () => {
    const strengthened = VALID_POLICIES.replace(
      '生产写入、对外发布、Git push 和删除数据必须经人工审批。',
      '生产写入、对外发布、Git push 和删除数据必须经人工审批。任何绕过审批的操作都属违规。',
    );
    expect(validateIdentityGuard('agent/POLICIES.md', strengthened).ok).toBe(true);
  });
});

describe('stripGuardSections（D-041 P0-1）', () => {
  it('剥离 ROLE 受保护标题行', () => {
    const stripped = stripGuardSections('agent/ROLE.md', VALID_ROLE);
    expect(stripped).not.toContain('# 岗位定位');
    expect(stripped).not.toContain('## 长期职责');
    expect(stripped).toContain('## 协作协议');
  });

  it('剥离 POLICIES 含红线词的行', () => {
    const stripped = stripGuardSections('agent/POLICIES.md', VALID_POLICIES);
    expect(stripped).not.toContain('人工审批');
    expect(stripped).not.toContain('生产写入');
    expect(stripped).not.toContain('Git push');
    expect(stripped).toContain('## 主动上报');
  });

  it('未知文件原样返回', () => {
    const content = '# 任意\n- x\n';
    expect(stripGuardSections('agent/GOALS.md', content)).toBe(content);
  });
});
