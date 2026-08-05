import { useState } from 'react';
import { Activity, CheckCircle2 } from 'lucide-react';
import { api, type OperationDto } from '../api.js';
import { PageHeader } from '../components/PageHeader.js';
import { notify, errorText } from '../components/ToastFeedback.js';
import { EmptyState } from '../components/PageState.js';
import { Button } from '../components/ui/button.js';

export function DoctorPage() {
  const [operation, setOperation] = useState<OperationDto>();
  const [error, setError] = useState('');
  const run = async () => {
    try {
      const next = await api.runDoctor();
      setOperation(next);
      notify.success('系统诊断已提交到操作中心');
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="系统健康"
        title="系统诊断"
        description="检查 Node、Registry、目录权限和本机工具能力，不做静默修改。"
        actions={
          <Button onClick={() => void run()}>
            <Activity className="size-4" />
            运行系统 Doctor
          </Button>
        }
      />
      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <section className="rounded-xl border border-border bg-card p-6">
        <EmptyState
          icon={<CheckCircle2 className="size-6" />}
          title={operation ? '诊断已进入操作中心' : '准备进行只读诊断'}
          description={
            operation ? `Operation ${operation.id}` : '结果会逐项显示通过、警告、失败和修复命令。'
          }
        />
      </section>
    </div>
  );
}
