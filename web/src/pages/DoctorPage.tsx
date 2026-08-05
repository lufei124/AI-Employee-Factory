import { useState } from 'react';
import { Activity, CheckCircle2 } from 'lucide-react';
import { api, type OperationDto } from '../api.js';

export function DoctorPage() {
  const [operation, setOperation] = useState<OperationDto>();
  const [error, setError] = useState('');
  const run = async () => {
    try {
      setOperation(await api.runDoctor());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">系统健康</p>
          <h1>系统诊断</h1>
          <p>检查 Node、Registry、目录权限和本机工具能力，不做静默修改。</p>
        </div>
        <button className="button primary" onClick={() => void run()}>
          <Activity size={16} />
          运行系统 Doctor
        </button>
      </header>
      {error && <div className="notice danger">{error}</div>}
      <section className="panel">
        <div className="empty-state">
          <CheckCircle2 size={32} />
          <h3>{operation ? '诊断已进入操作中心' : '准备进行只读诊断'}</h3>
          <p>
            {operation ? `Operation ${operation.id}` : '结果会逐项显示通过、警告、失败和修复命令。'}
          </p>
        </div>
      </section>
    </div>
  );
}
