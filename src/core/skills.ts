import fs from 'fs-extra';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { AgentCtlError } from './errors.js';
import { agentIdSchema, type RuntimeProvider } from '../schemas/agent-schema.js';

export type SkillScope = 'project' | 'user';

/** D-034：版本化替换时 .archive 保留的最近版本数，超限按时间清理。 */
const ARCHIVE_KEEP = 5;

/** 归档引用用的文件系统安全时间戳。 */
function archiveStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export interface SkillMetadata {
  name: string;
  version: string;
  source: string;
  installed_at: string;
  digest: string;
  scope: SkillScope;
}

/** 从 SKILL.md frontmatter 解析 name/version（D-034 抽出，供 install/upsert/adopt/fallback 复用）。
 *  name 经 agentIdSchema 校验（英文小写 kebab-case），非法抛 VALIDATION_ERROR；
 *  version 缺省 '0.0.0-local'。 */
export function parseSkillFrontmatter(text: string): { name: string; version: string } {
  const rawName = /^---[\s\S]*?^name:\s*([^\s]+)[\s\S]*?^---/m.exec(text)?.[1];
  const name = agentIdSchema.safeParse(rawName);
  if (!name.success) {
    throw new AgentCtlError(
      'VALIDATION_ERROR',
      'Skill frontmatter 缺少合法 name（英文小写 kebab-case，如 customer-feedback）。',
    );
  }
  const version = /^version:\s*([^\s]+)/m.exec(text)?.[1] ?? '0.0.0-local';
  return { name: name.data, version };
}

export async function digestSkillDirectory(root: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (directory: string): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.name === '.agentctl.yaml') continue;
      const file = path.join(directory, entry.name);
      hash.update(path.relative(root, file));
      if (entry.isDirectory()) await visit(file);
      else hash.update(await fs.readFile(file));
    }
  };
  await visit(root);
  return hash.digest('hex');
}

/**
 * Skill 作用域（D-003 演进，见 docs/DECISIONS.md）：
 * - project（项目级）：存于 `workspace/skills/<name>/`，投影到项目发现目录
 *   `workspace/.claude/skills/<name>`（Claude）/ `workspace/.codex/skills/<name>`（Codex）。
 *   随项目 git、进入默认备份。
 * - user（用户级）：原位存于 `runtimeHome/skills/<name>/`（= CLAUDE_CONFIG_DIR/CODEX_HOME 的 skills，
 *   即运行器原生用户级发现目录）。属于员工运行时身份，默认不进备份（仅 includeRuntime 时打包）。
 */
/**
 * 项目级技能投影助手（TASK-048 抽取，D-034 幂等语义的单一实现）：
 * 把 `workspace/skills/<name>` 的每个目录软链到目标 provider 的项目发现目录
 * `workspace/.claude/skills/<name>` / `workspace/.codex/skills/<name>`。
 * 目标相对 `../../skills/<name>`（与 SkillService.project/ensureFactorySkill 一致）。
 * 调用方负责先移除旧 provider 的投影目录（迁移切换时），本函数只做增量投影。
 */
export async function projectSkillsToProvider(
  workspace: string,
  provider: RuntimeProvider,
): Promise<void> {
  const projectionRoot = path.join(
    workspace,
    provider === 'claude' ? '.claude' : '.codex',
    'skills',
  );
  const storeRoot = path.join(workspace, 'skills');
  if (!(await fs.pathExists(storeRoot))) return;
  const entries = await fs.readdir(storeRoot, { withFileTypes: true });
  if (entries.length === 0) return;
  await fs.ensureDir(projectionRoot);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    // 幂等：软链已存在且指向正确则跳过，否则移除后重建（防重复/悬空软链）。
    const link = path.join(projectionRoot, entry.name);
    const target = path.join('../../skills', entry.name);
    try {
      const stat = await fs.lstat(link);
      if (stat.isSymbolicLink() && (await fs.readlink(link)) === target) continue;
      await fs.remove(link);
    } catch {
      // link 不存在（ENOENT）：直接创建。
    }
    await fs.symlink(target, link);
  }
}

