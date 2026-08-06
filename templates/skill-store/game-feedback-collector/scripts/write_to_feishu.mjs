#!/usr/bin/env node

/**
 * 飞书写入工具（薄 CLI，默认路径）。
 *
 * 用法：
 *   node write_to_feishu.mjs --input <classified.jsonl>           # 预检+去重预览，不写入
 *   node write_to_feishu.mjs --input <classified.jsonl> --confirm # 用户对话确认后写入
 *   node write_to_feishu.mjs --input <f.jsonl> --url <wiki-url> [--confirm]
 *
 * --confirm 仅是防误跑进程门，不是授权等价物；传参前仍须获得用户对话确认（见 SKILL.md）。
 * 预检/去重/回读逻辑见 feishu_writer.mjs；Agent 仍可在应对线上怪癖时偏离本脚本。
 */

import { spawnSync } from 'node:child_process';
import { parseWriteArgs, runWritePipeline } from './feishu_writer.mjs';

function usage(exitCode = 1) {
  console.error(`用法: node write_to_feishu.mjs --input <classified.jsonl> [--confirm] [--url <wiki-url>]
  --input    必填。分类后的 JSONL 路径。
  --confirm  可选。不带则只预检+去重预览并退出（不写入）。
             带上前须已获用户对话确认；本开关不是授权等价物。
  --url      可选。飞书 Wiki 表 URL，默认旧结果表。`);
  process.exit(exitCode);
}

function runCli(args) {
  const res = spawnSync('lark-cli', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`lark-cli 退出码 ${res.status}: ${(res.stderr || '').slice(0, 400)}`);
  }
  return JSON.parse(res.stdout);
}

let args;
try {
  args = parseWriteArgs(process.argv.slice(2));
} catch (error) {
  console.error(`错误: ${error.message}`);
  usage(1);
}

if (args.help) {
  usage(0);
}

const { summary, exitCode } = runWritePipeline(runCli, {
  input: args.input,
  confirm: args.confirm,
  url: args.url,
  log: console.error,
});

if (summary.mode === 'schema_blocked') {
  console.error(`schema 预检失败，共 ${summary.schemaErrors} 项差异，已阻断写入。`);
} else if (summary.mode === 'preview') {
  console.error(
    `\n预览完成: 待写入 ${summary.pendingNew}，跳过 ${summary.skipped}，冲突 ${summary.conflicts}，查重失败 ${summary.searchErrors}`,
  );
  console.error('未写入飞书。若用户已对话确认，请追加 --confirm 再执行。');
}

console.log(JSON.stringify(summary, null, 2));
process.exit(exitCode);
