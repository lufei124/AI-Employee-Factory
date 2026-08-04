import fs from 'fs-extra';
import path from 'node:path';
import { open } from 'node:fs/promises';
import { AgentCtlError } from './errors.js';

// 建议性文件锁（advisory）。陈旧锁靠 pid 存活判定回收；已知局限：操作系统 PID 复用可能使
// 已死进程的 pid 被新进程占用，导致陈旧锁被误判为「仍存活」而不回收。单机单用户场景下
// 概率极低且可由 doctor 检查兜底；多租户/高并发场景需评估更强方案（如 flock + 超时）。

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
    let text: string;
    try {
      text = await fs.readFile(this.path, 'utf8');
    } catch (error) {
      // 文件不存在 = 无锁持有，属正常；其他读取错误向上传播。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      return JSON.parse(text) as LockData;
    } catch {
      // 并发 acquire 时可能读到另一进程正在写入的瞬时半成品；短暂等待后重读一次。
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        return JSON.parse(await fs.readFile(this.path, 'utf8')) as LockData;
      } catch (error) {
        // 重读期间文件被移除（锁持有者在此窗口内 release）= 无锁，属正常，非损坏。
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        // R17：重读仍失败 = 持久损坏，不得静默视为「无锁」被抢占，须拒绝并提示 doctor 检查。
        throw new AgentCtlError('VALIDATION_ERROR', `锁文件损坏：${this.path}`, {
          remediation: '请运行 agentctl doctor 检查锁目录，或手动清理损坏的锁文件后重试。',
          cause: error,
        });
      }
    }
  }
}
