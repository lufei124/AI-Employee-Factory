import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillService } from '../src/core/skills.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

describe('SkillService', () => {
  it('copies a local skill and records immutable installation metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const workspace = path.join(root, 'agent');
    const source = path.join(root, 'source-skill');
    await fs.outputFile(
      path.join(source, 'SKILL.md'),
      '---\nname: sample-skill\ndescription: sample\n---\n',
    );
    const service = new SkillService(workspace, 'claude');

    await service.install(source);

    const metadata = YAML.parse(
      await fs.readFile(path.join(workspace, 'skills/sample-skill/.agentctl.yaml'), 'utf8'),
    ) as Record<string, string>;
    expect(metadata.name).toBe('sample-skill');
    expect(metadata.version).toBe('0.0.0-local');
    expect(metadata.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      (await fs.lstat(path.join(workspace, '.claude/skills/sample-skill'))).isSymbolicLink(),
    ).toBe(true);
  });

  it('rejects source symlinks that escape the skill directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const source = path.join(root, 'bad-skill');
    await fs.outputFile(
      path.join(source, 'SKILL.md'),
      '---\nname: bad-skill\ndescription: bad\n---\n',
    );
    await fs.symlink('/tmp', path.join(source, 'outside'));

    await expect(
      new SkillService(path.join(root, 'agent'), 'claude').install(source),
    ).rejects.toThrow('软链接');
  });

  it('rejects a skill source whose root is itself a symlink', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const realSource = path.join(root, 'real-skill');
    await fs.outputFile(
      path.join(realSource, 'SKILL.md'),
      '---\nname: linked-skill\ndescription: linked\n---\n',
    );
    const linkedSource = path.join(root, 'linked-skill');
    await fs.symlink(realSource, linkedSource);

    await expect(
      new SkillService(path.join(root, 'agent'), 'claude').install(linkedSource),
    ).rejects.toThrow('软链接');
  });

  it('computes a display digest for preset or legacy metadata that does not contain one', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const workspace = path.join(root, 'agent');
    await fs.outputFile(
      path.join(workspace, 'skills/legacy-skill/SKILL.md'),
      '---\nname: legacy-skill\ndescription: legacy\n---\n',
    );
    await fs.writeFile(
      path.join(workspace, 'skills/legacy-skill/.agentctl.yaml'),
      YAML.stringify({
        name: 'legacy-skill',
        version: '0.1.0',
        source: 'preset',
        installed_at: '2026-08-03T00:00:00.000Z',
      }),
    );

    const [metadata] = await new SkillService(workspace, 'claude').list();

    expect(metadata?.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('stores user-scope skills in runtimeHome and does not project them', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const workspace = path.join(root, 'agent');
    const runtimeHome = path.join(root, 'runtime');
    const source = path.join(root, 'user-skill');
    await fs.outputFile(
      path.join(source, 'SKILL.md'),
      '---\nname: user-skill\ndescription: user\n---\n',
    );
    const service = new SkillService(workspace, 'claude', runtimeHome);

    const metadata = await service.install(source, 'user');

    expect(metadata.scope).toBe('user');
    expect(await fs.pathExists(path.join(runtimeHome, 'skills/user-skill/.agentctl.yaml'))).toBe(
      true,
    );
    // 用户级不投影到项目发现目录
    expect(await fs.pathExists(path.join(workspace, '.claude/skills/user-skill'))).toBe(false);
  });

  it('lists and tags both project and user scopes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const workspace = path.join(root, 'agent');
    const runtimeHome = path.join(root, 'runtime');
    const service = new SkillService(workspace, 'codex', runtimeHome);
    const projectSource = path.join(root, 'proj-skill');
    const userSource = path.join(root, 'usr-skill');
    await fs.outputFile(
      path.join(projectSource, 'SKILL.md'),
      '---\nname: proj-skill\ndescription: p\n---\n',
    );
    await fs.outputFile(
      path.join(userSource, 'SKILL.md'),
      '---\nname: usr-skill\ndescription: u\n---\n',
    );
    await service.install(projectSource, 'project');
    await service.install(userSource, 'user');

    const list = await service.list();

    expect(list.find((s) => s.name === 'proj-skill')?.scope).toBe('project');
    expect(list.find((s) => s.name === 'usr-skill')?.scope).toBe('user');
  });

  it('rejects user-scope install without a runtimeHome', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const source = path.join(root, 'noskill');
    await fs.outputFile(path.join(source, 'SKILL.md'), '---\nname: noskill\ndescription: -\n---\n');

    await expect(
      new SkillService(path.join(root, 'agent'), 'claude').install(source, 'user'),
    ).rejects.toThrow('Runtime Home');
  });

  it('archives user-scope skills into the runtimeHome archive', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const workspace = path.join(root, 'agent');
    const runtimeHome = path.join(root, 'runtime');
    const source = path.join(root, 'arch-skill');
    await fs.outputFile(
      path.join(source, 'SKILL.md'),
      '---\nname: arch-skill\ndescription: a\n---\n',
    );
    const service = new SkillService(workspace, 'codex', runtimeHome);
    await service.install(source, 'user');

    await service.remove('arch-skill', 'user');

    expect(await fs.pathExists(path.join(runtimeHome, 'skills/arch-skill'))).toBe(false);
    expect(await fs.pathExists(path.join(runtimeHome, 'skills/.archive'))).toBe(true);
  });
});
