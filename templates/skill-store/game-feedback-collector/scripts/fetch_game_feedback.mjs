#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildGameFeedbackQuery,
  mapGameFeedbackRow,
  parseCliArgs,
  parseEnv,
  resolveDbConfig,
} from './game_feedback_db.mjs';

const HELP = `读取正式服 game_feedback（只读）

用法:
  node scripts/fetch_game_feedback.mjs [选项]

选项:
  --after-id ID           只读取 id 大于 ID 的记录
  --before-id ID          只读取 id 小于 ID 的记录
  --since MILLISECONDS    create_time 下界（含）
  --until MILLISECONDS    create_time 上界（含）
  --client-version VALUE  筛选客户端版本
  --limit N               返回 1-500 条，默认 100
  --help                  显示帮助
`;

async function loadProjectEnv() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(scriptDir, '../');
  try {
    return parseEnv(await readFile(resolve(projectRoot, '.env'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  let connection;
  try {
    const config = resolveDbConfig(await loadProjectEnv(), process.env);
    const query = buildGameFeedbackQuery(options);
    const mysql = await import('mysql2/promise');
    connection = await mysql.createConnection({
      ...config,
      timezone: 'Z',
      connectTimeout: 10_000,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    const [rows] = await connection.query(query.sql, query.params);
    let accepted = 0;
    let rejected = 0;
    let nextAfterId = null;
    for (const row of rows) {
      nextAfterId = String(row.id);
      const mapped = mapGameFeedbackRow(row);
      for (const warning of mapped.warnings) console.error(`warning: ${warning}`);
      if (!mapped.record) {
        rejected += 1;
        continue;
      }
      process.stdout.write(`${JSON.stringify(mapped.record)}\n`);
      accepted += 1;
    }
    console.error(
      JSON.stringify({
        read: rows.length,
        accepted,
        rejected,
        nextAfterId,
      }),
    );
  } catch (error) {
    console.error(`game_feedback 读取失败: ${error.code || error.name || 'Error'}`);
    process.exitCode = 1;
  } finally {
    await connection?.end();
  }
}

await main();
