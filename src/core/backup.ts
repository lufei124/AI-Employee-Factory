import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
} from 'node:crypto';
import YAML from 'yaml';
import * as tar from 'tar';
import { execa } from 'execa';
import { AgentCtlError } from './errors.js';
import { getRegisteredAgent } from './agents.js';
import { assertInside, type FactoryPaths } from './paths.js';
import type { RegistryStore } from './registry.js';
import { agentConfigSchema, agentIdSchema } from '../schemas/agent-schema.js';
import { backupManifestSchema, type BackupManifest } from '../schemas/backup-schema.js';
import { registryAgentSchema } from '../schemas/registry-schema.js';

const excludedNames = new Set([
  '.env',
  'secrets.enc',
  // R7：含凭据的配置/密钥文件，备份时直接排除（restore 时需重新配凭据，与 R19 pending 对齐）
  'settings.json',
  'config.json',
  '.netrc',
  'credentials.json',
  'gcloud.json',
  'id_rsa',
  'id_ed25519',
  'id_dsa',
  'id_ecdsa',
]);
const excludedExtensions = new Set(['.pem', '.key', '.p12', '.token', '.pfx', '.keystore']);

// R27：内容扫描用 Secret 正则（AKIA AWS / sk- OpenAI·Anthropic / api_key·app_secret 赋值）
const SECRET_PATTERN =
  /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|(?:api[_-]?key|app[_-]?secret)\s*[:=]\s*[^\s]+)/i;

function shouldCopy(source: string): boolean {
  const name = path.basename(source);
  if (excludedNames.has(name)) return false;
  if (name.startsWith('.env.') && name !== '.env.example') return false;
  // SSH 私钥（id_*）排除，公钥（id_*.pub）保留可备份
  if (name.startsWith('id_') && !name.endsWith('.pub')) return false;
  return !excludedExtensions.has(path.extname(name).toLowerCase());
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
}

async function collectFiles(root: string): Promise<Array<{ path: string; sha256: string }>> {
  const result: Array<{ path: string; sha256: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile())
        result.push({ path: path.relative(root, file), sha256: await sha256(file) });
    }
  };
  await visit(root);
  return result;
}

function encryptArchive(data: Buffer, passphrase: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const header = {
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
  return `AIEF1\n${JSON.stringify(header)}\n${encrypted.toString('base64')}\n`;
}

function decryptArchive(data: string, passphrase: string): Buffer {
  const [magic, rawHeader, payload] = data.trimEnd().split('\n');
  if (magic !== 'AIEF1' || !rawHeader || !payload)
    throw new AgentCtlError('VALIDATION_ERROR', '加密备份格式无效。');
  try {
    const header = JSON.parse(rawHeader) as { salt: string; iv: string; tag: string };
    const key = scryptSync(passphrase, Buffer.from(header.salt, 'base64'), 32);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(header.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(payload, 'base64')), decipher.final()]);
  } catch (error) {
    throw new AgentCtlError('VALIDATION_ERROR', '备份密码错误或文件已损坏。', { cause: error });
  }
}

export class BackupService {
  constructor(
    private readonly paths: FactoryPaths,
    private readonly registry: RegistryStore,
  ) {}

  async backup(
    agentId: string,
    options: { output?: string; includeRuntime?: boolean; passphrase?: string } = {},
  ): Promise<string> {
    const agent = await getRegisteredAgent(this.registry, agentId);
    if (options.includeRuntime && !options.passphrase)
      throw new AgentCtlError('VALIDATION_ERROR', '包含 Runtime 的备份必须提供密码并加密。');
    await this.rejectTrackedSecrets(agent.workspace.path);
    await fs.ensureDir(this.paths.backupsDir);
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-backup-stage-'));
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const defaultName = `${agent.id}-${timestamp}${options.includeRuntime ? '.aief.enc' : '.tar.gz'}`;
    const output = path.resolve(options.output ?? path.join(this.paths.backupsDir, defaultName));
    const temporaryArchive = path.join(os.tmpdir(), `agentctl-${randomUUID()}.tar.gz`);
    try {
      await fs.copy(agent.workspace.path, path.join(stage, 'workspace'), {
        filter: shouldCopy,
        dereference: false,
      });
      await fs.writeFile(path.join(stage, 'registry-agent.yaml'), YAML.stringify(agent));
      await fs.writeFile(
        path.join(stage, 'bridge.yaml'),
        YAML.stringify({
          enabled: agent.bridge.enabled,
          profile: agent.bridge.profile,
          mode: agent.bridge.mode,
          authorization: 'requires_reauthorization',
        }),
      );
      if (options.includeRuntime)
        await fs.copy(agent.runtime_home.path, path.join(stage, 'runtime'), {
          filter: shouldCopy,
          dereference: false,
        });
      await this.rejectSecretsInStage(stage);
      const files = await collectFiles(stage);
      const manifest: BackupManifest = backupManifestSchema.parse({
        schema_version: 1,
        created_at: new Date().toISOString(),
        agent: { id: agent.id, name: agent.name, runtime: agent.runtime.provider },
        include_runtime: options.includeRuntime === true,
        files,
        environment: { node: process.version, platform: process.platform, arch: process.arch },
      });
      await fs.writeFile(path.join(stage, 'manifest.yaml'), YAML.stringify(manifest));
      await fs.writeFile(
        path.join(stage, 'checksums.txt'),
        files.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n',
      );
      await tar.c(
        { gzip: true, cwd: stage, file: temporaryArchive, portable: true },
        await fs.readdir(stage),
      );
      await fs.ensureDir(path.dirname(output));
      if (options.includeRuntime)
        await fs.writeFile(
          output,
          encryptArchive(await fs.readFile(temporaryArchive), options.passphrase as string),
          { mode: 0o600 },
        );
      else await fs.move(temporaryArchive, output, { overwrite: false });
      return output;
    } finally {
      await fs.remove(stage);
      await fs.remove(temporaryArchive).catch(() => undefined);
    }
  }

