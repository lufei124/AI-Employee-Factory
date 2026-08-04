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
});
