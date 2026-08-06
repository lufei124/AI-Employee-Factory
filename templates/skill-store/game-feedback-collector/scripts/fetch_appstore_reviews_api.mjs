#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const DEFAULT_APP_ID = '6758041290';
const DEFAULT_MAX_PAGES = 50;
const PAGE_SIZE = 200;
const TOKEN_TTL_SECONDS = 1100;
const API_BASE = 'https://api.appstoreconnect.apple.com/v1';

const HELP = `读取 App Store 用户评论（App Store Connect API，需 API Key）

用法:
  node scripts/fetch_appstore_reviews_api.mjs [选项]

选项:
  --app-id ID             App ID（默认 6758041290）
  --territory CODE        按地区筛选（3 字母码，如 USA/CHN/GBR，可重复传入）
  --rating N              按评分筛选（1-5，可重复传入）
  --max-pages N           最大分页数，默认 50（每页最多 200 条）
  --limit N               总条数上限（达到即停）
  --help                  显示帮助

配置:
  需在项目根目录 .env 中配置（已 gitignore）:
    ASC_ISSUER_ID=签发者 ID
    ASC_KEY_ID=密钥 ID
    ASC_KEY_PATH=.p8 私钥文件绝对路径

输出:
  stdout: 每行一条规范化记录（JSONL），字段与 fetch_game_feedback.mjs 一致
  stderr: 摘要 JSON（总条数 / 采纳 / 拒绝 / 分页数）

说明:
  - 数据源为 App Store Connect API（官方，JWT 认证）。
  - 去重键格式：appstore:{territory}:{reviewId}，territory 为 3 字母地区码。
  - Connect API 不返回 app 版本、系统版本、设备型号，对应字段留 null。
  - 标题与正文合并写入「反馈内容」，格式：【标题】正文。
`;

