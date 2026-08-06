import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROPOSAL_LEDGER_FILE,
  PROPOSAL_LEDGER_MAX_LINES,
  appliedWithoutAnchor,
  hasApprovedAnchor,
  maybeEnforceIdentityProtocol,
  parseProposalFrontmatter,
  proposalLedgerPath,
  readLedger,
  recordDecision,
  recordProposal,
  truncateLedger,
} from '../src/core/proposal-ledger.js';
import { ensureIdentityBaseline } from '../src/core/identity-baseline.js';

// D-041 P1-3：身份修订对账账本。验证提案登记/决策登记/对账/协议执行/截断/上限。

const tempDirs: string[] = [];

/** 播种一个含五份身份文档 + 基线的员工工作区。 */
function seedWorkspace(workspace: string, description = '负责用户运营'): void {
  fs.mkdirpSync(path.join(workspace, 'agent'));
  fs.writeFileSync(
    path.join(workspace, 'agent/ROLE.md'),
    `# 岗位定位\n\n${description}。\n\n## 长期职责\n\n- 收集用户反馈并分类。\n- 跟进问题闭环。\n`,
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
  fs.writeFileSync(
    path.join(workspace, 'agent/CONSTITUTION.md'),
    `# 使命\n\n帮助用户提升产品体验。\n\n# 变更流程\n\n1. 写提案 → 用户批准 → 再改。\n`,
  );
}

async function setup(description?: string): Promise<{ workspace: string; logsRoot: string }> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-ws-'));
  const logsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-logs-'));
  tempDirs.push(workspace, logsRoot);
  seedWorkspace(workspace, description);
  await ensureIdentityBaseline({ workspace, description: description ?? '负责用户运营' });
  return { workspace, logsRoot };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('parseProposalFrontmatter（D-041 P1-3）', () => {
  it('解析 YAML 头为提案字段', () => {
    const content = `---
proposal_id: p-001
kind: identity
status: applied
target_file: agent/ROLE.md
proposed_at: 2026-08-06T00:00:00.000Z
user_anchor: 用户说“同意改成这样”
---

正文…`;
    expect(parseProposalFrontmatter(content)).toEqual({
      proposal_id: 'p-001',
      kind: 'identity',
      status: 'applied',
      target_file: 'agent/ROLE.md',
      proposed_at: '2026-08-06T00:00:00.000Z',
      user_anchor: '用户说“同意改成这样”',
    });
  });

  it('缺 frontmatter 或无 YAML 头 → 返回空对象（宽容不抛错）', () => {
    expect(parseProposalFrontmatter('# 无头的提案')).toEqual({});
    expect(parseProposalFrontmatter('')).toEqual({});
  });
});

describe('recordProposal / recordDecision / readLedger / truncateLedger（D-041 P1-3）', () => {
  it('登记提案与决策，账本可回读且决策带 user_anchor', async () => {
    const { logsRoot } = await setup();
    await recordProposal(logsRoot, 'ops', {
      proposal_id: 'p-001',
      kind: 'identity',
      target_file: 'agent/ROLE.md',
      status: 'proposed',
    });
    await recordDecision(logsRoot, 'ops', {
      proposal_id: 'p-001',
      decision: 'approved',
      target_file: 'agent/ROLE.md',
      user_anchor: '用户说“同意”',
    });
    const ledger = await readLedger(logsRoot, 'ops');
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({
      event: 'proposal',
      proposal_id: 'p-001',
      kind: 'identity',
      target_file: 'agent/ROLE.md',
      status: 'proposed',
    });
    expect(ledger[1]).toMatchObject({
      event: 'decision',
      decision: 'approved',
      user_anchor: '用户说“同意”',
    });
  });

  it('账本文件权限为 0600', async () => {
    const { logsRoot } = await setup();
    await recordProposal(logsRoot, 'ops', { proposal_id: 'p-1' });
    const stat = await fs.stat(proposalLedgerPath(logsRoot, 'ops'));
    expect((stat.mode & 0o777).toString(8)).toBe('600');
  });

  it('truncateLedger 只保留最近 maxLines 行', async () => {
    const { logsRoot } = await setup();
    for (let i = 0; i < 10; i += 1)
      await recordProposal(logsRoot, 'ops', { proposal_id: `p-${i}` });
    await truncateLedger(logsRoot, 'ops', 3);
    const ledger = await readLedger(logsRoot, 'ops');
    expect(ledger).toHaveLength(3);
    expect(ledger[0]).toMatchObject({ proposal_id: 'p-7' });
    expect(ledger[2]).toMatchObject({ proposal_id: 'p-9' });
  });

  it('账本不存在时 readLedger 返回 []（对账按无依据从严）', async () => {
    const { logsRoot } = await setup();
    expect(await readLedger(logsRoot, 'nobody')).toEqual([]);
  });
});

describe('hasApprovedAnchor（D-041 P1-3）', () => {
  it('有带 user_anchor 的 applied/approved 决策 → true', () => {
    const ledger = [
      { ts: '', event: 'decision', proposal_id: 'p-1', decision: 'approved', user_anchor: '同意' },
    ];
    expect(hasApprovedAnchor(ledger)).toBe(true);
    expect(hasApprovedAnchor(ledger, 'agent/ROLE.md')).toBe(false); // 无 target_file 不匹配指定文件
  });

  it('user_anchor 为空或拒绝决策 → false', () => {
    expect(
      hasApprovedAnchor([{ ts: '', event: 'decision', proposal_id: 'p-1', decision: 'approved' }]),
    ).toBe(false);
    expect(
      hasApprovedAnchor([
        {
          ts: '',
          event: 'decision',
          proposal_id: 'p-1',
          decision: 'rejected',
          user_anchor: '不同意',
        },
      ]),
    ).toBe(false);
  });
});

describe('appliedWithoutAnchor（D-041 P1-3）', () => {
  it('无身份改动 → 无违规', async () => {
    const { workspace, logsRoot } = await setup();
    const ledger = await readLedger(logsRoot, 'ops');
    expect(await appliedWithoutAnchor(workspace, ledger)).toEqual([]);
  });

  it('小幅改动（可进化区判定通过）→ 不算违规', async () => {
    const { workspace, logsRoot } = await setup();
    fs.appendFileSync(path.join(workspace, 'agent/ROLE.md'), '\n- 新增：统计反馈处理时效。\n');
    const ledger = await readLedger(logsRoot, 'ops');
    expect(await appliedWithoutAnchor(workspace, ledger)).toEqual([]);
  });

  it('整删重写 POLICIES 红线词且无批准依据 → 违规', async () => {
    const { workspace, logsRoot } = await setup();
    fs.writeFileSync(
      path.join(workspace, 'agent/POLICIES.md'),
      `# 权限与上报规则\n\n## 权限边界\n\n所有操作须谨慎。\n\n## 主动上报\n\n需要生产权限或管理决策时上报。\n`,
    );
    const ledger = await readLedger(logsRoot, 'ops');
    const violations = await appliedWithoutAnchor(workspace, ledger);
    expect(violations).toHaveLength(1);
    expect(violations[0].relPath).toBe('agent/POLICIES.md');
    expect(violations[0].reason).toContain('user_anchor');
  });

  it('删除 CONSTITUTION 锚点标题 → 违规', async () => {
    const { workspace, logsRoot } = await setup();
    fs.writeFileSync(
      path.join(workspace, 'agent/CONSTITUTION.md'),
      '# 毫无关系的全新文件\n\n内容。\n',
    );
    const ledger = await readLedger(logsRoot, 'ops');
    const violations = await appliedWithoutAnchor(workspace, ledger);
    expect(violations).toHaveLength(1);
    expect(violations[0].relPath).toBe('agent/CONSTITUTION.md');
  });

  it('带 user_anchor 的 applied 决策 → 显著改动放行（不违规）', async () => {
    const { workspace, logsRoot } = await setup();
    await recordDecision(logsRoot, 'ops', {
      proposal_id: 'p-1',
      decision: 'approved',
      target_file: 'agent/ROLE.md',
      user_anchor: '用户说“岗位改成内容运营，就这么干”',
    });
    fs.writeFileSync(
      path.join(workspace, 'agent/ROLE.md'),
      `# 岗位定位\n\n负责内容运营。\n\n## 长期职责\n\n- 选题策划。\n- 内容撰写。\n- 数据分析。\n- 跨部门协同。\n- 独立跟进完整项目。\n- 输出周报。\n`,
    );
    const ledger = await readLedger(logsRoot, 'ops');
    expect(await appliedWithoutAnchor(workspace, ledger)).toEqual([]);
  });

  it('基线缺失 → 返回空（无基线无从对账，交给 doctor）', async () => {
    const { logsRoot } = await setup();
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-bare-'));
    tempDirs.push(bare);
    seedWorkspace(bare); // 不写基线
    expect(await appliedWithoutAnchor(bare, await readLedger(logsRoot, 'ops'))).toEqual([]);
  });
});

describe('maybeEnforceIdentityProtocol（D-041 P1-3）', () => {
  it('advisory（默认）：直接短路，不计算违规也不阻断（对账交 doctor/appliedWithoutAnchor）', async () => {
    const { workspace, logsRoot } = await setup();
    fs.writeFileSync(path.join(workspace, 'agent/CONSTITUTION.md'), '# 无关内容\n\n删除宪法。\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await maybeEnforceIdentityProtocol({
      workspace,
      agentId: 'ops',
      logsRoot,
      protocol: 'advisory',
    });
    expect(result.blocked).toBe(false);
    expect(result.unauthorized).toEqual([]); // advisory 不计算违规清单
    expect(warn).not.toHaveBeenCalled(); // advisory 不打印 enforced 告警
    warn.mockRestore();
  });

  it('enforced：违规 → blocked=true + 记录 CURRENT_STATE', async () => {
    const { workspace, logsRoot } = await setup();
    fs.writeFileSync(
      path.join(workspace, 'agent/POLICIES.md'),
      `# 权限与上报规则\n\n## 权限边界\n\n所有操作须谨慎。\n\n## 主动上报\n\n需要生产权限或管理决策时上报。\n`,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const recorded: string[] = [];
    const result = await maybeEnforceIdentityProtocol({
      workspace,
      agentId: 'ops',
      logsRoot,
      protocol: 'enforced',
      recordState: async (message) => {
        recorded.push(message);
      },
    });
    expect(result.blocked).toBe(true);
    expect(result.unauthorized).toHaveLength(1);
    expect(recorded).toEqual([expect.stringContaining('未授权身份改动已拒绝提交')]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('已拒绝提交'));
    warn.mockRestore();
  });

  it('enforced + 无违规 → blocked=false', async () => {
    const { workspace, logsRoot } = await setup();
    const result = await maybeEnforceIdentityProtocol({
      workspace,
      agentId: 'ops',
      logsRoot,
      protocol: 'enforced',
    });
    expect(result.blocked).toBe(false);
    expect(result.unauthorized).toEqual([]);
  });

  it('advisory 不写 CURRENT_STATE（recordState 不被调用）', async () => {
    const { workspace, logsRoot } = await setup();
    fs.writeFileSync(
      path.join(workspace, 'agent/ROLE.md'),
      `# 岗位定位\n\n整段重写岗位内容。\n\n## 长期职责\n\n- 与原来完全不同的职责。\n- 长度差异明显。\n- 继续填充让占比超过百分之三十。\n- 再加几行确保阈值。\n`,
    );
    const recorded: string[] = [];
    await maybeEnforceIdentityProtocol({
      workspace,
      agentId: 'ops',
      logsRoot,
      protocol: 'advisory',
      recordState: async (message) => {
        recorded.push(message);
      },
    });
    expect(recorded).toEqual([]);
  });
});

describe('账本上限常量（P2-3 预留）', () => {
  it('PROPOSAL_LEDGER_MAX_LINES 为 5000', () => {
    expect(PROPOSAL_LEDGER_MAX_LINES).toBe(5000);
    expect(PROPOSAL_LEDGER_FILE).toBe('proposals');
  });
});
