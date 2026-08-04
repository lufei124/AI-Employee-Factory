import fs from 'fs-extra';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import YAML from 'yaml';
import { atomicWriteFile } from './atomic.js';
import { AgentCtlError } from './errors.js';
import { FileLock } from './locks.js';
import { assertInside, type FactoryPaths } from './paths.js';
import type { RegistryStore } from './registry.js';
import {
  trashIndexSchema,
  trashManifestSchema,
  type TrashComponent,
  type TrashComponentName,
  type TrashManifest,
} from '../schemas/trash-schema.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';

const retentionMs = 7 * 24 * 60 * 60 * 1000;

export interface TrashEntryDto {
  trashId: string;
  agentId: string;
  name: string;
  deletedAt: string;
  expiresAt: string;
  remainingDays: number;
  state: TrashManifest['state'];
}

export interface TrashPreview {
  agentId: string;
  components: Array<{ name: TrashComponentName; path: string; exists: boolean }>;
}

export class TrashService {
  constructor(
    private readonly paths: FactoryPaths,
    private readonly registry: RegistryStore,
  ) {}

  async preview(agent: RegistryAgent): Promise<TrashPreview> {
    const components = this.components(agent, 'preview');
    return {
      agentId: agent.id,
      components: await Promise.all(
        components.map(async (component) => ({
          name: component.name,
          path: component.source,
          exists: await fs.pathExists(component.source),
        })),
      ),
    };
  }

  async move(agent: RegistryAgent, now = new Date()): Promise<TrashEntryDto> {
    return this.lock().withLock({ purpose: `trash:move:${agent.id}` }, async () => {
      const current = (await this.registry.read()).agents.find((item) => item.id === agent.id);
      if (!current) throw new AgentCtlError('NOT_FOUND', `Agent 不存在：${agent.id}`);
      const trashId = randomUUID();
      const deletedAt = now.toISOString();
      const manifest: TrashManifest = {
        schema_version: 1,
        trash_id: trashId,
        agent_id: agent.id,
        name: agent.name,
        deleted_at: deletedAt,
        expires_at: new Date(now.getTime() + retentionMs).toISOString(),
        state: 'moving',
        registry: current,
        components: await this.componentRecords(current, trashId),
      };
      await this.saveManifest(manifest);
      try {
        await this.addToIndex(trashId);
      } catch (error) {
        await fs.remove(this.manifestFile(trashId)).catch(() => undefined);
        throw new AgentCtlError('OPERATION_FAILED', '初始化回收站条目失败。', { cause: error });
      }
      let registryRemoved = false;
      try {
        for (const component of manifest.components) {
          if (!component.existed) continue;
          await fs.ensureDir(path.dirname(component.trashed), 0o700);
          await rename(component.source, component.trashed);
          component.moved = true;
          await this.saveManifest(manifest);
        }
        await this.registry.remove(agent.id);
        registryRemoved = true;
        manifest.state = 'ready';
        await this.saveManifest(manifest);
        return this.toDto(manifest, now);
      } catch (error) {
        if (registryRemoved) await this.registry.add(current).catch(() => undefined);
        const rollbackErrors = await this.rollbackToSource(manifest.components);
        manifest.state = 'failed';
        manifest.error = rollbackErrors.length
          ? `移动失败且回滚不完整：${rollbackErrors.join(', ')}`
          : '移动失败，已回滚。';
        await this.saveManifest(manifest);
        throw new AgentCtlError('OPERATION_FAILED', `Agent ${agent.id} 移入回收站失败。`, {
          remediation: rollbackErrors.length
            ? '请运行 doctor 并检查回收站 failed 条目。'
            : '数据已回滚，可稍后重试。',
          cause: error,
        });
      }
    });
  }

  async list(now = new Date()): Promise<TrashEntryDto[]> {
    const index = await this.readIndex();
    const entries: TrashEntryDto[] = [];
    for (const trashId of index.entries) {
      const manifest = await this.readManifest(trashId).catch(() => undefined);
      if (manifest) entries.push(this.toDto(manifest, now));
    }
    return entries.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
  }

