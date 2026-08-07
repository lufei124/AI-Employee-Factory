// D-041 P2-1：knowledge 遗忘归档（raw/refined 陈旧条目的「移走而非删除」保留机制）。
//
// 四区模型的「可进化区」有界有淘汰：经验两级（lessons/raw/ 始终落盘、lessons/refined/
// 重要性提炼）会无限累积，若全部长期留存则索引膨胀、检索信噪比下降。本模块把超过
// `retentionDays`（默认 90）的 raw/refined 条目 **移到** `knowledge/.archive/<归档日期>/<层>/`
// 下（保留层与文件名，从索引与正式检索中隐退），而非删除——可经 CLI `knowledge restore`
// 按文件恢复，或 `purge` 彻底清理。语义对齐 TrashService（移走非删除、可恢复、过期清理），
// 但作用域只限知识条目本身（单个文件），不涉及整员工回收站。
//
// 归档路径按「日期 + 层（raw/refined）」两级分桶：raw 与 refined 的同名文件（`<date>-<agent>.md`）
// 不会互相覆盖，恢复时可无歧义地回到原 lessons/<层>/ 位置。
//
// 归档目录 `.archive/`（点目录）：
// - `KnowledgeIndexImpl.scan` 递归遍历时跳过点目录 → 归档条目不进 .index.json、不参与 recall；
// - 工作区 `.gitignore` 排除 `knowledge/.archive/` → 归档不进 git（避免员工 git 无限膨胀）；
//   恢复时条目移回 lessons/ 后重新入索引、重新进 evolve 提交。
//
// 接入：`settleActive` 末尾低频调用（不依赖 transcript，周期 settle 也会触发），以及
// CLI `agentctl knowledge retention` 手动触发。best-effort：归档/重建索引失败仅告警，
// 不阻断自进化链。

import fs from 'fs-extra';
import path from 'node:path';

/** raw/refined 条目保留天数：超过则归档。 */
export const RETENTION_DAYS = 90;

/** 归档根目录名（相对 knowledge/ 的点目录）。 */
export const KNOWLEDGE_ARCHIVE_DIR = '.archive';

/** 参与归档的 lessons 子目录。 */
export const RETENTION_SOURCE_DIRS = ['raw', 'refined'] as const;
export type RetentionSourceDir = (typeof RETENTION_SOURCE_DIRS)[number];

/** 归档结果（供 CLI/doctor 展示）。 */
export interface RetentionResult {
  /** 本次归档的条目（原 lessons/ 相对路径 → 归档后 knowledge/.archive 相对路径）。 */
  archived: Array<{ from: string; to: string }>;
  /** 本次无新增归档（有陈旧但全部已归档 / 无陈旧）。 */
  skipped: number;
}

/** 从条目文件名前缀解析归档日期（`<date>-<slug>.md`），失败返回 undefined（不归档该条目）。 */
export function archiveDateFromFilename(filename: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})-/.exec(filename);
  return match?.[1];
}

/**
 * 扫描并归档 lessons/raw 与 lessons/refined 中超过 retentionDays 的条目到
 * `knowledge/.archive/<归档日期>/<层>/`。移走非删除（保留层与文件名，可恢复）；索引由调用方重建。
 * best-effort：单个条目移动失败仅跳过并计数，不中断其余归档。
 */
export async function archiveStaleKnowledge(input: {
  workspace: string;
  /** 保留天数（默认 RETENTION_DAYS）。 */
  retentionDays?: number;
  /** 覆盖「当前时间」判定（测试用）。缺省真实 now。 */
  now?: Date;
}): Promise<RetentionResult> {
  const retentionDays = input.retentionDays ?? RETENTION_DAYS;
  const now = input.now ?? new Date();
  const archiveRoot = path.join(input.workspace, 'knowledge', KNOWLEDGE_ARCHIVE_DIR);
  const result: RetentionResult = { archived: [], skipped: 0 };

  for (const dir of RETENTION_SOURCE_DIRS) {
    const sourceDir = path.join(input.workspace, 'knowledge', 'lessons', dir);
    let entries: string[];
    try {
      entries = await fs.readdir(sourceDir);
    } catch {
      continue; // 目录不存在（新建员工尚无 raw/refined）→ 跳过。
    }
    for (const filename of entries) {
      if (!filename.endsWith('.md')) continue;
      const date = archiveDateFromFilename(filename);
      if (!date) continue;
      const entryDate = new Date(`${date}T00:00:00Z`);
      if (Number.isNaN(entryDate.getTime())) continue;
      const ageDays = (now.getTime() - entryDate.getTime()) / 86_400_000;
      if (ageDays < retentionDays) continue; // 未到保留期。

      const source = path.join(sourceDir, filename);
      if ((await fs.lstat(source)).isSymbolicLink()) {
        result.skipped += 1; // 拒移软链接（防逃逸）。
        continue;
      }
      // 按「日期 + 层」分桶：raw 与 refined 的同名文件不互相覆盖。
      const target = path.join(archiveRoot, date, dir, filename);
      try {
        await fs.ensureDir(path.dirname(target));
        await fs.move(source, target, { overwrite: false });
        result.archived.push({
          from: path.posix.join('lessons', dir, filename),
          to: path.posix.join(KNOWLEDGE_ARCHIVE_DIR, date, dir, filename),
        });
      } catch {
        result.skipped += 1;
      }
    }
  }
  return result;
}

