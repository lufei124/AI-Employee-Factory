import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_ARCHIVE_DIR,
  RETENTION_DAYS,
  RETENTION_SOURCE_DIRS,
  archiveDateFromFilename,
  archiveStaleKnowledge,
  listKnowledgeArchive,
  purgeKnowledgeArchive,
  restoreKnowledge,
} from '../src/core/knowledge-retention.js';

// D-041 P2-1：knowledge 遗忘归档。验证「超保留期 raw/refined 条目移入 .archive/（移走非删除）、
// 可恢复、可彻底清理」；软链接/越界路径拒绝；保留期内不动。

const tempDirs: string[] = [];
afterEach(async () => Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir))));

/** 播种含 lessons/raw 与 lessons/refined 的员工知识目录。 */
async function seedKnowledge(workspace: string): Promise<void> {
  await fs.ensureDir(path.join(workspace, 'knowledge', 'lessons', 'raw'));
  await fs.ensureDir(path.join(workspace, 'knowledge', 'lessons', 'refined'));
  // 陈旧：3 个月前。
  const stale = new Date(Date.now() - 3 * 30 * 24 * 3600_000).toISOString().slice(0, 10);
  // 新鲜：1 天前。
  const fresh = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);
  await fs.writeFile(
    path.join(workspace, 'knowledge', 'lessons', 'raw', `${stale}-ops.md`),
    '旧原始\n',
  );
  await fs.writeFile(
    path.join(workspace, 'knowledge', 'lessons', 'refined', `${stale}-ops.md`),
    '# 旧提炼\n',
  );
  await fs.writeFile(
    path.join(workspace, 'knowledge', 'lessons', 'raw', `${fresh}-ops.md`),
    '新原始\n',
  );
  return undefined;
}

describe('archiveDateFromFilename（D-041 P2-1）', () => {
  it('解析 `<date>-<slug>.md` 前缀日期', () => {
    expect(archiveDateFromFilename('2026-05-01-ops.md')).toBe('2026-05-01');
  });
  it('非日期前缀 → undefined（不归档）', () => {
    expect(archiveDateFromFilename('notes.md')).toBeUndefined();
    expect(archiveDateFromFilename('2026-5-1-ops.md')).toBeUndefined();
  });
});

describe('archiveStaleKnowledge（D-041 P2-1）', () => {
  it('陈旧条目移入 .archive/<date>/<层>/，保留期内不动，返回 moved 清单', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-ws-'));
    tempDirs.push(workspace);
    await seedKnowledge(workspace);
    const staleDate = new Date(Date.now() - 3 * 30 * 24 * 3600_000).toISOString().slice(0, 10);
    const result = await archiveStaleKnowledge({ workspace });
    expect(result.archived).toHaveLength(2);
    expect(result.archived[0]).toMatchObject({
      from: `lessons/raw/${staleDate}-ops.md`,
      to: `.archive/${staleDate}/raw/${staleDate}-ops.md`,
    });
    // 陈旧条目已从 lessons/ 移走。
    expect(
      await fs.pathExists(
        path.join(workspace, 'knowledge', 'lessons', 'raw', `${staleDate}-ops.md`),
      ),
    ).toBe(false);
    // 新鲜条目仍在原处。
    const fresh = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);
    expect(
      await fs.pathExists(path.join(workspace, 'knowledge', 'lessons', 'raw', `${fresh}-ops.md`)),
    ).toBe(true);
  });

  it('无 lessons/raw|refined 目录（新建员工）→ 空结果不报错', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-empty-'));
    tempDirs.push(workspace);
    const result = await archiveStaleKnowledge({ workspace });
    expect(result.archived).toEqual([]);
    expect(result.skipped).toBe(0);
  });

  it('未到保留期（--days 覆盖）不归档；now 覆盖时间判定', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-days-'));
    tempDirs.push(workspace);
    await seedKnowledge(workspace);
    // 30 天前的条目：60 天保留期内 → 不归档。
    const monthAgo = new Date(Date.now() - 30 * 24 * 3600_000).toISOString().slice(0, 10);
    await fs.writeFile(
      path.join(workspace, 'knowledge', 'lessons', 'raw', `${monthAgo}-ops.md`),
      '一个月前的\n',
    );
    const result = await archiveStaleKnowledge({ workspace, retentionDays: 60 });
    // 仅 3 个月前的两条归档；30 天前的留在原处。
    expect(result.archived).toHaveLength(2);
  });

  it('拒绝移动软链接条目（不归档，记 skipped）', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-link-'));
    tempDirs.push(workspace);
    await fs.ensureDir(path.join(workspace, 'knowledge', 'lessons', 'raw'));
    const stale = new Date(Date.now() - 3 * 30 * 24 * 3600_000).toISOString().slice(0, 10);
    await fs.writeFile(path.join(workspace, 'knowledge', 'lessons', 'raw', `${stale}-ops.md`), 'x');
    const outside = path.join(os.tmpdir(), `retention-outside-${Date.now()}`);
    await fs.writeFile(outside, 'outside');
    tempDirs.push(outside);
    await fs.symlink(
      outside,
      path.join(workspace, 'knowledge', 'lessons', 'raw', `${stale}-link.md`),
    );
    const result = await archiveStaleKnowledge({ workspace });
    expect(result.archived).toHaveLength(1); // 真实文件归档，软链接跳过。
    expect(result.skipped).toBe(1);
  });
});

