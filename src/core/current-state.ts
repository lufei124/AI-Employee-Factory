// OP6-B：agent/CURRENT_STATE.md 自动更新（系统侧生命周期事件）。
//
// 纯文件逻辑，不涉 git（git 单文件提交在 src/core/git.ts gitCommitFile，由应用层组合）。
//
// 结构约定：文件含系统管理标记块，块内为行级 KV（`- key：value`），系统更新只重写
// 目标 key 那一行，块外内容（员工的「工作进展」段等）原样保留。
//
// 永不覆盖他人成果：无标记块且内容已被人工修改过（不等于旧种子模板）→ skip 并警告；
// 等于旧种子模板（创建后从未被改过）→ 自动升级为带标记块格式，再按事件行合并。
import fs from 'fs-extra';
import path from 'node:path';
import { atomicWriteFile } from './atomic.js';

export const STATE_BLOCK_BEGIN = '<!-- factory-auto:begin -->';
export const STATE_BLOCK_END = '<!-- factory-auto:end -->';

/** 从相对路径列表生成 Claude 权限放行规则（Edit/Write 各一条）。 */
function allowRulesFor(relPaths: string[]): string[] {
  return relPaths.flatMap((p) => [`Edit(${p})`, `Write(${p})`]);
}

/**
 * 幂等确保工作区 .claude/settings.json 含指定文件的 Claude 权限放行（存量员工升级用）。
 * 保留既有 permissions（defaultMode 等）与其他顶层字段；无放行时合并写回。
 * 非法 JSON：不覆盖，返回（员工本机运行时产物，doctor 会告警）。
 */
export async function ensureAgentDocsAllowed(workspace: string, relPaths: string[]): Promise<void> {
  const settingsFile = path.join(workspace, '.claude', 'settings.json');
  let settings: Record<string, unknown> = {};
  if (await fs.pathExists(settingsFile)) {
    try {
      const parsed = (await fs.readJson(settingsFile)) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') settings = parsed;
    } catch {
      return;
    }
  }
  const permissions =
    settings.permissions &&
    typeof settings.permissions === 'object' &&
    !Array.isArray(settings.permissions)
      ? (settings.permissions as Record<string, unknown>)
      : {};
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : [];
  const missing = allowRulesFor(relPaths).filter((rule) => !allow.includes(rule));
  if (missing.length === 0) return;
  await atomicWriteFile(
    settingsFile,
    `${JSON.stringify(
      { ...settings, permissions: { ...permissions, allow: [...allow, ...missing] } },
      null,
      2,
    )}\n`,
    0o600,
  );
}

/**
 * 幂等确保工作区 .claude/settings.json 含 CURRENT_STATE 放行（存量员工升级用）。
 * 保留既有 permissions（defaultMode 等）与其他顶层字段；无放行时合并写回。
 */
export async function ensureStateEditAllowed(workspace: string): Promise<void> {
  await ensureAgentDocsAllowed(workspace, ['agent/CURRENT_STATE.md']);
}

/** 旧种子模板原文（templates.ts 曾写入的初版，无标记块）——精确匹配以识别未升级文件。 */
export const LEGACY_SEED_CONTENT = '# 当前状态\n\n- 状态：已创建，待完成运行器登录与飞书授权\n';

/** 状态行 key → 行内中文标签。 */
const KEY_LABELS: Record<StateKey, string> = {
  state: '状态',
  runtime_auth: '运行器',
  feishu_auth: '飞书',
  last_event: '最近事件',
};

/** 员工生命周期状态（系统侧事件可写到的取值）。 */
export const STATE_VALUES = ['已创建', '已就绪', '运行中', '已停止', '已归档', '已恢复'] as const;
export type StateValue = (typeof STATE_VALUES)[number];

export interface StateRow {
  /** 员工当前生命周期状态。 */
  state?: StateValue;
  /** 运行器登录状态（未登录/已登录）。 */
  runtime_auth?: string;
  /** 飞书授权状态（未授权/已授权）。 */
  feishu_auth?: string;
  /** 最近一次生命周期事件（如「运行器登录」）。 */
  last_event?: string;
}

