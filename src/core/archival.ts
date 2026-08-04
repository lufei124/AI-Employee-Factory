// OP1 Stage E：archival 后端前置约束。把 archival 后端的写入约束写成 frozen 不变量（D-014 ADR）。
// 本模块仅定义契约，不实现任何后端——kind 默认 'none'。未来新增后端（local-sqlite/external）
// 必须满足 D-014 的全部约束并经安全评审后才可落地。

/** archival 后端的类型。'none' 为默认（不启用任何外部归档）。 */
export type ArchivalBackendKind = 'local-sqlite' | 'external' | 'none';

/** archival 后端的写入约束（D-014 frozen 不变量，实现不得放宽）。 */
export interface ArchivalBackend {
  readonly kind: ArchivalBackendKind;
  /**
   * 归档一条内容。
   * 硬约束（实现必须满足）：
   * - 写入前必须经核心 secret 正则（SECRET_PATTERN）过滤，禁止原始 Secret 落盘；
   * - 必须经用户显式 per-entry 授权（不得隐式归档用户未确认的内容）；
   * - 不得传输 runtime_home / bridge 内容（仅工作区可迁移身份知识）；
   * - 网络面 / 多租户威胁模型须经安全评审（external 后端尤其如此）。
   */
  archive(entry: ArchivalEntry): Promise<ArchivalResult>;
}

/** 单条可归档内容。relPath 相对工作区知识根，content 已由调用方脱敏。 */
export interface ArchivalEntry {
  /** 相对知识根（如 `lessons/2026-08-04-user-operations.md`）的路径。 */
  relPath: string;
  /** 已脱敏的内容（调用方须经 redactSecrets，后端不得再信任原始数据）。 */
  content: string;
  /** 内容所属权威层（与 knowledge/ frontmatter 的 authority_layer 一致）。 */
  authorityLayer: 'agent' | 'knowledge' | 'decisions' | 'skills' | 'native_memory' | 'session';
  /** 内容产生的时间（ISO 8601）。 */
  createdAt: string;
}

/** 归档结果。 */
export interface ArchivalResult {
  /** 后端持久化后的稳定引用（文件路径 / 记录 ID）。 */
  reference: string;
  /** 后端实际落盘的字节数。 */
  bytes: number;
}
