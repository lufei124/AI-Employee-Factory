import fs from 'fs-extra';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { atomicWriteFile } from './atomic.js';
import { AgentCtlError } from './errors.js';
import { FileLock } from './locks.js';
import {
  REGISTRY_VERSION,
  registrySchema,
  registrySchemaV1,
  type Registry,
  type RegistryAgent,
  type RegistryV1,
} from '../schemas/registry-schema.js';

// OP3-A 长期：v1（含 runtime 块）在内存中规范化为 v2（丢弃 runtime，保留 config_hash 与其余字段），不丢数据。
function normalizeRegistryV1(v1: RegistryV1): Registry {
  return registrySchema.parse({
    version: REGISTRY_VERSION,
    agents: v1.agents.map(({ runtime: _runtime, ...rest }) => rest),
  });
}

export class RegistryStore {
  constructor(
    readonly file: string,
    readonly locksDir?: string,
  ) {}

  async initialize(): Promise<void> {
    if (await fs.pathExists(this.file)) {
      await this.read();
      return;
    }
    await atomicWriteFile(
      this.file,
      YAML.stringify({ version: REGISTRY_VERSION, agents: [] }),
      0o600,
    );
  }

  async read(): Promise<Registry> {
    if (!(await fs.pathExists(this.file))) {
      throw new AgentCtlError('NOT_FOUND', `Registry 不存在：${this.file}`, {
        remediation: '请先运行 agentctl init。',
      });
    }
    try {
      const raw = YAML.parse(await fs.readFile(this.file, 'utf8'));
      if (raw && typeof raw === 'object' && raw.version === 1) {
        return normalizeRegistryV1(registrySchemaV1.parse(raw));
      }
      return registrySchema.parse(raw);
    } catch (error) {
      throw new AgentCtlError('VALIDATION_ERROR', `Registry 格式无效：${this.file}`, {
        remediation: '请从 registry/backups 恢复最近备份，然后运行 agentctl doctor。',
        cause: error,
      });
    }
  }

  // SOFT 迁移：仅当磁盘仍为 v1 时重写为 v2（清理残留），v2 无操作。
  async migrate(options: { dryRun?: boolean } = {}): Promise<{ migrated: boolean }> {
    if (!this.locksDir) {
      await this.read();
      return { migrated: false };
    }
    let migrated = false;
    const lock = new FileLock(path.join(this.locksDir, 'registry.lock'));
    await this.serialize(lock, async () => {
      const raw = YAML.parse(await fs.readFile(this.file, 'utf8'));
      if (raw && typeof raw === 'object' && raw.version === 1) {
        const norm = normalizeRegistryV1(registrySchemaV1.parse(raw));
        migrated = true;
        if (!options.dryRun) await atomicWriteFile(this.file, YAML.stringify(norm), 0o600);
      }
    });
    return { migrated };
  }

  async add(agent: RegistryAgent): Promise<void> {
    const parsed = registrySchema.shape.agents.element.parse(agent);
    await this.update((registry) => {
      this.assertUnique(registry, parsed);
      return { ...registry, agents: [...registry.agents, parsed] };
    });
  }

  async updateAgent(id: string, update: (agent: RegistryAgent) => RegistryAgent): Promise<void> {
    await this.update((registry) => {
      const index = registry.agents.findIndex((agent) => agent.id === id);
      if (index < 0) throw new AgentCtlError('NOT_FOUND', `Agent 不存在：${id}`);
      const current = registry.agents[index];
      if (!current) throw new AgentCtlError('NOT_FOUND', `Agent 不存在：${id}`);
      const next = registrySchema.shape.agents.element.parse(update(current));
      const others = registry.agents.filter((_, agentIndex) => agentIndex !== index);
      this.assertUnique({ ...registry, agents: others }, next);
      return { ...registry, agents: registry.agents.map((item, i) => (i === index ? next : item)) };
    });
  }