export class SkillService {
  constructor(
    readonly workspace: string,
    readonly provider: RuntimeProvider,
    private readonly runtimeHome?: string,
  ) {}

  async list(): Promise<SkillMetadata[]> {
    const project = await this.listRoot(this.projectRoot(), 'project');
    const user = this.runtimeHome ? await this.listRoot(this.userRoot(), 'user') : [];
    return [...project, ...user].sort((left, right) => left.name.localeCompare(right.name));
  }

  async install(source: string, scope: SkillScope = 'project'): Promise<SkillMetadata> {
    const resolved = path.resolve(source);
    // R6：Skill 源根不得是软链接（rejectSymlinks 仅扫树内，不防源根本身为软链接逃逸）。
    if ((await fs.pathExists(resolved)) && (await fs.lstat(resolved)).isSymbolicLink()) {
      throw new AgentCtlError('VALIDATION_ERROR', 'Skill 源不能是软链接。', {
        remediation: '请提供 Skill 目录的真实路径，而非软链接。',
      });
    }
    const skillFile = path.join(resolved, 'SKILL.md');
    if (!(await fs.pathExists(skillFile)))
      throw new AgentCtlError('VALIDATION_ERROR', 'Skill 目录必须包含 SKILL.md。');
    await this.rejectSymlinks(resolved);
    const skillText = await fs.readFile(skillFile, 'utf8');
    const { name, version } = parseSkillFrontmatter(skillText);
    const root = this.storeRoot(scope);
    const target = path.join(root, name);
    if (await fs.pathExists(target)) throw new AgentCtlError('CONFLICT', `Skill 已安装：${name}`);
    const stage = path.join(root, `.staging-${name}-${randomUUID()}`);
    await fs.ensureDir(path.dirname(stage));
    try {
      await fs.copy(resolved, stage, { dereference: false, errorOnExist: true });
      const metadata: SkillMetadata = {
        name,
        version,
        source: resolved,
        installed_at: new Date().toISOString(),
        digest: await digestSkillDirectory(stage),
        scope,
      };
      await fs.writeFile(path.join(stage, '.agentctl.yaml'), YAML.stringify(metadata));
      await fs.rename(stage, target);
      if (scope === 'project') await this.project(name);
      return metadata;
    } catch (error) {
      await fs.remove(stage);
      throw error;
    }
  }

  async remove(name: string, scope: SkillScope = 'project'): Promise<void> {
    agentIdSchema.parse(name);
    const root = this.storeRoot(scope);
    const target = path.join(root, name);
    if (!(await fs.pathExists(target)))
      throw new AgentCtlError('NOT_FOUND', `Skill 不存在：${name}`);
    if (scope === 'project') await fs.remove(this.projectionPath(name));
    // 卸载为不可恢复操作：直接删除技能目录（含用户级原位目录 / 项目级 store 根），不再移入 .archive。
    await fs.remove(target);
  }

