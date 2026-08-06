import fs from 'fs-extra';
import YAML from 'yaml';
import { z } from 'zod';
import { atomicWriteFile } from './atomic.js';
import { AgentCtlError } from './errors.js';
import type { FactoryPaths } from './paths.js';
import { RegistryStore } from './registry.js';

// R5：Factory 配置 schema。sync.sanitize_non_whitelist 控制 CC Switch 同步时是否
// 移除员工 settings.json 中残留的非白名单 env（默认 false，保留兼容）。
export const skillStoreRepositorySchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, '仓库名仅允许字母数字与 ._-'),
    // local = 随项目分发、离线可用的内置技能源（templates/skill-store/）；github = 远端公开仓库。
    source: z.enum(['github', 'local']).default('github'),
    url: z
      .string()
      .url()
      .refine((value) => value.startsWith('https://github.com/'), {
        message: '仅支持 https://github.com/ 的公开仓库',
      })
      .optional(),
    description: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.source === 'github' && !value.url) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'github 源必须提供仓库 url' });
    }
  });

export type SkillStoreRepository = z.infer<typeof skillStoreRepositorySchema>;

// 内置本地技能源：读取 `templates/skill-store/` 下的技能目录，随项目分发、离线可用、不可移除。
// 由 SkillStoreService 恒常合并进仓库列表（不写入 config.yaml），保证内置技能始终可安装。
export const FIRST_PARTY_SOURCE: SkillStoreRepository = {
  name: 'first-party',
  source: 'local',
  description: 'AI Employee Factory 内置技能（随项目分发，离线可用）',
};

// 内置默认仓库源（可配置列表的起点，用户可增删）。商店发现逻辑会扫描 SKILL.md/清单，
// 仓库结构不同只会得到空列表，不会影响其余安装方式。
export const builtinSkillStoreRepositories: SkillStoreRepository[] = [
  {
    name: 'superpowers',
    source: 'github',
    url: 'https://github.com/obra/superpowers',
    description: '社区 Claude Code 技能合集（obra/superpowers）',
  },
  {
    name: 'anthropic-skills',
    source: 'github',
    url: 'https://github.com/anthropics/skills',
    description: 'Anthropic 官方 Skills 集合',
  },
];

export const factoryConfigSchema = z.object({
  version: z.number(),
  home: z.string(),
  workspace_root: z.string(),
  service_provider: z.string(),
  sync: z
    .object({
      sanitize_non_whitelist: z.boolean().default(false),
    })
    .optional()
    .default({ sanitize_non_whitelist: false }),
  skill_store: z
    .object({
      repositories: z.array(skillStoreRepositorySchema).max(20).default([]),
    })
    .optional()
    .default({ repositories: [] }),
});

export type FactoryConfig = z.infer<typeof factoryConfigSchema>;

export async function readConfig(paths: FactoryPaths): Promise<FactoryConfig> {
  const fallback = {
    version: 1,
    home: paths.home,
    workspace_root: paths.workspaceRoot,
    service_provider: process.platform === 'darwin' ? 'launchd' : 'unsupported',
  };
  let raw: unknown = fallback;
  if (await fs.pathExists(paths.configFile)) {
    try {
      raw = YAML.parse(await fs.readFile(paths.configFile, 'utf8'));
    } catch (error) {
      throw new AgentCtlError('VALIDATION_ERROR', `Factory 配置解析失败：${paths.configFile}`, {
        cause: error,
      });
    }
  }
  const parsed = factoryConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentCtlError('VALIDATION_ERROR', `Factory 配置无效：${paths.configFile}`, {
      cause: parsed.error,
    });
  }
  // 向后兼容：旧配置（或缺省）没有 skill_store 时注入内置默认仓库源；
  // 显式存在 skill_store（即便为空）则尊重用户已清空的列表。
  const hasSkillStore = typeof raw === 'object' && raw !== null && 'skill_store' in raw;
  if (!hasSkillStore) {
    return { ...parsed.data, skill_store: { repositories: builtinSkillStoreRepositories } };
  }
  return parsed.data;
}

export async function initializeFactory(paths: FactoryPaths): Promise<void> {
  await Promise.all(
    [
      paths.home,
      paths.workspaceRoot,
      paths.registryDir,
      paths.runtimesDir,
      paths.bridgesDir,
      paths.servicesDir,
      paths.schedulesDir,
      paths.logsDir,
      paths.backupsDir,
      paths.trashDir,
      paths.locksDir,
      paths.skillStoreDir,
    ].map((directory) => fs.ensureDir(directory)),
  );
  if (!(await fs.pathExists(paths.configFile))) {
    await atomicWriteFile(
      paths.configFile,
      YAML.stringify({
        version: 1,
        home: paths.home,
        workspace_root: paths.workspaceRoot,
        service_provider: process.platform === 'darwin' ? 'launchd' : 'unsupported',
        skill_store: { repositories: builtinSkillStoreRepositories },
      }),
      0o600,
    );
  }
  await new RegistryStore(paths.registryFile).initialize();
  await Promise.all([
    fs.chmod(paths.home, 0o700),
    fs.chmod(paths.workspaceRoot, 0o700),
    fs.chmod(paths.registryDir, 0o700),
    fs.chmod(paths.runtimesDir, 0o700),
    fs.chmod(paths.bridgesDir, 0o700),
    fs.chmod(paths.servicesDir, 0o700),
    fs.chmod(paths.schedulesDir, 0o700),
    fs.chmod(paths.logsDir, 0o700),
    fs.chmod(paths.backupsDir, 0o700),
    fs.chmod(paths.trashDir, 0o700),
    fs.chmod(paths.locksDir, 0o700),
    fs.chmod(paths.skillStoreDir, 0o700),
  ]);
}
