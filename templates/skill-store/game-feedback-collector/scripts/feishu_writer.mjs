/**
 * 飞书写入可注入库（默认工具，非唯一路径）。
 * 所有飞书交互经 runCli 注入，便于 mock 测试；默认 CLI 使用 spawnSync('lark-cli')。
 */

import { readFileSync } from 'node:fs';

export const DEFAULT_WIKI_URL =
  'https://uvidumfqwzk.feishu.cn/wiki/V6WEwEh1MikK0dk8Y8hcAJPZnbb?table=tblFTnIHPOHn66tY&view=vew4pnUSHd';

export const DEFAULT_TABLE_ID = 'tblFTnIHPOHn66tY';

export const FIELD_NAMES = [
  '去重键',
  '反馈分类',
  '情感倾向',
  '反馈时间',
  '负责人 (人员 )',
  '客户端版本',
  '反馈内容翻译',
  '反馈内容',
  '来源',
  '图片链接',
  '设备型号',
  '系统版本',
];

/** select 字段：写入前用 field-get 拉取线上选项做预检（线上为权威）。 */
export const SELECT_FIELDS = ['反馈分类', '情感倾向', '来源'];

export function parseWriteArgs(argv, { requireConfirmFlag = true } = {}) {
  let input = null;
  let confirm = false;
  let url = DEFAULT_WIKI_URL;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--confirm') {
      if (!requireConfirmFlag) {
        throw new Error(`未知参数 ${arg}`);
      }
      confirm = true;
    } else if (arg === '--input') {
      input = argv[++i];
      if (!input) {
        throw new Error('--input 需要路径参数');
      }
    } else if (arg === '--url') {
      url = argv[++i];
      if (!url) {
        throw new Error('--url 需要路径参数');
      }
    } else {
      throw new Error(`未知参数 ${arg}`);
    }
  }

  if (help) {
    return { help: true, input, confirm, url };
  }
  if (!input) {
    throw new Error('缺少必填参数 --input');
  }
  return { help: false, input, confirm, url };
}

export function loadRecords(inputPath) {
  const lines = readFileSync(inputPath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map((l, idx) => {
    try {
      return JSON.parse(l);
    } catch (error) {
      throw new Error(`解析 JSONL 失败（行 ${idx + 1}）: ${error.message}`);
    }
  });
}

export function tableIdFromUrl(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('table') || DEFAULT_TABLE_ID;
  } catch {
    return DEFAULT_TABLE_ID;
  }
}

export function resolveTable(runCli, url = DEFAULT_WIKI_URL) {
  const info = runCli(['sheets', '+workbook-info', '--url', url, '--format', 'json']);
  const baseToken = info.data?.sheets?.[0]?.bitable_app_token;
  if (!baseToken) {
    throw new Error('workbook-info 未返回 bitable_app_token');
  }
  return { baseToken, tableId: tableIdFromUrl(url), url };
}

function optionNames(fieldRes) {
  const opts = fieldRes?.data?.field?.options || [];
  return opts.map((o) => o.name);
}

/**
 * 拉取线上 select 选项并校验记录中的选项值（含尾空格精确匹配）。
 * 返回 { ok, schema, errors }；ok=false 时整批应阻断。
 */
export function precheckSchema(runCli, { baseToken, tableId }, records) {
  const schema = {};
  const errors = [];

  for (const fieldName of SELECT_FIELDS) {
    const res = runCli([
      'base',
      '+field-get',
      '--base-token',
      baseToken,
      '--table-id',
      tableId,
      '--field-id',
      fieldName,
      '--format',
      'json',
    ]);
    const names = optionNames(res);
    if (names.length === 0) {
      errors.push({ field: fieldName, reason: '线上选项为空或 field-get 失败' });
    }
    schema[fieldName] = names;
  }

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const key = record.去重键 ?? `行${i + 1}`;

    const cats = record.反馈分类;
    if (cats != null) {
      const list = Array.isArray(cats) ? cats : [cats];
      for (const c of list) {
        if (!schema['反馈分类'].includes(c)) {
          errors.push({
            key,
            field: '反馈分类',
            value: c,
            reason: '不在线上选项中（注意尾空格）',
            online: schema['反馈分类'],
          });
        }
      }
    }

    const sentiment = record.情感倾向;
    if (sentiment != null && sentiment !== '' && !schema['情感倾向'].includes(sentiment)) {
      errors.push({
        key,
        field: '情感倾向',
        value: sentiment,
        reason: '不在线上选项中',
        online: schema['情感倾向'],
      });
    }

    const source = record.来源;
    if (source != null && source !== '' && !schema['来源'].includes(source)) {
      errors.push({
        key,
        field: '来源',
        value: source,
        reason: '不在线上选项中',
        online: schema['来源'],
      });
    }
  }

  return { ok: errors.length === 0, schema, errors };
}