  /** D-034：同名更新/版本化（不抛 CONFLICT）。target 不存在时等同 install；
   *  digest 相同则幂等 no-op；不同则备份旧版到 .archive 后复制式替换并重投影。 */
  async upsert(source: string, scope: SkillScope = 'project'): Promise<SkillMetadata> {
    const resolved = path.resolve(source);
    // R6：Skill 源根不得是软链接。
    if ((await fs.pathExists(resolved)) && (await fs.lstat(resolved)).isSymbolicLink()) {
      throw new AgentCtlError('VALIDATION_ERROR', 'Skill 源不能是软链接。', {
        remediation: '请提供 Skill 目录的真实路径，而非软链接。',
      });
    }
    const skillFile = path.join(resolved, 'SKILL.md');
    if (!(await fs.pathExists(skillFile)))
      throw new AgentCtlError('VALIDATION_ERROR', 'Skill 目录必须包含 SKILL.md。');
    await this.rejectSymlinks(resolved);
    const skillText = await fs.readFile(skillFile, 'utf8');
    const { name } = parseSkillFrontmatter(skillText);
    const root = this.storeRoot(scope);
    const target = path.join(root, name);
    // 不存在 → 完全等同 install（复制 + 元数据 + 投影）。
    if (!(await fs.pathExists(target))) return this.install(resolved, scope);

    // 已存在：digest 相同 → 幂等 no-op（避免无谓 git 噪音）。
    const newDigest = await digestSkillDirectory(resolved);
    const existing = await this.readStoreMetadata(target, name, scope);
    if (existing.digest === newDigest) return existing;

    // 源即目标（原位自维护技能：autoAdoptSelfSkills 把 store 内路径同时当 source 与 target）：
    // 只原位刷新 .agentctl.yaml 元数据 + 重投影，不做「先删再拷贝」的自我替换——否则
    // source 被 remove 后 fs.copy 必然 ENOENT（skill-self adopt 报错根因，D-034 修复）。
    if (resolved === target) {
      const metadata: SkillMetadata = {
        name,
        version: this.nextVersion(existing.version, parseSkillFrontmatter(skillText).version),
        source: existing.source ?? 'self',
        installed_at: existing.installed_at,
        digest: newDigest,
        scope,
      };
      await fs.writeFile(path.join(target, '.agentctl.yaml'), YAML.stringify(metadata));
      if (scope === 'project') await this.project(name);
      return metadata;
    }

    // 版本化替换：备份旧版 → 清理 target → stage 复制 → rename 覆盖 → 重投影。
    const stage = path.join(root, `.staging-${name}-${randomUUID()}`);
    const archived = await this.backupToArchive(target, name, existing.version);
    await fs.ensureDir(path.dirname(stage));
    try {
      await fs.remove(target);
      await fs.copy(resolved, stage, { dereference: false, errorOnExist: true });
      const version = this.nextVersion(existing.version, parseSkillFrontmatter(skillText).version);
      const metadata: SkillMetadata = {
        name,
        version,
        source: 'self',
        installed_at: new Date().toISOString(),
        digest: newDigest,
        scope,
      };
      await fs.writeFile(path.join(stage, '.agentctl.yaml'), YAML.stringify(metadata));
      await fs.rename(stage, target);
      if (scope === 'project') await this.project(name);
      return metadata;
    } catch (error) {
      await fs.remove(stage);
      await fs.remove(target).catch(() => undefined);
      await this.restoreFromArchive(target, name, path.basename(archived));
      if (scope === 'project') await this.project(name);
      throw error;
    }
  }

  /** D-034：原位修复——给已写盘的 manual skill 补写 .agentctl.yaml + 投影软链（零 LLM）。
   *  缺 SKILL.md 抛 NOT_FOUND；frontmatter 非法或目录名与 frontmatter name 不一致抛 VALIDATION_ERROR，
   *  均不改动 store。 */
  async adopt(name: string, scope: SkillScope = 'project'): Promise<SkillMetadata> {
    agentIdSchema.parse(name);
    const root = this.storeRoot(scope);
    const target = path.join(root, name);
    const skillFile = path.join(target, 'SKILL.md');
    if (!(await fs.pathExists(skillFile))) {
      throw new AgentCtlError('NOT_FOUND', `Skill 不存在：${name}`, {
        remediation: '请确认该目录包含 SKILL.md。',
      });
    }
    const skillText = await fs.readFile(skillFile, 'utf8');
    const parsed = parseSkillFrontmatter(skillText); // 非法抛 VALIDATION_ERROR，不改 store。
    if (parsed.name !== name) {
      throw new AgentCtlError(
        'VALIDATION_ERROR',
        `Skill 目录名（${name}）与 frontmatter name（${parsed.name}）不一致。`,
      );
    }
    const metadata: SkillMetadata = {
      name: parsed.name,
      version: parsed.version,
      source: 'self',
      installed_at: new Date().toISOString(),
      digest: await digestSkillDirectory(target),
      scope,
    };
    await fs.writeFile(path.join(target, '.agentctl.yaml'), YAML.stringify(metadata));
    if (scope === 'project') await this.project(name);
    return metadata;
  }

