export type AgentCtlErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'LOCKED'
  | 'DEPENDENCY_MISSING'
  | 'AUTH_REQUIRED'
  | 'OPERATION_FAILED';

const defaultExitCodes: Record<AgentCtlErrorCode, number> = {
  VALIDATION_ERROR: 2,
  NOT_FOUND: 3,
  CONFLICT: 4,
  LOCKED: 4,
  DEPENDENCY_MISSING: 5,
  AUTH_REQUIRED: 5,
  OPERATION_FAILED: 1,
};

export class AgentCtlError extends Error {
  readonly code: AgentCtlErrorCode;
  readonly remediation?: string;
  readonly exitCode: number;

  constructor(
    code: AgentCtlErrorCode,
    message: string,
    options: { remediation?: string; exitCode?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AgentCtlError';
    this.code = code;
    this.exitCode = options.exitCode ?? defaultExitCodes[code];
    if (options.remediation !== undefined) this.remediation = options.remediation;
  }
}