export function searchExisting(runCli, { baseToken, tableId }, key) {
  const body = JSON.stringify({
    keyword: key,
    search_fields: ['去重键'],
    select_fields: ['去重键', '反馈内容'],
    filter: { logic: 'and', conditions: [['去重键', '==', key]] },
    limit: 10,
  });
  const res = runCli([
    'base',
    '+record-search',
    '--base-token',
    baseToken,
    '--table-id',
    tableId,
    '--json',
    body,
    '--format',
    'json',
  ]);
  const ids = res.data?.record_id_list || [];
  const rows = res.data?.data || [];
  if (ids.length === 0) {
    return null;
  }
  return { recordId: ids[0], content: rows[0]?.[1] ?? '' };
}

/**
 * 对每条记录做去重三态判定。search_error 不进入 pendingNew。
 */
export function dedupCheck(runCli, table, records, { log = () => {} } = {}) {
  const skipped = [];
  const conflicts = [];
  const searchErrors = [];
  const pendingNew = [];
  const results = [];

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const key = record.去重键;
    let status = 'new';
    let existingRecordId = null;
    let searchErrorMessage = null;

    try {
      const existing = searchExisting(runCli, table, key);
      if (existing) {
        existingRecordId = existing.recordId;
        status = existing.content === record.反馈内容 ? 'skip' : 'conflict';
      }
    } catch (error) {
      status = 'search_error';
      searchErrorMessage = String(error.message || error).slice(0, 200);
    }

    if (status === 'skip') {
      skipped.push({ key, existingRecordId });
      log(`[${i + 1}/${records.length}] 跳过（已存在相同内容）: ${key}`);
    } else if (status === 'conflict') {
      conflicts.push({ key, existingRecordId });
      log(
        `[${i + 1}/${records.length}] 冲突（去重键已存在但内容不同）: ${key} record_id=${existingRecordId}`,
      );
    } else if (status === 'search_error') {
      searchErrors.push({ key, error: searchErrorMessage });
      log(`[${i + 1}/${records.length}] 查重失败（不写入）: ${key} — ${searchErrorMessage}`);
    } else {
      pendingNew.push(record);
      log(`[${i + 1}/${records.length}] 待写入: ${key}`);
    }

    results.push({
      key,
      status: status === 'search_error' ? 'error' : status,
      existingRecordId: status === 'search_error' ? searchErrorMessage : existingRecordId,
      反馈分类: record.反馈分类,
      情感倾向: record.情感倾向,
      反馈时间: record.反馈时间,
      内容预览: String(record.反馈内容 || '').slice(0, 50),
    });
  }

  return { skipped, conflicts, searchErrors, pendingNew, results };
}

export function buildPayload(record) {
  const payload = {};
  for (const name of FIELD_NAMES) {
    payload[name] = record[name] ?? null;
  }
  for (const key of Object.keys(payload)) {
    if (key.startsWith('_')) {
      delete payload[key];
    }
  }
  // 保险：即使 FIELD_NAMES 不含下划线字段，也从 record 侧剥离
  delete payload._分类判定;
  delete payload._分类内容;
  return payload;
}

export function writeRecords(runCli, table, pending, { log = () => {} } = {}) {
  const created = [];
  const failed = [];

  for (let i = 0; i < pending.length; i += 1) {
    const record = pending[i];
    const payload = buildPayload(record);
    log(`[写入 ${i + 1}/${pending.length}] ${record.去重键}`);
    try {
      const res = runCli([
        'base',
        '+record-upsert',
        '--base-token',
        table.baseToken,
        '--table-id',
        table.tableId,
        '--json',
        JSON.stringify(payload),
        '--format',
        'json',
      ]);
      const recordId = res.data?.record?.record_id_list?.[0];
      if (!recordId) {
        throw new Error(`upsert 未返回 record_id: ${JSON.stringify(res).slice(0, 300)}`);
      }
      created.push({ key: record.去重键, recordId, payload });
    } catch (error) {
      log(`  失败: ${error.message}`);
      failed.push({ key: record.去重键, error: error.message });
    }
  }

  return { created, failed };
}

