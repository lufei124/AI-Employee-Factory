// OP6-A（T01）：受控 git 工具模块。统一走 execa(shell:false)，供审查门读取工作区状态、
// 生成 diff、做工作区内容快照，以及 create-agent 的基线提交。零业务逻辑，纯 git 封装。
//
// 安全：所有命令在给定 cwd 内执行，不经 shell，不拼接用户可控参数进 argv（命令字面量）。
import { execa } from 'execa';
import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'fs-extra';

export interface GitStatusEntry {
  /** 状态码（如 'M'、'??'、'A'）。 */
  code: string;
  /** 相对工作区的路径（含目录）。 */
  path: string;
}

/** 读取工作区相对某 base 的变更状态（git status --short）。 */
export async function gitStatusShort(workspace: string, base = '.'): Promise<GitStatusEntry[]> {
  const result = await execa('git', ['status', '--short', '--', base], {
    cwd: workspace,
    shell: false,
    extendEnv: false,
    reject: false,
  });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const code = line.slice(0, 2).trim();
      const file = line.slice(3).trim();
      return { code, path: file };
    });
}

/** 暂存并提交工作区全部变更（基线提交 / 任务完成提交用）。 */
export async function gitAddCommit(
  workspace: string,
  message: string,
  options: {
    /** 提交前是否需要 git user 配置；缺失时返回 false 而非抛错（可恢复提示）。 */
    requireIdentity?: boolean;
  } = {},
): Promise<boolean> {
  if (!(await checkIdentity(workspace, options.requireIdentity))) return false;
  const add = await execa('git', ['add', '-A'], {
    cwd: workspace,
    shell: false,
    extendEnv: false,
    reject: false,
  });
  if (add.exitCode !== 0) return false;
  const commit = await execa('git', ['commit', '-m', message, '--allow-empty'], {
    cwd: workspace,
    shell: false,
    extendEnv: false,
    reject: false,
  });
  return commit.exitCode === 0;
}

/** 检查仓库是否已配置 git user.name / user.email（本地或全局）。
 *  requireIdentity === false 时跳过检查（可恢复提示场景）。 */
async function checkIdentity(
  workspace: string,
  requireIdentity: boolean | undefined,
): Promise<boolean> {
  if (requireIdentity === false) return true;
  const tries = [
    ['config', 'user.name'],
    ['config', 'user.email'],
  ];
  let ok = 0;
  for (const args of tries) {
    const result = await execa('git', args, {
      cwd: workspace,
      shell: false,
      extendEnv: false,
      reject: false,
    });
    if (result.exitCode === 0 && result.stdout.trim().length > 0) ok += 1;
  }
  return ok === 2;
}

/** 暂存并提交单个文件（OP6-B：CURRENT_STATE 自动更新用）。只 add 目标文件，绝不用 add -A，
 *  防误收员工工作区中未提交的其他成果。 */
export async function gitCommitFile(
  workspace: string,
  relPath: string,
  message: string,
  options: {
    /** 提交前是否需要 git user 配置；缺失时返回 false 而非抛错（可恢复提示）。 */
    requireIdentity?: boolean;
  } = {},
): Promise<boolean> {
  if (!(await checkIdentity(workspace, options.requireIdentity))) return false;
  const add = await execa('git', ['add', '--', relPath], {
    cwd: workspace,
    shell: false,
    extendEnv: false,
    reject: false,
  });
  if (add.exitCode !== 0) return false;
  const commit = await execa('git', ['commit', '-m', message, '--allow-empty'], {
    cwd: workspace,
    shell: false,
    extendEnv: false,
    reject: false,
  });
  return commit.exitCode === 0;
}

/** 生成某 base 相对当前 HEAD 的未提交 diff（审查门用）。base 为相对路径。 */
export async function gitDiff(workspace: string, base = '.'): Promise<string> {
  const result = await execa('git', ['diff', '--', base], {
    cwd: workspace,
    shell: false,
    extendEnv: false,
    reject: false,
  });
  if (result.exitCode !== 0) return '';
  return result.stdout;
}

/** 对工作区内容做快照哈希（规划门脏审计用）。返回按相对路径排序后的 sha256。 */
export async function snapshotWorkspaceHash(workspace: string): Promise<string> {
  const hash = createHash('sha256');
  const entries = await collectFiles(workspace);
  for (const entry of entries) {
    hash.update(entry.relative);
    hash.write('\0');
    hash.write(entry.content);
    hash.write('\0');
  }
  return hash.digest('hex');
}

interface WorkspaceFile {
  relative: string;
  content: Buffer;
}

/** 递归收集工作区文件（跳过 .git 与常见编辑器临时文件），按相对路径排序。 */
async function collectFiles(workspace: string): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    names.sort();
    for (const name of names) {
      if (name === '.git') continue;
      const absolute = path.join(dir, name);
      let stat;
      try {
        stat = await fs.stat(absolute);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await walk(absolute);
      } else if (stat.isFile() && !isIgnoredTemp(name)) {
        let content: Buffer;
        try {
          content = await fs.readFile(absolute);
        } catch {
          continue;
        }
        files.push({ relative: path.relative(workspace, absolute), content });
      }
    }
  };
  await walk(workspace);
  return files;
}

function isIgnoredTemp(name: string): boolean {
  return name.endsWith('.tmp');
}