function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function parseCliArgs(argv) {
  const options = {
    appId: DEFAULT_APP_ID,
    maxPages: DEFAULT_MAX_PAGES,
    territories: [],
    ratings: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help') {
      options.help = true;
      continue;
    }
    const value = argv[index + 1];
    switch (option) {
      case '--app-id':
        if (!value || !/^\d+$/.test(value)) throw new Error('--app-id must be a numeric string');
        options.appId = value;
        index += 1;
        break;
      case '--territory':
        if (!value || !/^[A-Za-z]{3}$/.test(value))
          throw new Error('--territory must be a 3-letter code');
        options.territories.push(value.toUpperCase());
        index += 1;
        break;
      case '--rating': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error('--rating must be 1-5');
        options.ratings.push(n);
        index += 1;
        break;
      }
      case '--max-pages': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error('--max-pages must be 1-500');
        options.maxPages = n;
        index += 1;
        break;
      }
      case '--limit': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new Error('--limit must be a positive integer');
        options.limit = n;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unsupported option: ${option}`);
    }
  }
  return options;
}

async function loadAscConfig() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(scriptDir, '../');
  let fileEnv = {};
  try {
    fileEnv = parseEnv(await readFile(resolve(projectRoot, '.env'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const sources = [process.env, fileEnv];
  const get = (name) => {
    for (const s of sources) {
      if (s[name] !== undefined && s[name] !== '') return s[name];
    }
    return '';
  };
  const issuerId = get('ASC_ISSUER_ID');
  const keyId = get('ASC_KEY_ID');
  const keyPath = get('ASC_KEY_PATH');
  const missing = [];
  if (!issuerId) missing.push('ASC_ISSUER_ID');
  if (!keyId) missing.push('ASC_KEY_ID');
  if (!keyPath) missing.push('ASC_KEY_PATH');
  if (missing.length) {
    throw new Error(`.env 缺少 App Store Connect 配置: ${missing.join(', ')}`);
  }
  if (!existsSync(keyPath)) {
    throw new Error(`.p8 私钥文件不存在: ${keyPath}`);
  }
  const privateKey = await readFile(keyPath, 'utf8');
  return { issuerId, keyId, privateKey };
}

function makeJwt(issuerId, keyId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuerId,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
      aud: 'appstoreconnect-v1',
    }),
  ).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const sig = crypto.sign(null, Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${sig.toString('base64url')}`;
}

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function isoToMillis(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function ratingToSentiment(rating) {
  const n = Number(rating);
  if (!Number.isFinite(n)) return '中性';
  if (n <= 2) return '负面';
  if (n === 3) return '中性';
  return '正面';
}

function mapConnectReview(review) {
  const a = review?.attributes || {};
  const reviewId = cleanText(review?.id);
  const territory = cleanText(a.territory) || 'UNK';
  const warnings = [];
  if (!reviewId) {
    return { record: null, warnings: ['评论缺少 id，已拒绝'] };
  }
  const title = cleanText(a.title);
  const body = cleanText(a.body);
  if (!title && !body) {
    return {
      record: null,
      warnings: [`appstore:${territory}:${reviewId} 标题与正文均为空，已拒绝`],
    };
  }
  const merged = title && body ? `【${title}】${body}` : body || title;
  const cleanedContent = cleanText(merged);
  if (!cleanedContent) {
    return {
      record: null,
      warnings: [`appstore:${territory}:${reviewId} 合并后内容为空，已拒绝`],
    };
  }
  return {
    record: {
      去重键: `appstore:${territory}:${reviewId}`,
      反馈时间: isoToMillis(a.createdDate),
      反馈内容: cleanedContent,
      反馈内容翻译: null,
      情感倾向: ratingToSentiment(a.rating),
      反馈分类: null,
      来源: '苹果应用商店',
      图片链接: null,
      客户端版本: null,
      系统版本: null,
      设备型号: null,
      '负责人 (人员 )': null,
    },
    warnings,
  };
}

function buildReviewsUrl(appId, options) {
  const params = new URLSearchParams();
  params.set('limit', String(PAGE_SIZE));
  params.set('sort', '-createdDate');
  if (options.territories.length > 0) {
    params.set('filter[territory]', options.territories.join(','));
  }
  if (options.ratings.length > 0) {
    params.set('filter[rating]', options.ratings.join(','));
  }
  return `${API_BASE}/apps/${encodeURIComponent(appId)}/customerReviews?${params.toString()}`;
}

async function fetchWithRetry(url, config, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const token = makeJwt(config.issuerId, config.keyId, config.privateKey);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    if (res.status === 429 && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2;
      console.error(
        `warning: 429 限流，等待 ${retryAfter}s 后重试 (attempt ${attempt + 1}/${retries})`,
      );
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    return res;
  }
  throw new Error('请求失败：超过最大重试次数');
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

  let config;
  try {
    config = await loadAscConfig();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  console.error('App Store Connect 配置加载成功');

  let url = buildReviewsUrl(options.appId, options);
  let accepted = 0;
  let rejected = 0;
  let pages = 0;
  let totalWritten = 0;
  const seenKeys = new Set();

  while (url && pages < options.maxPages) {
    let res;
    try {
      res = await fetchWithRetry(url, config);
    } catch (error) {
      console.error(`error: ${error.message}`);
      break;
    }
    if (!res.ok) {
      const body = await res.text();
      console.error(`error: HTTP ${res.status} ${body.slice(0, 300)}`);
      break;
    }
    const data = await res.json();
    const reviews = data.data || [];
    pages += 1;
    for (const review of reviews) {
      if (options.limit && totalWritten >= options.limit) break;
      const mapped = mapConnectReview(review);
      for (const warning of mapped.warnings) console.error(`warning: ${warning}`);
      if (!mapped.record) {
        rejected += 1;
        continue;
      }
      if (seenKeys.has(mapped.record.去重键)) continue;
      seenKeys.add(mapped.record.去重键);
      process.stdout.write(`${JSON.stringify(mapped.record)}\n`);
      accepted += 1;
      totalWritten += 1;
    }
    url = data.links?.next || null;
    if (options.limit && totalWritten >= options.limit) break;
  }

  console.error(
    JSON.stringify({
      appId: options.appId,
      pages,
      accepted,
      rejected,
      limited: options.limit ? totalWritten >= options.limit : false,
    }),
  );
}

await main();