  async restore(trashId: string, now = new Date()): Promise<void> {
    await this.lock().withLock({ purpose: `trash:restore:${trashId}` }, async () => {
      const manifest = await this.readManifest(trashId);
      if (manifest.state !== 'ready') {
        throw new AgentCtlError('CONFLICT', `回收站条目当前不可恢复：${manifest.state}`);
      }
      if ((await this.registry.read()).agents.some((agent) => agent.id === manifest.agent_id)) {
        throw new AgentCtlError('CONFLICT', `Agent ID 已被占用：${manifest.agent_id}`);
      }
      for (const component of manifest.components) {
        this.validateComponent(component);
        if (component.existed && (await fs.pathExists(component.source))) {
          throw new AgentCtlError('CONFLICT', `恢复目标已存在：${component.source}`);
        }
        if (component.existed && !(await fs.pathExists(component.trashed))) {
          throw new AgentCtlError('NOT_FOUND', `回收站数据缺失：${component.name}`);
        }
        if (component.existed && (await fs.lstat(component.trashed)).isSymbolicLink()) {
          throw new AgentCtlError('VALIDATION_ERROR', `回收站组件不能是软链接：${component.name}`);
        }
      }
      manifest.state = 'restoring';
      await this.saveManifest(manifest);
      const restored: TrashComponent[] = [];
      let registryAdded = false;
      try {
        for (const component of manifest.components) {
          if (!component.existed) continue;
          await fs.ensureDir(path.dirname(component.source));
          await rename(component.trashed, component.source);
          restored.push(component);
        }
        await this.registry.add({
          ...manifest.registry,
          status: 'stopped',
          archived: false,
          // R19：恢复后强制重新授权（Bridge 凭据可能已失效），与 BackupService.restore 一致。
          bridge: { ...manifest.registry.bridge, authorization: 'pending' },
          updated_at: now.toISOString(),
        });
        registryAdded = true;
        await fs.remove(this.manifestFile(trashId));
        await this.removeFromIndex(trashId);
      } catch (error) {
        const rollbackErrors: string[] = [];
        if (registryAdded) {
          try {
            await this.registry.remove(manifest.agent_id);
            registryAdded = false;
          } catch {
            rollbackErrors.push('registry');
          }
        }
        if (!registryAdded) {
          for (const component of restored.reverse()) {
            try {
              await fs.ensureDir(path.dirname(component.trashed));
              await rename(component.source, component.trashed);
            } catch {
              rollbackErrors.push(component.name);
            }
          }
        }
        manifest.state = rollbackErrors.length ? 'failed' : 'ready';
        manifest.error = rollbackErrors.length
          ? `恢复失败且回滚不完整：${rollbackErrors.join(', ')}`
          : '恢复失败，已回滚。';
        await this.saveManifest(manifest);
        throw new AgentCtlError('OPERATION_FAILED', '恢复回收站员工失败。', { cause: error });
      }
    });
  }

  async purgeExpired(now = new Date()): Promise<{ purged: string[] }> {
    return this.lock().withLock({ purpose: 'trash:purge-expired' }, async () => {
      const index = await this.readIndex();
      const purged: string[] = [];
      for (const trashId of [...index.entries]) {
        const manifest = await this.readManifest(trashId).catch(() => undefined);
        if (
          !manifest ||
          manifest.state !== 'ready' ||
          new Date(manifest.expires_at).getTime() > now.getTime()
        ) {
          continue;
        }
        manifest.state = 'purging';
        await this.saveManifest(manifest);
        try {
          for (const component of manifest.components) {
            this.validateComponent(component);
            if (component.existed) {
              if (
                (await fs.pathExists(component.trashed)) &&
                (await fs.lstat(component.trashed)).isSymbolicLink()
              ) {
                throw new AgentCtlError(
                  'VALIDATION_ERROR',
                  `回收站组件不能是软链接：${component.name}`,
                );
              }
              await fs.remove(component.trashed);
            }
          }
          await fs.remove(this.manifestFile(trashId));
          await this.removeFromIndex(trashId);
          purged.push(trashId);
        } catch (error) {
          manifest.state = 'failed';
          manifest.error = '过期清理失败，请运行 doctor 检查。';
          await this.saveManifest(manifest);
          throw new AgentCtlError('OPERATION_FAILED', `清理回收站条目失败：${trashId}`, {
            cause: error,
          });
        }
      }
      return { purged };
    });
  }

  private lock(): FileLock {
    return new FileLock(path.join(this.paths.locksDir, 'trash.lock'));
  }

  private components(agent: RegistryAgent, trashId: string): TrashComponent[] {
    const sources: Array<[TrashComponentName, string, string]> = [
      ['workspace', agent.workspace.path, this.paths.workspaceRoot],
      ['runtime', agent.runtime_home.path, this.paths.runtimesDir],
      ['bridge', agent.bridge.home, this.paths.bridgesDir],
      ['logs', path.join(this.paths.logsDir, agent.id), this.paths.logsDir],
      ['services', path.join(this.paths.servicesDir, agent.id), this.paths.servicesDir],
      ['schedules', path.join(this.paths.schedulesDir, agent.id), this.paths.schedulesDir],
    ];
    return sources.map(([name, source, root]) => {
      const validated = assertInside(root, source, `回收站 ${name}`);
      return {
        name,
        source: validated,
        trashed: path.join(path.dirname(validated), '.agentctl-trash', trashId, name),
        existed: false,
        moved: false,
      };
    });
  }