  async restore(
    backupPath: string,
    options: { newId?: string; newName?: string; passphrase?: string; dryRun?: boolean } = {},
  ): Promise<{ id: string; workspace: string }> {
    const backup = path.resolve(backupPath);
    if (!(await fs.pathExists(backup)))
      throw new AgentCtlError('NOT_FOUND', `备份不存在：${backup}`);
    const extract = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-restore-'));
    const archive = path.join(os.tmpdir(), `agentctl-restore-${randomUUID()}.tar.gz`);
    try {
      if (backup.endsWith('.enc')) {
        if (!options.passphrase) throw new AgentCtlError('AUTH_REQUIRED', '恢复加密备份需要密码。');
        await fs.writeFile(
          archive,
          decryptArchive(await fs.readFile(backup, 'utf8'), options.passphrase),
          { mode: 0o600 },
        );
      } else await fs.copyFile(backup, archive);
      await tar.x({ cwd: extract, file: archive, strict: true, preservePaths: false });
      const manifest = backupManifestSchema.parse(
        YAML.parse(await fs.readFile(path.join(extract, 'manifest.yaml'), 'utf8')),
      );
      await this.verifyChecksums(extract, manifest);
      const original = registryAgentSchema.parse(
        YAML.parse(await fs.readFile(path.join(extract, 'registry-agent.yaml'), 'utf8')),
      );
      const id = options.newId ? agentIdSchema.parse(options.newId) : original.id;
      const name = options.newName ?? original.name;
      const workspace = assertInside(
        this.paths.workspaceRoot,
        path.join(this.paths.workspaceRoot, id),
        '恢复工作区',
      );
      const runtimeHome = assertInside(
        this.paths.runtimesDir,
        path.join(this.paths.runtimesDir, id, original.runtime.provider),
        '恢复 Runtime Home',
      );
      const bridgeHome = assertInside(
        this.paths.bridgesDir,
        path.join(this.paths.bridgesDir, id),
        '恢复 Bridge Home',
      );
      const logHome = assertInside(
        this.paths.logsDir,
        path.join(this.paths.logsDir, id),
        '恢复日志目录',
      );
      if ((await this.registry.read()).agents.some((agent) => agent.id === id))
        throw new AgentCtlError('CONFLICT', `Agent 已存在：${id}`);
      for (const target of [workspace, runtimeHome, bridgeHome, logHome])
        if (await fs.pathExists(target))
          throw new AgentCtlError('CONFLICT', `恢复目标已存在：${target}`);
      if (options.dryRun) return { id, workspace };
      const stageWorkspace = path.join(this.paths.workspaceRoot, `.restore-${id}-${randomUUID()}`);
      const created: string[] = [];
      try {
        await fs.copy(path.join(extract, 'workspace'), stageWorkspace, { dereference: false });
        const configFile = path.join(stageWorkspace, 'agent.yaml');
        const config = agentConfigSchema.parse(YAML.parse(await fs.readFile(configFile, 'utf8')));
        const updated = {
          ...config,
          id,
          name,
          feishu: config.feishu.enabled ? { ...config.feishu, bridge_profile: id } : config.feishu,
        };
        await fs.writeFile(configFile, YAML.stringify(updated));
        await this.rewriteGeneratedLaunchers(stageWorkspace, original.id, id);
        await fs.move(stageWorkspace, workspace);
        created.push(workspace);
        if (
          !options.newId &&
          manifest.include_runtime &&
          (await fs.pathExists(path.join(extract, 'runtime')))
        )
          await fs.copy(path.join(extract, 'runtime'), runtimeHome, { dereference: false });
        else await fs.ensureDir(runtimeHome);
        created.push(runtimeHome);
        await fs.ensureDir(bridgeHome);
        created.push(bridgeHome);
        await fs.ensureDir(logHome);
        created.push(logHome);
        if (options.newId) await this.removeGitRemotes(workspace);
        const now = new Date().toISOString();
        const runtime = original.runtime.model
          ? {
              provider: original.runtime.provider,
              locked: true as const,
              model: original.runtime.model,
            }
          : { provider: original.runtime.provider, locked: true as const };
        await this.registry.add({
          ...original,
          id,
          name,
          status: 'stopped',
          archived: false,
          runtime,
          workspace: { path: workspace, git_repository: true },
          runtime_home: { path: runtimeHome },
          bridge: original.bridge.enabled
            ? {
                enabled: true,
                profile: id,
                home: bridgeHome,
                mode: 'dedicated_bot',
                authorization: 'pending',
              }
            : { enabled: false, home: bridgeHome, mode: 'disabled', authorization: 'pending' },
          created_at: now,
          updated_at: now,
        });
        return { id, workspace };
      } catch (error) {
        await fs.remove(stageWorkspace);
        await Promise.all(created.map((target) => fs.remove(target).catch(() => undefined)));
        throw error;
      }
    } finally {
      await fs.remove(extract);
      await fs.remove(archive).catch(() => undefined);
    }
  }