  // OP3-A 长期：repair 的受信重建路径--以 agent.yaml 的 runtime 块为唯一真相刷新 config_hash。
  // Registry 不再持有 runtime 块，无 provider/locked/model 可重建，仅刷新指纹。
  async refreshConfigHash(id: string, configHash: string): Promise<void> {
    await this.update((registry) => {
      const index = registry.agents.findIndex((agent) => agent.id === id);
      if (index < 0) throw new AgentCtlError('NOT_FOUND', `Agent 不存在：${id}`);
      const current = registry.agents[index];
      if (!current) throw new AgentCtlError('NOT_FOUND', `Agent 不存在：${id}`);
      const next = registrySchema.shape.agents.element.parse({
        ...current,
        config_hash: configHash,
        updated_at: new Date().toISOString(),
      });
      return { ...registry, agents: registry.agents.map((item, i) => (i === index ? next : item)) };
    });
  }

  async remove(id: string): Promise<RegistryAgent> {
    let removed: RegistryAgent | undefined;
    await this.update((registry) => {
      removed = registry.agents.find((agent) => agent.id === id);
      if (!removed) throw new AgentCtlError('NOT_FOUND', `Agent 不存在：${id}`);
      return { ...registry, agents: registry.agents.filter((agent) => agent.id !== id) };
    });
    if (!removed) throw new AgentCtlError('NOT_FOUND', `Agent 不存在：${id}`);
    return removed;
  }

  private assertUnique(registry: Registry, candidate: RegistryAgent): void {
    if (registry.agents.some((agent) => agent.id === candidate.id)) {
      throw new AgentCtlError('CONFLICT', `Agent 已存在：${candidate.id}`);
    }
    if (
      registry.agents.some(
        (agent) => path.resolve(agent.workspace.path) === path.resolve(candidate.workspace.path),
      )
    ) {
      throw new AgentCtlError('CONFLICT', `工作区已被其他 Agent 绑定：${candidate.workspace.path}`);
    }
    if (
      registry.agents.some(
        (agent) =>
          path.resolve(agent.runtime_home.path) === path.resolve(candidate.runtime_home.path),
      )
    ) {
      throw new AgentCtlError(
        'CONFLICT',
        `Runtime Home 已被其他 Agent 绑定：${candidate.runtime_home.path}`,
      );
    }
    if (
      candidate.bridge.profile &&
      registry.agents.some((agent) => agent.bridge.profile === candidate.bridge.profile)
    ) {
      throw new AgentCtlError('CONFLICT', `Bridge Profile 已存在：${candidate.bridge.profile}`);
    }
  }

  private async update(transform: (registry: Registry) => Registry): Promise<void> {
    // R15：读-改-写全程持全局 registry.lock，防并发丢失员工条目。
    // 未传 locksDir 时（如部分测试）保持无锁路径，向后兼容。
    if (!this.locksDir) {
      return this.updateUnlocked(transform);
    }
    const lock = new FileLock(path.join(this.locksDir, 'registry.lock'));
    await this.serialize(lock, () => this.updateUnlocked(transform));
  }

  /**
   * FileLock 本身是 fail-fast（并发 acquire 即拒绝）。对用户可见的 Registry 写入改为
   * 有界重试，使 Web+CLI 并发更新排队完成而非立即抛 LOCKED。非 LOCKED 错误直传。
   */
  private async serialize<T>(lock: FileLock, operation: () => Promise<T>): Promise<T> {
    const maxAttempts = 80;
    const delayMs = 25;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await lock.withLock({ purpose: 'registry:update' }, operation);
      } catch (error) {
        if (!(error instanceof AgentCtlError) || error.code !== 'LOCKED') throw error;
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  private async updateUnlocked(transform: (registry: Registry) => Registry): Promise<void> {
    const current = await this.read();
    await this.backup();
    const next = registrySchema.parse(transform(current));
    await atomicWriteFile(this.file, YAML.stringify(next), 0o600);
  }

  private async backup(): Promise<void> {
    const backupDir = path.join(path.dirname(this.file), 'backups');
    await fs.ensureDir(backupDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.copyFile(
      this.file,
      path.join(backupDir, `agents-${stamp}-${randomUUID().slice(0, 8)}.yaml`),
    );
  }
}
