import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Copy, XCircle } from 'lucide-react';

async function copyWithFallback(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard permissions vary by browser; fall through to the local selection method.
  }

  if (typeof document.execCommand !== 'function') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    setState((await copyWithFallback(text)) ? 'copied' : 'failed');
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setState('idle'), 1800);
  };

  return (
    <button
      type="button"
      className={`icon-button copy-button ${state}`}
      aria-label={`复制命令 ${text}`}
      title={state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : '复制命令'}
      onClick={() => void copy()}
    >
      {state === 'copied' ? (
        <CheckCircle2 size={15} />
      ) : state === 'failed' ? (
        <XCircle size={15} />
      ) : (
        <Copy size={15} />
      )}
      {state !== 'idle' && <span role="status">{state === 'copied' ? '已复制' : '复制失败'}</span>}
    </button>
  );
}
