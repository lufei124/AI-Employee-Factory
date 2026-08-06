import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IDENTITY_BASELINE_FILE,
  IDENTITY_DOCS,
  allowedIdentityDiff,
  baselineDrift,
  ensureIdentityBaseline,
  parseIdentityBaseline,
  snapshotDoc,
  type DocBaseline,
} from '../src/core/identity-baseline.js';

// D-041 P0-3：身份基线 + 双真相消解。验证基线快照/幂等/漂移检测/可进化判定。

const tempDirs: string[] = [];

function seed(workspace: string, role: string): void {
  void role;
  fs.mkdirpSync(path.join(workspace, 'agent'));
  fs.writeFileSync(
    path.join(workspace, 'agent/ROLE.md'),
    `# 岗位定位\n\n负责用户反馈收集、分析与闭环跟进。\n\n## 长期职责\n\n- 收集用户反馈并分类。\n`,
  );
  fs.writeFileSync(
    path.join(workspace, 'agent/GOALS.md'),
    '# 核心目标\n\n- 收集并分析用户反馈。\n',
  );
  fs.writeFileSync(
    path.join(workspace, 'agent/OPERATING_SYSTEM.md'),
    '# 标准工作闭环\n\n发现问题 → 收集证据 → 判断影响 → 提出方案。\n',
  );
  fs.writeFileSync(
    path.join(workspace, 'agent/POLICIES.md'),
    `# 权限与上报规则\n\n## 权限边界\n\n生产写入、对外发布、Git push 和删除数据必须经人工审批。\n\n## 主动上报\n\n需要生产权限或管理决策时上报。\n`,
  );
}

