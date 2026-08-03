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
});
