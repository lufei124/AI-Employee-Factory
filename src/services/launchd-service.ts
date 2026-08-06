import fs from 'fs-extra';
import path from 'node:path';
import { execa } from 'execa';
import { AgentCtlError } from '../core/errors.js';
import type { ServiceAdapter, ServiceStatus } from './service-adapter.js';

export interface LaunchdPlistInput {
  label: string;
  program: string;
  args: string[];
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
  calendar?: { hour: number; minute: number };
  /** D-035：秒级重复周期（StartInterval）。与 calendar 互斥；设了则优先渲染 StartInterval。 */
  startInterval?: number;
  /** D-032：true 时 plist 写 RunAtLoad<true/>，员工随开机常驻；默认 false（定时任务等）。 */
  runAtLoad?: boolean;
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function array(values: string[]): string {
  return `<array>${values.map((value) => `<string>${xml(value)}</string>`).join('')}</array>`;
}

function dictionary(values: Record<string, string>): string {
  return `<dict>${Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join('')}</dict>`;
}

export function renderLaunchdPlist(input: LaunchdPlistInput): string {
  // D-035：StartInterval 与 StartCalendarInterval 互斥（launchd 同时指定为配置错误）。
  // 秒级周期优先，设了则忽略 calendar。
  const startInterval =
    input.startInterval !== undefined
      ? `<key>StartInterval</key><integer>${input.startInterval}</integer>`
      : '';
  const calendar =
    input.startInterval === undefined && input.calendar
      ? `<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${input.calendar.hour}</integer><key>Minute</key><integer>${input.calendar.minute}</integer></dict>`
      : '';
  const runAtLoad = input.runAtLoad === true ? '<true/>' : '<false/>';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(input.label)}</string><key>ProgramArguments</key>${array([input.program, ...input.args])}<key>EnvironmentVariables</key>${dictionary(input.env)}<key>WorkingDirectory</key><string>${xml(path.dirname(input.stdoutPath))}</string><key>StandardOutPath</key><string>${xml(input.stdoutPath)}</string><key>StandardErrorPath</key><string>${xml(input.stderrPath)}</string><key>RunAtLoad</key>${runAtLoad}${calendar}${startInterval}</dict></plist>\n`;
}

export class LaunchdServiceAdapter implements ServiceAdapter {
  readonly installedFile: string;

  constructor(
    private readonly input: LaunchdPlistInput,
    private readonly canonicalFile: string,
    home: string,
    private readonly uid = process.getuid?.() ?? 0,
  ) {
    this.installedFile = path.join(home, 'Library', 'LaunchAgents', `${input.label}.plist`);
  }

  async install(): Promise<void> {
    await fs.ensureDir(path.dirname(this.canonicalFile));
    await fs.ensureDir(path.dirname(this.installedFile));
    await fs.ensureDir(path.dirname(this.input.stdoutPath));
    // R10：预创建 launchd stdout/stderr 日志 0o600，避免 launchd 按 umask 建 0o644
    // 泄露运行时输出。已存在则收紧权限，不截断已有日志。
    for (const log of [this.input.stdoutPath, this.input.stderrPath]) {
      if (await fs.pathExists(log)) await fs.chmod(log, 0o600).catch(() => undefined);
      else await fs.writeFile(log, '', { mode: 0o600 });
    }
    const content = renderLaunchdPlist(this.input);
    await fs.writeFile(this.canonicalFile, content, { mode: 0o600 });
    await fs.copy(this.canonicalFile, this.installedFile, { overwrite: true });
  }

  async start(): Promise<void> {
    await this.install();
    const domain = `gui/${this.uid}`;
    const existing = await this.status();
    if (existing.state === 'not-installed') {
      const result = await execa('launchctl', ['bootstrap', domain, this.installedFile], {
        shell: false,
        reject: false,
      });
      if (result.exitCode !== 0)
        throw new AgentCtlError('OPERATION_FAILED', `launchd 加载失败：${result.stderr}`);
    }
    const kick = await execa('launchctl', ['kickstart', '-k', `${domain}/${this.input.label}`], {
      shell: false,
      reject: false,
    });
    if (kick.exitCode !== 0)
      throw new AgentCtlError('OPERATION_FAILED', `launchd 启动失败：${kick.stderr}`);
  }

  async enableScheduled(): Promise<void> {
    await this.install();
    const domain = `gui/${this.uid}`;
    const existing = await this.status();
    if (existing.state === 'not-installed') {
      const result = await execa('launchctl', ['bootstrap', domain, this.installedFile], {
        shell: false,
        reject: false,
      });
      if (result.exitCode !== 0) {
        throw new AgentCtlError('OPERATION_FAILED', `launchd 加载定时任务失败：${result.stderr}`);
      }
    }
  }

  async stop(): Promise<void> {
    const result = await execa('launchctl', ['bootout', `gui/${this.uid}/${this.input.label}`], {
      shell: false,
      reject: false,
    });
    if (result.exitCode !== 0 && !/not found|No such process/i.test(result.stderr)) {
      throw new AgentCtlError('OPERATION_FAILED', `launchd 停止失败：${result.stderr}`);
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async status(): Promise<ServiceStatus> {
    const result = await execa('launchctl', ['print', `gui/${this.uid}/${this.input.label}`], {
      shell: false,
      reject: false,
    });
    if (result.exitCode !== 0) return { state: 'not-installed', detail: result.stderr };
    return {
      state: /state = running/.test(result.stdout) ? 'running' : 'stopped',
      detail: result.stdout,
    };
  }

  async uninstall(): Promise<void> {
    await this.stop();
    await fs.remove(this.installedFile);
    await fs.remove(this.canonicalFile);
  }

  // D-032：改写两份 plist 的 RunAtLoad（纯文件 I/O，不触碰 launchctl）。停止时调用把
  // 「常驻」改为 false，使暂停跨重启保持；启动/重启用 bridge 默认 true（随开机拉起）。
  async setRunAtLoad(runAtLoad: boolean): Promise<void> {
    this.input.runAtLoad = runAtLoad;
    await this.install();
  }

  // D-032：从 canonical plist 解析 RunAtLoad，作为「是否常驻」的持久意图来源。
  // 文件不存在（从未 start 过）返回 false，避免把从未启动的员工误拉起。
  async isAutoStart(): Promise<boolean> {
    try {
      const content = await fs.readFile(this.canonicalFile, 'utf8');
      return /<key>RunAtLoad<\/key><true\/>/.test(content);
    } catch {
      return false;
    }
  }
}
