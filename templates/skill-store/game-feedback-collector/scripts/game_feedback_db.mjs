const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export function parseEnv(text) {
  const output = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    output[key] = value;
  }
  return output;
}

function firstValue(sources, names) {
  for (const source of sources) {
    for (const name of names) {
      if (source[name] !== undefined && source[name] !== '') {
        return source[name];
      }
    }
  }
  return '';
}

export function resolveDbConfig(fileEnv = {}, processEnv = {}) {
  const sources = [processEnv, fileEnv];
  const rawPort = firstValue(sources, ['DB_PORT', 'MYSQL_PORT']) || '3306';
  const config = {
    host: firstValue(sources, ['DB_HOST', 'MYSQL_HOST']),
    port: Number(rawPort),
    user: firstValue(sources, ['DB_USER', 'MYSQL_USER']),
    password: firstValue(sources, ['DB_PASSWORD', 'MYSQL_PASSWORD']),
    database: firstValue(sources, ['DB_DATABASE', 'MYSQL_DATABASE']),
  };
  const missing = [];
  if (!config.host) missing.push('DB_HOST');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    missing.push('DB_PORT');
  }
  if (!config.user) missing.push('DB_USER');
  if (!config.password) missing.push('DB_PASSWORD');
  if (!config.database) missing.push('DB_DATABASE');
  if (missing.length) {
    throw new Error(`Missing database config: ${missing.join(', ')}`);
  }
  return config;
}

function parseUnsignedInteger(value, label) {
  if (!/^\d+$/.test(String(value || ''))) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return BigInt(value);
}

function nextValue(argv, index, option) {
  if (index + 1 >= argv.length) throw new Error(`${option} requires a value`);
  return argv[index + 1];
}

export function parseCliArgs(argv) {
  const options = { limit: DEFAULT_LIMIT };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help') {
      options.help = true;
      continue;
    }
    const value = nextValue(argv, index, option);
    index += 1;
    switch (option) {
      case '--after-id':
        options.afterId = parseUnsignedInteger(value, 'after-id');
        break;
      case '--before-id':
        options.beforeId = parseUnsignedInteger(value, 'before-id');
        break;
      case '--since':
        options.since = parseUnsignedInteger(value, 'since');
        break;
      case '--until':
        options.until = parseUnsignedInteger(value, 'until');
        break;
      case '--client-version':
        if (!value.trim()) throw new Error('client-version must not be empty');
        options.clientVersion = value.trim();
        break;
      case '--limit': {
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
          throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
        }
        options.limit = limit;
        break;
      }
      default:
        throw new Error(`Unsupported option: ${option}`);
    }
  }
  if (options.since !== undefined && options.until !== undefined && options.since > options.until) {
    throw new Error('since must not be greater than until');
  }
  if (
    options.afterId !== undefined &&
    options.beforeId !== undefined &&
    options.afterId >= options.beforeId
  ) {
    throw new Error('after-id must be less than before-id');
  }
  return options;
}

export function buildGameFeedbackQuery(options = {}) {
  const conditions = [];
  const params = [];
  if (options.afterId !== undefined) {
    conditions.push('id > ?');
    params.push(String(options.afterId));
  }
  if (options.beforeId !== undefined) {
    conditions.push('id < ?');
    params.push(String(options.beforeId));
  }
  if (options.since !== undefined) {
    conditions.push('create_time >= ?');
    params.push(String(options.since));
  }
  if (options.until !== undefined) {
    conditions.push('create_time <= ?');
    params.push(String(options.until));
  }
  if (options.clientVersion !== undefined) {
    conditions.push('client_version = ?');
    params.push(options.clientVersion);
  }
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  const where = conditions.length ? `\nWHERE ${conditions.join(' AND ')}` : '';
  const sql = [
    'SELECT id, client_version, content, create_time, image_urls,',
    '       os_version, phone_type',
    'FROM game_feedback',
    `${where}`,
    'ORDER BY id ASC',
    'LIMIT ?',
  ]
    .filter(Boolean)
    .join('\n');
  params.push(limit);
  return { sql, params, limit };
}

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function normalizeImages(value, warnings, id) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value);
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('not a string array');
    }
    return JSON.stringify(parsed);
  } catch {
    warnings.push(`db:${id} image_urls 不是有效的 JSON URL 数组，已保留原值`);
    return raw;
  }
}

export function mapGameFeedbackRow(row) {
  const id = String(row?.id ?? '');
  const content = cleanText(row?.content);
  const warnings = [];
  if (!id) {
    return { record: null, warnings: ['数据库记录缺少 id'] };
  }
  if (!content) {
    return { record: null, warnings: [`db:${id} 反馈内容为空，已拒绝`] };
  }
  return {
    record: {
      去重键: `db:${id}`,
      反馈时间:
        row.create_time === null || row.create_time === undefined ? null : Number(row.create_time),
      反馈内容: content,
      反馈内容翻译: null,
      情感倾向: null,
      反馈分类: null,
      来源: '应用内反馈',
      图片链接: normalizeImages(row.image_urls, warnings, id),
      客户端版本: cleanText(row.client_version) || null,
      系统版本: cleanText(row.os_version) || null,
      设备型号: cleanText(row.phone_type) || null,
      '负责人 (人员 )': null,
    },
    warnings,
  };
}

export const QUERY_LIMITS = Object.freeze({
  default: DEFAULT_LIMIT,
  max: MAX_LIMIT,
});