  private async verifyChecksums(root: string, manifest: BackupManifest): Promise<void> {
    const manifestPaths = new Set(manifest.files.map((entry) => entry.path));
    for (const entry of manifest.files) {
      if (path.isAbsolute(entry.path) || entry.path.split(path.sep).includes('..'))
        throw new AgentCtlError('VALIDATION_ERROR', '备份 checksum 包含非法路径。');
      const file = path.join(root, entry.path);
      if (!(await fs.pathExists(file)) || (await sha256(file)) !== entry.sha256)
        throw new AgentCtlError('VALIDATION_ERROR', `备份校验失败：${entry.path}`);
    }
    // R21：集合一致性--拒绝 extract 树中 manifest 未声明的额外文件
    // （manifest.yaml/checksums.txt 为归档时在 collectFiles 之后写入的元数据，豁免）
    const knownMeta = new Set(['manifest.yaml', 'checksums.txt']);
    const actual = await collectFiles(root);
    for (const found of actual) {
      if (knownMeta.has(found.path)) continue;
      if (!manifestPaths.has(found.path))
        throw new AgentCtlError('VALIDATION_ERROR', `备份含未声明文件：${found.path}`);
    }
  }

  private async rejectTrackedSecrets(workspace: string): Promise<void> {
    const result = await execa('git', ['ls-files'], {
      cwd: workspace,
      shell: false,
      reject: false,
    });
    if (result.exitCode !== 0) return;
    for (const relative of result.stdout.split('\n').filter(Boolean)) {
      const name = path.basename(relative);
      if (!shouldCopy(name))
        throw new AgentCtlError('VALIDATION_ERROR', `Git 已跟踪敏感文件：${relative}`, {
          remediation: `请先将 ${relative} 从 Git 跟踪中移除并更换相关凭据。`,
        });
      const file = path.join(workspace, relative);
      if ((await fs.stat(file)).size < 1024 * 1024) {
        const content = await fs.readFile(file, 'utf8');
        if (SECRET_PATTERN.test(content))
          throw new AgentCtlError(
            'VALIDATION_ERROR',
            `Git 已跟踪的文件疑似包含 Secret：${relative}`,
          );
      }
    }
  }

  // R27：对所有暂存文件（workspace 全部含未跟踪 + runtime_home）做内容扫描，
  // 命中 Secret 正则即拒绝备份并指出文件。不改动文件内容。覆盖 rejectTrackedSecrets 漏掉的未跟踪与 runtime 文件。
  private async rejectSecretsInStage(stage: string): Promise<void> {
    const scan = async (directory: string): Promise<void> => {
      if (!(await fs.pathExists(directory))) return;
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await scan(file);
        else if (entry.isFile() && (await fs.stat(file)).size < 1024 * 1024) {
          const content = await fs.readFile(file, 'utf8');
          if (SECRET_PATTERN.test(content))
            throw new AgentCtlError(
              'VALIDATION_ERROR',
              `暂存文件疑似包含 Secret：${path.relative(stage, file)}`,
              { remediation: '请从该文件移除 Secret，或将其加入备份排除名单。' },
            );
        }
      }
    };
    await scan(path.join(stage, 'workspace'));
    await scan(path.join(stage, 'runtime'));
  }

  private async rewriteGeneratedLaunchers(
    workspace: string,
    oldId: string,
    newId: string,
  ): Promise<void> {
    for (const relative of [
      'README.md',
      'deployment/start.sh',
      'deployment/run.sh',
      'deployment/health-check.sh',
      'deployment/MIGRATION.md',
    ]) {
      const file = path.join(workspace, relative);
      if (await fs.pathExists(file))
        await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replaceAll(oldId, newId));
    }
  }

  private async removeGitRemotes(workspace: string): Promise<void> {
    const listed = await execa('git', ['remote'], { cwd: workspace, shell: false, reject: false });
    if (listed.exitCode !== 0) return;
    for (const remote of listed.stdout.split('\n').filter(Boolean))
      await execa('git', ['remote', 'remove', remote], { cwd: workspace, shell: false });
  }
}
