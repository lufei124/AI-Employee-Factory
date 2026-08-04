import fs from 'fs-extra';
import path from 'node:path';
import { execa } from 'execa';
import YAML from 'yaml';
import { z } from 'zod';
import { AgentCtlError } from './errors.js';
import { atomicWriteFile } from './atomic.js';
import { readConfig, skillStoreRepositorySchema, type SkillStoreRepository } from './config.js';
import { assertInside, type FactoryPaths } from './paths.js';

export interface SkillStoreSkill {
  name: string;
  description: string;
  version: string;
  /** 相对仓库根的技能目录（含 SKILL.md 的目录）。 */
  path: string;
  repository: string;
}

export interface SkillStoreRepositoryState extends SkillStoreRepository {
  cached: boolean;
  lastRefreshedAt?: string;
}

const manifestSchema = z.object({
  skills: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      version: z.string().optional(),
      path: z.string(),
    }),
  ),
});

/**
 * Skill 商店：把可配置的远端 GitHub 仓库源（`config.yaml` 的 `skill_store.repositories`）
 * 浅克隆到 `~/.ai-employees/skill-store/cache/<name>/` 并用 `agent-skills.yaml/json` 清单
 * 或扫 `SKILL.md` 发现技能。安装复用 `SkillService.install`（传递源路径），不改变任何
 * 既有安装方式（上传目录 / 本地路径 / CLI）。仅接受 `https://github.com/` 公开仓库。
 */
export class SkillStoreService {
  constructor(private readonly paths: FactoryPaths) {}

  async listRepositories(): Promise<SkillStoreRepositoryState[]> {
    const config = await readConfig(this.paths);
    const states: SkillStoreRepositoryState[] = [];
    for (const repo of config.skill_store.repositories) {
      const marker = this.markerFile(repo);
      let lastRefreshedAt: string | undefined;
      if (await fs.pathExists(marker)) {
        lastRefreshedAt = (await fs.readFile(marker, 'utf8')).trim();
      }
      states.push({
        ...repo,
        cached: await fs.pathExists(marker),
        ...(lastRefreshedAt ? { lastRefreshedAt } : {}),
      });
    }
    return states;
  }

  async addRepository(input: {
    name: string;
    url: string;
    description?: string;
  }): Promise<SkillStoreRepositoryState> {
    const repo = skillStoreRepositorySchema.parse(input);
    const config = await readConfig(this.paths);
    if (config.skill_store.repositories.some((item) => item.name === repo.name)) {
      throw new AgentCtlError('CONFLICT', `仓库源已存在：${repo.name}`);
    }
    if (config.skill_store.repositories.length >= 20) {
      throw new AgentCtlError('VALIDATION_ERROR', '仓库源最多 20 个。');
    }
    await this.writeRepositories([...config.skill_store.repositories, repo]);
    return { ...repo, cached: false };
  }

  async removeRepository(name: string): Promise<void> {
    const config = await readConfig(this.paths);
    if (!config.skill_store.repositories.some((item) => item.name === name)) {
      throw new AgentCtlError('NOT_FOUND', `仓库源不存在：${name}`);
    }
    await this.writeRepositories(
      config.skill_store.repositories.filter((item) => item.name !== name),
    );
    await fs.remove(this.cacheDir(name)).catch(() => undefined);
  }

  async refresh(name: string): Promise<SkillStoreRepositoryState> {
    const repo = await this.getRepository(name);
    const dir = this.cacheDir(repo.name);
    await fs.ensureDir(path.dirname(dir));
    try {
      if (await fs.pathExists(path.join(dir, '.git'))) {
        await execa('git', ['-C', dir, 'pull', '--ff-only'], { shell: false, timeout: 60_000 });
      } else {
        await fs.remove(dir).catch(() => undefined);
        await execa('git', ['clone', '--depth', '1', repo.url, dir], {
          shell: false,
          timeout: 120_000,
        });
      }
      const now = new Date().toISOString();
      await fs.writeFile(this.markerFile(repo), now);
      return { ...repo, cached: true, lastRefreshedAt: now };
    } catch (error) {
      throw new AgentCtlError('OPERATION_FAILED', `刷新仓库 ${repo.name} 失败`, {
        remediation: '请检查网络连接与仓库地址，然后重试。',
        cause: error,
      });
    }
  }