  /** D-034：从 .archive 恢复某历史版本。archiveRef 匹配归档目录名子串；缺省取最新。 */
  async rollback(
    name: string,
    scope: SkillScope = 'project',
    archiveRef?: string,
  ): Promise<SkillMetadata> {
    agentIdSchema.parse(name);
    const storeRoot = this.storeRoot(scope);
    const archiveRoot = path.join(storeRoot, '.archive');
    const candidates = ((await fs.pathExists(archiveRoot)) ? await fs.readdir(archiveRoot) : [])
      .filter((entry) => entry.startsWith(`${name}-`))
      .sort();
    const pick = archiveRef
      ? candidates.find((entry) => entry.includes(archiveRef))
      : candidates.at(-1);
    if (!pick) throw new AgentCtlError('NOT_FOUND', `未找到 ${name} 的归档版本。`);
    const target = path.join(storeRoot, name);
    // 当前版本若存在，先并入归档（防覆盖丢失）。
    if (await fs.pathExists(target)) {
      const current = await this.readStoreMetadata(target, name, scope);
      await this.backupToArchive(target, name, current.version);
    }
    await fs.remove(target).catch(() => undefined);
    await fs.move(path.join(archiveRoot, pick), target);
    if (scope === 'project') await this.project(name);
    return this.readStoreMetadata(target, name, scope);
  }

  /** 读取 store 根某 skill 的元数据；无 .agentctl.yaml（手动）时现场合成（不写盘）。 */
  private async readStoreMetadata(
    target: string,
    name: string,
    scope: SkillScope,
  ): Promise<SkillMetadata> {
    const file = path.join(target, '.agentctl.yaml');
    if (await fs.pathExists(file)) {
      const meta = YAML.parse(await fs.readFile(file, 'utf8')) as SkillMetadata;
      return {
        ...meta,
        name,
        scope,
        digest: meta.digest || (await digestSkillDirectory(target)),
      };
    }
    const stat = await fs.stat(path.join(target, 'SKILL.md'));
    return {
      name,
      version: '0.0.0-local',
      source: 'manual',
      installed_at: stat.mtime.toISOString(),
      digest: await digestSkillDirectory(target),
      scope,
    };
  }

  /** 把 target 目录复制进 .archive/<name>-<version>-<ts>/，并清理超限版本。返回归档目录完整路径。 */
  private async backupToArchive(target: string, name: string, version: string): Promise<string> {
    const archiveRoot = path.join(path.dirname(target), '.archive');
    const ref = `${name}-${version}-${archiveStamp()}`;
    const dest = path.join(archiveRoot, ref);
    await fs.ensureDir(archiveRoot);
    await fs.copy(target, dest, { dereference: false });
    await this.pruneArchive(archiveRoot, name);
    return dest;
  }

  /** 从 .archive 恢复 ref 命名的版本到 target（替换失败回滚用）。 */
  private async restoreFromArchive(target: string, name: string, ref: string): Promise<void> {
    const archiveRoot = path.join(path.dirname(target), '.archive');
    const src = path.join(archiveRoot, ref);
    if (!(await fs.pathExists(src))) return;
    await fs.ensureDir(path.dirname(target));
    await fs.move(src, target);
  }

  /** 保留该 name 最近 ARCHIVE_KEEP 个归档版本，超限删除。 */
  private async pruneArchive(archiveRoot: string, name: string): Promise<void> {
    const entries = (await fs.readdir(archiveRoot))
      .filter((entry) => entry.startsWith(`${name}-`))
      .sort();
    const excess = entries.slice(0, -ARCHIVE_KEEP);
    for (const entry of excess) await fs.remove(path.join(archiveRoot, entry));
  }

  /** 版本化替换时确定新版本号：frontmatter 版本不同则用之；相同则 auto-bump patch。 */
  private nextVersion(oldVersion: string, newVersion: string): string {
    if (newVersion !== oldVersion) return newVersion;
    const parts = oldVersion.split('.').map((part) => {
      const num = Number(part);
      return Number.isFinite(num) ? num : 0;
    });
    parts[2] = (parts[2] ?? 0) + 1;
    return parts.join('.');
  }

