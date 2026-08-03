import fs from 'fs-extra';
import path from 'node:path';
import { open } from 'node:fs/promises';
import { AgentCtlError } from './errors.js';

interface LockData {
  pid: number;
  purpose: string;
  acquired_at: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class FileLock {
  private owned = false;

  constructor(readonly path: string) {}

  async acquire(input: { purpose: string }): Promise<void> {
    await fs.ensureDir(path.dirname(this.path));
    try {
      const handle = await open(this.path, 'wx', 0o600);
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          purpose: input.purpose,
          acquired_at: new Date().toISOString(),
        }),
      );
      await handle.close();
      this.owned = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.readExisting();
      if (existing && !isAlive(existing.pid)) {
        await fs.remove(this.path);
        await this.acquire(input);
        return;
      }
      throw new AgentCtlError('LOCKED', `操作正在执行：${existing?.purpose ?? this.path}`, {
        remediation: '请等待当前任务完成；若进程已异常退出，重试时会自动回收陈旧锁。',
      });
    }
  }

  async release(): Promise<void> {
    if (!this.owned) return;
    await fs.remove(this.path);
    this.owned = false;
  }

  async withLock<T>(input: { purpose: string }, operation: () => Promise<T>): Promise<T> {
    await this.acquire(input);
    try {
      return await operation();
    } finally {
      await this.release();
    }
  }

  private async readExisting(): Promise<LockData | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.path, 'utf8')) as LockData;
    } catch {
      return undefined;
    }
  }
}
