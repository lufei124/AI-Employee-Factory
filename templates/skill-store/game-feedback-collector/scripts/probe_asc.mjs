#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

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

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '../');
let env;
try {
  env = parseEnv(await readFile(resolve(projectRoot, '.env'), 'utf8'));
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('项目根目录缺少 .env 文件');
    process.exit(1);
  }
  throw error;
}

const issuerId = env.ASC_ISSUER_ID;
const keyId = env.ASC_KEY_ID;
const keyPath = env.ASC_KEY_PATH;
const missing = [];
if (!issuerId) missing.push('ASC_ISSUER_ID');
if (!keyId) missing.push('ASC_KEY_ID');
if (!keyPath) missing.push('ASC_KEY_PATH');
if (missing.length) {
  console.error(`.env 缺少 App Store Connect 配置: ${missing.join(', ')}`);
  process.exit(1);
}
if (!existsSync(keyPath)) {
  console.error(`.p8 私钥文件不存在: ${keyPath}`);
  process.exit(1);
}
console.error('配置检查通过（凭据值不打印）');
console.error(`Issuer ID 长度=${issuerId.length}, Key ID=${keyId}, Key 文件存在`);

const privateKey = await readFile(keyPath, 'utf8');

function makeJwt(issuer, kid, key) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({ iss: issuer, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' }),
  ).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const sig = crypto.sign(null, Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${sig.toString('base64url')}`;
}

const token = makeJwt(issuerId, keyId, privateKey);
console.error(`JWT 生成成功，长度 ${token.length}`);

const res = await fetch('https://api.appstoreconnect.apple.com/v1/apps?limit=200', {
  headers: { Authorization: `Bearer ${token}` },
});
console.error(`GET /v1/apps -> HTTP ${res.status}`);
if (!res.ok) {
  const body = await res.text();
  console.error('错误响应:', body.slice(0, 800));
  process.exit(1);
}

const data = await res.json();
console.log('apps 总数:', data.data.length);
console.log('');
for (const app of data.data) {
  const a = app.attributes || {};
  console.log(JSON.stringify({ id: app.id, name: a.name, bundleId: a.bundleId, sku: a.sku }));
}
