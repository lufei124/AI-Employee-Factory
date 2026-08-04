// OP2-F 扩展面能力隔离（R23）：把扩展点限定为纯数据或 adapter 接口，
// 禁止同进程 JS 模块直接持有 fs/execa。本文件只定义契约类型与评审用沙箱语义，
// v1 不固化加载器实现（无加载器、无默认扩展）。
//
// 设计原则（D-013）：扩展能力按「数据可达性」分级，任何代码型扩展必须运行在
// 子进程/Worker 并经 IPC 限制能力，不能直接 `import fs`/`execa` 触碰宿主文件系统。

/** 扩展的执行形态。决定扩展能接触到哪些能力。 */
export type ExtensionKind = 'data-only' | 'adapter-interface' | 'subprocess';

/**
 * 扩展沙箱契约（评审用，v1 不固化加载器）。
 *
 * - `data-only`：纯 YAML/JSON preset，零代码。范围最窄，无任何宿主能力。
 * - `adapter-interface`：只接收核心注入的限定句柄（如 IdentityStore 校验结果、
 *   `BackupFilter` 纯函数），不直接持有 fs/execa。
 * - `subprocess`：代码型扩展，必须在子进程/Worker 中运行，经 IPC 只接收白名单消息。
 *
 * 安全性由 `ExtensionKind` 收敛保证：同类扩展不得越级获取能力。
 */
export interface ExtensionSandbox {
  readonly kind: ExtensionKind;
  /** 加载扩展清单。data-only 返回纯数据；其他返回受限句柄。 */
  load(manifest: ExtensionManifest): Promise<Extension>;
}

/** 扩展清单。v1 仅识别 kind 与标识，不解析任何宿主路径。 */
export interface ExtensionManifest {
  readonly name: string;
  readonly kind: ExtensionKind;
}

/** 已加载扩展。v1 仅保留标识，能力由沙箱按 kind 注入。 */
export interface Extension {
  readonly name: string;
  readonly kind: ExtensionKind;
}
