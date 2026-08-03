import { describe, expect, it } from 'vitest';
import { createProgram } from '../src/cli-program.js';

describe('agentctl command surface', () => {
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
        'runtime',
        'bridge',
        'job',
        'skill',
        'web',
        'trash',
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
    expect(names('trash')).toEqual(expect.arrayContaining(['move', 'list', 'restore', 'purge']));
  });
});
