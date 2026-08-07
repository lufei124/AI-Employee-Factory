// OP6-A（T01）：受控 git 工具模块。统一走 execa(shell:false)，供读取工作区状态、
// 做基线提交与单文件提交（CURRENT_STATE / 自我进化）。零业务逻辑，纯 git 封装。
//
// 安全：所有命令在给定 cwd 内执行，不经 shell，不拼接用户可控参数进 argv（命令字面量）。
import { execa } from 'execa';

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

/** 读取某提交（缺省 HEAD）下文件的全文（git show <ref>:<path>）。供身份回滚等「从历史写回」场景。
 *  文件在该提交不存在 → 返回 undefined；git 异常（非仓库/路径越界）同样返回 undefined（调用方判 NOT_FOUND）。
 *  stripFinalNewline:false 保留文件结尾换行（回滚写回时字节级一致，不丢末行空行）。 */
export async function gitShowFile(
  workspace: string,
  relPath: string,
  ref = 'HEAD',
): Promise<string | undefined> {
  const result = await execa('git', ['show', `${ref}:${relPath}`], {
    cwd: workspace,
    shell: false,
    extendEnv: false,
    reject: false,
    stripFinalNewline: false,
  });
  if (result.exitCode !== 0) return undefined;
  return result.stdout;
}

/** git 提交记录条目。 */
export interface GitLogEntry {
  hash: string;
  subject: string;
  /** 提交时间（ISO，来自 %cI）。 */
  date: string;
}

/** 读取提交记录（git log）。可选 grep 过滤提交消息（如 `evolve:`）、limit 取最近 N 条、
 *  path 限定文件。非仓库/无记录 → 空数组。供 Web「进化历史」只读视图与审计。 */
export async function gitLog(
  workspace: string,
  options: { grep?: string; limit?: number; path?: string; ref?: string } = {},
): Promise<GitLogEntry[]> {
  const args = ['log', '--format=%H%x00%s%x00%cI'];
  // D-041 P3-1 增强：ref 指定单个提交（git log <ref> -n1），供进化历史「点提交看文件清单」。
  if (options.ref) args.push(options.ref, '-n', '1');
  if (options.grep) args.push('--grep', options.grep);
  if (options.limit !== undefined) args.push('-n', String(options.limit));
  if (options.path) args.push('--', options.path);
  const result = await execa('git', args, {
    cwd: workspace,
    shell: false,
    extendEnv: false,
    reject: false,
  });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash, subject, date] = line.split('\0');
      return { hash: hash ?? '', subject: subject ?? '', date: date ?? '' };
    });
}

/** 单次提交变更的文件条目（git show --name-status）。供 Web「进化历史」点提交看改动文件。 */
export interface GitCommitFile {
  /** 变更状态：A/M/D/R（新增/修改/删除/重命名）。 */
  status: string;
  /** 相对工作区的路径（重命名取新路径）。 */
  path: string;
}

/** 读取单次提交变更的文件清单。ref 无效/非仓库 → 空数组（调用方判 NOT_FOUND）。 */
export async function gitShowCommitFiles(workspace: string, ref: string): Promise<GitCommitFile[]> {
  const result = await execa('git', ['show', '--name-status', '--format=', ref], {
    cwd: workspace,
    shell: false,
    extendEnv: false,
    reject: false,
  });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .filter((line) => /\S/.test(line))
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      // 重命名行 `R100\told\tnew` → 取新路径（该提交下存在）。
      const path = (status ?? '').startsWith('R') && rest.length >= 2 ? rest[1] : rest[0];
      return { status: (status ?? '').charAt(0), path: path ?? '' };
    })
    .filter((entry) => entry.path.length > 0);
}
