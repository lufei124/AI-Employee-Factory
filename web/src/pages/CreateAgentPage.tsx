import { useCallback, useState } from 'react';
import { ChevronLeft, ChevronRight, Check, Sparkles } from 'lucide-react';
import { api, type GeneratedProfile } from '../api.js';
import { PageHeader } from '../components/PageHeader.js';
import { CopyButton } from '../components/CopyButton.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Textarea } from '../components/ui/textarea.js';
import { Switch } from '../components/ui/switch.js';
import { cn } from '../lib/utils.js';

// D-029：进入向导即预填一份可编辑的默认蓝图，用户可手动修改或「AI 生成蓝图」
// 用一句话描述重新生成。默认蓝图保证离屏即可看到可编辑的完整骨架。
const DEFAULT_BRIEF = '帮我建一名用户运营专员，负责收集和分析用户反馈，提炼产品洞察并闭环跟进。';
const DEFAULT_PROFILE: GeneratedProfile = {
  id: 'user-operations',
  name: '用户运营专员',
  description: '专注于用户运营，负责收集与分析用户反馈，提炼运营洞察并闭环跟进，提升产品体验。',
  goals: ['建立用户反馈收集渠道', '每周输出运营洞察报告', '推动高优先级反馈闭环跟进'],
  responsibilities: ['收集与整理用户反馈', '分析反馈并提炼共性洞察', '跟进高优先级问题至解决'],
  policies: ['对外发布须经人工审批', '删除数据须经人工审批', 'Git push 须经人工审批'],
  escalation_conditions: ['涉及资源投入或对外沟通时上报', '需要更高权限时申请'],
  skills: ['feedback-analyze', 'feedback-collect'],
};

function agentIdFromName(name: string, fallback: string): string {
  const generated = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return generated || fallback;
}

function toLines(value: string[] | undefined): string {
  return (value ?? []).join('\n');
}

function fromLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

const STEPS = ['描述与蓝图', '运行环境', '确认创建'];

