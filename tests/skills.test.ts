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

  it('lists a manually-copied skill that has SKILL.md but no .agentctl.yaml (D-033)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const workspace = path.join(root, 'agent');
    // 模拟用户手动拷贝进 store 目录：只有 SKILL.md，没有 .agentctl.yaml（仅 install()/导入流程写）。
    await fs.outputFile(
      path.join(workspace, 'skills/game-feedback-collector/SKILL.md'),
      '---\nname: game-feedback-collector\ndescription: 收集游戏反馈\nversion: 1.2.0\n---\n',
    );
    // 无 SKILL.md 的目录不应被列出。
    await fs.outputFile(path.join(workspace, 'skills/not-a-skill/README.md'), 'no skill here\n');

    const list = await new SkillService(workspace, 'claude').list();

    const manual = list.find((s) => s.name === 'game-feedback-collector');
    expect(manual).toBeDefined();
    expect(manual?.version).toBe('1.2.0');
    expect(manual?.source).toBe('manual');
    expect(manual?.scope).toBe('project');
    expect(manual?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(list.some((s) => s.name === 'not-a-skill')).toBe(false);
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

  it('uninstalls user-scope skills permanently (no .archive)', async () => {
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

    // 卸载为彻底删除：runtimeHome 原位目录删除，且不再产生 .archive 归档区
    expect(await fs.pathExists(path.join(runtimeHome, 'skills/arch-skill'))).toBe(false);
    expect(await fs.pathExists(path.join(runtimeHome, 'skills/.archive'))).toBe(false);
  });

  it('uninstalls project-scope skills and their projection symlink', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const workspace = path.join(root, 'agent');
    const source = path.join(root, 'proj-remove-skill');
    await fs.outputFile(
      path.join(source, 'SKILL.md'),
      '---\nname: proj-remove-skill\ndescription: p\n---\n',
    );
    const service = new SkillService(workspace, 'claude');
    await service.install(source, 'project');

    await service.remove('proj-remove-skill', 'project');

    // store 根目录与 .claude/skills 投影软链都删除，无 .archive
    expect(await fs.pathExists(path.join(workspace, 'skills/proj-remove-skill'))).toBe(false);
    expect(await fs.pathExists(path.join(workspace, '.claude/skills/proj-remove-skill'))).toBe(
      false,
    );
    expect(await fs.pathExists(path.join(workspace, 'skills/.archive'))).toBe(false);
  });

  it('rejects removing a skill that does not exist', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const service = new SkillService(path.join(root, 'agent'), 'claude');

    await expect(service.remove('missing-skill', 'project')).rejects.toThrow('Skill 不存在');
  });
});

