import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileLock } from '../src/core/locks.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('FileLock', () => {
  it('prevents concurrent ownership and releases in finally', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-lock-'));
    tempDirs.push(root);
    const lock = new FileLock(path.join(root, 'run.lock'));

    await lock.acquire({ purpose: 'run:user-operations' });
    await expect(new FileLock(lock.path).acquire({ purpose: 'second' })).rejects.toThrow(
      '正在执行',
    );
    await lock.release();
    await expect(fs.pathExists(lock.path)).resolves.toBe(false);
  });

  it('refuses to seize a lock backed by a corrupt lock file instead of treating it as unlocked', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-lock-corrupt-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'corrupt.lock');
    await fs.writeFile(lockPath, 'not-valid-json-{corrupt');

    await expect(new FileLock(lockPath).acquire({ purpose: 'first' })).rejects.toThrow('损坏');
  });
});
