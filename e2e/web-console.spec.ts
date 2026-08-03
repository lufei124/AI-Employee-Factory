import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

let root = '';
let server: ChildProcessWithoutNullStreams;
let consoleUrl = '';

test.beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-web-e2e-'));
  const port = 42_000 + (process.pid % 1000);
  server = spawn(
    process.execPath,
    [path.resolve('dist/cli.js'), 'web', '--no-open', '--port', String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: root,
        AI_EMPLOYEES_HOME: path.join(root, 'private'),
        AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  consoleUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Web 控制台启动超时')), 15_000);
    let output = '';
    server.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = output.match(/地址：(http:\/\/127\.0\.0\.1:\d+\/#session=[^\s]+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    server.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Web 控制台提前退出 (${code})：${output}`));
    });
  });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGINT');
    await new Promise<void>((resolve) => server.once('exit', () => resolve()));
  }
  expect(await fs.pathExists(path.join(root, '.claude'))).toBe(false);
  expect(await fs.pathExists(path.join(root, '.codex'))).toBe(false);
  expect(await fs.pathExists(path.join(root, '.lark-channel'))).toBe(false);
  await fs.remove(root);
});

test('initializes, creates, manages, backs up, and restores an isolated employee', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(consoleUrl).origin,
  });
  await page.goto(consoleUrl);
  await expect(page.getByText('欢迎来到 AI Employee Factory')).toBeVisible();
  await page.getByRole('button', { name: '操作中心', exact: true }).click();
  await expect(page.locator('.drawer-backdrop')).toHaveCount(0);
  for (const width of [768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await page.waitForTimeout(300);
    const layout = await page.evaluate(() => {
      const workspace = document.querySelector('.workspace-shell')?.getBoundingClientRect();
      const drawer = document.querySelector('.operations-drawer.open')?.getBoundingClientRect();
      return workspace && drawer
        ? { workspaceRight: workspace.right, drawerLeft: drawer.left }
        : null;
    });
    expect(layout).not.toBeNull();
    expect(layout?.workspaceRight).toBeLessThanOrEqual((layout?.drawerLeft ?? 0) + 1);
  }
  await page.getByRole('button', { name: '关闭操作中心' }).click();
  await page.getByRole('button', { name: '初始化 Factory' }).click();
  await expect(page.getByText('尚未创建 AI 员工')).toBeVisible();

  await page.getByRole('link', { name: '创建员工' }).first().click();
  await expect(page.getByLabel('Agent ID')).toHaveValue('user-operations');
  await expect(page.getByLabel('员工名称')).toHaveValue('用户运营专员');
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByLabel('Claude Code').check();
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByText('创建预览')).toBeVisible();
  await page.getByRole('button', { name: '创建员工' }).click();
  await expect(page.getByText('员工创建完成')).toBeVisible();
  const setupCommand = 'agentctl runtime sync user-operations';
  await page.getByRole('button', { name: `复制命令 ${setupCommand}` }).click();
  await expect(page.getByText('已复制')).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(setupCommand);
  await page.getByRole('link', { name: '进入员工详情' }).click();

  await expect(page.getByText('运行器已锁定')).toBeVisible();
  await expect(page.getByText('agentctl runtime sync user-operations')).toBeVisible();
  await page.getByRole('button', { name: 'Skills' }).click();
  await expect(page.getByText('feedback-analyze')).toBeVisible();
  await expect(page.getByText('feedback-collect')).toBeVisible();
  await page.getByRole('button', { name: '身份文档' }).click();
  await expect(page.getByLabel('Markdown 内容')).toContainText('用户运营');

  await page.getByRole('button', { name: '诊断' }).click();
  await page.getByRole('button', { name: '运行 Doctor' }).click();
  await expect(page.getByText(/诊断任务 .* 已进入操作中心/)).toBeVisible();
  await page.getByRole('button', { name: '日志' }).click();
  await page.getByRole('button', { name: '实时跟随' }).click();
  await expect(page.getByRole('button', { name: '停止跟随' })).toBeVisible();
  await page.getByRole('button', { name: '停止跟随' }).click();
  await page.getByRole('button', { name: '备份' }).click();
  await page.getByRole('button', { name: '创建备份' }).click();
  await expect(page.getByText(/备份任务已提交/)).toBeVisible();

  await expect
    .poll(async () => {
      return page.evaluate(async () => {
        const response = await fetch('/api/v1/backups');
        const payload = (await response.json()) as { data: unknown[] };
        return payload.data.length;
      });
    })
    .toBe(1);

  await page.getByRole('link', { name: '备份恢复' }).click();
  await page.getByPlaceholder('agent-copy').fill('user-operations-copy');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '恢复副本' }).click();
  await expect
    .poll(async () => {
      return page.evaluate(async () => {
        const response = await fetch('/api/v1/agents');
        const payload = (await response.json()) as { data: Array<{ id: string }> };
        return payload.data.map((agent) => agent.id);
      });
    })
    .toContain('user-operations-copy');

  expect(await fs.pathExists(path.join(root, 'agents/user-operations/.git'))).toBe(true);
  expect(
    await fs.pathExists(path.join(root, 'agents/user-operations/skills/feedback-collect/SKILL.md')),
  ).toBe(true);
  expect(await fs.pathExists(path.join(root, 'private/runtimes/user-operations/claude'))).toBe(
    true,
  );

  await page.goto(`${new URL(consoleUrl).origin}/#/agents/user-operations`);
  await expect(page.getByText('用户运营专员')).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '移入回收站' }).click();
  await expect(page).toHaveURL(/#\/agents$/);
  await expect(page.getByText('user-operations', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '备份恢复' }).click();
  const trashPanel = page
    .getByRole('heading', { name: '员工回收站' })
    .locator('xpath=ancestor::section');
  await expect(trashPanel).toBeVisible();
  await expect(trashPanel.getByText(/user-operations ·/)).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '恢复员工' }).click();
  await expect(trashPanel.getByText(/user-operations ·/)).toHaveCount(0);
  expect(
    (
      await page.evaluate(async () => {
        const response = await fetch('/api/v1/agents');
        return (await response.json()) as { data: Array<{ id: string; status: string }> };
      })
    ).data,
  ).toContainEqual(expect.objectContaining({ id: 'user-operations', status: 'stopped' }));
});