export function CreateAgentPage() {
  const [step, setStep] = useState(0);
  const [brief, setBrief] = useState(DEFAULT_BRIEF);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState(true);
  const [id, setId] = useState(DEFAULT_PROFILE.id ?? '');
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);
  const [name, setName] = useState(DEFAULT_PROFILE.name);
  const [description, setDescription] = useState(DEFAULT_PROFILE.description);
  const [goals, setGoals] = useState(toLines(DEFAULT_PROFILE.goals));
  const [responsibilities, setResponsibilities] = useState(
    toLines(DEFAULT_PROFILE.responsibilities),
  );
  const [policies, setPolicies] = useState(toLines(DEFAULT_PROFILE.policies));
  const [escalation, setEscalation] = useState(toLines(DEFAULT_PROFILE.escalation_conditions));
  const [skills, setSkills] = useState(toLines(DEFAULT_PROFILE.skills));
  const [runtime, setRuntime] = useState<'claude' | 'codex'>('claude');
  const [feishu, setFeishu] = useState<'dedicated' | 'disabled'>('dedicated');
  const [created, setCreated] = useState<{ id: string; workspace: string }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const input = {
    id,
    name,
    runtime,
    feishu,
    description,
    goals: fromLines(goals),
    responsibilities: fromLines(responsibilities),
    policies: fromLines(policies),
    escalation_conditions: fromLines(escalation),
    skills: fromLines(skills),
  };
  const canContinue = id.length > 0 && description.length > 0 && fromLines(goals).length > 0;

  const applyProfile = useCallback((profile: GeneratedProfile) => {
    setName(profile.name);
    setDescription(profile.description);
    setGoals(toLines(profile.goals));
    setResponsibilities(toLines(profile.responsibilities));
    setPolicies(toLines(profile.policies));
    setEscalation(toLines(profile.escalation_conditions));
    setSkills(toLines(profile.skills));
    setIdManuallyEdited((edited) => {
      if (!edited) {
        const nextId =
          profile.id && /^[a-z0-9][a-z0-9-]*$/.test(profile.id)
            ? profile.id
            : agentIdFromName(profile.name, '');
        setId(nextId);
      }
      return edited;
    });
  }, []);

  const generate = useCallback(
    async (source: string) => {
      setGenerating(true);
      setError('');
      try {
        const profile = await api.generateEmployeeProfile(source);
        applyProfile(profile);
        setGenerated(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setGenerating(false);
      }
    },
    [applyProfile],
  );

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      setCreated(await api.createAgent(input));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    const isClaude = runtime === 'claude';
    const commands = [
      {
        label: isClaude ? '1. 同步 CC Switch Provider' : '1. 登录 Codex',
        description: isClaude
          ? '同步 CC Switch 当前 Claude Provider 到员工隔离环境'
          : '在员工专属 CODEX_HOME 中完成 Codex 登录',
        command: isClaude
          ? `agentctl runtime sync ${created.id}`
          : `agentctl runtime login ${created.id}`,
      },
      {
        label: '2. 授权飞书',
        description: '如已启用独立飞书机器人，在终端扫码或授权',
        command: `agentctl bridge authorize ${created.id}`,
      },
      {
        label: '3. 运行诊断',
        description: '检查目录、隔离环境、Runtime 和 Bridge 状态',
        command: `agentctl doctor ${created.id}`,
      },
    ];
    return (
      <div className="mx-auto max-w-xl space-y-6">
        <div className="flex flex-col items-center rounded-xl border border-border bg-card p-10 text-center shadow-sm">
          <div className="mb-5 grid size-14 place-items-center rounded-2xl bg-success/15 text-success">
            <Check className="size-7" />
          </div>
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">准备就绪</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">员工创建完成</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {created.id} 的基础目录已创建，但还需在本机终端完成下面的初始化步骤。
          </p>
        </div>

        <div className="space-y-3">
          {commands.map(({ label, description: desc, command }) => (
            <div
              key={command}
              className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-5 py-4"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
              </div>
              <code className="flex shrink-0 items-center gap-2 rounded-md bg-muted px-3 py-1.5 font-mono text-xs text-muted-foreground">
                {command}
                <CopyButton text={command} />
              </code>
            </div>
          ))}
        </div>

        <div className="flex justify-center">
          <Button asChild>
            <a href={`#/agents/${created.id}`}>进入员工详情</a>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="员工蓝图"
        title="创建 AI 员工"
        description="用一句话描述员工用法，AI 自动生成可编辑蓝图；生成可迁移、可诊断且身份隔离的本地员工。"
      />

      <ol className="flex items-center gap-2">
        {STEPS.map((label, index) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                'grid size-6 place-items-center rounded-full text-[11px] font-semibold',
                index < step && 'bg-success text-success-foreground',
                index === step && 'bg-primary text-primary-foreground',
                index > step && 'bg-muted text-muted-foreground',
              )}
            >
              {index < step ? <Check className="size-3.5" /> : index + 1}
            </span>
            <span
              className={cn(
                'text-sm',
                index === step ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {label}
            </span>
            {index < STEPS.length - 1 && <span className="mx-1 h-px w-8 bg-border" />}
          </li>
        ))}
      </ol>

      <section className="rounded-xl border border-border bg-card p-6">
        {step === 0 && (
          <div className="space-y-5">
            <div className="grid gap-1.5">
              <Label htmlFor="create-brief">一句话描述你的员工</Label>
              <Textarea
                id="create-brief"
                aria-label="员工描述"
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                placeholder="例如：帮我建一个负责收集用户反馈、分析并闭环跟进的产品运营……"
                rows={3}
              />
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  disabled={generating || brief.trim().length === 0}
                  onClick={() => void generate(brief)}
                >
                  <Sparkles className={cn('size-4', generating && 'animate-pulse')} />
                  {generating ? 'AI 生成中…' : 'AI 生成蓝图'}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {generated
                    ? '已生成，可修改下方字段后继续。'
                    : 'AI 会生成岗位名、职责、目标与权限边界。'}
                </p>
              </div>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="create-name">员工名称</Label>
                <Input
                  id="create-name"
                  aria-label="员工名称"
                  value={name}
                  onChange={(event) => {
                    const nextName = event.target.value;
                    setName(nextName);
                    if (!idManuallyEdited) setId(agentIdFromName(nextName, ''));
                  }}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="create-id">Agent ID（自动生成）</Label>
                <Input
                  id="create-id"
                  aria-label="Agent ID"
                  value={id}
                  onChange={(event) => {
                    setId(event.target.value);
                    setIdManuallyEdited(true);
                  }}
                  placeholder="例如 content-operator"
                  className="font-mono"
                />
              </div>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="create-desc">职责描述</Label>
                <Textarea
                  id="create-desc"
                  rows={3}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="create-goals">核心目标（每行一条）</Label>
                <Textarea
                  id="create-goals"
                  rows={4}
                  value={goals}
                  onChange={(event) => setGoals(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="create-resp">长期职责（每行一条）</Label>
                <Textarea
                  id="create-resp"
                  rows={4}
                  value={responsibilities}
                  onChange={(event) => setResponsibilities(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="create-policies">权限与上报规则（每行一条）</Label>
                <Textarea
                  id="create-policies"
                  rows={4}
                  value={policies}
                  onChange={(event) => setPolicies(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="create-escalation">主动上报情形（每行一条）</Label>
                <Textarea
                  id="create-escalation"
                  rows={3}
                  value={escalation}
                  onChange={(event) => setEscalation(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="create-skills">技能（每行一个，英文 kebab-case）</Label>
                <Textarea
                  id="create-skills"
                  rows={3}
                  value={skills}
                  onChange={(event) => setSkills(event.target.value)}
                />
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-6">
            <div className="grid gap-1.5">
              <Label>运行环境</Label>
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    {
                      value: 'claude',
                      name: 'Claude Code',
                      desc: '默认 sonnet，专属 CLAUDE_CONFIG_DIR',
                    },
                    {
                      value: 'codex',
                      name: 'OpenAI Codex',
                      desc: 'workspace-write，专属 CODEX_HOME',
                    },
                  ] as const
                ).map((option) => (
                  <label
                    key={option.value}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors',
                      runtime === option.value
                        ? 'border-primary/60 bg-primary/5'
                        : 'border-border hover:border-muted-foreground/30',
                    )}
                  >
                    <input
                      type="radio"
                      aria-label={option.name}
                      className="mt-0.5 size-4 accent-(--primary)"
                      checked={runtime === option.value}
                      onChange={() => setRuntime(option.value)}
                    />
                    <span>
                      <strong className="block text-sm font-semibold">{option.name}</strong>
                      <small className="block text-xs text-muted-foreground">{option.desc}</small>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
              <span>
                <strong className="block text-sm font-semibold">启用独立飞书机器人</strong>
                <small className="block text-xs text-muted-foreground">
                  创建后在隔离终端中完成扫码或 App 授权
                </small>
              </span>
              <Switch
                checked={feishu === 'dedicated'}
                onCheckedChange={(checked) => setFeishu(checked ? 'dedicated' : 'disabled')}
                aria-label="启用独立飞书机器人"
              />
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">创建预览</p>
            <dl className="divide-y divide-border rounded-lg border border-border">
              {[
                ['Agent', `${name} · ${id}`],
                ['职责描述', description],
                ['核心目标', `${fromLines(goals).length} 条`],
                ['Runtime', runtime === 'claude' ? 'Claude Code' : 'OpenAI Codex'],
                ['飞书', feishu === 'dedicated' ? '独立机器人' : '不启用'],
              ].map(([key, value]) => (
                <div key={key} className="flex items-center justify-between gap-4 px-5 py-3.5">
                  <dt className="text-sm text-muted-foreground">{key}</dt>
                  <dd className="text-right text-sm font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
              不会访问真实模型或飞书 API；登录和授权将在创建后单独完成。
            </div>
          </div>
        )}

        {error && (
          <div className="mt-5 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <footer className="mt-6 flex items-center justify-between border-t border-border pt-5">
          {step > 0 ? (
            <Button variant="ghost" onClick={() => setStep(step - 1)}>
              <ChevronLeft className="size-4" />
              上一步
            </Button>
          ) : (
            <span />
          )}
          {step < 2 ? (
            <Button disabled={step === 0 && !canContinue} onClick={() => setStep(step + 1)}>
              下一步
              <ChevronRight className="size-4" />
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => void submit()}>
              {busy ? '创建中…' : '创建员工'}
            </Button>
          )}
        </footer>
      </section>
    </div>
  );
}