describe('SkillService.upsert / adopt / rollback (D-034)', () => {
  it('upserts a new skill like install', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const workspace = path.join(root, 'agent');
    const source = path.join(root, 'new-skill');
    await fs.outputFile(
      path.join(source, 'SKILL.md'),
      '---\nname: new-skill\ndescription: new\nversion: 1.0.0\n---\n',
    );
    const service = new SkillService(workspace, 'claude');

    const metadata = await service.upsert(source);

    expect(metadata.version).toBe('1.0.0');
    expect(await fs.pathExists(path.join(workspace, 'skills/new-skill/.agentctl.yaml'))).toBe(true);
    expect(
      (await fs.lstat(path.join(workspace, '.claude/skills/new-skill'))).isSymbolicLink(),
    ).toBe(true);
  });

  it('upserts a same-name skill as a versioned replacement (no CONFLICT)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const workspace = path.join(root, 'agent');
    const source1 = path.join(root, 'v1');
    const source2 = path.join(root, 'v2');
    await fs.outputFile(
      path.join(source1, 'SKILL.md'),
      '---\nname: shared\ndescription: first\nversion: 1.0.0\n---\n',
    );
    await fs.outputFile(
      path.join(source2, 'SKILL.md'),
      '---\nname: shared\ndescription: second\nversion: 1.1.0\n---\n',
    );
    const service = new SkillService(workspace, 'claude');
    await service.upsert(source1);

    const metadata = await service.upsert(source2);

    expect(metadata.version).toBe('1.1.0');
    const stored = await fs.readFile(path.join(workspace, 'skills/shared/SKILL.md'), 'utf8');
    expect(stored).toContain('second');
    // 旧版已进 .archive
    const archive = path.join(workspace, 'skills/.archive');
    const archived = (await fs.readdir(archive)).filter((e) => e.startsWith('shared-'));
    expect(archived.length).toBeGreaterThan(0);
  });

  it('upsert is a no-op when the digest is unchanged', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const workspace = path.join(root, 'agent');
    const source = path.join(root, 'same');
    await fs.outputFile(
      path.join(source, 'SKILL.md'),
      '---\nname: same\ndescription: d\nversion: 1.0.0\n---\n',
    );
    const service = new SkillService(workspace, 'claude');
    const first = await service.upsert(source);
    const metaBefore = await fs.readFile(
      path.join(workspace, 'skills/same/.agentctl.yaml'),
      'utf8',
    );

    const second = await service.upsert(source);

    expect(second.digest).toBe(first.digest);
    const metaAfter = await fs.readFile(path.join(workspace, 'skills/same/.agentctl.yaml'), 'utf8');
    expect(metaAfter).toBe(metaBefore);
  });

  it('adopt writes metadata and projects a manually-written skill', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const workspace = path.join(root, 'agent');
    // 模拟员工任务中直接写盘：只有 SKILL.md，无 .agentctl.yaml。
    await fs.outputFile(
      path.join(workspace, 'skills/self-made/SKILL.md'),
      '---\nname: self-made\ndescription: self\nversion: 0.3.0\n---\n',
    );
    const service = new SkillService(workspace, 'claude');

    const metadata = await service.adopt('self-made');

    expect(metadata.source).toBe('self');
    expect(metadata.version).toBe('0.3.0');
    expect(await fs.pathExists(path.join(workspace, 'skills/self-made/.agentctl.yaml'))).toBe(true);
    expect(
      (await fs.lstat(path.join(workspace, '.claude/skills/self-made'))).isSymbolicLink(),
    ).toBe(true);
  });

  it('adopt rejects a directory whose frontmatter name mismatches the dir name', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const workspace = path.join(root, 'agent');
    await fs.outputFile(
      path.join(workspace, 'skills/foo/SKILL.md'),
      '---\nname: bar\ndescription: d\n---\n',
    );
    const service = new SkillService(workspace, 'claude');

    await expect(service.adopt('foo')).rejects.toThrow('不一致');
    // 未写入元数据
    expect(await fs.pathExists(path.join(workspace, 'skills/foo/.agentctl.yaml'))).toBe(false);
  });

  it('adopt rejects a missing SKILL.md without touching the store', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const workspace = path.join(root, 'agent');
    await fs.outputFile(path.join(workspace, 'skills/empty/README.md'), 'no skill');
    const service = new SkillService(workspace, 'claude');

    await expect(service.adopt('empty')).rejects.toThrow('Skill 不存在');
    expect(await fs.pathExists(path.join(workspace, 'skills/empty/.agentctl.yaml'))).toBe(false);
  });

  it('rollback restores an earlier archived version', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-'));
    roots.push(root);
    const workspace = path.join(root, 'agent');
    const source1 = path.join(root, 'r1');
    const source2 = path.join(root, 'r2');
    await fs.outputFile(
      path.join(source1, 'SKILL.md'),
      '---\nname: rollback-me\ndescription: first\nversion: 1.0.0\n---\n',
    );
    await fs.outputFile(
      path.join(source2, 'SKILL.md'),
      '---\nname: rollback-me\ndescription: second\nversion: 2.0.0\n---\n',
    );
    const service = new SkillService(workspace, 'claude');
    await service.upsert(source1);
    await service.upsert(source2);

    const rolled = await service.rollback('rollback-me');

    expect(rolled.version).toBe('1.0.0');
    const stored = await fs.readFile(path.join(workspace, 'skills/rollback-me/SKILL.md'), 'utf8');
    expect(stored).toContain('first');
  });
});
