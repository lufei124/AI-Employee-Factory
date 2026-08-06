#!/usr/bin/env node

/**
 * 飞书去重预览工具（只读，不写入）。
 *
 * 用法：
 *   node dedup_and_preview.mjs --input <classified.jsonl> [--url <wiki-url>]
 */

import { spawnSync } from 'node:child_process';
import {
  parseWriteArgs,
  loadRecords,
  resolveTable,
  dedupCheck,
  computeExitCode,
} from './feishu_writer.mjs';

function usage(exitCode = 1) {
  console.error('用法: node dedup_and_preview.mjs --input <classified.jsonl> [--url <wiki-url>]');
  process.exit(exitCode);
}

function runCli(args) {
  const res = spawnSync('lark-cli', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`lark-cli 退出码 ${res.status}: ${(res.stderr || '').slice(0, 300)}`);
  }
  return JSON.parse(res.stdout);
}

let args;
try {
  args = parseWriteArgs(process.argv.slice(2), { requireConfirmFlag: false });
} catch (error) {
  console.error(`错误: ${error.message}`);
  usage(1);
}

if (args.help) {
  usage(0);
}

const records = loadRecords(args.input);
console.error(`读取 ${records.length} 条记录: ${args.input}`);

console.error('解析飞书 Base token...');
const table = resolveTable(runCli, args.url);
console.error('Base token 解析成功');

const { results, skipped, conflicts, searchErrors, pendingNew } = dedupCheck(
  runCli,
  table,
  records,
  { log: console.error },
);

const summary = {
  total: results.length,
  new: pendingNew.length,
  skip: skipped.length,
  conflict: conflicts.length,
  error: searchErrors.length,
};

console.log(JSON.stringify({ summary, results }, null, 2));
process.exit(
  computeExitCode({
    schemaErrors: 0,
    failed: 0,
    searchErrors: searchErrors.length,
    conflicts: conflicts.length,
    verificationFailed: false,
  }),
);
