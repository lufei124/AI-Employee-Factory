import fs from 'fs-extra';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { AgentCtlError } from './errors.js';
import { agentIdSchema, type RuntimeProvider } from '../schemas/agent-schema.js';

export interface SkillMetadata {
  name: string;
  version: string;
  source: string;
  installed_at: string;
  digest: string;
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

export class SkillService {
  constructor(
    readonly workspace: string,
    readonly provider: RuntimeProvider,
    private readonly runtimeHome?: string,
  ) {}

  async list(): Promise<SkillMetadata[]> {
    const root = path.join(this.workspace, 'skills');
    if (!(await fs.pathExists(root))) return [];
    const names = (await fs.readdir(root)).filter((name) => name !== '.archive').sort();
    const result: SkillMetadata[] = [];
    for (const name of names) {
      const file = path.join(root, name, '.agentctl.yaml');
      if (await fs.pathExists(file)) {
        const metadata = YAML.parse(await fs.readFile(file, 'utf8')) as SkillMetadata;
        result.push({
          ...metadata,
          digest: metadata.digest || (await digestSkillDirectory(path.join(root, name))),
        });
      }
    }
    return result;
  }

  async install(source: string): Promise<SkillMetadata> {
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
    const target = path.join(this.workspace, 'skills', name);
    if (await fs.pathExists(target)) throw new AgentCtlError('CONFLICT', `Skill 已安装：${name}`);
    const stage = path.join(this.workspace, 'skills', `.staging-${name}-${randomUUID()}`);
    await fs.ensureDir(path.dirname(stage));
    try {
      await fs.copy(resolved, stage, { dereference: false, errorOnExist: true });
      const metadata: SkillMetadata = {
        name,
        version,
        source: resolved,
        installed_at: new Date().toISOString(),
        digest: await digestSkillDirectory(stage),
      };
      await fs.writeFile(path.join(stage, '.agentctl.yaml'), YAML.stringify(metadata));
      await fs.rename(stage, target);
      await this.project(name);
      return metadata;
    } catch (error) {
      await fs.remove(stage);
      throw error;
    }
  }

  async remove(name: string): Promise<void> {
    agentIdSchema.parse(name);
    const target = path.join(this.workspace, 'skills', name);
    if (!(await fs.pathExists(target)))
      throw new AgentCtlError('NOT_FOUND', `Skill 不存在：${name}`);
    await fs.remove(this.projectionPath(name));
    const archive = path.join(this.workspace, 'skills', '.archive');
    await fs.ensureDir(archive);
    await fs.move(target, path.join(archive, `${name}-${Date.now()}`));
  }

  private async project(name: string): Promise<void> {
    const projection = this.projectionPath(name);
    await fs.ensureDir(path.dirname(projection));
    if (this.provider === 'claude') await fs.symlink(path.join('../../skills', name), projection);
    else await fs.symlink(path.join(this.workspace, 'skills', name), projection);
  }

  private projectionPath(name: string): string {
    if (this.provider === 'claude') return path.join(this.workspace, '.claude', 'skills', name);
    if (!this.runtimeHome)
      throw new AgentCtlError('VALIDATION_ERROR', 'Codex Skill 投影需要 Runtime Home。');
    return path.join(this.runtimeHome, 'skills', name);
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