  private async componentRecords(agent: RegistryAgent, trashId: string): Promise<TrashComponent[]> {
    const components = this.components(agent, trashId);
    for (const component of components) {
      component.existed = await fs.pathExists(component.source);
      if (component.existed && (await fs.lstat(component.source)).isSymbolicLink()) {
        throw new AgentCtlError('VALIDATION_ERROR', `拒绝移动软链接组件：${component.name}`);
      }
    }
    return components;
  }

  private validateComponent(component: TrashComponent): void {
    assertInside(this.rootFor(component.name), component.source, `回收站 ${component.name}`);
    const expected = path.join(
      path.dirname(component.source),
      '.agentctl-trash',
      path.basename(path.dirname(component.trashed)),
      component.name,
    );
    if (path.resolve(expected) !== path.resolve(component.trashed)) {
      throw new AgentCtlError('VALIDATION_ERROR', `回收站路径不合法：${component.name}`);
    }
  }

  private rootFor(name: TrashComponentName): string {
    switch (name) {
      case 'workspace':
        return this.paths.workspaceRoot;
      case 'runtime':
        return this.paths.runtimesDir;
      case 'bridge':
        return this.paths.bridgesDir;
      case 'logs':
        return this.paths.logsDir;
      case 'services':
        return this.paths.servicesDir;
      case 'schedules':
        return this.paths.schedulesDir;
    }
  }

  private async rollbackToSource(components: TrashComponent[]): Promise<string[]> {
    const errors: string[] = [];
    for (const component of [...components].reverse()) {
      if (!component.moved || !(await fs.pathExists(component.trashed))) continue;
      try {
        await fs.ensureDir(path.dirname(component.source));
        await rename(component.trashed, component.source);
        component.moved = false;
      } catch {
        errors.push(component.name);
      }
    }
    return errors;
  }

  private async ensureStorage(): Promise<void> {
    await fs.ensureDir(path.join(this.paths.trashDir, 'manifests'), 0o700);
    await fs.chmod(this.paths.trashDir, 0o700).catch(() => undefined);
  }

  private manifestFile(trashId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(trashId)) {
      throw new AgentCtlError('VALIDATION_ERROR', '回收站 ID 格式无效。');
    }
    return path.join(this.paths.trashDir, 'manifests', `${trashId}.yaml`);
  }

  private async saveManifest(manifest: TrashManifest): Promise<void> {
    await this.ensureStorage();
    const parsed = trashManifestSchema.parse(manifest);
    await atomicWriteFile(this.manifestFile(parsed.trash_id), YAML.stringify(parsed), 0o600);
  }

  private async readManifest(trashId: string): Promise<TrashManifest> {
    const file = this.manifestFile(trashId);
    if (!(await fs.pathExists(file))) {
      throw new AgentCtlError('NOT_FOUND', `回收站条目不存在：${trashId}`);
    }
    return trashManifestSchema.parse(YAML.parse(await fs.readFile(file, 'utf8')));
  }

  private async readIndex() {
    const file = path.join(this.paths.trashDir, 'index.yaml');
    if (!(await fs.pathExists(file)))
      return trashIndexSchema.parse({ schema_version: 1, entries: [] });
    return trashIndexSchema.parse(YAML.parse(await fs.readFile(file, 'utf8')));
  }

  private async saveIndex(entries: string[]): Promise<void> {
    await this.ensureStorage();
    const index = trashIndexSchema.parse({ schema_version: 1, entries: [...new Set(entries)] });
    await atomicWriteFile(
      path.join(this.paths.trashDir, 'index.yaml'),
      YAML.stringify(index),
      0o600,
    );
  }

  private async addToIndex(trashId: string): Promise<void> {
    const index = await this.readIndex();
    await this.saveIndex([...index.entries, trashId]);
  }

  private async removeFromIndex(trashId: string): Promise<void> {
    const index = await this.readIndex();
    await this.saveIndex(index.entries.filter((entry) => entry !== trashId));
  }

  private toDto(manifest: TrashManifest, now: Date): TrashEntryDto {
    return {
      trashId: manifest.trash_id,
      agentId: manifest.agent_id,
      name: manifest.name,
      deletedAt: manifest.deleted_at,
      expiresAt: manifest.expires_at,
      remainingDays: Math.max(
        0,
        Math.ceil((new Date(manifest.expires_at).getTime() - now.getTime()) / 86_400_000),
      ),
      state: manifest.state,
    };
  }
}
