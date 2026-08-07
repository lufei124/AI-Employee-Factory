import path from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import chalk from 'chalk';
import { Command } from 'commander';
import { confirm, input, password, select } from '@inquirer/prompts';
import type { CreateAgentInput } from './core/create-agent.js';
import type { GeneratedProfile } from './core/employee-generator.js';
import { generateSkill, renderSkillFile } from './core/skill-generator.js';
import { AgentCtlError } from './core/errors.js';
import { OperationStore } from './core/operation-store.js';
import { resolveFactoryPaths, displayPath } from './core/paths.js';
import { RegistryStore } from './core/registry.js';
import type { RuntimeProvider } from './schemas/agent-schema.js';
import { FactoryApplication } from './application/factory-application.js';
import { settleLaunchdService } from './services/factory-services.js';
import { startWebConsole } from './web/start.js';

function context() {
  const paths = resolveFactoryPaths();
  const registry = new RegistryStore(paths.registryFile);
  return { paths, application: new FactoryApplication(paths, registry) };
}

function runtimeSetupCommand(provider: RuntimeProvider, id: string): string {
  return provider === 'claude' ? `agentctl runtime sync ${id}` : `agentctl runtime login ${id}`;
}

async function confirmDanger(message: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!(await confirm({ message, default: false })))
    throw new AgentCtlError('OPERATION_FAILED', '操作已取消。');
}

// OP4-B：CLI 发起的 run/job 记录摘要到 operations.jsonl（best-effort，失败不影响操作结果）。
// web 路径由 OperationManager 记录；此函数仅覆盖 CLI 主路径，使 agentctl operations query 可查 CLI 发起操作。
async function recordOperation(
  logsDir: string,
  input: Parameters<OperationStore['record']>[0],
): Promise<void> {
  await new OperationStore(logsDir).record(input).catch(() => undefined);
}

function slugFromName(name: string): string {
  const id = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id;
}

/** 返回合法 Agent ID（kebab-case 英文），否则返回空串（供 fallback 到人工输入）。 */
function validAgentId(value: string | undefined): string {
  return value && /^[a-z0-9][a-z0-9-]*$/.test(value) ? value : '';
}

async function createInputFromOptions(
  options: Record<string, unknown>,
  generated?: GeneratedProfile,
): Promise<CreateAgentInput> {
  const runtime =
    (options.runtime as RuntimeProvider | undefined) ??
    (await select({
      message: '选择运行器',
      choices: [
        { name: 'Claude Code', value: 'claude' },
        { name: 'OpenAI Codex', value: 'codex' },
      ],
    }));
  const derivedId = generated ? validAgentId(generated.id) || slugFromName(generated.name) : '';
  const id =
    (options.id as string | undefined) ?? (derivedId || (await input({ message: 'Agent ID' })));
  const name =
    (options.name as string | undefined) ??
    (generated ? generated.name : await input({ message: '员工名称' }));
  const feishu = (options.feishu as 'dedicated' | 'disabled' | undefined) ?? 'dedicated';
  const result: CreateAgentInput = { id, name, runtime, feishu };
  if (typeof options.description === 'string') result.description = options.description;
  if (Array.isArray(options.goal)) result.goals = options.goal as string[];
  if (typeof options.model === 'string') result.model = options.model;
  // T08：角色（worker 默认 / chief）。options.role 总带默认，显式校验仅接受合法值。
  if (typeof options.role === 'string') result.role = options.role as CreateAgentInput['role'];
  return result;
}