describe('listKnowledgeArchive / restoreKnowledge / purgeKnowledgeArchive（D-041 P2-1）', () => {
  async function setupArchived(): Promise<string> {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-mgmt-'));
    tempDirs.push(workspace);
    await seedKnowledge(workspace);
    await archiveStaleKnowledge({ workspace });
    return workspace;
  }

  it('list 列出 .archive 下全部归档条目（按日期 + 层）', async () => {
    const workspace = await setupArchived();
    const staleDate = new Date(Date.now() - 3 * 30 * 24 * 3600_000).toISOString().slice(0, 10);
    const entries = await listKnowledgeArchive(workspace);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      date: staleDate,
      tier: 'raw',
      relPath: `.archive/${staleDate}/raw/${staleDate}-ops.md`,
    });
    expect(entries[1]).toMatchObject({
      date: staleDate,
      tier: 'refined',
      relPath: `.archive/${staleDate}/refined/${staleDate}-ops.md`,
    });
  });

  it('restore 把归档条目移回 lessons/ 原位，返回恢复目标', async () => {
    const workspace = await setupArchived();
    const staleDate = new Date(Date.now() - 3 * 30 * 24 * 3600_000).toISOString().slice(0, 10);
    const result = await restoreKnowledge(
      workspace,
      `.archive/${staleDate}/refined/${staleDate}-ops.md`,
    );
    expect(result.restored).toBe(`lessons/refined/${staleDate}-ops.md`);
    expect(
      await fs.pathExists(
        path.join(workspace, 'knowledge', 'lessons', 'refined', `${staleDate}-ops.md`),
      ),
    ).toBe(true);
    expect(
      await fs.pathExists(
        path.join(
          workspace,
          'knowledge',
          KNOWLEDGE_ARCHIVE_DIR,
          staleDate,
          'refined',
          `${staleDate}-ops.md`,
        ),
      ),
    ).toBe(false);
  });

  it('restore 目标已存在 → 拒绝（不覆盖）', async () => {
    const workspace = await setupArchived();
    const staleDate = new Date(Date.now() - 3 * 30 * 24 * 3600_000).toISOString().slice(0, 10);
    await fs.writeFile(
      path.join(workspace, 'knowledge', 'lessons', 'raw', `${staleDate}-ops.md`),
      '已有内容\n',
    );
    await expect(
      restoreKnowledge(workspace, `.archive/${staleDate}/raw/${staleDate}-ops.md`),
    ).rejects.toThrow('恢复目标已存在');
  });

  it('purge 彻底删除归档条目', async () => {
    const workspace = await setupArchived();
    const staleDate = new Date(Date.now() - 3 * 30 * 24 * 3600_000).toISOString().slice(0, 10);
    await purgeKnowledgeArchive(workspace, `.archive/${staleDate}/raw/${staleDate}-ops.md`);
    const entries = await listKnowledgeArchive(workspace);
    expect(entries).toHaveLength(1); // 只剩 refined 那条。
  });

  it('越界路径（.. 逃逸 .archive）→ 拒绝', async () => {
    const workspace = await setupArchived();
    await expect(restoreKnowledge(workspace, '../agent.yaml')).rejects.toThrow(
      '归档条目路径不合法',
    );
    await expect(purgeKnowledgeArchive(workspace, '../../agent.yaml')).rejects.toThrow(
      '归档条目路径不合法',
    );
  });
});

describe('常量与目录约定（D-041 P2-1）', () => {
  it('RETENTION_DAYS 默认 90；源目录为 raw/refined；归档目录为 .archive', () => {
    expect(RETENTION_DAYS).toBe(90);
    expect(RETENTION_SOURCE_DIRS).toEqual(['raw', 'refined']);
    expect(KNOWLEDGE_ARCHIVE_DIR).toBe('.archive');
  });
});
