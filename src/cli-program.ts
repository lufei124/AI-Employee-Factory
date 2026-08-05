import path from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import chalk from 'chalk';
import { Command } from 'commander';
import { confirm, input, password, select } from '@inquirer/prompts';
import type { CreateAgentInput } from './core/create-agent.js';
import { AgentCtlError } from './core/errors.js';
import { OperationStore } from './core/operation-store.js';
import { resolveFactoryPaths, displayPath } from './core/paths.js';
import { RegistryStore } from './core/registry.js';
import type { RuntimeProvider } from './schemas/agent-schema.js';
import { FactoryApplication } from './application/factory-application.js';
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

async function createInputFromOptions(options: Record<string, unknown>): Promise<CreateAgentInput> {
  const runtime =
    (options.runtime as RuntimeProvider | undefined) ??
    (await select({
      message: '选择运行器',
      choices: [
        { name: 'Claude Code', value: 'claude' },
        { name: 'OpenAI Codex', value: 'codex' },
      ],
    }));
  const preset = options.preset as string | undefined;
  const id = (options.id as string | undefined) ?? (await input({ message: 'Agent ID' }));
  const name = (options.name as string | undefined) ?? (await input({ message: '员工名称' }));
  const feishu = (options.feishu as 'dedicated' | 'disabled' | undefined) ?? 'dedicated';
  const result: CreateAgentInput = { id, name, runtime, feishu };
  if (preset) result.preset = preset;
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
    .option('--mcp', '启用 MCP Streamable HTTP 端点（/mcp，静态 bearer 认证）')
    .action(async (options: { port: string; open: boolean; mcp?: boolean }) => {
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
        ...(options.mcp ? { enableMcp: true } : {}),
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
    .option('--preset <preset>')
    .option('--feishu <mode>', 'dedicated 或 disabled', 'dedicated')
    .option('--description <description>')
    .option('--goal <goal...>')
    .option('--model <model>')
    .option('--role <role>', 'worker 或 chief（默认 worker）', 'worker')
    .option('--dry-run')
    .action(async (options: Record<string, unknown>) => {
      const { paths, application } = context();
      await application.initialize();
      const createInput = await createInputFromOptions(options);
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
    .command('run <agent-id> <task>')
    .description('执行单次 Agent 任务')
    .option('--timeout <seconds>', '超时秒数', '900')
    .action(async (id: string, task: string, options: { timeout: string }) => {
      const { paths, application } = context();
      const operationId = randomUUID();
      const traceId = randomUUID();
      const result = await application.runAgent(id, task, Number(options.timeout), {
        operationId,
        traceId,
      });
      await recordOperation(paths.logsDir, {
        operation_id: operationId,
        agent_id: id,
        kind: 'run',
        started_at: result.startedAt,
        finished_at: result.finishedAt,
        exit_code: result.exitCode,
        trace_id: traceId,
      });
      process.exitCode = result.exitCode;
    });

  // ===== Chief 编排核心闭环（spec-chief-orchestration）：plan 命令组 + chief run =====
  const plan = program.command('plan').description('Todo 任务计划编排（Chief 编排核心闭环）');
  plan
    .command('list <owner-id>')
    .description('列出该员工工作区下的任务计划')
    .action(async (ownerId: string) => {
      const { application } = context();
      const plans = await application.listTaskPlans(ownerId);
      if (!plans.length) return console.log('尚无任务计划。');
      for (const p of plans)
        console.log(`${p.id}\t${p.status}\t${p.name}\titems=${p.items.length}`);
    });
  plan
    .command('create <owner-id> <plan-id> <name>')
    .description('新建一个空任务计划（draft）')
    .action(async (ownerId: string, planId: string, name: string) => {
      const { application } = context();
      const created = await application.createTaskPlan(ownerId, { id: planId, name });
      console.log(chalk.green(`✓ 已创建计划 ${created.id}（状态 ${created.status}）`));
    });
  plan
    .command('add <owner-id> <plan-id> <item-id> <agent> <prompt>')
    .description('往计划追加一个任务项（执行员工 + 提示词）')
    .option('--depends <id...>', '依赖的任务项 id')
    .action(
      async (
        ownerId: string,
        planId: string,
        itemId: string,
        agent: string,
        prompt: string,
        options: { depends?: string[] },
      ) => {
        const { application } = context();
        const updated = await application.addTaskItem(ownerId, planId, {
          id: itemId,
          title: itemId,
          agent,
          prompt,
          ...(options.depends && options.depends.length ? { dependencies: options.depends } : {}),
        });
        console.log(
          chalk.green(`✓ 已追加任务项 ${itemId}（计划 ${planId}，共 ${updated.items.length} 项）`),
        );
      },
    );
  plan
    .command('get <owner-id> <plan-id>')
    .description('查看计划详情（每项状态/员工/依赖/审查）')
    .action(async (ownerId: string, planId: string) => {
      const { application } = context();
      const p = await application.getTaskPlan(ownerId, planId);
      console.log(YAML.stringify(p));
    });
  plan
    .command('confirm <owner-id> <plan-id>')
    .description('确认计划（draft→active，可派发）')
    .action(async (ownerId: string, planId: string) => {
      const { application } = context();
      const p = await application.confirmPlan(ownerId, planId);
      console.log(chalk.green(`✓ 计划 ${p.id} 已确认（${p.status}）`));
    });
  plan
    .command('reject <owner-id> <plan-id>')
    .description('驳回计划（draft→cancelled，可附反馈）')
    .option('-n, --note <text>', '驳回反馈')
    .action(async (ownerId: string, planId: string, options: { note?: string }) => {
      const { application } = context();
      const p = await application.rejectPlan(ownerId, planId, options.note);
      console.log(chalk.yellow(`计划 ${p.id} 已驳回（${p.status}）${p.note ? `：${p.note}` : ''}`));
    });
  plan
    .command('run <owner-id> <plan-id>')
    .description('派发已确认计划（默认串行，--concurrency 可选并发）')
    .option('--concurrency <n>', '并发数', '1')
    .action(async (ownerId: string, planId: string, options: { concurrency?: string }) => {
      const { application } = context();
      const operation = await application.runTaskPlan(ownerId, planId, {
        ...(options.concurrency ? { concurrency: Number(options.concurrency) } : {}),
      });
      console.log(chalk.cyan(`操作 ${operation.id} 已启动（${operation.state}），等待派发完成…`));
      // 派发期间打印进度行（summary 聚合：N/M 完成 · 执行中 …）。
      const unsubscribe = application.operationManager.subscribe(operation.id, (event) => {
        if (typeof event.summary === 'string')
          process.stdout.write(`\r${chalk.dim(event.summary.padEnd(60))}`);
      });
      try {
        await application.waitOperation(operation.id);
        process.stdout.write('\n');
      } finally {
        unsubscribe();
      }
      const p = await application.getTaskPlan(ownerId, planId);
      for (const item of p.items)
        console.log(
          `${item.id}\t${item.status}${item.exit_code !== undefined ? `\texit=${item.exit_code}` : ''}`,
        );
    });
  plan
    .command('review <owner-id> <plan-id>')
    .description('对等待审查的任务项做 Chief 交叉审查（D-017 单向搬运）')
    .option('--chief <chief-id>', '执行审查的 Chief 员工 id（默认 owner）')
    .action(async (ownerId: string, planId: string, options: { chief?: string }) => {
      const { application } = context();
      const chiefId = options.chief ?? ownerId;
      const p = await application.reviewTaskPlan(ownerId, chiefId, planId);
      for (const item of p.items)
        if (item.review)
          console.log(`${item.id}\t${item.review.verdict}\t${item.review.note ?? ''}`);
    });
  plan
    .command('confirm-review <owner-id> <plan-id> <item-id>')
    .description('人工确认合并某任务项（awaiting_review→completed）')
    .action(async (ownerId: string, planId: string, itemId: string) => {
      const { application } = context();
      const p = await application.confirmReview(ownerId, planId, itemId);
      console.log(chalk.green(`✓ 任务项 ${itemId} 已合并（计划 ${p.id}）`));
    });
  plan
    .command('reject-review <owner-id> <plan-id> <item-id>')
    .description('人工驳回某任务项返工（awaiting_review→developing）')
    .option('-n, --note <text>', '驳回反馈')
    .action(async (ownerId: string, planId: string, itemId: string, options: { note?: string }) => {
      const { application } = context();
      const p = await application.rejectReview(ownerId, planId, itemId, options.note);
      console.log(chalk.yellow(`任务项 ${itemId} 已驳回返工（计划 ${p.id}）`));
    });

  const chiefGroup = program.command('chief').description('Chief 编排');
  chiefGroup
    .command('run <chief-id> <goal>')
    .description('一句话把目标交给 Chief 走完整条流水线（拆解→确认→派发→审查）')
    .option('--concurrency <n>', '并发数', '1')
    .action(async (chiefId: string, goal: string, options: { concurrency?: string }) => {
      const { application } = context();
      const result = await application.orchestrate(chiefId, goal, {
        ...(options.concurrency ? { concurrency: Number(options.concurrency) } : {}),
        confirm: async (plan) => {
          console.log(
            chalk.cyan(`\nChief 拆解出计划「${plan.name}」（${plan.items.length} 个任务）`),
          );
          for (const item of plan.items)
            console.log(
              `  ${item.id}\t${item.agent}\t${item.title}${item.dependencies.length ? `\tdepends=${item.dependencies.join(',')}` : ''}\n    ${item.prompt}`,
            );
          const ok = await confirm({ message: '确认派发该计划？', default: true });
          return ok;
        },
        // 派发期间打印进度行（\r 覆写，保持同步等终态语义）。
        onProgress: (summary) => process.stdout.write(`\r${chalk.dim(summary.padEnd(60))}`),
      });
      if (!result.confirmed) return console.log(chalk.yellow('计划未确认，已取消。'));
      if (result.operation)
        console.log(
          chalk.cyan(`编排操作 ${result.operation.id} 完成（${result.operation.state}）`),
        );
      console.log(YAML.stringify(result.plan.items));
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

  registerJobCommands(program);
  registerSkillCommands(program);
  registerTrashCommands(program);
  registerKnowledgeCommands(program);
  registerPruneCommands(program);

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
  for (const verb of ['enable', 'disable'] as const) {
    group.command(`${verb} <agent-id> <job-id>`).action(async (id: string, jobId: string) => {
      const { application } = context();
      await application.setJobEnabled(id, jobId, verb === 'enable');
      console.log(chalk.green(`✓ ${jobId} ${verb}d`));
    });
  }
  group.command('install <agent-id> <job-path>').action(async (id: string, source: string) => {
    const { application } = context();
    const job = await application.installJob(id, source);
    console.log(chalk.green(`✓ 已安装任务 ${job.id}`));
  });
  group
    .command('uninstall <agent-id> <job-id>')
    .option('--dry-run')
    .option('--yes')
    .action(async (id: string, jobId: string, options: { dryRun?: boolean; yes?: boolean }) => {
      if (options.dryRun) return console.log(`将归档任务 ${jobId}`);
      await confirmDanger(`归档任务 ${jobId}？`, options.yes === true);
      const { application } = context();
      await application.archiveJob(id, jobId);
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

  const storeGroup = program.command('skill-store').description('Skill 商店（GitHub 仓库源）');
  storeGroup.command('list-repos').action(async () => {
    const { application } = context();
    for (const repo of await application.listSkillStoreRepositories())
      console.log(
        `${repo.name}\t${repo.url}\t${repo.cached ? 'cached' : 'not-cached'}\t${repo.lastRefreshedAt ?? ''}`,
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
      for (const { entry, score, matchedKeywords } of result.hits) {
        console.log(
          `${chalk.green(entry.relPath)}  (score=${score}, 命中: ${matchedKeywords.join(', ')})`,
        );
        console.log(`  ${entry.title}`);
        if (entry.summary) console.log(`  ${entry.summary}`);
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
}