  // 项目级投影：store 根 `workspace/skills/<name>` 软链到项目发现目录。
  // 幂等（D-034）：软链已存在且指向正确则跳过，否则移除后重建（防重复/悬空软链）。
  private async project(name: string): Promise<void> {
    const projection = this.projectionPath(name);
    const target = path.join('../../skills', name);
    await fs.ensureDir(path.dirname(projection));
    try {
      const stat = await fs.lstat(projection);
      if (stat.isSymbolicLink() && (await fs.readlink(projection)) === target) return;
      await fs.remove(projection);
    } catch {
      // projection 不存在（ENOENT）：直接创建。
    }
    await fs.symlink(target, projection);
  }

  private projectRoot(): string {
    return path.join(this.workspace, 'skills');
  }

  private userRoot(): string {
    if (!this.runtimeHome)
      throw new AgentCtlError('VALIDATION_ERROR', '用户级 Skill 需要 Runtime Home。');
    return path.join(this.runtimeHome, 'skills');
  }

  private storeRoot(scope: SkillScope): string {
    return scope === 'user' ? this.userRoot() : this.projectRoot();
  }

  private projectionPath(name: string): string {
    if (this.provider === 'claude') return path.join(this.workspace, '.claude', 'skills', name);
    return path.join(this.workspace, '.codex', 'skills', name);
  }

  private async listRoot(root: string, scope: SkillScope): Promise<SkillMetadata[]> {
    if (!(await fs.pathExists(root))) return [];
    const names = (await fs.readdir(root)).sort();
    const result: SkillMetadata[] = [];
    for (const name of names) {
      if (name.startsWith('.staging-')) continue;
      const full = path.join(root, name);
      // 用户级根仅统计真实目录；历史 Codex preset 投影（软链）不属于用户级 store。
      if (scope === 'user' && (await fs.lstat(full)).isSymbolicLink()) continue;
      const file = path.join(full, '.agentctl.yaml');
      if (await fs.pathExists(file)) {
        const metadata = YAML.parse(await fs.readFile(file, 'utf8')) as SkillMetadata;
        result.push({
          ...metadata,
          scope: metadata.scope ?? scope,
          digest: metadata.digest || (await digestSkillDirectory(full)),
        });
      } else {
        // D-033：手动拷贝进 store 目录的 Skill 无 .agentctl.yaml（该文件仅 install()/导入流程写）。
        // 只要含合法 frontmatter 的 SKILL.md 就现场合成元数据，使此类 Skill 在 Web 后台可见。
        const fallback = await this.readSkillMetadataFallback(full, scope);
        if (fallback) result.push(fallback);
      }
    }
    return result;
  }

  // D-033：为无 .agentctl.yaml 元数据的手动 Skill 现场合成元数据（不写盘），
  // 复用 parseSkillFrontmatter 的 frontmatter 解析规则；缺 SKILL.md 或 name 非法时返回 null（不阻断列表）。
  private async readSkillMetadataFallback(
    full: string,
    scope: SkillScope,
  ): Promise<SkillMetadata | null> {
    const skillFile = path.join(full, 'SKILL.md');
    if (!(await fs.pathExists(skillFile))) return null;
    const text = await fs.readFile(skillFile, 'utf8');
    let parsed: { name: string; version: string };
    try {
      parsed = parseSkillFrontmatter(text);
    } catch {
      return null;
    }
    const stat = await fs.stat(skillFile);
    return {
      name: parsed.name,
      version: parsed.version,
      source: 'manual',
      installed_at: stat.mtime.toISOString(),
      digest: await digestSkillDirectory(full),
      scope,
    };
  }

  private async rejectSymlinks(root: string): Promise<void> {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(root, entry.name);
      if (entry.isSymbolicLink())
        throw new AgentCtlError('VALIDATION_ERROR', `Skill 源包含不可安全复制的软链接：${target}`);
      if (entry.isDirectory()) await this.rejectSymlinks(target);
    }
  }
}