export function verifyReadback(runCli, table, created) {
  if (created.length === 0) {
    return { verifications: [], verificationFailed: false };
  }

  const recordIds = created.map((c) => c.recordId);
  const readRes = runCli([
    'base',
    '+record-get',
    '--base-token',
    table.baseToken,
    '--table-id',
    table.tableId,
    '--json',
    JSON.stringify({ record_id_list: recordIds }),
    '--format',
    'json',
  ]);
  const fields = readRes.data?.fields || [];
  const rows = readRes.data?.data || [];
  const readIds = readRes.data?.record_id_list || [];

  const verifications = [];
  let verificationFailed = false;

  for (let i = 0; i < readIds.length; i += 1) {
    const row = rows[i] || [];
    const map = {};
    for (let j = 0; j < fields.length; j += 1) {
      map[fields[j]] = row[j];
    }
    const expected = created.find((c) => c.recordId === readIds[i]);
    const exp = expected?.payload || {};
    const ver = {
      recordId: readIds[i],
      去重键: map.去重键,
      去重键_OK: map.去重键 === exp.去重键,
      来源: map.来源,
      来源_OK: map.来源 === exp.来源,
      反馈分类: map.反馈分类,
      反馈分类_OK: JSON.stringify(map.反馈分类 || []) === JSON.stringify(exp.反馈分类 || []),
      情感倾向: map.情感倾向,
      情感倾向_OK: map.情感倾向 === exp.情感倾向,
      // 翻译由表侧自动化生成：回读非空不判失败
      反馈内容翻译: map.反馈内容翻译,
      翻译_已被表侧自动化填充: map.反馈内容翻译 !== null && map.反馈内容翻译 !== undefined,
      反馈时间: map.反馈时间,
    };
    if (!ver.去重键_OK || !ver.来源_OK || !ver.反馈分类_OK || !ver.情感倾向_OK) {
      verificationFailed = true;
    }
    verifications.push(ver);
  }

  return { verifications, verificationFailed };
}

export function computeExitCode(summary) {
  if (summary.schemaErrors > 0) return 1;
  if (summary.failed > 0) return 1;
  if (summary.searchErrors > 0) return 1;
  if (summary.conflicts > 0) return 1;
  if (summary.verificationFailed) return 1;
  return 0;
}

/**
 * 主编排：预检 → 去重 →（预览或写入+回读）。
 * confirm=false 时绝不调用 record-upsert。
 */
export function runWritePipeline(
  runCli,
  { input, confirm, url = DEFAULT_WIKI_URL, log = console.error } = {},
) {
  const records = loadRecords(input);
  log(`读取 ${records.length} 条记录: ${input}`);

  log('解析飞书 Base token...');
  const table = resolveTable(runCli, url);
  log('Base token 解析成功');

  log('校验线上 schema（field-get）...');
  const precheck = precheckSchema(runCli, table, records);
  if (!precheck.ok) {
    const summary = {
      mode: 'schema_blocked',
      input,
      total: records.length,
      schemaErrors: precheck.errors.length,
      schemaErrorDetails: precheck.errors,
      failed: 0,
      searchErrors: 0,
      conflicts: 0,
      verificationFailed: false,
    };
    return { summary, exitCode: computeExitCode(summary), table, schema: precheck.schema };
  }
  log('schema 预检通过');

  const dedup = dedupCheck(runCli, table, records, { log });

  if (!confirm) {
    const summary = {
      mode: 'preview',
      input,
      total: records.length,
      pendingNew: dedup.pendingNew.length,
      skipped: dedup.skipped.length,
      conflicts: dedup.conflicts.length,
      searchErrors: dedup.searchErrors.length,
      schemaErrors: 0,
      failed: 0,
      verificationFailed: false,
      skippedDetails: dedup.skipped,
      conflictDetails: dedup.conflicts,
      searchErrorDetails: dedup.searchErrors,
      pendingKeys: dedup.pendingNew.map((r) => r.去重键),
    };
    return {
      summary,
      exitCode: computeExitCode(summary),
      table,
      schema: precheck.schema,
      dedup,
    };
  }

  const { created, failed } = writeRecords(runCli, table, dedup.pendingNew, { log });
  log(
    `\n写入完成: 成功 ${created.length}，跳过 ${dedup.skipped.length}，冲突 ${dedup.conflicts.length}，查重失败 ${dedup.searchErrors.length}，失败 ${failed.length}`,
  );

  let verifications = [];
  let verificationFailed = false;
  if (created.length > 0) {
    log('批量回读校验...');
    ({ verifications, verificationFailed } = verifyReadback(runCli, table, created));
  }

  const summary = {
    mode: 'write',
    input,
    created: created.length,
    skipped: dedup.skipped.length,
    conflicts: dedup.conflicts.length,
    searchErrors: dedup.searchErrors.length,
    schemaErrors: 0,
    failed: failed.length,
    verificationFailed,
    skippedDetails: dedup.skipped,
    conflictDetails: dedup.conflicts,
    searchErrorDetails: dedup.searchErrors,
    failedDetails: failed,
    verifications,
  };

  return {
    summary,
    exitCode: computeExitCode(summary),
    table,
    schema: precheck.schema,
    dedup,
    created,
    failed,
  };
}