export function createProgram(): Command {
  const program = new Command('agentctl')
    .description('本地 AI 员工创建与管理平台')
    .version('0.1.0');

  program
    .command('web')
    .description('启动本机 Web 管理控制台')
    .option('--port <port>', '本机端口，0 表示自动选择', '0')
    .option('--no-open', '不自动打开浏览器')
    .action(async (options: { port: string; open: boolean }) => {
      const port = Number(options.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new AgentCtlError('VALIDATION_ERROR', 'port 必须是 0 到 65535 的整数。');
      }
      const { application } = context();
      const running = await startWebConsole({
        application,
        port,
        openBrowser: options.open,
        handleSignals: true,
      });
      console.log(chalk.green('✓ Web 管理控制台已启动'));
      console.log(`地址：${running.url}`);
      console.log('按 Ctrl+C 停止。');
    });

  program
    .command('init')
    .description('初始化 AI Employees 控制面')
    .option('--dry-run', '只显示将创建的目录')
    .action(async (options: { dryRun?: boolean }) => {
      const { paths, application } = context();
      if (options.dryRun) {
        console.log(YAML.stringify(paths));
        return;
      }
      await application.initialize();
      console.log(chalk.green('✓ Factory 已初始化'));
      console.log(`Node.js: ${process.version}`);
      for (const [name, version] of Object.entries(await application.dependencyVersions()))
        console.log(`${name}: ${version}`);
      console.log(`Registry: ${displayPath(paths.registryFile)}`);
    });

  program
    .command('create')
    .description('创建隔离的 AI 员工')
    .option('--id <id>')
    .option('--name <name>')
    .option('--runtime <provider>', 'claude 或 codex')
    .option('--feishu <mode>', 'dedicated 或 disabled', 'dedicated')
    .option('--describe <description>', '用一句话描述员工用法，由 AI 生成蓝图')
    .option('--description <description>')
    .option('--goal <goal...>')
    .option('--model <model>')
    .option('--role <role>', 'worker 或 chief（默认 worker）', 'worker')
    .option('--dry-run')
    .action(async (options: Record<string, unknown>) => {
      const { paths, application } = context();
      await application.initialize();
      // D-029：--describe 先用本地 Claude 生成员工蓝图，再预填 createInput。
      let generated: GeneratedProfile | undefined;
      if (typeof options.describe === 'string' && options.describe.trim().length > 0) {
        generated = await application.generateProfile(
          options.describe,
          typeof options.model === 'string' ? { model: options.model } : undefined,
        );
        console.log(chalk.cyan('AI 生成员工蓝图：'));
        console.log(
          YAML.stringify({
            id: validAgentId(generated.id) || slugFromName(generated.name),
            name: generated.name,
            description: generated.description,
            goals: generated.goals,
          }),
        );
      }
      const createInput = await createInputFromOptions(options, generated);
      if (generated) {
        createInput.description = generated.description;
        createInput.goals = generated.goals;
        createInput.responsibilities = generated.responsibilities;
        createInput.policies = generated.policies;
        createInput.escalation_conditions = generated.escalation_conditions;
        createInput.skills = generated.skills;
      }
      if (options.dryRun) {
        console.log(
          YAML.stringify({
            input: createInput,
            workspace: path.join(paths.workspaceRoot, createInput.id),
            runtime_home: path.join(paths.runtimesDir, createInput.id, createInput.runtime),
            bridge_home: path.join(paths.bridgesDir, createInput.id),
          }),
        );
        return;
      }
      const result = await application.createAgent(createInput);
      console.log(chalk.green(`✓ 已创建 ${createInput.name} (${result.id})`));
      console.log(`Workspace: ${displayPath(result.workspace)}`);
      console.log(`下一步: ${runtimeSetupCommand(createInput.runtime, result.id)}`);
      if (createInput.feishu === 'dedicated')
        console.log(`飞书授权: agentctl bridge authorize ${result.id}`);
      console.log(`诊断: agentctl doctor ${result.id}`);
    });

  program
    .command('list')
    .description('列出 AI 员工')
    .action(async () => {
      const { application } = context();
      const agents = await application.listAgents();
      if (!agents.length) return console.log('尚未创建 AI 员工。');
      for (const agent of agents)
        console.log(`${agent.id}\t${agent.name}\t${agent.role}\t${agent.runtime}\t${agent.status}`);
    });

  program
    .command('show <agent-id>')
    .description('显示 Agent 配置')
    .action(async (id: string) => {
      const { application } = context();
      console.log(YAML.stringify(await application.getAgent(id)));
    });

  for (const verb of ['start', 'stop', 'restart', 'status'] as const) {
    program
      .command(`${verb} <agent-id>`)
      .description(`${verb} Agent 后台服务`)
      .action(async (id: string) => {
        const { application } = context();
        const result = await application.lifecycleAction(id, verb);
        if (verb === 'status') console.log(`${id}: ${result.state}`);
        else console.log(chalk.green(`✓ ${id} ${verb}`));
      });
  }

  program
    .command('chat <agent-id>')
    .description('进入 Agent 交互会话')
    .action(async (id: string) => {
      const { application } = context();
      process.exitCode = await application.chat(id);
    });

  program
    .command('logs <agent-id>')
    .description('查看 Agent 最新日志')
    .option('--lines <count>', '显示行数', '200')
    .option('--follow', '持续跟随')
    .action(async (id: string, options: { lines: string; follow?: boolean }) => {
      const { application } = context();
      const lines = Number(options.lines);
      if (options.follow) {
        process.exitCode = await application.followLatestLog(id, lines);
      } else {
        console.log((await application.readLatestLog(id, lines)).content);
      }
    });

  const runtime = program.command('runtime').description('运行器 Provider 配置、登录与状态');
  runtime
    .command('sync <agent-id>')
    .description('同步 CC Switch 当前 Claude Provider（可用 --provider 指定具体 Provider）')
    .option(
      '--provider <name>',
      '绑定并同步 CC Switch 中指定的 Provider（live 清除绑定回退当前 Provider）',
    )
    .action(async (id: string, options: { provider?: string }) => {
      const { application } = context();
      // exactOptionalPropertyTypes：仅在有显式值时传入 provider，undefined 缺省（live 语义）。
      const summary = await application.syncRuntime(
        id,
        options.provider === undefined ? {} : { provider: options.provider },
      );
      console.log(
        chalk.green(`✓ 已同步 CC Switch Provider（${summary?.keys.length ?? 0} 项配置）`),
      );
    });
  runtime.command('login <agent-id>').action(async (id: string) => runRuntimeAuth(id, 'login'));
  runtime.command('status <agent-id>').action(async (id: string) => runRuntimeAuth(id, 'status'));

  const bridge = program.command('bridge').description('飞书 Bridge 授权与状态');
  bridge
    .command('authorize <agent-id>')
    .option('--app-id <id>')
    .option('--tenant <tenant>', 'feishu 或 lark', 'feishu')
    .action(async (id: string, options: { appId?: string; tenant: 'feishu' | 'lark' }) => {
      const { application } = context();
      process.exitCode = await application.bridgeAuthorize(id, options);
    });
  bridge.command('status <agent-id>').action(async (id: string) => {
    const { application } = context();
    const result = await application.bridgeStatus(id);
    if (result.exitCode === 0) {
      console.log(result.output);
    } else {
      console.log('待授权');
      process.exitCode = 5;
    }
  });
  // D-035：飞书主入口——立即沉淀员工 skill/记忆，或管理周期 settle 任务（StartInterval）。
  bridge
    .command('settle [agent-id]')
    .description('沉淀员工 skill/记忆（adopt/提交/reconcile），或管理周期任务')
    .option('--install', '为该员工安装周期 settle 任务')
    .option('--uninstall', '卸载周期 settle 任务')
    .option('--interval <seconds>', '周期间隔（秒），默认 300', '300')
    .action(
      async (
        id: string | undefined,
        options: { install?: boolean; uninstall?: boolean; interval: string },
      ) => {
        const { application, paths } = context();
        const ids = id ? [id] : await application.listBridgeEnabledIds();
        if (!ids.length) return console.log('没有已启用飞书 Bridge 的员工。');
        for (const agentId of ids) {
          const { registry, agent } = await application.getAgent(agentId);
          if (options.install) {
            await settleLaunchdService(
              registry,
              agent.runtime,
              paths,
              Number(options.interval),
            ).start();
            console.log(chalk.green(`✓ ${agentId} 周期 settle 已安装（每 ${options.interval}s）`));
          } else if (options.uninstall) {
            await settleLaunchdService(registry, agent.runtime, paths, 0).uninstall();
            console.log(chalk.green(`✓ ${agentId} 周期 settle 已卸载`));
          } else {
            await application.settleEmployee(agentId);
            console.log(chalk.green(`✓ ${agentId} settle 完成`));
          }
        }
      },
    );

  registerJobCommands(program);
  registerSkillCommands(program);
  registerTrashCommands(program);
  registerKnowledgeCommands(program);
  registerPruneCommands(program);
  registerUsageCommands(program);
  registerIdentityCommands(program);

  program
    .command('archive <agent-id>')
    .description('非破坏性归档 Agent')
    .option('--dry-run')
    .option('--yes')
    .action(async (id: string, options: { dryRun?: boolean; yes?: boolean }) => {
      const { application } = context();
      const { registry: agent } = await application.getAgent(id);
      if (options.dryRun)
        return console.log(`将停止服务并归档 ${id}，保留 ${displayPath(agent.workspace.path)}`);
      await confirmDanger(`归档 ${id}？Workspace 和正式记忆会保留。`, options.yes === true);
      await application.archiveAgent(id);
      console.log(chalk.green(`✓ ${id} 已归档`));
    });

  program
    .command('repair <agent-id>')
    .description('以 agent.yaml 重建 Registry config_hash，修复配置漂移')
    .action(async (id: string) => {
      const { application } = context();
      const result = await application.repairAgent(id);
      console.log(chalk.green(`✓ ${result.id} 已修复（config_hash 已刷新）`));
    });

  program
    .command('migrate')
    .description('将 Registry 从 v1（含 runtime 块）升级为 v2（移除 runtime 块），SOFT 迁移')
    .option('--dry-run', '仅预览，不写盘')
    .action(async (options: { dryRun?: boolean }) => {
      const { application } = context();
      const result = await application.migrate(options.dryRun ? { dryRun: true } : {});
      if (options.dryRun) {
        console.log(
          result.migrated
            ? 'Registry 为 v1，可安全迁移至 v2（移除 runtime 块，config_hash 保留）。'
            : 'Registry 已是 v2，无需迁移。',
        );
        return;
      }
      console.log(
        result.migrated
          ? chalk.green('✓ Registry 已迁移至 v2（移除 runtime 块）。')
          : 'Registry 已是 v2，无需迁移。',
      );
    });

  program
    .command('doctor [agent-id]')
    .description('诊断 Factory 或 Agent')
    .action(async (id?: string) => {
      const { application } = context();
      const report = await application.doctor(id);
      for (const check of report.checks) {
        const marker =
          check.status === 'pass'
            ? chalk.green('通过')
            : check.status === 'warn'
              ? chalk.yellow('警告')
              : chalk.red('失败');
        console.log(`${marker}  ${check.label}：${check.detail}`);
        if (check.remediation) console.log(`      解决方法：${check.remediation}`);
      }
      console.log(
        `汇总：${report.summary.pass} 通过 / ${report.summary.warn} 警告 / ${report.summary.fail} 失败`,
      );
      if (report.summary.fail > 0) process.exitCode = 6;
    });
  program
    .command('backup <agent-id>')
    .description('备份 Agent')
    .option('--output <path>')
    .option('--include-runtime')
    .action(async (id: string, options: { output?: string; includeRuntime?: boolean }) => {
      const { application } = context();
      const backupOptions: { output?: string; includeRuntime?: boolean; passphrase?: string } = {};
      if (options.output) backupOptions.output = options.output;
      if (options.includeRuntime) {
        backupOptions.includeRuntime = true;
        backupOptions.passphrase = await password({
          message: '请输入 Runtime 备份加密密码',
          mask: '*',
        });
      }
      const output = await application.createBackup(id, backupOptions);
      console.log(chalk.green(`✓ 备份已生成：${displayPath(output)}`));
    });
  program
    .command('restore <backup-path>')
    .description('恢复 Agent 备份')
    .option('--new-id <id>')
    .option('--new-name <name>')
    .option('--dry-run')
    .option('--yes')
    .action(
      async (
        backupPath: string,
        options: { newId?: string; newName?: string; dryRun?: boolean; yes?: boolean },
      ) => {
        const { application } = context();
        const encrypted = backupPath.endsWith('.enc');
        const passphrase = encrypted
          ? await password({ message: '请输入备份解密密码', mask: '*' })
          : undefined;
        if (!options.dryRun)
          await confirmDanger(
            `从 ${path.resolve(backupPath)} 恢复 Agent？不会覆盖已有数据。`,
            options.yes === true,
          );
        const restoreOptions: {
          newId?: string;
          newName?: string;
          passphrase?: string;
          dryRun?: boolean;
        } = {};
        if (options.newId) restoreOptions.newId = options.newId;
        if (options.newName) restoreOptions.newName = options.newName;
        if (passphrase) restoreOptions.passphrase = passphrase;
        if (options.dryRun) restoreOptions.dryRun = true;
        const result = await application.restoreBackupPath(backupPath, restoreOptions);
        console.log(
          options.dryRun
            ? YAML.stringify(result)
            : chalk.green(`✓ 已恢复 ${result.id}：${displayPath(result.workspace)}`),
        );
        if (!options.dryRun) {
          const { agent } = await application.getAgent(result.id);
          console.log(
            `下一步：${runtimeSetupCommand(agent.runtime.provider, result.id)} && agentctl doctor ${result.id}`,
          );
        }
      },
    );

  const internal = new Command('_service').description('内部 launchd 入口');
  program.addCommand(internal, { hidden: true });
  internal.command('bridge <agent-id>').action(async (id: string) => {
    const { application } = context();
    process.exitCode = await application.runBridgeService(id);
  });
  internal.command('job <agent-id> <job-id>').action(async (id: string, jobId: string) => {
    const { application } = context();
    process.exitCode = await application.runJobService(id, jobId);
  });
  // D-035：周期/手动触发的员工沉淀（adopt/提交/reconcile，无 transcript）。
  internal.command('settle <agent-id>').action(async (id: string) => {
    const { application } = context();
    await application.settleEmployee(id);
  });
  // D-035：飞书 bridge 逐消息拦截——把每条 `claude -p` 送回 runLogged + 完整沉淀链。
  // 用 `--` 分隔时 commander14 的 variadic 解析有坑（`-- <args...>` 收不到 `-p`），
  // 故用 `<args...>` + allowUnknownOption/allowExcessArguments，把 `--` 及后续当普通参数透传。
  internal
    .command('bridge-run <agent-id> <args...>')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (id: string, args: string[]) => {
      const { application } = context();
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      process.exitCode = await application.runBridgeMessage(
        id,
        args,
        Buffer.concat(chunks).toString('utf8'),
      );
    });
  program.hook('preAction', async (_root, actionCommand) => {
    const ancestry: string[] = [];
    for (let current: Command | null = actionCommand; current; current = current.parent) {
      ancestry.push(current.name());
    }
    if (ancestry.includes('_service') || actionCommand.opts().dryRun === true) return;
    const { application } = context();
    if (!(await application.factoryStatus()).initialized) return;
    await application.purgeExpiredTrash().catch((error: unknown) => {
      console.warn(
        chalk.yellow(
          `警告：回收站过期清理失败：${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
  });
  return program;
}

function registerTrashCommands(program: Command): void {
  const group = program.command('trash').description('员工回收站管理');
  group
    .command('move <agent-id>')
    .description('将员工全部受管数据移入 7 天回收站')
    .option('--dry-run')
    .option('--yes')
    .action(async (id: string, options: { dryRun?: boolean; yes?: boolean }) => {
      const { application } = context();
      if (options.dryRun) {
        console.log(YAML.stringify(await application.trashAgent(id, { dryRun: true })));
        return;
      }
      await confirmDanger(`将 ${id} 的全部数据移入回收站？7 天内可以恢复。`, options.yes === true);
      const entry = await application.trashAgent(id);
      console.log(chalk.green(`✓ ${id} 已移入回收站：${entry.trashId}`));
    });
  group
    .command('list')
    .description('列出可恢复员工')
    .action(async () => {
      const { application } = context();
      const entries = await application.listTrash();
      if (!entries.length) return console.log('回收站为空。');
      for (const entry of entries) {
        console.log(
          `${entry.trashId}\t${entry.agentId}\t${entry.state}\t剩余 ${entry.remainingDays} 天`,
        );
      }
    });
  group
    .command('restore <trash-id>')
    .description('恢复回收站员工为 stopped')
    .option('--dry-run')
    .option('--yes')
    .action(async (trashId: string, options: { dryRun?: boolean; yes?: boolean }) => {
      const { application } = context();
      if (options.dryRun) {
        console.log(YAML.stringify(await application.restoreTrash(trashId, { dryRun: true })));
        return;
      }
      await confirmDanger(`恢复回收站条目 ${trashId}？`, options.yes === true);
      await application.restoreTrash(trashId);
      console.log(chalk.green(`✓ 已恢复 ${trashId}`));
    });
  group
    .command('purge [trash-id]')
    .description(
      '永久清理回收站条目；不指定 ID 则清理所有已过期条目，指定 ID 配合 --force 可清理失败/卡死条目',
    )
    .option('--force', '强制清理指定 ID（含 failed/moving/purging 态）')
    .option('--dry-run')
    .option('--yes')
    .action(
      async (
        trashId: string | undefined,
        options: { force?: boolean; dryRun?: boolean; yes?: boolean },
      ) => {
        const { application } = context();
        if (trashId) {
          if (options.dryRun) {
            console.log(YAML.stringify(await application.purgeTrash(trashId, { dryRun: true })));
            return;
          }
          await confirmDanger(`永久清理回收站条目 ${trashId}？`, options.yes === true);
          await application.purgeTrash(trashId, { force: options.force === true });
          console.log(chalk.green(`✓ 已清理 ${trashId}`));
          return;
        }
        if (options.force)
          throw new AgentCtlError('VALIDATION_ERROR', '--force 需配合指定 <trash-id> 使用。');
        if (options.dryRun) {
          console.log(YAML.stringify(await application.purgeExpiredTrash({ dryRun: true })));
          return;
        }
        await confirmDanger('永久清理所有已超过 7 天的回收站条目？', options.yes === true);
        const result = await application.purgeExpiredTrash();
        console.log(chalk.green(`✓ 已永久清理 ${result.purged.length} 个条目`));
      },
    );
}

async function runRuntimeAuth(id: string, operation: 'login' | 'status'): Promise<void> {
  const { application } = context();
  const { agent } = await application.getAgent(id);
  process.exitCode = await application.runtimeAuth(id, operation);
  if (agent.runtime.provider === 'claude' && process.exitCode === 0) {
    console.log(
      chalk.green(
        operation === 'login'
          ? '✓ Claude 默认使用 CC Switch，当前 Provider 已同步；未执行官方 OAuth 登录。'
          : '✓ CC Switch 当前 Claude Provider 可用且已同步。',
      ),
    );
  }
}

function registerJobCommands(program: Command): void {
  const group = program.command('job').description('定时任务管理');
  group.command('list <agent-id>').action(async (id: string) => {
    const { application } = context();
    for (const job of await application.listJobs(id))
      console.log(
        `${job.id}\t${job.enabled ? 'enabled' : 'disabled'}\t${job.schedule.time}\t${job.execution.type}`,
      );
  });
  group.command('validate <agent-id> [job-id]').action(async (id: string, jobId?: string) => {
    const { application } = context();
    const all = await application.listJobs(id);
    const jobs = jobId ? all.filter((job) => job.id === jobId) : all;
    if (jobId && jobs.length === 0)
      throw new AgentCtlError('NOT_FOUND', `定时任务不存在：${jobId}`);
    console.log(chalk.green(`✓ ${jobs.length} 个任务配置有效`));
  });
  group.command('run <agent-id> <job-id>').action(async (id: string, jobId: string) => {
    const { paths, application } = context();
    const job = (await application.listJobs(id)).find((item) => item.id === jobId);
    if (!job) throw new AgentCtlError('NOT_FOUND', `定时任务不存在：${jobId}`);
    if (!job.enabled) console.log(chalk.yellow('注意：正在手工运行已禁用任务。'));
    const operationId = randomUUID();
    const traceId = randomUUID();
    const result = await application.runJob(id, jobId, { operationId, traceId });
    await recordOperation(paths.logsDir, {
      operation_id: operationId,
      agent_id: id,
      kind: 'job',
      started_at: result.startedAt!,
      finished_at: result.finishedAt!,
      exit_code: result.exitCode,
      trace_id: traceId,
    });
    process.exitCode = result.exitCode;
  });
}

function registerSkillCommands(program: Command): void {
  const group = program.command('skill').description('Skill 管理');
  group.command('list <agent-id>').action(async (id: string) => {
    const { application } = context();
    for (const skill of await application.listSkills(id))
      console.log(`${skill.name}\t${skill.scope}\t${skill.version}\t${skill.digest.slice(0, 12)}`);
  });
  group
    .command('install <agent-id> <skill-path>')
    .option('--dry-run')
    .option('--scope <project|user>', '安装作用域（默认 project）', 'project')
    .action(
      async (
        id: string,
        source: string,
        options: { dryRun?: boolean; scope?: 'project' | 'user' },
      ) => {
        if (options.dryRun)
          return console.log(`将从 ${path.resolve(source)} 安装 Skill（scope=${options.scope}）`);
        const { application } = context();
        const skill = await application.installSkill(id, source, options.scope);
        console.log(chalk.green(`✓ 已安装 ${skill.name}@${skill.version}（${skill.scope}）`));
      },
    );
  group
    .command('remove <agent-id> <skill-name>')
    .option('--dry-run')
    .option('--yes')
    .option('--scope <project|user>', '卸载作用域（默认 project）', 'project')
    .action(
      async (
        id: string,
        name: string,
        options: { dryRun?: boolean; yes?: boolean; scope?: 'project' | 'user' },
      ) => {
        if (options.dryRun) return console.log(`将卸载 Skill ${name}（scope=${options.scope}）`);
        await confirmDanger(
          `卸载 Skill ${name}（${options.scope}）？此操作不可恢复。`,
          options.yes === true,
        );
        const { application } = context();
        await application.removeSkill(id, name, options.scope);
      },
    );
  group
    .command('create-self <agent-id> <brief>')
    .description('D-034 用本地 Claude 为员工生成并注册一个 Skill（自建）')
    .option('--model <model>', '生成所用 Claude 模型')
    .option('--scope <project|user>', '作用域（默认 project）', 'project')
    .option('--dry-run', '只预览将生成的 SKILL.md，不落盘')
    .action(
      async (
        id: string,
        brief: string,
        options: { model?: string; scope?: 'project' | 'user'; dryRun?: boolean },
      ) => {
        if (options.dryRun) {
          const skill = await generateSkill(brief, options.model ? { model: options.model } : {});
          return console.log(renderSkillFile(skill));
        }
        const { application } = context();
        const metadata = await application.createSkillForAgent(id, brief, {
          ...(options.model ? { model: options.model } : {}),
          ...(options.scope ? { scope: options.scope } : {}),
        });
        console.log(chalk.green(`✓ 已为员工生成并注册 Skill ${metadata.name}@${metadata.version}`));
      },
    );
  group
    .command('adopt <agent-id> <skill-name>')
    .description('D-034 给员工手动写盘的 skill 补写元数据并投影（原位修复）')
    .option('--scope <project|user>', '作用域（默认 project）', 'project')
    .action(async (id: string, name: string, options: { scope?: 'project' | 'user' }) => {
      const { application } = context();
      const metadata = await application.adoptSkill(id, name, options.scope);
      console.log(chalk.green(`✓ 已 adopt Skill ${metadata.name}@${metadata.version}`));
    });
  group
    .command('rollback <agent-id> <skill-name>')
    .description('D-034 从 .archive 恢复员工某 skill 的历史版本')
    .option('--scope <project|user>', '作用域（默认 project）', 'project')
    .option('--archive-ref <ref>', '归档引用（缺省取最新）')
    .option('--yes')
    .action(
      async (
        id: string,
        name: string,
        options: { scope?: 'project' | 'user'; archiveRef?: string; yes?: boolean },
      ) => {
        await confirmDanger(
          `回滚 Skill ${name}（${options.scope ?? 'project'}）到历史版本？`,
          options.yes === true,
        );
        const { application } = context();
        const metadata = await application.rollbackSkill(
          id,
          name,
          options.scope,
          options.archiveRef,
        );
        console.log(chalk.green(`✓ 已回滚 Skill ${metadata.name}@${metadata.version}`));
      },
    );

  const storeGroup = program
    .command('skill-store')
    .description('Skill 商店（内置 first-party + GitHub 仓库源）');
  storeGroup.command('list-repos').action(async () => {
    const { application } = context();
    for (const repo of await application.listSkillStoreRepositories())
      console.log(
        `${repo.name}\t${repo.source === 'local' ? '(bundled)' : repo.url}\t${repo.cached ? 'cached' : 'not-cached'}\t${repo.lastRefreshedAt ?? ''}`,
      );
  });
  storeGroup
    .command('add-repo <name> <url>')
    .option('--description <text>')
    .action(async (name: string, url: string, options: { description?: string }) => {
      const { application } = context();
      const repo = await application.addSkillStoreRepository(
        options.description ? { name, url, description: options.description } : { name, url },
      );
      console.log(chalk.green(`✓ 已添加仓库源 ${repo.name}（${repo.url}）`));
    });
  storeGroup
    .command('remove-repo <name>')
    .option('--yes')
    .action(async (name: string, options: { yes?: boolean }) => {
      await confirmDanger(`移除仓库源 ${name}？`, options.yes === true);
      await context().application.removeSkillStoreRepository(name);
      console.log(chalk.green(`已移除仓库源 ${name}`));
    });
  storeGroup.command('refresh <name>').action(async (name: string) => {
    const { application } = context();
    const repo = await application.refreshSkillStoreRepository(name);
    console.log(chalk.green(`✓ 已刷新 ${repo.name}（${repo.lastRefreshedAt}）`));
  });
  storeGroup.command('list-skills <name>').action(async (name: string) => {
    const { application } = context();
    for (const skill of await application.listSkillStoreSkills(name))
      console.log(`${skill.name}\t${skill.version}\t${skill.path}`);
  });
  storeGroup
    .command('install <agent-id> <repo-name> <skill-path>')
    .option('--scope <project|user>', '安装作用域（默认 project）', 'project')
    .action(
      async (
        id: string,
        repoName: string,
        skillPath: string,
        options: { scope?: 'project' | 'user' },
      ) => {
        const { application } = context();
        const skill = await application.installSkillFromStore(
          repoName,
          skillPath,
          id,
          options.scope,
        );
        console.log(chalk.green(`✓ 已从商店安装 ${skill.name}@${skill.version}（${skill.scope}）`));
      },
    );

  const operationsGroup = program.command('operations').description('操作审计日志查询');
  operationsGroup
    .command('query')
    .description('查询持久化的操作摘要（logs/operations.jsonl）')
    .option('--agent <agent-id>')
    .option('--kind <kind>')
    .option('--since <iso>')
    .option('--until <iso>')
    .option('--limit <number>', '返回最近 N 条', '100')
    .action(
      async (options: {
        agent?: string;
        kind?: string;
        since?: string;
        until?: string;
        limit?: string;
      }) => {
        const { application } = context();
        const summaries = await application.queryOperations({
          ...(options.agent ? { agentId: options.agent } : {}),
          ...(options.kind ? { kind: options.kind } : {}),
          ...(options.since ? { since: options.since } : {}),
          ...(options.until ? { until: options.until } : {}),
          limit: options.limit ? Number(options.limit) : 100,
        });
        console.log(YAML.stringify(summaries));
      },
    );
}

function registerPruneCommands(program: Command): void {
  program
    .command('prune')
    .description('按分类清理 run 日志/registry 备份/员工备份归档/operations 审计日志')
    .option('--logs', '清理 Agent run 日志')
    .option('--registry-backups', '清理 registry 备份')
    .option('--archives', '清理员工备份归档')
    .option('--operations', '清理 operations 审计日志')
    .option('--dry-run', '仅预览，不实际清理')
    .option('--yes', '跳过确认')
    .option('--keep-days <number>', '按天数保留（logs/archives/operations）')
    .option('--keep-count <number>', '按数量保留（registry-backups）')
    .action(
      async (options: {
        logs?: boolean;
        registryBackups?: boolean;
        archives?: boolean;
        operations?: boolean;
        dryRun?: boolean;
        yes?: boolean;
        keepDays?: string;
        keepCount?: string;
      }) => {
        const { application } = context();
        const base = {
          logs: options.logs === true,
          registryBackups: options.registryBackups === true,
          archives: options.archives === true,
          operations: options.operations === true,
          ...(options.keepDays ? { keepDays: Number(options.keepDays) } : {}),
          ...(options.keepCount ? { keepCount: Number(options.keepCount) } : {}),
        };
        const preview = await application.prune({ ...base, dryRun: true });
        console.log(YAML.stringify(preview));
        if (options.dryRun) return;
        await confirmDanger('按上述预览执行清理？', options.yes === true);
        const result = await application.prune({ ...base, dryRun: false });
        for (const scope of result.scopes) {
          console.log(
            chalk.green(
              `✓ ${scope.scope}：清理 ${scope.paths.length} 项，释放 ${scope.freedBytes} 字节`,
            ),
          );
        }
        const total = result.scopes.reduce((sum, scope) => sum + scope.freedBytes, 0);
        console.log(chalk.green(`✓ 共释放 ${total} 字节`));
      },
    );
}

// D-036：飞书实际使用日志查询（本地 SQLite usage.db）。
function registerUsageCommands(program: Command): void {
  const group = program.command('usage').description('飞书实际使用日志查询');
  group
    .command('query')
    .description('查询每条飞书消息的使用记录（logs/usage.db）')
    .option('--agent <agent-id>')
    .option('--since <iso>')
    .option('--until <iso>')
    .option('--limit <number>', '返回最近 N 条', '100')
    .action(async (options: { agent?: string; since?: string; until?: string; limit?: string }) => {
      const { application } = context();
      const messages = await application.queryUsage({
        ...(options.agent ? { agentId: options.agent } : {}),
        ...(options.since ? { since: options.since } : {}),
        ...(options.until ? { until: options.until } : {}),
        limit: options.limit ? Number(options.limit) : 100,
      });
      console.log(YAML.stringify(messages));
    });
  group
    .command('summary')
    .description('聚合统计：按天 + 员工的消息数/平均耗时/总成本/错误数')
    .option('--agent <agent-id>')
    .option('--since <iso>')
    .option('--until <iso>')
    .action(async (options: { agent?: string; since?: string; until?: string }) => {
      const { application } = context();
      const rows = await application.usageSummary({
        ...(options.agent ? { agentId: options.agent } : {}),
        ...(options.since ? { since: options.since } : {}),
        ...(options.until ? { until: options.until } : {}),
      });
      console.log(YAML.stringify(rows));
    });
}

// OP1 Stage B：knowledge/ 轻量索引 + recall 命令组。
function registerKnowledgeCommands(program: Command): void {
  const group = program.command('knowledge').description('知识库索引与召回');
  group
    .command('rebuild <agent-id>')
    .description('扫描 knowledge/**/*.md 重建关键词索引（写入 knowledge/.index.json）')
    .action(async (id: string) => {
      const { application } = context();
      const result = await application.knowledgeIngest(id);
      console.log(chalk.green(`✓ 已索引 ${result.entries} 条知识 → ${result.indexFile}`));
    });
  group
    .command('recall <agent-id> <query>')
    .description('按关键词从知识库召回相关条目')
    .action(async (id: string, query: string) => {
      const { application } = context();
      const result = await application.knowledgeRecall(id, query);
      if (result.hits.length === 0) {
        console.log('未命中任何知识条目。');
        return;
      }
      for (const { entry, score, matchedKeywords, evidence } of result.hits) {
        console.log(
          `${chalk.green(entry.relPath)}  (score=${score}, 命中: ${matchedKeywords.join(', ')})`,
        );
        console.log(`  ${entry.title}`);
        if (entry.summary) console.log(`  ${entry.summary}`);
        if (evidence && evidence.length > 0) {
          console.log(`  ${chalk.cyan('证据:')}`);
          for (const line of evidence) console.log(`    ${line}`);
        }
      }
    });
  group
    .command('verify <agent-id>')
    .description('校验索引与 knowledge/ 内容一致（索引漂移检测）')
    .action(async (id: string) => {
      const { application } = context();
      const consistency = await application.knowledgeVerify(id);
      if (consistency.ok) {
        console.log(chalk.green('✓ 索引一致。'));
        return;
      }
      for (const issue of consistency.issues) console.log(`- ${issue.detail}`);
      process.exitCode = 6;
    });
  // D-041 P2-1：knowledge 遗忘归档命令组。
  group
    .command('retention <agent-id>')
    .description(
      '将 lessons/raw 与 lessons/refined 中超过保留期（默认 90 天）的条目移入 knowledge/.archive/（移走非删除，可恢复）',
    )
    .option('--days <number>', '保留天数', '90')
    .action(async (id: string, options: { days?: string }) => {
      const { application } = context();
      const days = options.days !== undefined ? Number(options.days) : 90;
      if (!Number.isFinite(days) || days <= 0)
        throw new AgentCtlError('VALIDATION_ERROR', '--days 必须是正整数。');
      const result = await application.knowledgeArchiveStale(id, { retentionDays: days });
      if (result.archived.length === 0) {
        console.log('没有需要归档的陈旧条目。');
        return;
      }
      for (const entry of result.archived) console.log(`- ${entry.from} → ${entry.to}`);
      console.log(chalk.green(`✓ 已归档 ${result.archived.length} 条，索引已重建。`));
    });
  group
    .command('archive-list <agent-id>')
    .description('列出 knowledge/.archive/ 下已归档的经验条目（可恢复）')
    .action(async (id: string) => {
      const { application } = context();
      const entries = await application.knowledgeListArchive(id);
      if (entries.length === 0) return console.log('归档为空。');
      for (const entry of entries) console.log(`${entry.date}\t${entry.relPath}`);
    });
  group
    .command('restore <agent-id> <archive-rel-path> [target-rel-path]')
    .description(
      '从 knowledge/.archive/ 恢复一条经验条目回 lessons/（移回即重新入索引）。可选指定恢复目标相对路径',
    )
    .action(async (id: string, archiveRelPath: string, targetRel?: string) => {
      const { application } = context();
      const result = await application.knowledgeRestore(id, archiveRelPath, targetRel);
      console.log(chalk.green(`✓ 已恢复 → knowledge/${result.restored}`));
    });
  group
    .command('purge <agent-id> <archive-rel-path>')
    .description('彻底删除一条已归档经验条目（不可恢复，谨慎使用）')
    .option('--yes')
    .action(async (id: string, archiveRelPath: string, options: { yes?: boolean }) => {
      const { application } = context();
      await confirmDanger(`永久删除归档条目 ${archiveRelPath}？`, options.yes === true);
      await application.knowledgePurgeArchive(id, archiveRelPath);
      console.log(chalk.green('✓ 已永久删除。'));
    });
}

// D-041 P2-2/P3-3：身份文档命令组。rollback 是身份文档的 git 回滚逃生口；proposals 列提案
// 状态机（proposed/approved/rejected/applied/expired），供审计「哪些身份改动有批准依据」。
function registerIdentityCommands(program: Command): void {
  const group = program.command('identity').description('员工身份文档管理');
  group
    .command('rollback <agent-id> <file>')
    .description(
      '把员工身份文档回滚到指定提交（缺省 HEAD 上一版本）。写回工作区 + evolve 提交 + 刷新身份基线',
    )
    .option('--ref <commit>', '回滚到的提交（git show 的 ref，缺省 HEAD）')
    .option('--yes')
    .action(async (id: string, file: string, options: { ref?: string; yes?: boolean }) => {
      const { application } = context();
      const ref = options.ref ?? 'HEAD';
      await confirmDanger(
        `将 ${id} 的身份文档 ${file} 回滚到 ${ref}？现有改动将被覆盖并进 evolve 提交。`,
        options.yes === true,
      );
      const result = await application.identityRollback(id, file, { ref });
      console.log(
        chalk.green(`✓ ${result.relPath} 已回滚到 ${result.ref}（${result.restoredAt}）`),
      );
    });
  group
    .command('proposals <agent-id>')
    .description(
      '列出员工提案账本状态机（proposed/approved/rejected/applied/expired，含批准依据 user_anchor）',
    )
    .action(async (id: string) => {
      const { paths, application } = context();
      await application.getAgent(id); // 校验员工存在。
      const { readLedger } = await import('./core/proposal-ledger.js');
      const ledger = await readLedger(paths.logsDir, id);
      if (ledger.length === 0) {
        console.log('提案账本为空。');
        return;
      }
      for (const row of ledger) {
        if (row.event === 'proposal') {
          const { kind, target_file } = row as { kind?: string; target_file?: string };
          console.log(
            `[${new Date(row.ts).toISOString().slice(0, 19)}] 提案 ${row.proposal_id} ${row.status}` +
              `${kind ? `（${kind}` : ''}${target_file ? `, ${target_file}` : ''}${kind || target_file ? '）' : ''}`,
          );
        } else {
          const { decision, user_anchor, target_file } = row as {
            decision: string;
            user_anchor?: string;
            target_file?: string;
          };
          console.log(
            `[${new Date(row.ts).toISOString().slice(0, 19)}] 决策 ${row.proposal_id} → ${decision}` +
              `${target_file ? `（${target_file}` : ''}${user_anchor ? `，依据：${user_anchor}` : ''}${target_file || user_anchor ? '）' : ''}`,
          );
        }
      }
    });
}