async function setup(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'baseline-'));
  tempDirs.push(dir);
  seed(dir, '');
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('ensureIdentityBaseline（D-041 P0-3）', () => {
  it('播种基线：写入 IDENTITY_BASELINE.md 且含 sha256/标题/全文', async () => {
    const ws = await setup();
    const { wrote, baseline } = await ensureIdentityBaseline({
      workspace: ws,
      description: '负责用户反馈',
    });
    expect(wrote).toBe(true);
    expect(baseline.description).toBe('负责用户反馈');
    for (const doc of IDENTITY_DOCS) {
      expect(baseline.docs[doc].sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(baseline.docs[doc].headings.length).toBeGreaterThan(0);
      expect(baseline.docs[doc].content.length).toBeGreaterThan(0);
    }
    const file = await fs.readFile(path.join(ws, IDENTITY_BASELINE_FILE), 'utf8');
    expect(file).toContain('# 身份基线');
    expect(file).toContain('agent/ROLE.md');
    expect(file).toContain('负责用户反馈');
  });

  it('幂等：内容与描述未变时第二次不重写（wrote=false）', async () => {
    const ws = await setup();
    await ensureIdentityBaseline({ workspace: ws, description: '负责用户反馈' });
    const before = await fs.readFile(path.join(ws, IDENTITY_BASELINE_FILE), 'utf8');
    const { wrote } = await ensureIdentityBaseline({ workspace: ws, description: '负责用户反馈' });
    expect(wrote).toBe(false);
    expect(await fs.readFile(path.join(ws, IDENTITY_BASELINE_FILE), 'utf8')).toBe(before);
  });

  it('描述变化（唯一权威更新）→ 刷新基线（wrote=true）', async () => {
    const ws = await setup();
    await ensureIdentityBaseline({ workspace: ws, description: '旧描述' });
    const { wrote, baseline } = await ensureIdentityBaseline({
      workspace: ws,
      description: '新描述',
    });
    expect(wrote).toBe(true);
    expect(baseline.description).toBe('新描述');
    const file = await fs.readFile(path.join(ws, IDENTITY_BASELINE_FILE), 'utf8');
    expect(file).toContain('新描述');
  });

  it('ROLE 被改后基线快照的是当前内容（基线代表系统认可的现状）', async () => {
    const ws = await setup();
    await ensureIdentityBaseline({ workspace: ws, description: 'd' });
    // 员工改 ROLE 职责行，基线尚未重写 → 此时基线仍是旧内容。
    fs.appendFileSync(path.join(ws, 'agent/ROLE.md'), '\n- 新增一条职责。\n');
    await ensureIdentityBaseline({ workspace: ws, description: 'd' });
    // 再次 ensure：快照应反映新内容，第二次 ensure 幂等（wrote=false）。
    const { wrote } = await ensureIdentityBaseline({ workspace: ws, description: 'd' });
    expect(wrote).toBe(false);
  });

  it('parseIdentityBaseline 从渲染文本反解成功', async () => {
    const ws = await setup();
    const { baseline } = await ensureIdentityBaseline({
      workspace: ws,
      description: '负责用户反馈',
    });
    const file = await fs.readFile(path.join(ws, IDENTITY_BASELINE_FILE), 'utf8');
    const parsed = parseIdentityBaseline(file);
    expect(parsed).not.toBeNull();
    expect(parsed!.description).toBe('负责用户反馈');
    for (const doc of IDENTITY_DOCS) {
      expect(parsed!.docs[doc].sha256).toBe(baseline.docs[doc].sha256);
    }
  });
});

describe('baselineDrift（D-041 P0-3）', () => {
  it('无改动 → drift=false', async () => {
    const ws = await setup();
    await ensureIdentityBaseline({ workspace: ws, description: 'd' });
    const result = await baselineDrift(ws);
    expect(result).not.toBeNull();
    expect(result!.drift).toBe(false);
  });

  it('员工改 GOALS（可进化区）→ 该文档 drift=true，ROLE 不动', async () => {
    const ws = await setup();
    await ensureIdentityBaseline({ workspace: ws, description: 'd' });
    fs.appendFileSync(path.join(ws, 'agent/GOALS.md'), '\n- 新增目标。\n');
    const result = await baselineDrift(ws);
    expect(result!.drift).toBe(true);
    expect(result!.docs['agent/GOALS.md']).toBeDefined();
    expect(result!.docs['agent/ROLE.md']).toBeUndefined();
  });

  it('基线缺失 → 返回 null', async () => {
    const ws = await setup();
    const result = await baselineDrift(ws);
    expect(result).toBeNull();
  });
});

describe('allowedIdentityDiff（D-041 P0-3）', () => {
  const baselineRole: DocBaseline = snapshotDoc(
    `# 岗位定位\n\n负责用户反馈收集、分析与闭环跟进。\n\n## 长期职责\n\n- 收集用户反馈并分类。\n- 跟进问题闭环。\n`,
  );
  const baselinePolicies: DocBaseline = snapshotDoc(
    `# 权限与上报规则\n\n## 权限边界\n\n生产写入、对外发布、Git push 和删除数据必须经人工审批。\n\n## 主动上报\n\n需要生产权限或管理决策时上报。\n`,
  );

  it('小幅增改（<30%）且在锚点内 → 可进化', () => {
    const current = `# 岗位定位\n\n负责用户反馈收集、分析与闭环跟进。\n\n## 长期职责\n\n- 收集用户反馈并分类。\n- 跟进问题闭环。\n- 新增：统计反馈处理时效。\n`;
    expect(allowedIdentityDiff('agent/ROLE.md', current, baselineRole)).toBe(true);
  });

  it('整删重写（占比≥30%）→ 疑似漂移', () => {
    const current = `# 岗位定位\n\n完全不同的岗位描述，整段重写。\n\n## 长期职责\n\n- 与岗位定位无关的新职责列表，长度完全不一样。\n- 而且这里内容非常长，远超原本的职责列表。\n- 继续填充更多内容让行数占比超过百分之三十。\n- 再多加几行以确保超过阈值。\n`;
    expect(allowedIdentityDiff('agent/ROLE.md', current, baselineRole)).toBe(false);
  });

  it('删除 POLICIES 红线词 → 疑似漂移（锚点缺失）', () => {
    const current = `# 权限与上报规则\n\n## 权限边界\n\n所有操作须谨慎。\n\n## 主动上报\n\n需要生产权限或管理决策时上报。\n`;
    expect(allowedIdentityDiff('agent/POLICIES.md', current, baselinePolicies)).toBe(false);
  });

  it('删除 ROLE 岗位定位标题 → 疑似漂移', () => {
    const current = `# 职责与协作\n\n负责用户反馈收集、分析与闭环跟进。\n\n## 长期职责\n\n- 收集用户反馈并分类。\n- 跟进问题闭环。\n`;
    expect(allowedIdentityDiff('agent/ROLE.md', current, baselineRole)).toBe(false);
  });
});