/** 列出 knowledge/.archive 下的全部归档条目（按日期 + 层分桶）。 */
export async function listKnowledgeArchive(
  workspace: string,
): Promise<Array<{ date: string; tier: RetentionSourceDir; relPath: string }>> {
  const archiveRoot = path.join(workspace, 'knowledge', KNOWLEDGE_ARCHIVE_DIR);
  const out: Array<{ date: string; tier: RetentionSourceDir; relPath: string }> = [];
  let dates: string[];
  try {
    dates = await fs.readdir(archiveRoot);
  } catch {
    return out; // 无归档。
  }
  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const dateDir = path.join(archiveRoot, date);
    const dateStat = await fs.lstat(dateDir).catch(() => undefined);
    if (!dateStat?.isDirectory()) continue;
    for (const tier of RETENTION_SOURCE_DIRS) {
      const tierDir = path.join(dateDir, tier);
      const tierStat = await fs.lstat(tierDir).catch(() => undefined);
      if (!tierStat?.isDirectory()) continue;
      for (const filename of await fs.readdir(tierDir)) {
        if (!filename.endsWith('.md')) continue;
        out.push({
          date,
          tier,
          relPath: path.posix.join(KNOWLEDGE_ARCHIVE_DIR, date, tier, filename),
        });
      }
    }
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** 校验归档条目相对路径（相对 knowledge/ 根，形如 `.archive/<日期>/<层>/<文件>`）落在
 *  .archive 树内，返回规范绝对路径。 */
function assertArchiveEntry(workspace: string, relPath: string): string {
  const knowledgeRoot = path.resolve(path.join(workspace, 'knowledge'));
  const archiveRoot = path.resolve(path.join(knowledgeRoot, KNOWLEDGE_ARCHIVE_DIR));
  const normalized = relPath.split('/').join(path.sep);
  const file = path.resolve(path.join(knowledgeRoot, normalized));
  const relative = path.relative(archiveRoot, file);
  if (
    relative === '' ||
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`归档条目路径不合法（必须位于 knowledge/.archive/ 内）：${relPath}`);
  }
  return file;
}

/**
 * 恢复一条归档条目回 lessons/ 原位（移走即回正式知识，重新入索引）。目标文件已存在时
 * 拒绝恢复（不覆盖，语义对齐回收站恢复）。归档路径形如 `.archive/<日期>/<层>/<文件>`，
 * 恢复即回 `lessons/<层>/<文件>`；`targetRel` 可选指定恢复目标（缺省回原始 lessons/ 位置）。
 */
export async function restoreKnowledge(
  workspace: string,
  archiveRelPath: string,
  targetRel?: string,
): Promise<{ restored: string }> {
  const file = assertArchiveEntry(workspace, archiveRelPath);
  if (!(await fs.pathExists(file))) throw new Error(`归档条目不存在：${archiveRelPath}`);
  if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('归档条目不能是软链接。');
  // 归档路径形如 `.archive/<日期>/<层>/<文件>`（层为 raw/refined，可选兼容旧单层）。
  const match = /^\.archive\/\d{4}-\d{2}-\d{2}\/(raw|refined)\/(.+)$/.exec(archiveRelPath);
  const restoredRel = targetRel ?? (match ? `lessons/${match[1]}/${match[2]}` : archiveRelPath);
  const restoredAbs = path.join(workspace, 'knowledge', restoredRel.split('/').join(path.sep));
  const knowledgeRoot = path.resolve(path.join(workspace, 'knowledge'));
  const restoredResolved = path.resolve(restoredAbs);
  const relative = path.relative(knowledgeRoot, restoredResolved);
  if (
    relative === '' ||
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`恢复目标必须位于 knowledge/ 内：${restoredRel}`);
  }
  if (await fs.pathExists(restoredAbs)) throw new Error(`恢复目标已存在：${restoredRel}`);
  await fs.ensureDir(path.dirname(restoredAbs));
  await fs.move(file, restoredAbs, { overwrite: false });
  return { restored: restoredRel };
}

/** 彻底删除一条归档条目（不可恢复）。语义对齐回收站 purgeOne。 */
export async function purgeKnowledgeArchive(
  workspace: string,
  archiveRelPath: string,
): Promise<void> {
  const file = assertArchiveEntry(workspace, archiveRelPath);
  if (!(await fs.pathExists(file))) throw new Error(`归档条目不存在：${archiveRelPath}`);
  await fs.remove(file);
}
