import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentCtlError } from '../src/core/errors.js';
import { SkillStoreService } from '../src/core/skill-store.js';
import { resolveFactoryPaths } from '../src/core/paths.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

function pathsFor(root: string) {
  return resolveFactoryPaths({
    HOME: root,
    AI_EMPLOYEES_HOME: path.join(root, 'private'),
    AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
  });
}

async function writeEmptyConfig(paths: ReturnType<typeof pathsFor>): Promise<void> {
  await fs.ensureDir(path.dirname(paths.configFile));
  await fs.writeFile(
    paths.configFile,
    `version: 1\nhome: ${paths.home}\nworkspace_root: ${paths.workspaceRoot}\nservice_provider: launchd\nskill_store:\n  repositories: []\n`,
  );
}

describe('SkillStoreService', () => {
  it('adds a repository and lists it as not cached', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-store-'));
    roots.push(root);
    const paths = pathsFor(root);
    await writeEmptyConfig(paths);
    const service = new SkillStoreService(paths);

    const state = await service.addRepository({
      name: 'my-skills',
      url: 'https://github.com/owner/repo',
      description: 'my skills',
    });

    expect(state.cached).toBe(false);
    const all = await service.listRepositories();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('my-skills');
    expect(all[0].cached).toBe(false);
  });

  it('rejects non-github and duplicate repository URLs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-store-'));
    roots.push(root);
    const paths = pathsFor(root);
    await writeEmptyConfig(paths);
    const service = new SkillStoreService(paths);

    await expect(
      service.addRepository({ name: 'bad', url: 'https://example.com/repo' }),
    ).rejects.toThrow('仅支持 https://github.com/');
    await service.addRepository({ name: 'dup', url: 'https://github.com/a/b' });
    await expect(
      service.addRepository({ name: 'dup', url: 'https://github.com/c/d' }),
    ).rejects.toThrow('已存在');
  });

  it('removes a repository and its cache directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-store-'));
    roots.push(root);
    const paths = pathsFor(root);
    await writeEmptyConfig(paths);
    const service = new SkillStoreService(paths);
    await service.addRepository({ name: 'gone', url: 'https://github.com/a/b' });
    await fs.ensureDir(path.join(paths.skillStoreDir, 'cache', 'gone'));

    await service.removeRepository('gone');

    expect(await service.listRepositories()).toHaveLength(0);
    expect(await fs.pathExists(path.join(paths.skillStoreDir, 'cache', 'gone'))).toBe(false);
  });

  it('scans SKILL.md files to discover skills', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-store-'));
    roots.push(root);
    const paths = pathsFor(root);
    await writeEmptyConfig(paths);
    const service = new SkillStoreService(paths);
    await service.addRepository({ name: 'scan', url: 'https://github.com/a/b' });
    const cacheRoot = path.join(paths.skillStoreDir, 'cache', 'scan');
    await fs.ensureDir(path.join(cacheRoot, '.git'));
    await fs.outputFile(
      path.join(cacheRoot, 'skills/hello/SKILL.md'),
      '---\nname: hello\ndescription: says hi\nversion: 1.2.0\n---\n',
    );

    const skills = await service.listSkills('scan');

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: 'hello',
      description: 'says hi',
      version: '1.2.0',
      path: 'skills/hello',
      repository: 'scan',
    });
  });

  it('reads skills from an agent-skills.yaml manifest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-store-'));
    roots.push(root);
    const paths = pathsFor(root);
    await writeEmptyConfig(paths);
    const service = new SkillStoreService(paths);
    await service.addRepository({ name: 'manifest', url: 'https://github.com/a/b' });
    const cacheRoot = path.join(paths.skillStoreDir, 'cache', 'manifest');
    await fs.ensureDir(path.join(cacheRoot, '.git'));
    await fs.writeFile(
      path.join(cacheRoot, 'agent-skills.yaml'),
      `skills:\n  - name: listed\n    description: from manifest\n    version: 3.0.0\n    path: dir/listed\n`,
    );

    const skills = await service.listSkills('manifest');

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: 'listed', version: '3.0.0', path: 'dir/listed' });
  });

  it('requires a refreshed (cached) repository before listing or resolving', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-store-'));
    roots.push(root);
    const paths = pathsFor(root);
    await writeEmptyConfig(paths);
    const service = new SkillStoreService(paths);
    await service.addRepository({ name: 'fresh', url: 'https://github.com/a/b' });

    await expect(service.listSkills('fresh')).rejects.toThrow('尚未刷新');
    await expect(service.resolveSkillSource('fresh', 'skills/x')).rejects.toThrow('尚未刷新');
  });

  it('resolves a valid skill source and rejects traversal or missing SKILL.md', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-store-'));
    roots.push(root);
    const paths = pathsFor(root);
    await writeEmptyConfig(paths);
    const service = new SkillStoreService(paths);
    await service.addRepository({ name: 'res', url: 'https://github.com/a/b' });
    const cacheRoot = path.join(paths.skillStoreDir, 'cache', 'res');
    await fs.ensureDir(path.join(cacheRoot, '.git'));
    await fs.outputFile(path.join(cacheRoot, 'skills/ok/SKILL.md'), '---\nname: ok\n---\n');

    const source = await service.resolveSkillSource('res', 'skills/ok');
    expect(source).toBe(path.join(cacheRoot, 'skills', 'ok'));

    await expect(service.resolveSkillSource('res', '../escape')).rejects.toThrow(AgentCtlError);
    await expect(service.resolveSkillSource('res', 'skills/missing')).rejects.toThrow(
      '不存在 Skill',
    );
  });
});
