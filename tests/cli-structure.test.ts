import { describe, expect, it } from 'vitest';
import { createProgram } from '../src/cli-program.js';

describe('agentctl command surface', () => {
  it('registers the migrate command with a --dry-run option (OP3-A)', () => {
    const program = createProgram();
    const migrate = program.commands.find((command) => command.name() === 'migrate');
    expect(migrate).toBeDefined();
    expect(migrate?.options.map((option) => option.flags).join(' ')).toContain('--dry-run');
  });

  it('registers all v1 top-level commands', () => {
    const commands = createProgram().commands.map((command) => command.name());
    expect(commands).toEqual(
      expect.arrayContaining([
        'init',
        'create',
        'list',
        'show',
        'start',
        'stop',
        'restart',
        'status',
        'chat',
        'run',
        'logs',
        'doctor',
        'backup',
        'restore',
        'archive',
        'repair',
        'migrate',
        'runtime',
        'bridge',
        'job',
        'skill',
        'skill-store',
        'knowledge',
        'web',
        'trash',
        'operations',
        'prune',
      ]),
    );
  });

  it('registers runtime, bridge, job, and skill subcommands', () => {
    const program = createProgram();
    const names = (group: string) =>
      program.commands
        .find((command) => command.name() === group)
        ?.commands.map((command) => command.name());
    expect(names('runtime')).toEqual(expect.arrayContaining(['sync', 'login', 'status']));
    // OP5-D：runtime sync 支持 --provider <name>（绑定 CC Switch 具体 Provider，live 清除绑定）。
    const syncCmd = program.commands
      .find((command) => command.name() === 'runtime')
      ?.commands.find((command) => command.name() === 'sync');
    expect(syncCmd?.options.map((option) => option.flags).join(' ')).toContain('--provider');
    expect(names('bridge')).toEqual(expect.arrayContaining(['authorize', 'status']));
    expect(names('job')).toEqual(
      expect.arrayContaining([
        'list',
        'validate',
        'run',
        'enable',
        'disable',
        'install',
        'uninstall',
      ]),
    );
    expect(names('skill')).toEqual(expect.arrayContaining(['list', 'install', 'remove']));
    expect(names('knowledge')).toEqual(expect.arrayContaining(['rebuild', 'recall', 'verify']));
    expect(names('skill-store')).toEqual(
      expect.arrayContaining([
        'list-repos',
        'add-repo',
        'remove-repo',
        'refresh',
        'list-skills',
        'install',
      ]),
    );
    expect(names('trash')).toEqual(expect.arrayContaining(['move', 'list', 'restore', 'purge']));
    expect(names('operations')).toEqual(expect.arrayContaining(['query']));
  });

  it('registers the plan and chief orchestration command groups (spec-chief-orchestration)', () => {
    const program = createProgram();
    const names = (group: string) =>
      program.commands
        .find((command) => command.name() === group)
        ?.commands.map((command) => command.name());
    expect(names('plan')).toEqual(
      expect.arrayContaining([
        'list',
        'create',
        'add',
        'get',
        'confirm',
        'reject',
        'run',
        'review',
        'confirm-review',
        'reject-review',
      ]),
    );
    expect(names('chief')).toEqual(expect.arrayContaining(['run']));
    // plan run 支持 --concurrency；review 支持 --chief；reject-review 支持 --note。
    const optionFlags = (group: string, sub: string) =>
      program.commands
        .find((command) => command.name() === group)
        ?.commands.find((command) => command.name() === sub)
        ?.options.map((option) => option.flags)
        .join(' ') ?? '';
    expect(optionFlags('plan', 'run')).toContain('--concurrency');
    expect(optionFlags('plan', 'reject')).toContain('--note');
    expect(optionFlags('plan', 'review')).toContain('--chief');
    expect(optionFlags('plan', 'reject-review')).toContain('--note');
    expect(optionFlags('chief', 'run')).toContain('--concurrency');
  });
});
