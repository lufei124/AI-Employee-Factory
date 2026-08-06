// D-041 P0-1：身份文档只读锚点硬门。
//
// 需求：员工的所有进化都在聊天/干活中由 AI 自己完成，人工不直接编辑；但身份文档的
// 「宪法」性质内容不能被员工静默削弱——岗位骨架（ROLE.md 的岗位定位/长期职责）与
// 权限红线（POLICIES.md 的红线词）是员工自我进化的**保护基线**。
//
// 本模块提供内容级校验（纯函数，零 I/O）：
// - `GUARDED_SECTION_MARKERS`：声明式锚点（标题 / 红线词）。
// - `validateIdentityGuard`：对将要提交的文件内容做校验，返回 `{ok, issues}`。
// - `stripGuardSections`：剥离受保护行，供「提案剥离」场景（员工把想改的部分从受保护
//   区块中抽离出来，单独走提案，不直接改受保护原文）。
//
// 接入（commitSelfEvolution）：提交 ROLE.md / POLICIES.md 前先校验，失败 → console.warn
// 留现场 + **跳过该文件提交**（保留工作区脏文件供 git diff/checkout，不悄悄回滚，不阻断
// 主流程）。硬门不是权限门（不阻止员工在聊天中提案修改），只是防止静默削弱后不可追溯。

export type GuardKind = 'role_title' | 'redline_word';

/** 受保护锚点：文件相对路径 → 锚点清单。 */
export interface GuardedMarker {
  /** 锚点类型：'role_title' 为 ROLE.md 章节标题（内容级，只要求标题行在），
   *  'redline_word' 为 POLICIES.md 红线词（要求不被删除，允许被说明文字扩展）。 */
  kind: GuardKind;
  /** 锚点显示名（doctor/告警用）。 */
  label: string;
  /** 锚点值：标题行文本（不含前导 #，trim 后匹配）或红线词。 */
  value: string;
}

/** 相对工作区的身份文档 → 受保护锚点清单。 */
export const GUARDED_SECTION_MARKERS: Readonly<Record<string, readonly GuardedMarker[]>> = {
  'agent/ROLE.md': [
    { kind: 'role_title', label: '岗位定位', value: '岗位定位' },
    { kind: 'role_title', label: '长期职责', value: '长期职责' },
  ],
  'agent/POLICIES.md': [
    { kind: 'redline_word', label: '人工审批', value: '人工审批' },
    { kind: 'redline_word', label: '生产写入', value: '生产写入' },
    { kind: 'redline_word', label: '对外发布', value: '对外发布' },
    { kind: 'redline_word', label: '删除数据', value: '删除数据' },
    { kind: 'redline_word', label: 'Git push', value: 'Git push' },
  ],
  // D-041 P1-3：宪法区。CONSTITUTION.md 是员工不可静默改动的顶层身份文档——锚点标题
  // 缺失即疑似被删除/重写（员工删整个宪法 → 硬门拒绝提交；要改走聊天明确指示）。
  'agent/CONSTITUTION.md': [
    { kind: 'role_title', label: '使命', value: '使命' },
    { kind: 'role_title', label: '变更流程', value: '变更流程' },
  ],
};

export interface GuardIssue {
  marker: GuardedMarker;
  /** 问题说明（中文，供 console.warn / doctor）。 */
  message: string;
}

export interface GuardResult {
  ok: boolean;
  issues: GuardIssue[];
}

/** 对单个身份文档内容做锚点硬门校验。返回 `{ok, issues}`，`ok=false` 表示锚点缺失。 */
export function validateIdentityGuard(relPath: string, content: string): GuardResult {
  const markers = GUARDED_SECTION_MARKERS[relPath] ?? [];
  const issues: GuardIssue[] = [];
  for (const marker of markers) {
    const present =
      marker.kind === 'role_title'
        ? hasTitle(content, marker.value)
        : content.includes(marker.value);
    if (!present) {
      issues.push({
        marker,
        message: `${relPath} 缺少受保护锚点「${marker.label}」（${marker.value}），疑似被删除或削弱。`,
      });
    }
  }
  return { ok: issues.length === 0, issues };
}

/** markdown 一级/二级标题行是否含指定文本（trim 后匹配标题文本）。 */
function hasTitle(content: string, title: string): boolean {
  return content.split('\n').some(
    (line) =>
      /^#{1,2}\s+/.test(line) &&
      line
        .replace(/^#{1,2}\s+/, '')
        .trim()
        .startsWith(title),
  );
}

/** 剥离受保护行：移除 ROLE.md 受保护标题所在的行，及 POLICIES.md 包含红线词的行。
 *  供提案工具把「想改的内容」从受保护区块中抽离，不直接改受保护原文。 */
export function stripGuardSections(relPath: string, content: string): string {
  const markers = GUARDED_SECTION_MARKERS[relPath] ?? [];
  if (markers.length === 0) return content;
  return content
    .split('\n')
    .filter((line) => {
      for (const marker of markers) {
        const hit =
          marker.kind === 'role_title'
            ? /^#{1,2}\s+/.test(line) &&
              line
                .replace(/^#{1,2}\s+/, '')
                .trim()
                .startsWith(marker.value)
            : line.includes(marker.value);
        if (hit) return false;
      }
      return true;
    })
    .join('\n');
}