type StateKey = keyof StateRow;

export type UpdateResult = 'updated' | 'upgraded' | 'skipped';

/** 渲染完整状态块（含边界注释），供模板与测试复用。 */
export function renderStateBlock(row: StateRow): string {
  const lines = Object.entries(row)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `- ${KEY_LABELS[key as StateKey]}：${value}`);
  return [STATE_BLOCK_BEGIN, ...lines, STATE_BLOCK_END].join('\n');
}

/** 渲染带「工作进展」段的完整新种子内容。缺省参数为创建时的初始状态。 */
export function renderNewSeed(row: StateRow = INITIAL_STATE): string {
  return (
    `# 当前状态\n\n${renderStateBlock(row)}\n\n## 工作进展\n\n` +
    '（员工维护：当前任务、进展、下一步。系统不会修改本段，也不会覆盖人工内容。）\n'
  );
}

/** 创建员工时的初始状态行。 */
export const INITIAL_STATE: StateRow = {
  state: '已创建',
  runtime_auth: '未登录',
  feishu_auth: '未授权',
  last_event: '创建员工',
};

/**
 * 更新 CURRENT_STATE.md 中目标 key 的状态行。
 *
 * - 有标记块：只重写目标 key 的行，其余行与块外内容原样保留。
 * - 无标记块且内容等于旧种子模板：升级为带标记块格式，事件行直接写入升级后的块
 *   （避免「升级 + 事件」两次写入）。
 * - 无标记块且被人工改过：跳过并 console.warn（永不覆盖他人成果）。
 *
 * @returns 'updated'（有标记块，行级合并）/ 'upgraded'（无标记块升级后写入）/ 'skipped'（人工内容，未动）。
 */
export async function updateCurrentState(file: string, row: StateRow): Promise<UpdateResult> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch {
    throw new Error(`CURRENT_STATE.md 不存在：${file}`);
  }

  const begin = content.indexOf(STATE_BLOCK_BEGIN);
  const end = content.indexOf(STATE_BLOCK_END);

  if (begin === -1 || end === -1 || end < begin) {
    // 无完整标记块。
    if (content.trim() === LEGACY_SEED_CONTENT.trim()) {
      // 升级后从初始种子行合并事件行（事件行优先），避免「升级 + 事件」两次写入。
      await atomicWriteFile(file, renderNewSeed({ ...INITIAL_STATE, ...row }), 0o644);
      return 'upgraded';
    }
    console.warn(
      `[current-state] 跳过 ${path.basename(file)} 的自动更新：文件缺少系统标记块且内容已被人工修改，` +
        '保留人工内容不动。',
    );
    return 'skipped';
  }

  const before = content.slice(0, begin);
  const block = content.slice(begin + STATE_BLOCK_BEGIN.length, end);
  const after = content.slice(end + STATE_BLOCK_END.length);

  const lines = block.split('\n');
  const entries = new Map<string, string>();
  for (const line of lines) {
    const match = /^- ([^：]+)：(.+)$/.exec(line.trim());
    if (match) entries.set(match[1]!.trim(), match[2]!.trim());
  }
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue;
    const label = KEY_LABELS[key as StateKey];
    const existing = [...entries.keys()].find((k) => k === label);
    if (existing) entries.set(existing, value);
    else entries.set(label, value);
  }

  const mergedBlock = [...entries.entries()]
    .map(([label, value]) => `- ${label}：${value}`)
    .join('\n');

  // 保留块前/块后内容原样（员工「工作进展」段等在 after 部分不受影响）。
  const next = `${before}${STATE_BLOCK_BEGIN}\n${mergedBlock}\n${STATE_BLOCK_END}${after}`;
  // 目标 key 已是目标值（no-op）时 next === content，不写盘（mtime 不变）。
  if (next !== content) await atomicWriteFile(file, next, 0o644);
  return 'updated';
}
