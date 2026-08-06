import fs from 'fs-extra';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { AgentCtlError } from './errors.js';
import { agentIdSchema, type RuntimeProvider } from '../schemas/agent-schema.js';

export type SkillScope = 'project' | 'user';

export interface SkillMetadata {
  name: string;
  version: string;
  source: string;
  installed_at: string;
  digest: string;
  scope: SkillScope;
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
    const name = agentIdSchema.parse(
      /^---[\s\S]*?^name:\s*([^\s]+)[\s\S]*?^---/m.exec(skillText)?.[1],
    );
    const version = /^version:\s*([^\s]+)/m.exec(skillText)?.[1] ?? '0.0.0-local';
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

  // 项目级投影：store 根 `workspace/skills/<name>` 软链到项目发现目录。
  private async project(name: string): Promise<void> {
    const projection = this.projectionPath(name);
    await fs.ensureDir(path.dirname(projection));
    await fs.symlink(path.join('../../skills', name), projection);
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
  // 复用 install() 的 frontmatter 解析规则；缺 SKILL.md 或 name 非法时返回 null（不阻断列表）。
  private async readSkillMetadataFallback(
    full: string,
    scope: SkillScope,
  ): Promise<SkillMetadata | null> {
    const skillFile = path.join(full, 'SKILL.md');
    if (!(await fs.pathExists(skillFile))) return null;
    const text = await fs.readFile(skillFile, 'utf8');
    const name = agentIdSchema.safeParse(
      /^---[\s\S]*?^name:\s*([^\s]+)[\s\S]*?^---/m.exec(text)?.[1],
    );
    if (!name.success) return null;
    const version = /^version:\s*([^\s]+)/m.exec(text)?.[1] ?? '0.0.0-local';
    const stat = await fs.stat(skillFile);
    return {
      name: name.data,
      version,
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
