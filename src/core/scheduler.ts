import fs from 'fs-extra';
import path from 'node:path';
import YAML from 'yaml';
import { atomicWriteFile } from './atomic.js';
import { AgentCtlError } from './errors.js';
import { assertInside } from './paths.js';
import { agentIdSchema } from '../schemas/agent-schema.js';
import { jobConfigSchema, type JobConfig } from '../schemas/job-schema.js';

export class JobStore {
  readonly jobsDir: string;

  constructor(readonly workspace: string) {
    this.jobsDir = path.join(workspace, 'automation', 'jobs');
  }

  async list(): Promise<JobConfig[]> {
    if (!(await fs.pathExists(this.jobsDir))) return [];
    const files = (await fs.readdir(this.jobsDir)).filter((file) => /\.ya?ml$/i.test(file)).sort();
    return Promise.all(files.map((file) => this.readFile(path.join(this.jobsDir, file))));
  }

  async get(id: string): Promise<JobConfig> {
    agentIdSchema.parse(id);
    for (const extension of ['yaml', 'yml']) {
      const file = path.join(this.jobsDir, `${id}.${extension}`);
      if (await fs.pathExists(file)) return this.readFile(file);
    }
    throw new AgentCtlError('NOT_FOUND', `定时任务不存在：${id}`);
  }

  async setEnabled(id: string, enabled: boolean): Promise<JobConfig> {
    const current = await this.get(id);
    const file = await this.fileFor(id);
    const next = jobConfigSchema.parse({ ...current, enabled });
    await atomicWriteFile(file, YAML.stringify(next), 0o644);
    return next;
  }

  async install(source: string): Promise<JobConfig> {
    const parsed = await this.readFile(source);
    await fs.ensureDir(this.jobsDir);
    const target = path.join(this.jobsDir, `${parsed.id}.yaml`);
    if (await fs.pathExists(target))
      throw new AgentCtlError('CONFLICT', `定时任务已存在：${parsed.id}`);
    await atomicWriteFile(target, YAML.stringify(parsed), 0o644);
    return parsed;
  }

  async create(input: JobConfig): Promise<JobConfig> {
    const parsed = this.validate(input);
    await fs.ensureDir(this.jobsDir);
    const target = path.join(this.jobsDir, `${parsed.id}.yaml`);
    if (await fs.pathExists(target))
      throw new AgentCtlError('CONFLICT', `定时任务已存在：${parsed.id}`);
    await atomicWriteFile(target, YAML.stringify(parsed), 0o644);
    return parsed;
  }

  async update(id: string, input: JobConfig): Promise<JobConfig> {
    agentIdSchema.parse(id);
    const currentFile = await this.fileFor(id);
    const parsed = this.validate(input);
    if (parsed.id !== id) throw new AgentCtlError('VALIDATION_ERROR', '定时任务 ID 不允许修改。');
    await atomicWriteFile(currentFile, YAML.stringify(parsed), 0o644);
    return parsed;
  }

  async uninstall(id: string): Promise<void> {
    const file = await this.fileFor(id);
    const archive = path.join(this.jobsDir, '.archive');
    await fs.ensureDir(archive);
    await fs.move(file, path.join(archive, `${id}-${Date.now()}.yaml`));
  }

  private async fileFor(id: string): Promise<string> {
    for (const extension of ['yaml', 'yml']) {
      const file = path.join(this.jobsDir, `${id}.${extension}`);
      if (await fs.pathExists(file)) return file;
    }
    throw new AgentCtlError('NOT_FOUND', `定时任务不存在：${id}`);
  }

  private async readFile(file: string): Promise<JobConfig> {
    return this.validate(YAML.parse(await fs.readFile(file, 'utf8')));
  }

  private validate(input: unknown): JobConfig {
    const parsed = jobConfigSchema.parse(input);
    const referenced =
      parsed.execution.type === 'script'
        ? parsed.execution.script_file
        : parsed.execution.prompt_file;
    assertInside(this.workspace, path.resolve(this.workspace, referenced), '任务文件');
    if (parsed.execution.type === 'agent' && parsed.execution.precheck) {
      assertInside(
        this.workspace,
        path.resolve(this.workspace, parsed.execution.precheck.script_file),
        '预检脚本',
      );
    }
    return parsed;
  }
}
