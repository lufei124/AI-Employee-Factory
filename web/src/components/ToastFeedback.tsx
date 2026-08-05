import { toast } from 'sonner';

/** 统一 Toast 反馈：成功 / 失败 / 信息。 */
export const notify = {
  success: (message: string, description?: string) => toast.success(message, { description }),
  error: (message: string, description?: string) => toast.error(message, { description }),
  info: (message: string, description?: string) => toast.info(message, { description }),
};

/** 把任意 catch 的 cause 转成可读错误信息。 */
export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
