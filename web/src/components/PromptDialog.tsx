import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';

/**
 * 品牌化「输入确认」弹窗（替代原生 window.prompt）。
 * 用户需输入与 expected 一致的文本才能确认，用于归档等类型确认。
 */
export function PromptDialog({
  open,
  onOpenChange,
  title,
  description,
  expected,
  expectedLabel = '员工 ID',
  placeholder,
  confirmLabel = '确认',
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  expected: string;
  expectedLabel?: string;
  placeholder?: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const [value, setValue] = useState('');
  const matched = value === expected;

  useEffect(() => {
    if (open) setValue('');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="prompt-confirm">
            {expectedLabel}（输入 <span className="font-mono text-foreground">{expected}</span>{' '}
            以确认）
          </Label>
          <Input
            id="prompt-confirm"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder ?? expected}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && matched && !busy) {
                event.preventDefault();
                void onConfirm();
              }
            }}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button
            variant="destructive"
            onClick={() => void onConfirm()}
            disabled={!matched || busy}
          >
            {busy ? '处理中…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