  async listSkills(name: string): Promise<SkillStoreSkill[]> {
    const repo = await this.getRepository(name);
    const dir = this.cacheDir(repo.name);
    if (!(await fs.pathExists(path.join(dir, '.git')))) {
      throw new AgentCtlError('NOT_FOUND', `仓库 ${repo.name} 尚未刷新。`, {
        remediation: '请先刷新仓库以拉取内容。',
      });
    }
    const manifest = await this.readManifest(dir, repo.name);
    if (manifest) return manifest;
    return this.scanSkills(dir, repo.name);
  }

  /** 解析仓库内技能源目录（校验包含在缓存根内），由调用方继续走 SkillService.install。 */
  async resolveSkillSource(name: string, skillPath: string): Promise<string> {
    const repo = await this.getRepository(name);
    const dir = this.cacheDir(repo.name);
    if (!(await fs.pathExists(path.join(dir, '.git')))) {
      throw new AgentCtlError('NOT_FOUND', `仓库 ${repo.name} 尚未刷新。`, {
        remediation: '请先刷新仓库并确认技能存在。',
      });
    }
    const source = assertInside(dir, path.resolve(dir, skillPath), 'Skill 源');
    if (!(await fs.pathExists(path.join(source, 'SKILL.md')))) {
      throw new AgentCtlError('VALIDATION_ERROR', `仓库 ${repo.name} 中不存在 Skill：${skillPath}`);
    }
    return source;
  }

  private cacheDir(name: string): string {
    return path.join(this.paths.skillStoreDir, 'cache', name);
  }

  private markerFile(repo: SkillStoreRepository): string {
    return path.join(this.cacheDir(repo.name), '.refreshed');
  }

  private async getRepository(name: string): Promise<SkillStoreRepository> {
    const config = await readConfig(this.paths);
    const repo = config.skill_store.repositories.find((item) => item.name === name);
    if (!repo) throw new AgentCtlError('NOT_FOUND', `仓库源不存在：${name}`);
    return repo;
  }

  private async writeRepositories(repositories: SkillStoreRepository[]): Promise<void> {
    const config = await readConfig(this.paths);
    await atomicWriteFile(
      this.paths.configFile,
      YAML.stringify({ ...config, skill_store: { repositories } }),
      0o600,
    );
  }

  private async readManifest(dir: string, repoName: string): Promise<SkillStoreSkill[] | null> {
    const yamlFile = path.join(dir, 'agent-skills.yaml');
    const jsonFile = path.join(dir, 'agent-skills.json');
    let raw: unknown;
    if (await fs.pathExists(yamlFile)) raw = YAML.parse(await fs.readFile(yamlFile, 'utf8'));
    else if (await fs.pathExists(jsonFile)) raw = JSON.parse(await fs.readFile(jsonFile, 'utf8'));
    else return null;
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) return null; // 清单格式异常则回退扫描
    return parsed.data.skills.map((skill) => ({
      name: skill.name,
      description: skill.description ?? '',
      version: skill.version ?? '0.0.0',
      path: skill.path,
      repository: repoName,
    }));
  }

  private async scanSkills(dir: string, repoName: string): Promise<SkillStoreSkill[]> {
    const skills: SkillStoreSkill[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue; // 跳过 .git 与隐藏目录
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(full);
        } else if (entry.name === 'SKILL.md') {
          const text = await fs.readFile(full, 'utf8');
          const relDir = path.relative(dir, path.dirname(full)).split(path.sep).join('/');
          skills.push({
            name:
              /^---[\s\S]*?^name:\s*([^\s]+)[\s\S]*?^---/m.exec(text)?.[1] ??
              relDir.split('/').pop() ??
              'unknown',
            description: /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '',
            version: /^version:\s*([^\s]+)/m.exec(text)?.[1] ?? '0.0.0',
            path: relDir,
            repository: repoName,
          });
        }
      }
    };
    await visit(dir);
    return skills;
  }
}
