import fs from 'fs-extra';
import path from 'node:path';
import { execa } from 'execa';
import { atomicWriteFile } from './atomic.js';
import { gitCommitFile, gitStatusShort } from './git.js';
import type { FactoryPaths } from './paths.js';
import { JobStore } from './scheduler.js';
import { jobLaunchdService } from '../services/factory-services.js';
import type { AgentConfig } from '../schemas/agent-schema.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';

// D-028：员工自我配置定时任务（按需）。员工可在任务执行中写 automation/jobs/*.yaml
// （managed_by: employee + enabled: true），系统在每次 run/chat/job 结束后自动 reconcile：
// 安装 launchd 调度、检测删除/停用并反注册、单文件 git 提交。best-effort，绝不抛错阻断主流程。
//
// 变更检测：plist 内容仅随 job.schedule.time 变化（ProgramArguments 只编码 agent+jobId，
// execution 详情在 job-run 时由 JobRunner 读取），故以 schedule.time 作为版本书签对比决定是否重装。

/** 卸载一个员工 job 的 launchd 调度（按确定性 label/路径，不依赖 job 配置是否存在）。 */
async function uninstallEmployeeJob(
  agentId: string,
  jobId: string,
  paths: FactoryPaths,
): Promise<void> {
  const uid = process.getuid?.() ?? 0;
  const label = `com.aiemployees.${agentId}.job.${jobId}`;
  await execa('launchctl', ['bootout', `gui/${uid}/${label}`], {
    shell: false,
    reject: false,
  }).catch(() => undefined);
  await fs.remove(path.join(paths.schedulesDir, agentId, `${jobId}.plist`));
  await fs.remove(path.join(paths.userHome, 'Library', 'LaunchAgents', `${label}.plist`));
}

/** 清单文件：记录上次已调度的 employee job 及其 schedule.time（用于检测删除/停用/改时间）。 */
function manifestFile(paths: FactoryPaths, agentId: string): string {
  return path.join(paths.schedulesDir, agentId, '.employee-jobs.json');
}

async function readManifest(file: string): Promise<Record<string, string>> {
  try {
    if (!(await fs.pathExists(file))) return {};
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    // 损坏清单忽略，按空处理（下次全量重装）。
    return {};
  }
}

async function commitJobFile(workspace: string, relPath: string, message: string): Promise<void> {
  try {
    const committed = await gitCommitFile(workspace, relPath, message, { requireIdentity: false });
    if (!committed) {
      console.warn(`[job-reconcile] 提交 ${relPath} 失败（缺 git 身份或 git 异常），跳过。`);
    }
  } catch (error) {
    console.warn(`[job-reconcile] 提交 ${relPath} 失败：`, error);
  }
}

/**
 * 对单个 agent 的员工 job 做 reconcile。best-effort：任何单 job 失败仅 console.warn，
 * 不阻断其余 job 或调用方主流程。
 */
export async function reconcileEmployeeJobs(
  registry: RegistryAgent,
  agent: AgentConfig,
  paths: FactoryPaths,
): Promise<void> {
  try {
    const workspace = registry.workspace.path;
    const store = new JobStore(workspace);
    const employeeJobs = (await store.listTolerant()).filter(
      (job) => job.managed_by === 'employee',
    );
    const desired = new Map(
      employeeJobs.filter((job) => job.enabled).map((job) => [job.id, job.schedule.time]),
    );

    const manifest = manifestFile(paths, registry.id);
    const previous = await readManifest(manifest);

    // 反注册：之前调度过但现在不在 desired（job 被删除或 enabled:false）。
    for (const id of Object.keys(previous)) {
      if (desired.has(id)) continue;
      await uninstallEmployeeJob(registry.id, id, paths).catch((error) =>
        console.warn(`[job-reconcile] 反注册任务 ${id} 失败：`, error),
      );
    }

    // 安装/更新 desired 中每个 job；schedule.time 变更 → 先反注册再重装（让 launchd 重新加载日历）。
    const next: Record<string, string> = {};
    for (const job of employeeJobs) {
      if (!job.enabled) continue;
      next[job.id] = job.schedule.time;
      try {
        if (previous[job.id] !== undefined && previous[job.id] !== job.schedule.time) {
          await uninstallEmployeeJob(registry.id, job.id, paths);
        }
        await jobLaunchdService(registry, agent.runtime, job, paths).enableScheduled();
      } catch (error) {
        console.warn(`[job-reconcile] 调度任务 ${job.id} 失败：`, error);
      }
    }

    // 写回清单（0600，仅记录 reconcile 自己调度的 employee job）。
    if (Object.keys(next).length > 0 || Object.keys(previous).length > 0) {
      await fs.ensureDir(path.dirname(manifest));
      await atomicWriteFile(manifest, JSON.stringify(next), 0o600);
    }

    // 单文件 git 提交新增/变更的员工 job YAML（沿用自我进化纪律：只 add -- <relPath>）。
    for (const job of employeeJobs) {
      const relPath = path.relative(workspace, await store.fileFor(job.id));
      if ((await gitStatusShort(workspace, relPath)).length > 0) {
        await commitJobFile(workspace, relPath, `job: 更新 ${job.id}`);
      }
    }
  } catch (error) {
    console.warn(`[job-reconcile] 员工任务 reconcile 失败：`, error);
  }
}
